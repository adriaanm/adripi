import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	type RequiredChildExtensionSnapshot,
	snapshotRequiredChildExtensions,
} from "../../shared/required-child-extensions.ts";
import {
	CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS,
	CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS,
	ChildAuthorityError,
	awaitWithinBound,
	bindChildAuthorityIdentity,
	createChildAuthorityLease,
	parseBoundChildAuthorityIdentity,
	parseChildAuthorityAction,
	parseChildAuthorityAudience,
	parseChildAuthorityCancelReason,
	parseChildAuthorityConsumers,
	parseChildAuthorityDecision,
	parseChildAuthorityPayload,
	parseChildAuthorityRequestId,
	prepareChildAuthorityServiceLease,
	type ChildAuthorityAction,
	type ChildAuthorityCancelReason,
	type ChildAuthorityDecision,
	type ChildAuthorityIdentity,
	type ChildAuthorityLease,
	type ChildAuthorityLeaseHandle,
	type ChildAuthorityPayload,
	type ChildAuthorityPrepareIdentity,
	type ChildAuthorityProvider,
	type ChildAuthorityProviderLease,
} from "./child-authority.ts";

export const CHILD_AUTHORITY_ENVELOPE_VERSION = 1;
/**
 * Parent review bound. It hosts one real reviewer + human decision: a shorter bound would turn an interactive
 * approval into `unavailable`.
 */
export const CHILD_AUTHORITY_DEFAULT_DECISION_TIMEOUT_MS = 600_000;
/** The child's bound must outlast the parent's, so the parent's typed timeout wins instead of a race. */
export const CHILD_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS = 605_000;
export const CHILD_AUTHORITY_DEFAULT_PREPARE_TIMEOUT_MS = 30_000;
/**
 * Starts at the child's first awaitLease(), not the parent's prepare(). Launch wiring must reach prepare
 * promptly after spawn, or explicitly pass leaseTimeoutMs > time-to-prepare + prepareTimeoutMs.
 * This default provides only 5s of startup/delivery slack; it is not a common-clock guarantee.
 */
export const CHILD_AUTHORITY_DEFAULT_LEASE_TIMEOUT_MS = 35_000;

const LEASE_KIND = "child-authority:lease";
const REQUEST_KIND = "child-authority:request";
const DECISION_KIND = "child-authority:decision";
const CANCEL_KIND = "child-authority:cancel";
const REVOKE_KIND = "child-authority:revoke";
const WIRE_KINDS: ReadonlySet<string> = new Set([LEASE_KIND, REQUEST_KIND, DECISION_KIND, CANCEL_KIND, REVOKE_KIND]);

/** Parent-to-child grant. It arrives only on the host-created IPC channel of the spawned runner. */
export interface ChildAuthorityLeaseGrant {
	readonly kind: typeof LEASE_KIND;
	readonly version: typeof CHILD_AUTHORITY_ENVELOPE_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
}

/** Child-to-parent action request. It carries no identity, no cwd, and no grant. */
export interface ChildAuthorityActionRequest {
	readonly kind: typeof REQUEST_KIND;
	readonly version: typeof CHILD_AUTHORITY_ENVELOPE_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly leaseId: string;
	readonly requestId: string;
	readonly action: ChildAuthorityAction;
}

export interface ChildAuthorityActionDecision {
	readonly kind: typeof DECISION_KIND;
	readonly version: typeof CHILD_AUTHORITY_ENVELOPE_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly leaseId: string;
	readonly requestId: string;
	readonly decision: ChildAuthorityDecision;
}

/** Child-to-parent release of one request: the parent aborts and disposes the matching review work. */
export interface ChildAuthorityCancelMessage {
	readonly kind: typeof CANCEL_KIND;
	readonly version: typeof CHILD_AUTHORITY_ENVELOPE_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly leaseId: string;
	readonly requestId: string;
	readonly reason: ChildAuthorityCancelReason;
}

