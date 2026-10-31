import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	snapshotRequiredChildExtensions,
	type RequiredChildExtension,
	type RequiredChildExtensionSnapshot,
} from "../../shared/required-child-extensions.ts";

/**
 * Trusted authority provider published once per process by pi-sbx.
 *
 * pi-subagents only reads and validates this slot: it owns no permission store, derives no policy and cannot
 * mint authority. A prepared lease transports the provider's decisions; it never grants authority of its own.
 *
 * Boundary: the provider is host code injected into a host-only API. Validating it here protects the transport
 * from a malformed service, not the process from arbitrary privileged code that already runs beside it.
 */
export const CHILD_AUTHORITY_PROVIDER_KEY = Symbol.for("pi-sbx.session-authority.v1");
export const CHILD_AUTHORITY_PROVIDER_VERSION = 2;
/**
 * Process-wide `AsyncLocalStorage` slot for code-only child consumption. It lives on `globalThis` under a
 * `Symbol.for` key so a bundled copy and a compiled copy of this module share one storage instead of each
 * holding its own empty one.
 */
export const CHILD_AUTHORITY_LEASE_SLOT_KEY = Symbol.for("pi-subagents.child-authority-lease.v1");
export const CHILD_AUTHORITY_LEASE_SLOT_VERSION = 1;
/** Same process-lifetime intent key used by the native runner. Presence, even
 * malformed/undefined, must never let a consumer fall back to root startup. */
export const CHILD_AUTHORITY_RUNNER_LATCH_KEY = Symbol.for("pi-subagents.child-authority-runner.v1");

export const CHILD_AUTHORITY_MAX_PAYLOAD_BYTES = 32 * 1024;
export const CHILD_AUTHORITY_MAX_PAYLOAD_DEPTH = 6;
export const CHILD_AUTHORITY_MAX_PAYLOAD_KEYS = 128;
export const CHILD_AUTHORITY_MAX_PAYLOAD_ITEMS = 256;
export const CHILD_AUTHORITY_MAX_PAYLOAD_STRING_BYTES = 8 * 1024;
export const CHILD_AUTHORITY_MAX_ACTION_TARGET_BYTES = 2048;
export const CHILD_AUTHORITY_MAX_ACTION_REASON_BYTES = 512;
/** Exact Guardian tool JSON has a separate budget; policy/path/hostname bounds do not expand. */
export const CHILD_AUTHORITY_MAX_TOOL_ACTION_CHARS = 64_000;
export const CHILD_AUTHORITY_MAX_TOOL_ACTION_BYTES = 256 * 1024;
export const CHILD_AUTHORITY_MAX_RATIONALE_BYTES = 512;
export const CHILD_AUTHORITY_MAX_CONSUMERS = 32;
export const CHILD_AUTHORITY_MAX_ID_BYTES = 128;
export const CHILD_AUTHORITY_MAX_CWD_BYTES = 4096;
export const CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS = 16;
/** Total request ids one lease accepts. Ids are never forgotten while the lease holds authority. */
export const CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS = 256;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const SURFACES: ReadonlySet<string> = new Set(["read", "write", "network", "command", "tool"]);
/** Terminal outcomes only: a deferred ask stays with the parent's reviewer/human completion. */
const OUTCOMES: ReadonlySet<string> = new Set(["allow", "deny", "unavailable", "cancelled"]);

export type ChildAuthorityErrorCode =
	| "service-missing"
	| "service-malformed"
	| "version-mismatch"
	| "session-mismatch"
	| "invalid-identity"
	| "invalid-action"
	| "invalid-decision"
	| "invalid-payload"
	| "invalid-lease"
	| "not-ready"
	| "disposed"
	| "already-prepared"
	| "cancelled"
	| "timeout"
	| "transport-unavailable";

/** Fail-closed authority fault. `code` is the stable reportable reason; the message is for humans. */
export class ChildAuthorityError extends Error {
	readonly code: ChildAuthorityErrorCode;

	constructor(code: ChildAuthorityErrorCode, message: string) {
		super(message);
		this.name = "ChildAuthorityError";
		this.code = code;
	}
}

export type ChildAuthoritySurface = "read" | "write" | "network" | "command" | "tool";

/** Child-declared part of the audience: only these fields may come from the child process. */
export interface ChildAuthorityPrepareIdentity {
	readonly agent: string;
	readonly index: number;
	readonly cwd: string;
}

/** Host-bound audience. The parent session/run ids are fixed by the host, never by the child. */
export interface ChildAuthorityIdentity extends ChildAuthorityPrepareIdentity {
	readonly parentSessionId: string;
	readonly runId: string;
}

export interface ChildAuthorityAction {
	readonly surface: ChildAuthoritySurface;
	readonly target: string;
	readonly reason: string;
}

export type ChildAuthorityOutcome = "allow" | "deny" | "unavailable" | "cancelled";

/** Why the child gave up on one request: the parent must abort the matching review work. */
export type ChildAuthorityCancelReason = "cancelled" | "timeout" | "disposed";

