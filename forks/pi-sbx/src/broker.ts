import { randomUUID } from "node:crypto";

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
 * Ask the broker. No broker means `defer` (the caller's human prompt decides);
 * a broker that throws is a denial, never an allow.
 */
export async function decideSandboxException(options: DecideOptions): Promise<SandboxExceptionDecision> {
	const broker = options.broker ?? getGuardianBroker();
	if (!broker) {
		return { kind: "defer", review: { rationale: "No guardian sandbox broker is published.", source: "rule" } };
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

/** Session-layer config fragment; the shape `loadConfig` merges last. */
export interface SessionLayer {
	filesystem?: { allowRead?: string[]; allowWrite?: string[] };
	network?: { allowedDomains?: string[] };
	excludedCommands?: string[];
}

function addUnique(existing: unknown, value: string): string[] {
	const list = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
	return list.includes(value) ? list : [...list, value];
}

/**
 * Apply one session-scope grant to the session config layer. Returns a new
 * object; the on-disk config is never touched, and reloads rebuild the layer
 * from scratch, so a grant cannot outlive the session.
 */
export function withSessionException(
	layer: SessionLayer,
	surface: SandboxSurface,
	target: string,
): SessionLayer {
	const next: SessionLayer = {
		...layer,
		filesystem: { ...(layer.filesystem ?? {}) },
		network: { ...(layer.network ?? {}) },
	};
	if (surface === "write" || surface === "read") {
		const key = surface === "write" ? "allowWrite" : "allowRead";
		next.filesystem = { ...next.filesystem, [key]: addUnique(next.filesystem?.[key], target) };
		return next;
	}
	if (surface === "network") {
		next.network = { ...next.network, allowedDomains: addUnique(next.network?.allowedDomains, target) };
		return next;
	}
	next.excludedCommands = addUnique(layer.excludedCommands, target);
	return next;
}

export type ExceptionPlan =
	| { action: "grant"; scope: SandboxScope }
	| { action: "deny"; message: string }
	| { action: "ask-human" };

/**
 * What the caller should do with a broker decision. Kept pure so the tool path
 * (allow → grant, deny → tell the model, defer → ask the human) is testable
 * without a Pi runtime.
 */
export function planExceptionOutcome(decision: SandboxExceptionDecision): ExceptionPlan {
	if (decision.kind === "allow") return { action: "grant", scope: decision.scope };
	if (decision.kind === "deny") return { action: "deny", message: decision.reason };
	return { action: "ask-human" };
}

function removeValue(existing: unknown, value: string): string[] | undefined {
	const list = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
	const next = list.filter((item) => item !== value);
	return next.length > 0 ? next : undefined;
}

/** Inverse of `withSessionException`, used to expire `once` grants. */
export function withoutSessionException(
	layer: SessionLayer,
	surface: SandboxSurface,
	target: string,
): SessionLayer {
	const next: SessionLayer = {
		...layer,
		filesystem: { ...(layer.filesystem ?? {}) },
		network: { ...(layer.network ?? {}) },
	};
	if (surface === "write" || surface === "read") {
		const key = surface === "write" ? "allowWrite" : "allowRead";
		const remaining = removeValue(next.filesystem?.[key], target);
		if (remaining) next.filesystem = { ...next.filesystem, [key]: remaining };
		else if (next.filesystem) delete next.filesystem[key];
		return next;
	}
	if (surface === "network") {
		const remaining = removeValue(next.network?.allowedDomains, target);
		if (remaining) next.network = { ...next.network, allowedDomains: remaining };
		else if (next.network) delete next.network.allowedDomains;
		return next;
	}
	const remaining = removeValue(layer.excludedCommands, target);
	if (remaining) next.excludedCommands = remaining;
	else delete next.excludedCommands;
	return next;
}

/** Whether the session layer already grants this surface/target. */
export function hasSessionException(layer: SessionLayer, surface: SandboxSurface, target: string): boolean {
	if (surface === "write" || surface === "read") {
		const key = surface === "write" ? "allowWrite" : "allowRead";
		const list = layer.filesystem?.[key];
		return Array.isArray(list) && list.includes(target);
	}
	if (surface === "network") {
		const list = layer.network?.allowedDomains;
		return Array.isArray(list) && list.includes(target);
	}
	return Array.isArray(layer.excludedCommands) && layer.excludedCommands.includes(target);
}
