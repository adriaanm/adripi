/** Broker contract between the sandbox layer and guardian.
 *
 * The sandbox asks; guardian decides; the human is the fallback for `defer`.
 * Nothing here depends on the sandbox implementation, and no sandbox package is
 * imported by guardian: the service is published on a `Symbol.for` slot, the
 * same discipline `pi-auto-review` uses, minus the dependency.
 */

export type SandboxSurface = "command" | "network" | "read" | "write";

export type SandboxScope = "once" | "session";

export interface SandboxExceptionRequest {
	/** Unique per request; used for audit correlation and one-shot grants. */
	id: string;
	/** `tool`: the model asked. `trap`: the sandbox blocked an attempt. */
	origin: "tool" | "trap";
	surface: SandboxSurface;
	/** Exact command, `host:port`, or absolute path. No wildcards. */
	target: string;
	/** The model may ask for `session`; policy or reviewer may narrow it. */
	scope: SandboxScope;
	/** Required for `origin: "tool"`; the model's justification. */
	reason?: string;
	cwd: string;
	/** `origin: "trap"` context. */
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

export interface SandboxExceptionRules {
	allow: string[];
	/** Classes the human decides: never auto-allowed, never sent to the reviewer. */
	defer: string[];
	deny: string[];
}

/** Durable session entry type for one exception decision. */
export const SANDBOX_EXCEPTION_ENTRY = "guardian-sandbox-exception";

/** One audit row per request; the sandbox side logs consumption separately. */
export interface SandboxAuditRecord {
	kind: "sandbox_exception";
	requestId: string;
	origin: SandboxExceptionRequest["origin"];
	surface: SandboxSurface;
	target: string;
	requestedScope: SandboxScope;
	decision: SandboxExceptionDecision["kind"];
	grantedScope?: SandboxScope;
	rule?: string;
	source?: SandboxReview["source"];
	rationale: string;
	grantId?: string;
	recordedAt: string;
}