const CANCEL_REASONS: ReadonlySet<string> = new Set(["cancelled", "timeout", "disposed"]);

export interface ChildAuthorityDecision {
	readonly outcome: ChildAuthorityOutcome;
	readonly rationale?: string;
	/** Parent-owned tool-batch circuit-breaker evidence; never inferred from prose. */
	readonly terminate?: boolean;
}

export type ChildAuthorityJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ChildAuthorityJsonValue[]
	| { readonly [key: string]: ChildAuthorityJsonValue };

export interface ChildAuthorityPayload {
	readonly [key: string]: ChildAuthorityJsonValue;
}

/**
 * The mirrored `pi-sbx.session-authority.v1` provider. pi-sbx implements and owns it; pi-subagents reads it
 * and binds one prepared lease to one host-created IPC channel.
 */
export interface ChildAuthorityProvider {
	readonly version: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
	readonly sessionId: string;
	readonly requiredExtensions: readonly RequiredChildExtension[];
	prepare(identity: ChildAuthorityIdentity, signal: AbortSignal): Promise<ChildAuthorityProviderLease>;
}

/** One prepared policy lease owned by the provider. Disposing it revokes the child's authority. */
export interface ChildAuthorityProviderLease {
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
	readonly signal?: AbortSignal;
	decide(action: ChildAuthorityAction, signal: AbortSignal): Promise<ChildAuthorityDecision>;
	dispose(): void;
}

/** Opaque, in-memory child-side lease. It is not serializable and cannot be rebuilt from a retained artifact. */
export interface ChildAuthorityLease {
	readonly version: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
	/** Aborted when the lease is disposed: parent disposal, provider cancellation, or channel loss. */
	readonly signal: AbortSignal;
	/**
	 * Ask the live parent to decide one action. Refused as `unavailable` until every required consumer has
	 * claimed and acknowledged this lease. A caller abort, the request bound, or disposal resolves `cancelled`
	 * (or `unavailable` for the bound) and tells the parent to stop reviewing. Never resolves `allow` without
	 * an actual parent decision.
	 */
	request(action: ChildAuthorityAction, signal?: AbortSignal): Promise<ChildAuthorityDecision>;
	acknowledge(consumerId: string): void;
	assertReady(): void;
	dispose(): void;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	let truncated = "";
	let used = 0;
	for (const character of value) {
		const size = byteLength(character);
		if (used + size > maxBytes) break;
		truncated += character;
		used += size;
	}
	return truncated;
}

function requireId(value: unknown, label: string): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) {
		throw new ChildAuthorityError("invalid-identity", `${label} requires 1-${CHILD_AUTHORITY_MAX_ID_BYTES} characters matching [A-Za-z0-9][A-Za-z0-9._:@+-]*.`);
	}
	return value;
}

function requireCwd(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0") || !path.isAbsolute(value) || byteLength(value) > CHILD_AUTHORITY_MAX_CWD_BYTES) {
		throw new ChildAuthorityError("invalid-identity", `${label} requires an absolute path of at most ${CHILD_AUTHORITY_MAX_CWD_BYTES} bytes without NUL or surrounding whitespace.`);
	}
	return value;
}

function requireKeys(value: object, allowed: readonly string[], label: string, code: ChildAuthorityErrorCode): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		throw new ChildAuthorityError(code, `${label} has unsupported fields: ${unexpected.join(", ")}. Identity and cwd come from the host-bound lease, never from the caller.`);
	}
}

function normalizeCwd(value: string): string {
	const normalized = path.normalize(value);
	// `path.normalize` keeps a trailing separator, so one spelling of the same directory must not fail a claim.
	return normalized.length > 1 && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

/** Validate the child-declared identity fields. Parent session/run ids in the input are rejected. */
export function parseChildAuthorityPrepareIdentity(value: unknown): ChildAuthorityPrepareIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChildAuthorityError("invalid-identity", "Child authority identity requires an object with agent, index, and cwd.");
	requireKeys(value, ["agent", "index", "cwd"], "Child authority identity", "invalid-identity");
	const record: { agent?: unknown; index?: unknown; cwd?: unknown } = value;
	const index = record.index;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 4096) {
		throw new ChildAuthorityError("invalid-identity", "Child authority identity index must be an integer between 0 and 4096.");
	}
	return Object.freeze({ agent: requireId(record.agent, "Child authority identity agent"), index, cwd: requireCwd(record.cwd, "Child authority identity cwd") });
}

/** Validate the host-fixed parent session/run audience. Uncatalogued or malformed ids fail closed. */
export function parseChildAuthorityAudience(trusted: { parentSessionId: unknown; runId: unknown }): { parentSessionId: string; runId: string } {
	return Object.freeze({
		parentSessionId: requireId(trusted.parentSessionId, "Child authority parent session id"),
		runId: requireId(trusted.runId, "Child authority run id"),
	});
}