export interface ChildAuthorityLeaseRevoke {
	readonly kind: typeof REVOKE_KIND;
	readonly version: typeof CHILD_AUTHORITY_ENVELOPE_VERSION;
	readonly sessionId: string;
	readonly runId: string;
	readonly leaseId: string;
}

export type ChildAuthorityWireMessage =
	| ChildAuthorityLeaseGrant
	| ChildAuthorityActionRequest
	| ChildAuthorityActionDecision
	| ChildAuthorityCancelMessage
	| ChildAuthorityLeaseRevoke;

function envelopeRecord(value: unknown): { kind: unknown; version: unknown } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as { kind?: unknown; version?: unknown };
	return { kind: record.kind, version: record.version };
}

function failDecision(outcome: "deny" | "unavailable" | "cancelled", rationale: string): ChildAuthorityDecision {
	return parseChildAuthorityDecision({ outcome, rationale });
}

function requirePositiveInteger(value: number | undefined, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) throw new ChildAuthorityError("invalid-identity", `${label} must be a positive integer.`);
	return resolved;
}

export interface CreateChildAuthorityControllerInput {
	/**
	 * The actual spawned runner. Authority lives on this handle; nothing else can create a lease.
	 *
	 * The provider is host code injected by the caller: this validates what the service returns, it does not
	 * protect the process from privileged code that already runs in it.
	 */
	readonly child: ChildProcess;
	/** Trusted provider read from `readChildAuthorityProvider()`; the controller never mints policy itself. */
	readonly provider: ChildAuthorityProvider;
	/** Host-fixed parent session id. A child message naming another session is ignored. */
	readonly sessionId: string;
	/** Host-fixed parent run id. A child message naming another run is ignored. */
	readonly runId: string;
	/** Parent review bound per action. Defaults to 600000ms so one reviewer + human decision fits. */
	readonly decisionTimeoutMs?: number;
	/** Preparation bound. Defaults to 30000ms; an abort-ignoring provider cannot exceed it. */
	readonly prepareTimeoutMs?: number;
}

/** What the parent may report about a live lease. It holds no decision logic and no grant. */
export interface ChildAuthorityPreparedLease {
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly payload: ChildAuthorityPayload;
	readonly requiredConsumers: readonly string[];
}

export interface ChildAuthorityController {
	/** One attempt per child process: a second or concurrent call is refused before anything is awaited. */
	prepare(identity: ChildAuthorityPrepareIdentity, signal?: AbortSignal): Promise<ChildAuthorityPreparedLease>;
	dispose(): void;
}

interface PendingActionRequest {
	readonly abort: AbortController;
	/** Set once the child released the request: its decision must never be sent afterwards. */
	abandoned: boolean;
}

type PreparationState = "idle" | "preparing" | "prepared" | "failed";

class IpcChildAuthorityController implements ChildAuthorityController {
	private readonly child: ChildProcess;
	private readonly provider: ChildAuthorityProvider;
	private readonly requiredExtensions: RequiredChildExtensionSnapshot;
	private readonly sessionId: string;
	private readonly runId: string;
	private readonly decisionTimeoutMs: number;
	private readonly prepareTimeoutMs: number;
	private readonly abort = new AbortController();
	private readonly pending = new Map<string, PendingActionRequest>();
	/** Every id this lease accepted. Never evicted: replay stays refused for the whole lease lifetime. */
	private readonly decidedIds = new Set<string>();
	private serviceLease: ChildAuthorityProviderLease | undefined;
	private prepared: ChildAuthorityPreparedLease | undefined;
	private preparation: PreparationState = "idle";
	private listening = false;
	private disposed = false;
	private readonly onMessage = (message: unknown): void => this.handleMessage(message);
	private readonly onChannelGone = (): void => this.dispose();
	private readonly onServiceAbort = (): void => this.dispose();

