import { randomUUID } from "node:crypto";
import type { JsonObject } from "./config.ts";

/**
 * Client side of the guardian sandbox broker.
 *
 * The contract is mirrored from `pi-guardian/src/sandbox/types.ts` on purpose:
 * the sandbox must not depend on guardian's package, and either side can be
 * updated without breaking the other as long as the JSON shapes stay
 * compatible. The broker itself is published by guardian at `session_start` on
 * a `Symbol.for` slot.
 */
export const SANDBOX_BROKER_KEY = Symbol.for("pi-guardian:sandbox-broker");

export type SandboxSurface = "command" | "network" | "read" | "write";

export type SandboxScope = "once" | "session";

export interface SandboxExceptionRequest {
	id: string;
	origin: "tool" | "trap";
	surface: SandboxSurface;
	target: string;
	scope: SandboxScope;
	reason?: string;
	cwd: string;
	command?: string;
	violation?: string;
	agentName?: string;
}

export interface SandboxReview {
	rationale: string;
	source: "rule" | "reviewer";
}

export type SandboxExceptionDecision =
	| { kind: "allow"; scope: SandboxScope; review: SandboxReview; grantId?: string }
	| { kind: "deny"; reason: string; review: SandboxReview }
	| { kind: "defer"; review: SandboxReview };

export interface SandboxBrokerService {
	review(request: SandboxExceptionRequest): Promise<SandboxExceptionDecision>;
}

export function getGuardianBroker(): SandboxBrokerService | undefined {
	return (globalThis as Record<symbol, unknown>)[SANDBOX_BROKER_KEY] as SandboxBrokerService | undefined;
}

export function publishGuardianBrokerForTest(service: SandboxBrokerService): () => void {
	const target = globalThis as Record<symbol, unknown>;
	if (target[SANDBOX_BROKER_KEY]) throw new Error("sandbox broker already published");
	target[SANDBOX_BROKER_KEY] = service;
	return () => {
		if (target[SANDBOX_BROKER_KEY] === service) delete target[SANDBOX_BROKER_KEY];
	};
}

export interface DecideOptions {
	surface: SandboxSurface;
	target: string;
	scope: SandboxScope;
	cwd: string;
	origin?: "tool" | "trap";
	reason?: string;
	command?: string;
	violation?: string;
	agentName?: string;
	/** Injected in tests; production reads the published slot. */
	broker?: SandboxBrokerService;
}

export function buildRequest(options: DecideOptions): SandboxExceptionRequest {
	return {
		id: randomUUID(),
		origin: options.origin ?? "tool",
		surface: options.surface,
		target: options.target,
		scope: options.scope,
		reason: options.reason,
		cwd: options.cwd,
		command: options.command,
		violation: options.violation,
		agentName: options.agentName,
	};
}

/**
 * Optional project-policy service published by guardian. A standing permission
 * belongs in the project's Guardian policy (`<workspace>/.pi/guardian.json`),
 * which guardian owns — the sandbox must not write the policy it is governed by.
 * There is no fallback that writes sandbox configuration instead.
 *
 * Contract mirrored from `pi-guardian/src/project-policy.ts`, same as the broker.
 * Rules use guardian's `<surface>:<pattern>` spelling, so callers pass a target
 * through `projectPolicyRule` rather than inventing their own prefix.
 */
export const PROJECT_POLICY_KEY = Symbol.for("pi-guardian:project-policy");

export type PreparedProjectRule =
	| { ok: true; commit(): { ok: true; path: string; hash: string; added: boolean } | { ok: false; reason: string } }
	| { ok: false; reason: string };

export interface ProjectPolicyService {
	readonly path: string;
	/** Capture the trusted policy snapshot BEFORE asking the human to save. */
	prepareRule(rule: string): PreparedProjectRule;
}

export function getProjectPolicyService(): ProjectPolicyService | undefined {
	return (globalThis as Record<symbol, unknown>)[PROJECT_POLICY_KEY] as ProjectPolicyService | undefined;
}

/** Guardian's rule text: `command:git push:*`, `network:example.com`, `read:/data`. */
export function projectPolicyRule(surface: SandboxSurface, pattern: string): string {
	return `${surface}:${pattern}`;
}

/**
 * Ask the sole policy authority. Missing/failed Guardian is a denial, not a
 * synthetic defer: without its hard-deny admission, a UI approval could expose
 * a credential path that is never grantable. Only an actual defer asks a human.
 */
export async function decideSandboxException(options: DecideOptions): Promise<SandboxExceptionDecision> {
	const broker = options.broker ?? getGuardianBroker();
	if (!broker) {
		const reason = "No guardian sandbox broker is published; restart with Guardian loaded before requesting an exception. Nothing was granted.";
		return { kind: "deny", reason, review: { rationale: reason, source: "rule" } };
	}
	const request = buildRequest(options);
	try {
		return await broker.review(request);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			kind: "deny",
			reason: `Sandbox exception review failed, so the request was denied: ${message}`,
			review: { rationale: `Broker failure: ${message}`, source: "reviewer" },
		};
	}
}

function isObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addUnique(existing: unknown, value: string): string[] {
	const list = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
	return list.includes(value) ? list : [...list, value];
}

export type ScopedPath = { surface: "read" | "write"; target: string };

/**
 * Build a command-local session layer with extra readable/writable paths. The
 * caller installs it in the SRT runtime for one execution and restores the
 * baseline afterwards; the session layer itself, and therefore every native file
 * tool, never sees these paths. No read/write/network/command grant outlives the
 * execution, so there is no grant store to expire.
 */
export function withScopedPaths(layer: JsonObject, paths: readonly ScopedPath[]): JsonObject {
	const filesystem: JsonObject = { ...(isObject(layer.filesystem) ? layer.filesystem : {}) };
	for (const entry of paths) {
		const key = entry.surface === "write" ? "allowWrite" : "allowRead";
		filesystem[key] = addUnique(filesystem[key], entry.target);
	}
	return { ...layer, filesystem };
}