/** Bind host-fixed parent session/run ids to the child-declared identity. */
export function bindChildAuthorityIdentity(trusted: { parentSessionId: unknown; runId: unknown }, child: unknown): ChildAuthorityIdentity {
	const audience = parseChildAuthorityAudience(trusted);
	const parsed = parseChildAuthorityPrepareIdentity(child);
	return Object.freeze({ parentSessionId: audience.parentSessionId, runId: audience.runId, agent: parsed.agent, index: parsed.index, cwd: parsed.cwd });
}

/** Validate a fully bound identity, as carried by a lease grant. */
export function parseBoundChildAuthorityIdentity(value: unknown): ChildAuthorityIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChildAuthorityError("invalid-identity", "Bound child authority identity requires an object.");
	requireKeys(value, ["parentSessionId", "runId", "agent", "index", "cwd"], "Bound child authority identity", "invalid-identity");
	const record = value as { parentSessionId?: unknown; runId?: unknown; agent?: unknown; index?: unknown; cwd?: unknown };
	return bindChildAuthorityIdentity({ parentSessionId: record.parentSessionId, runId: record.runId }, { agent: record.agent, index: record.index, cwd: record.cwd });
}

/** Validate one action request. Only surface, target and reason are accepted. */
export function parseChildAuthorityAction(value: unknown): ChildAuthorityAction {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChildAuthorityError("invalid-action", "Child authority action requires an object with surface, target, and reason.");
	requireKeys(value, ["surface", "target", "reason"], "Child authority action", "invalid-action");
	const record = value as { surface?: unknown; target?: unknown; reason?: unknown };
	const surface = record.surface;
	if (typeof surface !== "string" || !SURFACES.has(surface)) throw new ChildAuthorityError("invalid-action", "Child authority action surface must be read, write, network, command, or tool.");
	const target = requireActionText(record.target, "Child authority action target", surface === "tool" ? CHILD_AUTHORITY_MAX_TOOL_ACTION_BYTES : CHILD_AUTHORITY_MAX_ACTION_TARGET_BYTES);
	if (surface === "tool" && target.length > CHILD_AUTHORITY_MAX_TOOL_ACTION_CHARS) throw new ChildAuthorityError("invalid-action", `Exact tool actions must be at most ${CHILD_AUTHORITY_MAX_TOOL_ACTION_CHARS} characters; nothing was truncated.`);
	return Object.freeze({
		surface: surface as ChildAuthoritySurface,
		target,
		reason: requireActionText(record.reason, "Child authority action reason", CHILD_AUTHORITY_MAX_ACTION_REASON_BYTES),
	});
}

function requireActionText(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ChildAuthorityError("invalid-action", `${label} requires a non-empty string without NUL.`);
	if (byteLength(value) > maxBytes) throw new ChildAuthorityError("invalid-action", `${label} must be at most ${maxBytes} bytes.`);
	return value;
}

/** Validate a correlating request id. Ids are bounded and must be safe to echo into logs. */
export function parseChildAuthorityRequestId(value: unknown): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) {
		throw new ChildAuthorityError("invalid-lease", `A child authority request id requires 1-${CHILD_AUTHORITY_MAX_ID_BYTES} characters matching [A-Za-z0-9][A-Za-z0-9._:@+-]*.`);
	}
	return value;
}

/** Validate the reason a child reports for abandoning one request. */
export function parseChildAuthorityCancelReason(value: unknown): ChildAuthorityCancelReason {
	if (typeof value !== "string" || !CANCEL_REASONS.has(value)) throw new ChildAuthorityError("invalid-lease", "A child authority cancel reason must be exactly cancelled, timeout, or disposed.");
	return value as ChildAuthorityCancelReason;
}

/**
 * Await one host operation without letting it outlive the caller's bound. An abort-ignoring provider therefore
 * cannot hang the launch path, and the abort reason is preserved so a timeout stays distinguishable.
 */