	constructor(input: CreateChildAuthorityControllerInput) {
		const { child, provider } = input;
		if (!child || typeof child !== "object" || typeof child.send !== "function" || typeof child.on !== "function" || typeof child.off !== "function") {
			throw new ChildAuthorityError("transport-unavailable", "Child authority requires the actual spawned ChildProcess with an IPC channel.");
		}
		if (!provider || typeof provider !== "object") throw new ChildAuthorityError("service-missing", "Child authority requires a published provider.");
		if (provider.version !== 1) throw new ChildAuthorityError("version-mismatch", `Child authority service version ${String(provider.version)} is unsupported; this package requires version 1.`);
		if (typeof provider.prepare !== "function") throw new ChildAuthorityError("service-malformed", "The published child authority service requires prepare().");
		if (provider.sessionId !== input.sessionId) {
			throw new ChildAuthorityError("session-mismatch", `Child authority service belongs to session '${String(provider.sessionId)}', not '${String(input.sessionId)}'.`);
		}
		const audience = parseChildAuthorityAudience({ parentSessionId: input.sessionId, runId: input.runId });
		this.decisionTimeoutMs = requirePositiveInteger(input.decisionTimeoutMs, CHILD_AUTHORITY_DEFAULT_DECISION_TIMEOUT_MS, "Child authority decisionTimeoutMs");
		this.prepareTimeoutMs = requirePositiveInteger(input.prepareTimeoutMs, CHILD_AUTHORITY_DEFAULT_PREPARE_TIMEOUT_MS, "Child authority prepareTimeoutMs");
		try {
			this.requiredExtensions = snapshotRequiredChildExtensions(provider.requiredExtensions, "Child authority required extensions");
		} catch (error) {
			throw new ChildAuthorityError("service-malformed", error instanceof Error ? error.message : String(error));
		}
		this.child = child;
		this.provider = provider;
		this.sessionId = audience.parentSessionId;
		this.runId = audience.runId;
	}

