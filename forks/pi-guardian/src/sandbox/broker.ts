import { randomUUID } from "node:crypto";
import { evaluateSandboxRules } from "./rules.ts";
import type {
	SandboxAuditRecord,
	SandboxBrokerService,
	SandboxExceptionDecision,
	SandboxExceptionRequest,
	SandboxExceptionRules,
	SandboxScope,
	SandboxSurface,
} from "./types.ts";

/** Same discipline as `pi-auto-review`'s broker slot: one publisher, globalThis,
 * so a fork/loaded-copy mismatch cannot produce two authorities in one process. */
export const SANDBOX_BROKER_KEY = Symbol.for("pi-guardian:sandbox-broker");

const SURFACES: ReadonlySet<string> = new Set(["command", "network", "read", "write"]);
const SCOPES: ReadonlySet<string> = new Set(["once", "session"]);

export type SandboxReviewOutcome = {
	outcome: "allow" | "deny" | "defer";
	rationale: string;
	/** The reviewer may narrow the scope, never widen it. */
	scope?: SandboxScope;
};

export type SandboxReviewFn = (request: SandboxExceptionRequest) => Promise<SandboxReviewOutcome>;

export interface SandboxBrokerOptions {
	rules: SandboxExceptionRules;
	agentDir: string;
	review: SandboxReviewFn;
	audit?: (record: SandboxAuditRecord) => void;
	now?: () => Date;
	/** Consecutive denials after which further asks are refused without review. */
	maxConsecutiveDenials?: number;
}

export function publishSandboxBroker(service: SandboxBrokerService): () => void {
	const target = globalThis as Record<symbol, unknown>;
	if (target[SANDBOX_BROKER_KEY]) throw new Error("pi-guardian sandbox broker is already published");
	target[SANDBOX_BROKER_KEY] = service;
	return () => {
		if (target[SANDBOX_BROKER_KEY] === service) delete target[SANDBOX_BROKER_KEY];
	};
}

export function getSandboxBroker(): SandboxBrokerService | undefined {
	return (globalThis as Record<symbol, unknown>)[SANDBOX_BROKER_KEY] as SandboxBrokerService | undefined;
}

/**
 * Decision order: request validation → hard-deny rules → allow rules → reviewer.
 * Rules never consult a model; a reviewer that fails is a denial, not a defer.
 * `defer` is the only path that reaches the human, and it grants nothing.
 */
export function createSandboxBroker(options: SandboxBrokerOptions): SandboxBrokerService {
	const now = options.now ?? (() => new Date());
	const audit = options.audit ?? (() => {});
	const rules = options.rules;
	const maxConsecutiveDenials = options.maxConsecutiveDenials ?? 3;
	// A model that keeps asking must not spin on the reviewer. Mirrors guardian's
	// tool-call breaker, scoped to exception requests.
	let consecutiveDenials = 0;

	const record = (request: SandboxExceptionRequest, decision: SandboxExceptionDecision, rule?: string) => {
		audit({
			kind: "sandbox_exception",
			requestId: request.id,
			origin: request.origin,
			surface: request.surface,
			target: request.target,
			requestedScope: request.scope,
			decision: decision.kind,
			grantedScope: decision.kind === "allow" ? decision.scope : undefined,
			rule,
			source: decision.review.source,
			rationale: decision.review.rationale,
			grantId: decision.kind === "allow" ? decision.grantId : undefined,
			recordedAt: now().toISOString(),
		});
	};

	const deny = (request: SandboxExceptionRequest, reason: string, rationale: string, source: "rule" | "reviewer", rule?: string) => {
		consecutiveDenials++;
		const decision: SandboxExceptionDecision = { kind: "deny", reason, review: { rationale, source } };
		record(request, decision, rule);
		return decision;
	};

	return {
		async review(request: SandboxExceptionRequest): Promise<SandboxExceptionDecision> {
			const invalid = validateRequest(request);
			if (invalid) return deny(request, invalid, `Invalid sandbox exception request: ${invalid}`, "rule");

			if (consecutiveDenials >= maxConsecutiveDenials) {
				return deny(
					request,
					`Sandbox exception denied: ${consecutiveDenials} consecutive denials in this session. Stop asking and continue without the exception.`,
					"Circuit breaker on repeated sandbox exception requests.",
					"rule",
				);
			}

			const ruled = evaluateSandboxRules(rules, request, options.agentDir);
			if (ruled.outcome === "deny") {
				return deny(
					request,
					`Sandbox exception denied by rule ${ruled.rule}. This class of access is never grantable; do not retry or rephrase it.`,
					`Blocked by hard-deny rule ${ruled.rule}.`,
					"rule",
					ruled.rule,
				);
			}
			if (ruled.outcome === "defer") {
				const decision: SandboxExceptionDecision = {
					kind: "defer",
					review: { rationale: `Rule ${ruled.rule} defers this class to the user.`, source: "rule" },
				};
				record(request, decision, ruled.rule);
				return decision;
			}
			if (ruled.outcome === "allow") {
				consecutiveDenials = 0;
				const decision: SandboxExceptionDecision = {
					kind: "allow",
					scope: request.scope,
					review: { rationale: `Allowed by rule ${ruled.rule}.`, source: "rule" },
					grantId: randomUUID(),
				};
				record(request, decision, ruled.rule);
				return decision;
			}

			let reviewed: SandboxReviewOutcome;
			try {
				reviewed = await options.review(request);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return deny(
					request,
					`Sandbox exception review failed, so the request was denied. Reason: ${reason}`,
					`Review failed: ${reason}`,
					"reviewer",
				);
			}

			if (reviewed.outcome === "defer") {
				const decision: SandboxExceptionDecision = {
					kind: "defer",
					review: { rationale: reviewed.rationale, source: "reviewer" },
				};
				record(request, decision);
				return decision;
			}
			if (reviewed.outcome === "deny") {
				return deny(
					request,
					`Sandbox exception denied. ${reviewed.rationale} Do not retry or rephrase the same target; ask the user if the step matters.`,
					reviewed.rationale,
					"reviewer",
				);
			}

			const decision: SandboxExceptionDecision = {
				kind: "allow",
				scope: narrowScope(request.scope, reviewed.scope),
				review: { rationale: reviewed.rationale, source: "reviewer" },
				grantId: randomUUID(),
			};
			consecutiveDenials = 0;
			record(request, decision);
			return decision;
		},
	};
}

function narrowScope(requested: SandboxScope, reviewed: SandboxScope | undefined): SandboxScope {
	return reviewed === "once" || requested === "once" ? "once" : "session";
}

function validateRequest(request: SandboxExceptionRequest): string | undefined {
	if (!request || typeof request !== "object") return "request must be an object";
	if (typeof request.id !== "string" || request.id.trim() === "") return "id must be a non-empty string";
	if (request.origin !== "tool" && request.origin !== "trap") return "origin must be tool or trap";
	if (!SURFACES.has(request.surface as SandboxSurface)) return `unknown surface: ${String(request.surface)}`;
	if (!SCOPES.has(request.scope)) return `unknown scope: ${String(request.scope)}`;
	if (typeof request.target !== "string" || request.target.trim() === "") return "target must be a non-empty string";
	if (typeof request.cwd !== "string" || request.cwd.trim() === "") return "cwd must be a non-empty string";
	// A model-asked exception without a justification is not reviewable.
	if (request.origin === "tool" && (typeof request.reason !== "string" || request.reason.trim() === "")) {
		return "reason is required when the model asks for an exception";
	}
	return undefined;
}