export function awaitWithinBound<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortFault(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortFault(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortFault(signal: AbortSignal): ChildAuthorityError {
	const reason: unknown = signal.reason;
	if (reason instanceof ChildAuthorityError) return reason;
	return new ChildAuthorityError("cancelled", "Child authority work was cancelled before it finished.");
}

/**
 * Validate one typed decision. Free-form text is never a decision: an outcome outside
 * allow|deny|unavailable|cancelled is refused, and an over-long rationale is truncated to the bound.
 */
export function parseChildAuthorityDecision(value: unknown): ChildAuthorityDecision {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChildAuthorityError("invalid-decision", "Child authority decision requires an object with a typed outcome.");
	requireKeys(value, ["outcome", "rationale", "terminate"], "Child authority decision", "invalid-decision");
	const record = value as { outcome?: unknown; rationale?: unknown; terminate?: unknown };
	const outcome = record.outcome;
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
		throw new ChildAuthorityError("invalid-decision", "Child authority decision outcome must be exactly allow, deny, unavailable, or cancelled.");
	}
	const typed = outcome as ChildAuthorityOutcome;
	if (record.terminate !== undefined && typeof record.terminate !== "boolean") throw new ChildAuthorityError("invalid-decision", "Child authority termination must be a boolean.");
	if (typed === "allow" && record.terminate === true) throw new ChildAuthorityError("invalid-decision", "An allow cannot terminate a tool batch.");
	const termination = record.terminate === true ? { terminate: true } : {};
	if (record.rationale === undefined) return Object.freeze({ outcome: typed, ...termination });
	if (typeof record.rationale !== "string" || record.rationale.includes("\0")) throw new ChildAuthorityError("invalid-decision", "Child authority decision rationale must be a string without NUL.");
	const rationale = truncateUtf8(record.rationale, CHILD_AUTHORITY_MAX_RATIONALE_BYTES).trim();
	return Object.freeze(rationale ? { outcome: typed, rationale, ...termination } : { outcome: typed, ...termination });
}

function assertJsonPayloadValue(value: unknown, depth: number): void {
	if (value === null) return;
	if (typeof value === "string") {
		if (value.includes("\0")) throw new ChildAuthorityError("invalid-payload", "Child authority payload strings must not contain NUL.");
		if (byteLength(value) > CHILD_AUTHORITY_MAX_PAYLOAD_STRING_BYTES) throw new ChildAuthorityError("invalid-payload", `Child authority payload strings must be at most ${CHILD_AUTHORITY_MAX_PAYLOAD_STRING_BYTES} bytes.`);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new ChildAuthorityError("invalid-payload", "Child authority payload numbers must be finite.");
		return;
	}
	if (typeof value === "boolean") return;
	if (typeof value !== "object") throw new ChildAuthorityError("invalid-payload", "Child authority payload accepts only JSON values.");
	if (depth >= CHILD_AUTHORITY_MAX_PAYLOAD_DEPTH) throw new ChildAuthorityError("invalid-payload", `Child authority payload must nest at most ${CHILD_AUTHORITY_MAX_PAYLOAD_DEPTH} levels.`);
	if (Array.isArray(value)) {
		if (value.length > CHILD_AUTHORITY_MAX_PAYLOAD_ITEMS) throw new ChildAuthorityError("invalid-payload", `Child authority payload arrays hold at most ${CHILD_AUTHORITY_MAX_PAYLOAD_ITEMS} items.`);
		for (const item of value) assertJsonPayloadValue(item, depth + 1);
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new ChildAuthorityError("invalid-payload", "Child authority payload accepts only plain JSON objects.");
	const entries = Object.entries(value);
	if (entries.length > CHILD_AUTHORITY_MAX_PAYLOAD_KEYS) throw new ChildAuthorityError("invalid-payload", `Child authority payload objects hold at most ${CHILD_AUTHORITY_MAX_PAYLOAD_KEYS} keys.`);
	for (const [key, item] of entries) {
		if (!key || key.includes("\0") || byteLength(key) > CHILD_AUTHORITY_MAX_ID_BYTES) throw new ChildAuthorityError("invalid-payload", `Child authority payload keys must be 1-${CHILD_AUTHORITY_MAX_ID_BYTES} bytes without NUL.`);
		assertJsonPayloadValue(item, depth + 1);
	}
}

function deepFreezeJson<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) deepFreezeJson(item);
		Object.freeze(value);
	}
	return value;
}

/** Validate a bounded JSON object payload and return an immutable deep copy. */
export function parseChildAuthorityPayload(value: unknown): ChildAuthorityPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChildAuthorityError("invalid-payload", "Child authority payload requires a JSON object.");
	assertJsonPayloadValue(value, 0);
	const serialized = JSON.stringify(value);
	if (byteLength(serialized) > CHILD_AUTHORITY_MAX_PAYLOAD_BYTES) throw new ChildAuthorityError("invalid-payload", `Child authority payload must be at most ${CHILD_AUTHORITY_MAX_PAYLOAD_BYTES} bytes.`);
	// Re-parsing an already validated JSON object yields a detached plain copy of that same value.
	return deepFreezeJson(JSON.parse(serialized) as ChildAuthorityPayload);
}

/**
 * Validate required consumer ids. When the host knows which extensions it loads, a consumer outside that set is
 * refused: it could never claim, so the lease could never become ready.
 */
export function parseChildAuthorityConsumers(value: unknown, requiredExtensionIds?: readonly string[]): readonly string[] {
	if (!Array.isArray(value) || value.length > CHILD_AUTHORITY_MAX_CONSUMERS) throw new ChildAuthorityError("invalid-lease", `Child authority required consumers must be an array of at most ${CHILD_AUTHORITY_MAX_CONSUMERS} ids.`);
	const consumers: string[] = [];
	for (const entry of value) {
		const id = requireId(entry, "Child authority required consumer");
		if (consumers.includes(id)) throw new ChildAuthorityError("invalid-lease", `Child authority required consumer '${id}' is duplicated.`);
		if (requiredExtensionIds && !requiredExtensionIds.includes(id)) {
			throw new ChildAuthorityError("invalid-lease", `Child authority required consumer '${id}' is not one of the required child extensions (${requiredExtensionIds.join(", ") || "none"}).`);
		}
		consumers.push(id);
	}
	return Object.freeze(consumers);
}