	async prepare(identity: ChildAuthorityPrepareIdentity, signal?: AbortSignal): Promise<ChildAuthorityPreparedLease> {
		if (this.preparation !== "idle") {
			throw new ChildAuthorityError("already-prepared", `Child authority has already been prepared for this child process (state '${this.preparation}'); one lease per child process.`);
		}
		if (this.disposed) throw new ChildAuthorityError("disposed", "The child authority controller is disposed.");
		this.preparation = "preparing";
		try {
			return await this.attemptPrepare(identity, signal);
		} catch (error) {
			// A failed preparation is terminal: the child gets no authority and the controller releases what it holds.
			this.preparation = "failed";
			this.dispose();
			if (error instanceof ChildAuthorityError) throw error;
			throw new ChildAuthorityError("service-malformed", `Child authority preparation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort(new ChildAuthorityError("cancelled", "The child authority controller is disposed."));
		const prepared = this.prepared;
		const serviceLease = this.serviceLease;
		if (prepared) {
			const revoke: ChildAuthorityLeaseRevoke = { kind: REVOKE_KIND, version: CHILD_AUTHORITY_ENVELOPE_VERSION, sessionId: this.sessionId, runId: this.runId, leaseId: prepared.leaseId };
			this.send(revoke);
		}
		for (const request of this.pending.values()) {
			request.abandoned = true;
			request.abort.abort(new ChildAuthorityError("cancelled", "The child authority lease is revoked."));
		}
		this.pending.clear();
		this.detachListeners(serviceLease);
		this.serviceLease = undefined;
		if (serviceLease) this.disposeServiceLease(serviceLease);
	}

	private async attemptPrepare(identity: ChildAuthorityPrepareIdentity, signal?: AbortSignal): Promise<ChildAuthorityPreparedLease> {
		if (!this.child.connected) throw new ChildAuthorityError("transport-unavailable", "The child process IPC channel is not connected; authority cannot be attached.");
		const bound = bindChildAuthorityIdentity({ parentSessionId: this.sessionId, runId: this.runId }, identity);
		// Channel loss during preparation must abort the wait instead of leaving the launch path hanging.
		this.attachChannelListeners();
		const prepareAbort = new AbortController();
		const timer = setTimeout(() => {
			prepareAbort.abort(new ChildAuthorityError("timeout", `Child authority preparation did not finish within ${this.prepareTimeoutMs}ms.`));
		}, this.prepareTimeoutMs);
		timer.unref();
		const prepareSignal = signal ? AbortSignal.any([this.abort.signal, prepareAbort.signal, signal]) : AbortSignal.any([this.abort.signal, prepareAbort.signal]);
		let serviceLease: ChildAuthorityProviderLease;
		try {
			serviceLease = await prepareChildAuthorityServiceLease({ provider: this.provider, requiredExtensions: this.requiredExtensions, identity: bound, signal: prepareSignal });
		} finally {
			clearTimeout(timer);
		}
		if (this.disposed) {
			this.disposeServiceLease(serviceLease);
			throw new ChildAuthorityError("cancelled", "The child authority controller was disposed while the service prepared the lease.");
		}
		const prepared: ChildAuthorityPreparedLease = Object.freeze({
			leaseId: randomUUID(),
			identity: bound,
			payload: serviceLease.payload,
			requiredConsumers: serviceLease.requiredConsumers,
		});
		this.serviceLease = serviceLease;
		this.prepared = prepared;
		serviceLease.signal?.addEventListener("abort", this.onServiceAbort, { once: true });
		const grant: ChildAuthorityLeaseGrant = {
			kind: LEASE_KIND,
			version: CHILD_AUTHORITY_ENVELOPE_VERSION,
			sessionId: this.sessionId,
			runId: this.runId,
			leaseId: prepared.leaseId,
			identity: bound,
			payload: serviceLease.payload,
			requiredConsumers: serviceLease.requiredConsumers,
		};
		if (!this.send(grant)) {
			this.prepared = undefined;
			this.serviceLease = undefined;
			this.detachListeners(serviceLease);
			this.disposeServiceLease(serviceLease);
			throw new ChildAuthorityError("transport-unavailable", "The child process IPC channel closed before the authority lease could be delivered.");
		}
		this.preparation = "prepared";
		return prepared;
	}

	private attachChannelListeners(): void {
		if (this.listening) return;
		this.listening = true;
		this.child.on("message", this.onMessage);
		this.child.on("disconnect", this.onChannelGone);
		this.child.on("exit", this.onChannelGone);
		this.child.on("error", this.onChannelGone);
	}

	private detachListeners(serviceLease: ChildAuthorityProviderLease | undefined): void {
		if (this.listening) {
			this.listening = false;
			this.child.off("message", this.onMessage);
			this.child.off("disconnect", this.onChannelGone);
			this.child.off("exit", this.onChannelGone);
			this.child.off("error", this.onChannelGone);
		}
		serviceLease?.signal?.removeEventListener("abort", this.onServiceAbort);
	}

	private disposeServiceLease(serviceLease: ChildAuthorityProviderLease): void {
		try {
			serviceLease.dispose();
		} catch {
			// The provider's dispose failure must not leave the transport alive or mask the original fault.
		}
	}

	private send(message: ChildAuthorityWireMessage): boolean {
		if (!this.child.connected) return false;
		try {
			this.child.send(message);
			return true;
		} catch {
			return false;
		}
	}

	private handleMessage(raw: unknown): void {
		const prepared = this.prepared;
		if (this.disposed || !prepared) return;
		const envelope = envelopeRecord(raw);
		if (!envelope || envelope.version !== CHILD_AUTHORITY_ENVELOPE_VERSION) return;
		const record = raw as Record<string, unknown>;
		// Wrong audience or a stale/foreign lease id is not answered: a decision would confirm a lease the peer
		// does not hold.
		if (record.sessionId !== this.sessionId || record.runId !== this.runId || record.leaseId !== prepared.leaseId) return;
		if (envelope.kind === REVOKE_KIND) {
			// The actual child may relinquish its whole lease, even while its process remains alive.
			this.dispose();
			return;
		}
		if (envelope.kind === CANCEL_KIND) {
			this.handleCancel(record);
			return;
		}
		if (envelope.kind === REQUEST_KIND) this.handleActionRequest(record);
	}

	private handleCancel(record: Record<string, unknown>): void {
		let requestId: string;
		let reason: ChildAuthorityCancelReason;
		try {
			requestId = parseChildAuthorityRequestId(record.requestId);
			reason = parseChildAuthorityCancelReason(record.reason);
		} catch {
			return;
		}
		const pending = this.pending.get(requestId);
		// A release for an unknown or already settled request changes nothing.
		if (!pending) return;
		pending.abandoned = true;
		pending.abort.abort(new ChildAuthorityError("cancelled", `The child released the request (${reason}).`));
	}

	private handleActionRequest(record: Record<string, unknown>): void {
		const prepared = this.prepared;
		if (!prepared) return;
		let requestId: string;
		try {
			requestId = parseChildAuthorityRequestId(record.requestId);
		} catch {
			return;
		}
		// Replayed and duplicate ids are never decided twice.
		if (this.pending.has(requestId) || this.decidedIds.has(requestId)) return;
		if (this.decidedIds.size >= CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS) {
			// Forgetful replay protection is not protection: revoke instead of evicting an older id.
			this.respond(requestId, failDecision("unavailable", `Child authority lease '${prepared.leaseId}' accepted its ${CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS} request ids and is revoked.`));
			this.dispose();
			return;
		}
		this.decidedIds.add(requestId);
		let action: ChildAuthorityAction;
		try {
			action = parseChildAuthorityAction(record.action);
		} catch {
			this.respond(requestId, failDecision("deny", "The action request was malformed or exceeded its bounds."));
			return;
		}
		if (this.pending.size >= CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS) {
			this.respond(requestId, failDecision("unavailable", `At most ${CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS} child authority requests may be decided concurrently.`));
			return;
		}
		const serviceLease = this.serviceLease;
		if (!serviceLease) {
			this.respond(requestId, failDecision("cancelled", "The child authority lease is no longer live."));
			return;
		}
		const requestAbort = new AbortController();
		const pending: PendingActionRequest = { abort: requestAbort, abandoned: false };
		this.pending.set(requestId, pending);
		const timer = setTimeout(() => {
			requestAbort.abort(new ChildAuthorityError("timeout", `The parent authority service did not decide the request within ${this.decisionTimeoutMs}ms.`));
		}, this.decisionTimeoutMs);
		timer.unref();
		let decisionPromise: Promise<ChildAuthorityDecision>;
		try {
			// A provider that throws synchronously must not escape into the host's IPC listener.
			decisionPromise = Promise.resolve(serviceLease.decide(action, requestAbort.signal));
		} catch {
			clearTimeout(timer);
			this.pending.delete(requestId);
			this.respond(requestId, failDecision("unavailable", "The parent authority service failed to decide the request."));
			return;
		}
		void (async () => {
			let result: ChildAuthorityDecision;
			try {
				result = parseChildAuthorityDecision(await awaitWithinBound(decisionPromise, requestAbort.signal));
			} catch (error) {
				const fault = error instanceof ChildAuthorityError ? error.code : undefined;
				result = fault === "timeout"
					? failDecision("unavailable", "The parent authority service did not decide the request in time.")
					: fault === "cancelled" || this.disposed
						? failDecision("cancelled", "The parent authority lease was revoked before the request was decided.")
						: failDecision("unavailable", "The parent authority service could not decide the request.");
			}
			clearTimeout(timer);
			this.pending.delete(requestId);
			// A released or revoked request never receives a decision: cancellation is not consent.
			if (!pending.abandoned) this.respond(requestId, result);
		})();
	}

	private respond(requestId: string, decision: ChildAuthorityDecision): void {
		const prepared = this.prepared;
		if (this.disposed || !prepared) return;
		const message: ChildAuthorityActionDecision = {
			kind: DECISION_KIND,
			version: CHILD_AUTHORITY_ENVELOPE_VERSION,
			sessionId: this.sessionId,
			runId: this.runId,
			leaseId: prepared.leaseId,
			requestId,
			decision,
		};
		this.send(message);
	}
}

/** Create the parent-side controller that binds one prepared lease to one host-created IPC channel. */
export function createChildAuthorityController(input: CreateChildAuthorityControllerInput): ChildAuthorityController {
	return new IpcChildAuthorityController(input);
}

/** The runner IPC endpoint the client binds. Production always binds the runner's own `process`. */
type ChildAuthorityRunnerProcess = Pick<NodeJS.Process, "on" | "off" | "send" | "connected">;

export interface CreateChildAuthorityRunnerClientOptions {
	readonly requestTimeoutMs?: number;
	readonly leaseTimeoutMs?: number;
}

export interface ChildAuthorityRunnerClient {
	/** Resolve the lease the parent prepared for this process. Fails closed when none arrives. */
	awaitLease(signal?: AbortSignal): Promise<ChildAuthorityLease>;
	dispose(): void;
}

interface LeaseWaiter {
	readonly promise: Promise<ChildAuthorityLease>;
	resolve(lease: ChildAuthorityLease): void;
	reject(error: Error): void;
	cleanup(): void;
}

class IpcChildAuthorityRunnerClient implements ChildAuthorityRunnerClient {
	private readonly target: ChildAuthorityRunnerProcess;
	private readonly requestTimeoutMs: number;
	private readonly leaseTimeoutMs: number;
	private grant: ChildAuthorityLeaseHandle | undefined;
	private waiter: LeaseWaiter | undefined;
	private failure: ChildAuthorityError | undefined;
	private disposed = false;
	private readonly onMessage = (message: unknown): void => this.handleMessage(message);
	private readonly onChannelGone = (): void => this.fail(new ChildAuthorityError("transport-unavailable", "The parent IPC channel closed; child authority was revoked."));

	constructor(target: ChildAuthorityRunnerProcess, options: CreateChildAuthorityRunnerClientOptions) {
		this.requestTimeoutMs = requirePositiveInteger(options.requestTimeoutMs, CHILD_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS, "Child authority requestTimeoutMs");
		this.leaseTimeoutMs = requirePositiveInteger(options.leaseTimeoutMs, CHILD_AUTHORITY_DEFAULT_LEASE_TIMEOUT_MS, "Child authority leaseTimeoutMs");
		this.target = target;
		target.on("message", this.onMessage);
		target.on("disconnect", this.onChannelGone);
	}

	awaitLease(signal?: AbortSignal): Promise<ChildAuthorityLease> {
		if (signal?.aborted) return Promise.reject(new ChildAuthorityError("cancelled", "Waiting for a child authority lease was cancelled."));
		if (this.disposed) return Promise.reject(new ChildAuthorityError("disposed", "The child authority runner client is disposed."));
		if (this.failure) return Promise.reject(this.failure);
		const granted = this.grant;
		if (granted) {
			// A revoked lease is never returned as live authority, even though its payload is still readable.
			if (granted.lease.signal.aborted) return Promise.reject(new ChildAuthorityError("cancelled", "The child authority lease was revoked."));
			return Promise.resolve(granted.lease);
		}
		if (!this.target.connected) return Promise.reject(new ChildAuthorityError("transport-unavailable", "The parent IPC channel is not connected; child authority is unavailable."));
		const waiter = this.ensureWaiter();
		if (!signal) return waiter.promise;
		// Each caller may bound its own wait without disturbing the shared lease grant.
		return new Promise<ChildAuthorityLease>((resolve, reject) => {
			const onAbort = (): void => reject(new ChildAuthorityError("cancelled", "Waiting for a child authority lease was cancelled."));
			signal.addEventListener("abort", onAbort, { once: true });
			waiter.promise.then(
				(lease) => {
					signal.removeEventListener("abort", onAbort);
					resolve(lease);
				},
				(error: Error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachListeners();
		this.grant?.lease.dispose();
		this.grant = undefined;
		const waiter = this.waiter;
		this.waiter = undefined;
		if (waiter) {
			waiter.cleanup();
			waiter.reject(new ChildAuthorityError("disposed", "The child authority runner client is disposed."));
		}
	}

	private ensureWaiter(): LeaseWaiter {
		if (this.waiter) return this.waiter;
		let resolveLease: (lease: ChildAuthorityLease) => void = () => {};
		let rejectLease: (error: Error) => void = () => {};
		const promise = new Promise<ChildAuthorityLease>((resolve, reject) => {
			resolveLease = resolve;
			rejectLease = reject;
		});
		// A lease that never arrives is either awaited or never consumed; an unawaited rejection must not become
		// an unhandled process fault.
		promise.catch(() => {});
		const timer = setTimeout(() => {
			this.fail(new ChildAuthorityError("transport-unavailable", `No child authority lease was prepared within ${this.leaseTimeoutMs}ms.`));
		}, this.leaseTimeoutMs);
		timer.unref();
		this.waiter = { promise, resolve: resolveLease, reject: rejectLease, cleanup: () => clearTimeout(timer) };
		return this.waiter;
	}

	private detachListeners(): void {
		this.target.off("message", this.onMessage);
		this.target.off("disconnect", this.onChannelGone);
	}

	private fail(error: ChildAuthorityError): void {
		if (this.failure || this.disposed) return;
		this.failure = error;
		this.detachListeners();
		this.grant?.lease.dispose();
		// The failed client holds no live authority, so no later awaitLease() can hand back a stale payload.
		this.grant = undefined;
		const waiter = this.waiter;
		this.waiter = undefined;
		if (waiter) {
			waiter.cleanup();
			waiter.reject(error);
		}
	}

	private handleMessage(raw: unknown): void {
		if (this.disposed || this.failure) return;
		const envelope = envelopeRecord(raw);
		if (!envelope || typeof envelope.kind !== "string" || !WIRE_KINDS.has(envelope.kind)) return;
		if (envelope.version !== CHILD_AUTHORITY_ENVELOPE_VERSION) {
			// A grant or revocation this build cannot read must never leave authority looking live.
			this.fail(new ChildAuthorityError("version-mismatch", `Child authority messages use version ${String(envelope.version)}; this package requires version ${CHILD_AUTHORITY_ENVELOPE_VERSION}.`));
			return;
		}
		if (envelope.kind === LEASE_KIND) {
			this.acceptLease(raw);
			return;
		}
		if (envelope.kind === DECISION_KIND) {
			this.acceptDecision(raw);
			return;
		}
		if (envelope.kind === REVOKE_KIND) {
			this.acceptRevoke(raw);
		}
	}

	private acceptLease(raw: unknown): void {
		if (this.grant) {
			// A replayed or replacement grant must not become a second capability.
			this.fail(new ChildAuthorityError("already-prepared", "A second child authority lease was granted to this process; refusing the replacement."));
			return;
		}
		const record = raw as Record<string, unknown>;
		const sessionId = record.sessionId;
		const runId = record.runId;
		const leaseId = record.leaseId;
		if (typeof sessionId !== "string" || !sessionId || typeof runId !== "string" || !runId || typeof leaseId !== "string" || !leaseId) {
			this.fail(new ChildAuthorityError("invalid-lease", "The child authority lease grant is missing its audience."));
			return;
		}
		let handle: ChildAuthorityLeaseHandle;
		try {
			const identity = parseBoundChildAuthorityIdentity(record.identity);
			// The grant's audience and its bound identity must agree; otherwise the child would hold a lease for
			// one session under another session's message.
			if (identity.parentSessionId !== sessionId || identity.runId !== runId) throw new ChildAuthorityError("invalid-lease", "The child authority lease grant audience does not match its bound identity.");
			handle = createChildAuthorityLease({
				leaseId,
				identity,
				payload: parseChildAuthorityPayload(record.payload),
				requiredConsumers: parseChildAuthorityConsumers(record.requiredConsumers),
				send: (requestId, action) => this.sendRequest(sessionId, runId, leaseId, requestId, action),
				cancel: (requestId, reason) => this.sendCancel(sessionId, runId, leaseId, requestId, reason),
				requestTimeoutMs: this.requestTimeoutMs,
			});
		} catch (error) {
			this.fail(error instanceof ChildAuthorityError ? error : new ChildAuthorityError("invalid-lease", `The child authority lease grant is invalid: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		this.grant = handle;
		// Lease disposal is terminal on both peers, not just cancellation of current requests.
		handle.lease.signal.addEventListener("abort", () => {
			if (!this.target.connected || typeof this.target.send !== "function") return;
			try {
				this.target.send({ kind: REVOKE_KIND, version: CHILD_AUTHORITY_ENVELOPE_VERSION, sessionId, runId, leaseId } satisfies ChildAuthorityLeaseRevoke);
			} catch {
				// Channel loss independently revokes the parent's lease.
			}
		}, { once: true });
		const waiter = this.waiter;
		this.waiter = undefined;
		if (waiter) {
			waiter.cleanup();
			waiter.resolve(handle.lease);
		}
	}

	private acceptDecision(raw: unknown): void {
		const grant = this.grant;
		if (!grant) return;
		const record = raw as Record<string, unknown>;
		if (!this.matchesGrant(grant, record)) return;
		let requestId: string;
		try {
			requestId = parseChildAuthorityRequestId(record.requestId);
		} catch {
			return;
		}
		grant.deliverDecision(requestId, record.decision);
	}

	private acceptRevoke(raw: unknown): void {
		const grant = this.grant;
		if (!grant) return;
		// Full audience equality, not just the lease id: another session's revoke must not revoke this lease,
		// and this session's revoke must not be ignored for a look-alike id.
		if (!this.matchesGrant(grant, raw as Record<string, unknown>)) return;
		this.fail(new ChildAuthorityError("cancelled", "The parent revoked child authority for this lease."));
	}

	private matchesGrant(grant: ChildAuthorityLeaseHandle, record: Record<string, unknown>): boolean {
		return record.sessionId === grant.lease.identity.parentSessionId
			&& record.runId === grant.lease.identity.runId
			&& record.leaseId === grant.lease.leaseId;
	}

	private sendRequest(sessionId: string, runId: string, leaseId: string, requestId: string, action: ChildAuthorityAction): boolean {
		if (this.disposed || !this.target.connected || typeof this.target.send !== "function") return false;
		const message: ChildAuthorityActionRequest = {
			kind: REQUEST_KIND,
			version: CHILD_AUTHORITY_ENVELOPE_VERSION,
			sessionId,
			runId,
			leaseId,
			requestId,
			action,
		};
		try {
			this.target.send(message);
			return true;
		} catch {
			return false;
		}
	}

	private sendCancel(sessionId: string, runId: string, leaseId: string, requestId: string, reason: ChildAuthorityCancelReason): void {
		if (!this.target.connected || typeof this.target.send !== "function") return;
		const message: ChildAuthorityCancelMessage = {
			kind: CANCEL_KIND,
			version: CHILD_AUTHORITY_ENVELOPE_VERSION,
			sessionId,
			runId,
			leaseId,
			requestId,
			reason,
		};
		try {
			this.target.send(message);
		} catch {
			// The parent's own bound still settles its review work; the child has already given up locally.
		}
	}
}

/**
 * Create the runner-side client for this runner process.
 *
 * The endpoint is captured from `globalThis.process`, never accepted as a parameter: a model-reconstructible
 * fake emitter cannot be substituted for the host-created IPC channel. Only the timing bounds are options.
 */
export function createChildAuthorityRunnerClient(options: CreateChildAuthorityRunnerClientOptions = {}): ChildAuthorityRunnerClient {
	const target = globalThis.process;
	if (!target || typeof target.send !== "function" || typeof target.on !== "function" || typeof target.off !== "function") {
		throw new ChildAuthorityError("transport-unavailable", "Child authority requires the runner process IPC channel; this process has none.");
	}
	return new IpcChildAuthorityRunnerClient(target, options);
}