function requireProviderLease(value: unknown): ChildAuthorityProviderLease {
	if (!value || typeof value !== "object") throw new ChildAuthorityError("service-malformed", "The child authority provider did not return a lease object.");
	const record = value as { decide?: unknown; dispose?: unknown; signal?: unknown };
	if (typeof record.decide !== "function" || typeof record.dispose !== "function") throw new ChildAuthorityError("service-malformed", "A child authority provider lease requires decide() and dispose().");
	if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) throw new ChildAuthorityError("service-malformed", "A child authority provider lease signal must be an AbortSignal.");
	return value as ChildAuthorityProviderLease;
}

/** Read and validate the trusted provider slot. Absence and version mismatch are explicit faults. */
export function readChildAuthorityProvider(sessionId?: string): ChildAuthorityProvider {
	const slot = (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
	if (slot === undefined) {
		throw new ChildAuthorityError("service-missing", `No child authority service is published at ${String(CHILD_AUTHORITY_PROVIDER_KEY)}; child authority is unavailable.`);
	}
	if (!slot || typeof slot !== "object" || Array.isArray(slot)) throw new ChildAuthorityError("service-malformed", "The published child authority service is not an object.");
	const record = slot as { version?: unknown; sessionId?: unknown; requiredExtensions?: unknown; prepare?: unknown };
	if (record.version !== CHILD_AUTHORITY_PROVIDER_VERSION) {
		throw new ChildAuthorityError("version-mismatch", `Child authority service version ${String(record.version)} is unsupported; this package requires version ${CHILD_AUTHORITY_PROVIDER_VERSION}.`);
	}
	const providerSessionId = record.sessionId;
	if (typeof providerSessionId !== "string" || !providerSessionId || providerSessionId.includes("\0") || byteLength(providerSessionId) > 256) {
		throw new ChildAuthorityError("service-malformed", "The published child authority service requires a non-empty sessionId of at most 256 bytes without NUL.");
	}
	if (sessionId !== undefined && providerSessionId !== sessionId) {
		throw new ChildAuthorityError("session-mismatch", `Child authority service belongs to session '${providerSessionId}', not '${sessionId}'.`);
	}
	if (typeof record.prepare !== "function") throw new ChildAuthorityError("service-malformed", "The published child authority service requires prepare().");
	let requiredExtensions: RequiredChildExtensionSnapshot;
	try {
		requiredExtensions = snapshotRequiredChildExtensions(record.requiredExtensions, "Child authority required extensions");
	} catch (error) {
		throw new ChildAuthorityError("service-malformed", error instanceof Error ? error.message : String(error));
	}
	const provider = slot as ChildAuthorityProvider;
	return Object.freeze({
		version: CHILD_AUTHORITY_PROVIDER_VERSION,
		sessionId: providerSessionId,
		requiredExtensions,
		prepare: (identity: ChildAuthorityIdentity, signal: AbortSignal) => provider.prepare(identity, signal),
	});
}

export interface ChildAuthorityServicePrepareOptions {
	readonly provider: ChildAuthorityProvider;
	readonly requiredExtensions: RequiredChildExtensionSnapshot;
	readonly identity: ChildAuthorityIdentity;
	readonly signal: AbortSignal;
}

/**
 * Ask the trusted provider for one bounded, validated policy lease. Nothing is derived here: a payload the
 * provider does not supply fails instead of being inferred from configuration, environment, or files.
 *
 * The provider promise is raced against `signal`, so a provider that ignores its signal cannot hang the caller.
 * A lease that arrives after the caller gave up is disposed instead of leaking provider authority, and every
 * validation failure disposes the returned lease exactly once.
 */
export async function prepareChildAuthorityServiceLease(options: ChildAuthorityServicePrepareOptions): Promise<ChildAuthorityProviderLease> {
	const { provider, requiredExtensions, identity, signal } = options;
	if (!provider || typeof provider !== "object") throw new ChildAuthorityError("service-missing", "Preparing child authority requires a published provider.");
	if (provider.version !== CHILD_AUTHORITY_PROVIDER_VERSION) {
		throw new ChildAuthorityError("version-mismatch", `Child authority service version ${String(provider.version)} is unsupported; this package requires version ${CHILD_AUTHORITY_PROVIDER_VERSION}.`);
	}
	if (typeof provider.prepare !== "function") throw new ChildAuthorityError("service-malformed", "The published child authority service requires prepare().");
	if (signal.aborted) throw abortFault(signal);
	// A synchronous provider throw becomes a rejection here, so callers never see a half-prepared service.
	const providerPromise = Promise.resolve().then(() => provider.prepare(identity, signal));
	let prepared: unknown;
	try {
		prepared = await awaitWithinBound(providerPromise, signal);
	} catch (error) {
		void providerPromise.then((late) => disposeLateServiceLease(late), () => {});
		if (error instanceof ChildAuthorityError) throw error;
		throw new ChildAuthorityError("service-malformed", `Child authority service failed to prepare a lease: ${truncateUtf8(error instanceof Error ? error.message : String(error), 200)}`);
	}
	let lease: ChildAuthorityProviderLease;
	try {
		lease = requireProviderLease(prepared);
	} catch (error) {
		disposeLateServiceLease(prepared);
		throw error;
	}
	if (signal.aborted || lease.signal?.aborted) {
		disposeQuietly(lease);
		throw signal.aborted ? abortFault(signal) : new ChildAuthorityError("cancelled", "Child authority preparation was cancelled by the service.");
	}
	let payload: ChildAuthorityPayload;
	let requiredConsumers: readonly string[];
	try {
		const extensionIds = requiredExtensions.map((extension) => extension.id);
		payload = parseChildAuthorityPayload(lease.payload);
		requiredConsumers = parseChildAuthorityConsumers(lease.requiredConsumers, extensionIds);
	} catch (error) {
		// An unusable service lease is still a live provider resource: release it exactly once before failing.
		disposeQuietly(lease);
		throw error;
	}
	if (signal.aborted) {
		disposeQuietly(lease);
		throw abortFault(signal);
	}
	let serviceDisposed = false;
	return Object.freeze({
		payload,
		requiredConsumers,
		signal: lease.signal,
		// The prepared service is always promise-shaped: a synchronous provider throw cannot reach the IPC listener.
		decide: async (action: ChildAuthorityAction, decisionSignal: AbortSignal) => lease.decide(action, decisionSignal),
		dispose: () => {
			if (serviceDisposed) return;
			serviceDisposed = true;
			disposeQuietly(lease);
		},
	});
}

function disposeLateServiceLease(value: unknown): void {
	// The provider may hand back a lease after the caller's bound expired; release it instead of retaining it.
	if (!value || typeof value !== "object") return;
	const record = value as { dispose?: unknown };
	if (typeof record.dispose !== "function") return;
	disposeQuietly(value as ChildAuthorityProviderLease);
}

function disposeQuietly(lease: ChildAuthorityProviderLease): void {
	try {
		lease.dispose();
	} catch {
		// A failing service dispose must not mask the fault that triggered it.
	}
}

interface ChildAuthorityLeaseSlot {
	version: typeof CHILD_AUTHORITY_LEASE_SLOT_VERSION;
	storage: AsyncLocalStorage<ChildAuthorityLease>;
}

function isLeaseSlot(value: unknown): value is ChildAuthorityLeaseSlot {
	if (!value || typeof value !== "object") return false;
	const record = value as { version?: unknown; storage?: unknown };
	return record.version === CHILD_AUTHORITY_LEASE_SLOT_VERSION && record.storage instanceof AsyncLocalStorage;
}

function leaseSlot(): ChildAuthorityLeaseSlot {
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[CHILD_AUTHORITY_LEASE_SLOT_KEY];
	if (existing === undefined) {
		const created: ChildAuthorityLeaseSlot = { version: CHILD_AUTHORITY_LEASE_SLOT_VERSION, storage: new AsyncLocalStorage() };
		root[CHILD_AUTHORITY_LEASE_SLOT_KEY] = created;
		return created;
	}
	if (!isLeaseSlot(existing)) throw new ChildAuthorityError("service-malformed", "The process-wide child authority lease slot is malformed or unsupported.");
	return existing;
}

/** A consumer's root/child dispatch check, not an authority grant. Do not create
 * a registry as a side effect of ordinary root startup. An inactive valid ALS
 * is root context; a latched runner is ALWAYS child, including after scope exit,
 * revocation, disposal, or malformed/undefined latch state. A corrupt registry
 * refuses instead of pretending there was no child context. */
export function hasChildAuthorityContext(): boolean {
	const root = globalThis as Record<PropertyKey, unknown>;
	if (CHILD_AUTHORITY_RUNNER_LATCH_KEY in root) return true;
	if (!(CHILD_AUTHORITY_LEASE_SLOT_KEY in root)) return false;
	const slot = root[CHILD_AUTHORITY_LEASE_SLOT_KEY];
	if (!isLeaseSlot(slot)) throw new ChildAuthorityError("service-malformed", "Cannot establish root context: the process-wide child authority lease slot is malformed or unsupported.");
	return slot.storage.getStore() !== undefined;
}

/**
 * The lease object itself is created by `createChildAuthorityLease`; `claim` is the one method only host code
 * may reach, so it is looked up structurally instead of widening the public lease type.
 */
function requireClaim(lease: ChildAuthorityLease): (consumerId: string, cwd: string) => void {
	if (!lease || typeof lease !== "object") throw new ChildAuthorityError("invalid-lease", "Child authority consumption requires a live lease created by this package.");
	const claim = (lease as { claim?: unknown }).claim;
	if (typeof claim !== "function") throw new ChildAuthorityError("invalid-lease", "Child authority consumption requires a live lease created by this package.");
	return claim.bind(lease) as (consumerId: string, cwd: string) => void;
}

/**
 * Run host code inside the child lease scope. This is the only way the live lease becomes reachable to child
 * extension code: an artifact, environment variable, or model message can never enter this scope.
 */
export function withChildAuthority<T>(lease: ChildAuthorityLease, callback: () => T): T {
	requireClaim(lease);
	return leaseSlot().storage.run(lease, callback);
}

/**
 * Called by a required child extension while it is loaded inside `withChildAuthority`.
 *
 * Returns the live lease so the consumer can capture it for its own tool callbacks; the object is still only
 * reachable from code that already runs inside the host load scope.
 */
export function claimChildAuthority(consumerId: string, cwd: string): ChildAuthorityLease {
	const lease = leaseSlot().storage.getStore();
	if (!lease) throw new ChildAuthorityError("invalid-lease", "claimChildAuthority requires an active withChildAuthority() scope around the child extension load.");
	requireClaim(lease)(consumerId, cwd);
	return lease;
}

/** Called by a required child extension once it has installed its adapters for this lease. */
export function acknowledgeChildAuthority(consumerId: string): void {
	const lease = leaseSlot().storage.getStore();
	if (!lease) throw new ChildAuthorityError("invalid-lease", "acknowledgeChildAuthority requires an active withChildAuthority() scope around the child extension load.");
	lease.acknowledge(consumerId);
}

interface ClaimRecord {
	cwd: string;
	acknowledged: boolean;
}

interface PendingRequest {
	complete(decision: ChildAuthorityDecision): void;
	/** Give up locally and tell the parent to abort the matching review work. */
	abandon(reason: ChildAuthorityCancelReason): void;
}

function typedDecision(outcome: ChildAuthorityOutcome, rationale?: string): ChildAuthorityDecision {
	return rationale === undefined ? Object.freeze({ outcome }) : parseChildAuthorityDecision({ outcome, rationale });
}

export interface ChildAuthorityLeaseOptions {
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
	/** Deliver one request to the parent. Return false when the channel cannot carry it. */
	send(requestId: string, action: ChildAuthorityAction): boolean;
	/** Tell the parent that one request will never be decided, so its review work is aborted. */
	cancel(requestId: string, reason: ChildAuthorityCancelReason): void;
	readonly requestTimeoutMs: number;
}

export interface ChildAuthorityLeaseHandle {
	readonly lease: ChildAuthorityLease;
	/** Resolve one correlated parent decision. Unknown, duplicate, and late ids are ignored. */
	deliverDecision(requestId: string, value: unknown): "delivered" | "ignored";
}

class LiveChildAuthorityLease implements ChildAuthorityLease {
	readonly version = CHILD_AUTHORITY_PROVIDER_VERSION;
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
	readonly signal: AbortSignal;
	private readonly send: ChildAuthorityLeaseOptions["send"];
	private readonly cancel: ChildAuthorityLeaseOptions["cancel"];
	private readonly requestTimeoutMs: number;
	private readonly abort = new AbortController();
	private readonly claims = new Map<string, ClaimRecord>();
	private readonly pending = new Map<string, PendingRequest>();
	private disposed = false;

	constructor(options: ChildAuthorityLeaseOptions) {
		this.leaseId = options.leaseId;
		this.identity = options.identity;
		this.payload = options.payload;
		this.requiredConsumers = options.requiredConsumers;
		this.send = options.send;
		this.cancel = options.cancel;
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.signal = this.abort.signal;
	}

	request(action: ChildAuthorityAction, signal?: AbortSignal): Promise<ChildAuthorityDecision> {
		const parsed = parseChildAuthorityAction(action);
		if (this.disposed) return Promise.resolve(typedDecision("cancelled", "The child authority lease is disposed."));
		if (signal?.aborted) return Promise.resolve(typedDecision("cancelled", "The request was cancelled before it was sent."));
		const missing = this.missingConsumers();
		if (missing.length > 0) {
			// Asking before the host's required consumers bound themselves would review work nobody can enforce.
			return Promise.resolve(typedDecision("unavailable", `Child authority is not ready; these required consumers have not claimed and acknowledged it: ${missing.join(", ")}.`));
		}
		if (this.pending.size >= CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS) {
			return Promise.resolve(typedDecision("unavailable", `At most ${CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS} child authority requests may be in flight.`));
		}
		const requestId = randomUUID();
		return new Promise<ChildAuthorityDecision>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const complete = (result: ChildAuthorityDecision): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(requestId);
				resolve(result);
			};
			const abandon = (reason: ChildAuthorityCancelReason): void => {
				if (settled) return;
				this.notifyCancel(requestId, reason);
				complete(reason === "timeout"
					? typedDecision("unavailable", "The parent did not decide the request in time.")
					: typedDecision("cancelled", reason === "disposed" ? "The child authority lease is disposed." : "The request was cancelled."));
			};
			const onAbort = (): void => abandon("cancelled");
			timer = setTimeout(() => abandon("timeout"), this.requestTimeoutMs);
			timer.unref();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(requestId, { complete, abandon });
			let delivered = false;
			try {
				delivered = this.send(requestId, parsed);
			} catch {
				// A transport that throws synchronously must still settle and release the pending entry.
				delivered = false;
			}
			if (!delivered) complete(typedDecision("cancelled", "The parent authority channel is not connected."));
		});
	}

	claim(consumerId: string, cwd: string): void {
		if (this.disposed) throw new ChildAuthorityError("disposed", `Child authority lease '${this.leaseId}' is disposed.`);
		const id = requireId(consumerId, "Child authority consumer");
		if (!this.requiredConsumers.includes(id)) throw new ChildAuthorityError("invalid-lease", `Consumer '${id}' is not required by child authority lease '${this.leaseId}'.`);
		if (this.claims.has(id)) throw new ChildAuthorityError("invalid-lease", `Consumer '${id}' already claimed child authority lease '${this.leaseId}'.`);
		const claimedCwd = requireCwd(cwd, "Child authority claim cwd");
		if (normalizeCwd(claimedCwd) !== normalizeCwd(this.identity.cwd)) {
			throw new ChildAuthorityError("invalid-lease", `Consumer '${id}' claimed cwd '${claimedCwd}' but lease '${this.leaseId}' binds '${this.identity.cwd}'.`);
		}
		this.claims.set(id, { cwd: claimedCwd, acknowledged: false });
	}

	acknowledge(consumerId: string): void {
		if (this.disposed) throw new ChildAuthorityError("disposed", `Child authority lease '${this.leaseId}' is disposed.`);
		const id = requireId(consumerId, "Child authority consumer");
		const claim = this.claims.get(id);
		if (!claim) throw new ChildAuthorityError("not-ready", `Consumer '${id}' must claim child authority lease '${this.leaseId}' before acknowledging it.`);
		claim.acknowledged = true;
	}

	assertReady(): void {
		if (this.disposed) throw new ChildAuthorityError("disposed", `Child authority lease '${this.leaseId}' is disposed.`);
		const missing = this.missingConsumers();
		if (missing.length > 0) {
			throw new ChildAuthorityError("not-ready", `Child authority lease '${this.leaseId}' is not ready; these required consumers have not claimed and acknowledged it: ${missing.join(", ")}.`);
		}
	}

	deliverDecision(requestId: string, value: unknown): "delivered" | "ignored" {
		const request = this.pending.get(requestId);
		if (!request || this.disposed) return "ignored";
		let result: ChildAuthorityDecision;
		try {
			result = parseChildAuthorityDecision(value);
		} catch {
			result = typedDecision("unavailable", "The parent authority service sent a malformed decision.");
		}
		request.complete(result);
		return "delivered";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort(new ChildAuthorityError("disposed", "The child authority lease is disposed."));
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) request.abandon("disposed");
	}

	private missingConsumers(): string[] {
		return this.requiredConsumers.filter((id) => this.claims.get(id)?.acknowledged !== true);
	}

	private notifyCancel(requestId: string, reason: ChildAuthorityCancelReason): void {
		try {
			this.cancel(requestId, reason);
		} catch {
			// A lost cancel notice only leaves parent review work to its own bound; the child already gave up.
		}
	}
}

/** Create the child-side lease plus its delivery seam. The transport owns the wire; this owns the contract. */
export function createChildAuthorityLease(options: ChildAuthorityLeaseOptions): ChildAuthorityLeaseHandle {
	const requiredConsumers = parseChildAuthorityConsumers(options.requiredConsumers);
	if (typeof options.send !== "function") throw new ChildAuthorityError("invalid-lease", "A child authority lease requires a send() transport.");
	if (typeof options.cancel !== "function") throw new ChildAuthorityError("invalid-lease", "A child authority lease requires a cancel() transport.");
	if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) throw new ChildAuthorityError("invalid-lease", "A child authority lease requestTimeoutMs must be a positive integer.");
	const lease = new LiveChildAuthorityLease({
		leaseId: requireId(options.leaseId, "Child authority lease id"),
		identity: parseBoundChildAuthorityIdentity(options.identity),
		payload: parseChildAuthorityPayload(options.payload),
		requiredConsumers,
		send: options.send,
		cancel: options.cancel,
		requestTimeoutMs: options.requestTimeoutMs,
	});
	return {
		lease,
		deliverDecision: (requestId, value) => {
			if (typeof requestId !== "string" || !requestId) return "ignored";
			try {
				parseChildAuthorityRequestId(requestId);
			} catch {
				return "ignored";
			}
			return lease.deliverDecision(requestId, value);
		},
	};
}
