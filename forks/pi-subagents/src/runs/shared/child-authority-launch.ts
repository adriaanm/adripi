/**
 * Production child-authority wiring for the one supported placement: a single native
 * background child in its own runner process.
 *
 * The parent proves whether this host session is guarded, refuses every placement it cannot
 * carry authority into, attaches the host-created IPC channel to the spawned runner and asks
 * the published provider for one lease. The runner awaits that lease on its own process
 * channel before any extension loads, and checks that the lease names the child it is about
 * to create. The provider payload is opaque here: this module transports authority, it never
 * derives or interprets policy.
 */
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import {
	hasMandatoryRequiredChildExtensions,
	resolveRequiredChildExtensions,
	type RequiredChildExtensionSnapshot,
} from "../../shared/required-child-extensions.ts";
import {
	CHILD_AUTHORITY_PROVIDER_KEY,
	ChildAuthorityError,
	readChildAuthorityProvider,
	type ChildAuthorityIdentity,
	type ChildAuthorityLease,
	type ChildAuthorityPrepareIdentity,
	type ChildAuthorityProvider,
} from "./child-authority.ts";
import { createChildAuthorityController, createChildAuthorityRunnerClient, type ChildAuthorityPreparedLease } from "./child-authority-ipc.ts";

/** Serialized runner-config marker: the host prepared authority for this runner, so a lease is required. */
export const CHILD_AUTHORITY_RUNNER_CONFIG_KEY = "childAuthority";
export const CHILD_AUTHORITY_RUNNER_REQUEST_VERSION = 1;

/** The host-written runner-config marker. Only the parent launch writes it; a writable config can add it, never remove the channel requirement. */
export interface ChildAuthorityRunnerRequest {
	readonly version: typeof CHILD_AUTHORITY_RUNNER_REQUEST_VERSION;
}

/**
 * Process-lifetime latch for a runner that holds child authority. It lives on `globalThis` under a
 * `Symbol.for` key so bundled and compiled copies share one latch.
 *
 * It is set from the actual host-created IPC channel, synchronously, before the lease is awaited, and it
 * is never cleared: revocation, disposal and the end of the extension-load scope do not reopen the parent
 * Pi process, and a guarded runner must refuse a nested child at any later moment. It carries no
 * permission — admission, identity and consumer acknowledgments still decide what the child may do.
 */
export const CHILD_AUTHORITY_RUNNER_LATCH_KEY = Symbol.for("pi-subagents.child-authority-runner.v1");
export const CHILD_AUTHORITY_RUNNER_LATCH_VERSION = 1;

interface ChildAuthorityRunnerLatch {
	readonly version: typeof CHILD_AUTHORITY_RUNNER_LATCH_VERSION;
	readonly latchedAt: number;
}

/** True once this process's own launch required a live child authority lease. */
export function childAuthorityRunnerLatched(): boolean {
	return (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_RUNNER_LATCH_KEY] !== undefined;
}

function latchChildAuthorityRunner(): void {
	const root = globalThis as Record<PropertyKey, unknown>;
	if (root[CHILD_AUTHORITY_RUNNER_LATCH_KEY] !== undefined) return;
	const latch: ChildAuthorityRunnerLatch = Object.freeze({ version: CHILD_AUTHORITY_RUNNER_LATCH_VERSION, latchedAt: Date.now() });
	root[CHILD_AUTHORITY_RUNNER_LATCH_KEY] = latch;
}

/**
 * The reason a nested child launch cannot run in a guarded runner process, or undefined outside one.
 *
 * Nested launches are refused from the latch alone, so they stay refused outside `withChildAuthority`,
 * after revocation and before any placement fact is evaluated.
 */
export function nestedChildAuthorityRefusal(host: "parent" | "runner"): string | undefined {
	if (!childAuthorityRunnerLatched()) return undefined;
	const placement = host === "parent" ? "foreground" : "background";
	return `Child authority refused this launch because this process is a guarded child authority runner: a nested ${placement} child cannot carry the parent's IPC lease and would re-root authority inside the runner. Run the work in the admitted child instead.`;
}

/**
 * A guarded launch hosts exactly one child session. Anything this launcher cannot carry the
 * host IPC channel and one live lease into is refused before it mutates or spawns.
 */
export interface ChildAuthorityLaunchPlacement {
	/** Which process would host the child: the parent Pi process, or a detached native runner. */
	readonly host: "parent" | "runner";
	/** Child sessions this process would host for the launch. */
	readonly children: number;
	readonly chain?: boolean;
	readonly parallel?: boolean;
	readonly dynamic?: boolean;
	/** A child launching a grandchild: per-process authority cannot be re-rooted inside a runner. */
	readonly nested?: boolean;
	/** External CLI/job runner selection. */
	readonly externalRunner?: string;
	/** Saved-machine/pane-native placement. */
	readonly machine?: string;
	/** Broker launcher wrapper around the runner. */
	readonly launcher?: string;
	/** Compiled Bun/binary Pi host, which cannot carry the Node IPC channel this launcher requires. */
	readonly binaryHost?: boolean;
	/** Retained/revived run: an earlier process kept no live lease. */
	readonly retainedResume?: boolean;
	readonly managedWorktree?: boolean;
	/** Unattended schedule with no live accountable parent. */
	readonly scheduled?: boolean;
	/** The request would run an in-parent child or a workflow script/host step under this guard. */
	readonly foreground?: boolean;
	readonly workflow?: boolean;
}

/**
 * The one reason a guarded launch cannot use this placement, or undefined when it can.
 * Wording names the supported alternative instead of implying the runner will switch itself.
 */
export function childAuthorityPlacementRefusal(placement: ChildAuthorityLaunchPlacement): string | undefined {
	const reasons: string[] = [];
	if (placement.host === "parent" || placement.foreground) reasons.push("foreground children run inside the parent Pi process, where the sandbox and Guardian services are process-global");
	if (placement.children !== 1) reasons.push(`this process would host ${placement.children} child sessions`);
	if (placement.chain) reasons.push("a chain runs more than one child");
	if (placement.parallel) reasons.push("a parallel group runs several children at once");
	if (placement.dynamic) reasons.push("a dynamic fanout decides its child count at runtime");
	if (placement.nested) reasons.push("a nested launch would re-root authority inside a runner");
	if (placement.externalRunner) reasons.push(`runner.type='${placement.externalRunner}' keeps no host IPC channel`);
	if (placement.machine) reasons.push(`machine '${placement.machine}' places the child in another process or host`);
	if (placement.launcher) reasons.push(`launcher '${placement.launcher}' starts the runner behind a wrapper`);
	if (placement.binaryHost) reasons.push("the compiled binary host cannot carry the host-created IPC channel");
	if (placement.retainedResume) reasons.push("a retained run holds no fresh lease");
	if (placement.managedWorktree) reasons.push("managed worktree allocation is not part of an admitted launch");
	if (placement.scheduled) reasons.push("an unattended schedule has no live accountable parent");
	if (placement.workflow) reasons.push("a workflow runs script and host steps before any single admitted child");
	if (reasons.length === 0) return undefined;
	const supported = placement.host === "parent"
		? "Child authority for this session supports one native background child: re-run with async: true, or do the work in the parent within its existing policy. Do not disable or evade the guard."
		: "Child authority for this session supports exactly one native background child start per run: launch a single agent asynchronously, and create any worktree yourself and pass it as cwd so the provider can admit it.";
	return `Child authority refused this launch because ${reasons.join("; ")}. ${supported}`;
}

/**
 * Display name for a configured launcher. The runner config stores `launcher: {name, argv}`, so a producer
 * that only forwarded strings silently dropped the refusal; this is the one spelling both use.
 */
export function launcherDisplayName(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value.trim() || "launcher";
	if (typeof value !== "object") return "launcher";
	const name = (value as { name?: unknown }).name;
	return typeof name === "string" && name.trim() ? name.trim() : "launcher";
}

/** Resolved admission for one production launch. `provider` is set exactly when the launch is guarded. */
export interface ChildAuthorityLaunchAdmission {
	readonly guarded: boolean;
	readonly provider?: ChildAuthorityProvider;
}

export interface ChildAuthorityLaunchAdmissionInput {
	/**
	 * The actual host Pi session id. Models and copied artifacts cannot supply it: callers pass
	 * the live session/run context the host already holds.
	 */
	readonly hostSessionId: string | undefined;
	/** Snapshots an earlier launch already carried; a mandatory entry may only tighten this admission. */
	readonly tighteningSnapshots?: ReadonlyArray<RequiredChildExtensionSnapshot | undefined>;
}

/**
 * Decide whether this launch runs under child authority.
 *
 * Guarded when the host session has mandatory required child extensions registered (the sandbox
 * and Guardian are live), when the provider slot exists at all (even malformed: a broken service
 * must not read as "no service"), or when an inherited/retained snapshot is mandatory. A missing
 * provider on a guarded launch is a refusal, never a silent unguarded child.
 */
export function admitChildAuthorityLaunch(input: ChildAuthorityLaunchAdmissionInput): ChildAuthorityLaunchAdmission {
	// A guarded runner is not a bare host: no later launch in this process may drop its authority.
	const nestedRefusal = nestedChildAuthorityRefusal("runner");
	if (nestedRefusal) throw new ChildAuthorityError("invalid-identity", nestedRefusal);
	const hostSessionId = input.hostSessionId;
	if (hostSessionId !== undefined && (typeof hostSessionId !== "string" || !hostSessionId.trim() || hostSessionId.trim() !== hostSessionId || hostSessionId.includes("\0"))) {
		throw new ChildAuthorityError("invalid-identity", "This launch cannot resolve a well-formed host Pi session id, so it cannot prove it is outside a guarded host session; refusing the child launch.");
	}
	const providerPublished = CHILD_AUTHORITY_PROVIDER_KEY in (globalThis as Record<PropertyKey, unknown>);
	const registered = hostSessionId === undefined ? undefined : resolveRequiredChildExtensions(hostSessionId);
	const registeredGuarded = hasMandatoryRequiredChildExtensions(registered);
	const inheritedGuarded = (input.tighteningSnapshots ?? []).some((snapshot) => hasMandatoryRequiredChildExtensions(snapshot));
	if (!providerPublished && !registeredGuarded && !inheritedGuarded) {
		if (hostSessionId === undefined) {
			// "No session id" is not evidence of an unguarded session: the caller holds no authority proof.
			throw new ChildAuthorityError("invalid-identity", "This launch has no host Pi session id, so it cannot prove it is outside a guarded host session; refusing the child launch.");
		}
		return { guarded: false };
	}
	// readChildAuthorityProvider is the only reader of the slot; it rejects a malformed, unsupported
	// or wrong-session service. That fault propagates as a refusal of the guarded launch.
	const provider = readChildAuthorityProvider(hostSessionId);
	return { guarded: true, provider };
}

export interface ChildAuthorityForegroundRefusalInput {
	/** The actual host Pi session id, from the live session context. */
	readonly hostSessionId: string | undefined;
	/** Placement facts the caller already resolved for this foreground child. */
	readonly machine?: string;
	readonly externalRunner?: string;
	readonly managedWorktree?: boolean;
}

export interface ChildAuthorityEarlyRefusalInput {
	readonly hostSessionId: string | undefined;
	/** A nested launch is refused from the process latch before any placement fact is trusted. */
	readonly host: "parent" | "runner";
	readonly tighteningSnapshots?: ReadonlyArray<RequiredChildExtensionSnapshot | undefined>;
	readonly placement?: Omit<ChildAuthorityLaunchPlacement, "host" | "children"> & { readonly children?: number };
}

/**
 * Early guarded refusal for a request that has not built its launch config yet: the refusal text instead of
 * a throw, so a caller can stop before it writes run directories, fanout descriptors, progress files,
 * resolves a machine placement or allocates a worktree.
 */
export function childAuthorityLaunchRefusal(input: ChildAuthorityEarlyRefusalInput): string | undefined {
	const nestedRefusal = nestedChildAuthorityRefusal(input.host);
	if (nestedRefusal) return nestedRefusal;
	let admission: ChildAuthorityLaunchAdmission;
	try {
		admission = admitChildAuthorityLaunch({ hostSessionId: input.hostSessionId, ...(input.tighteningSnapshots === undefined ? {} : { tighteningSnapshots: input.tighteningSnapshots }) });
	} catch (error) {
		return `Child authority refused this launch: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!admission.guarded) return undefined;
	const { children, ...facts } = input.placement ?? {};
	return childAuthorityPlacementRefusal({ host: input.host, children: children ?? 1, ...facts });
}

/**
 * The reason an in-parent child launch cannot run under child authority, or undefined when this host
 * session is not guarded. Foreground children share the parent process, where the sandbox and Guardian
 * services are process-global and cannot be re-rooted per child.
 */
export function childAuthorityForegroundRefusal(input: ChildAuthorityForegroundRefusalInput): string | undefined {
	return childAuthorityLaunchRefusal({
		hostSessionId: input.hostSessionId,
		host: "parent",
		placement: {
			...(input.machine === undefined ? {} : { machine: input.machine }),
			...(input.externalRunner === undefined ? {} : { externalRunner: input.externalRunner }),
			...(input.managedWorktree === true ? { managedWorktree: true } : {}),
		},
	});
}

/** The lease the parent prepared for one spawned runner. It holds no decision logic, and disposing it revokes. */
export interface SpawnedRunnerChildAuthority {
	readonly leaseId: string;
	readonly identity: ChildAuthorityIdentity;
	readonly requiredConsumers: readonly string[];
	dispose(): void;
}

export interface PrepareSpawnedRunnerChildAuthorityInput {
	readonly admission: ChildAuthorityLaunchAdmission;
	/** The actual spawned runner. Authority lives on this handle. */
	readonly child: ChildProcess;
	readonly hostSessionId: string;
	readonly runId: string;
	/** Host-fixed child identity: agent, flat index and resolved cwd of the single admitted child. */
	readonly identity: ChildAuthorityPrepareIdentity;
	readonly prepareTimeoutMs?: number;
}

/**
 * Reach the provider immediately after the authenticated spawn, before the runner is authorized
 * to proceed. Any failure disposes the controller and refuses the launch, so the caller can
 * terminate the process instead of leaving an authority-less runner alive.
 */
export async function prepareSpawnedRunnerChildAuthority(input: PrepareSpawnedRunnerChildAuthorityInput): Promise<SpawnedRunnerChildAuthority | undefined> {
	if (!input.admission.guarded) return undefined;
	const provider = input.admission.provider;
	if (!provider) {
		throw new ChildAuthorityError("service-missing", "Child authority is required for this host session but no provider is published; refusing the child launch.");
	}
	const controller = createChildAuthorityController({
		child: input.child,
		provider,
		sessionId: input.hostSessionId,
		runId: input.runId,
		...(input.prepareTimeoutMs === undefined ? {} : { prepareTimeoutMs: input.prepareTimeoutMs }),
	});
	let prepared: ChildAuthorityPreparedLease;
	try {
		prepared = await controller.prepare(input.identity);
	} catch (error) {
		controller.dispose();
		throw error;
	}
	return {
		leaseId: prepared.leaseId,
		identity: prepared.identity,
		requiredConsumers: prepared.requiredConsumers,
		dispose: () => controller.dispose(),
	};
}

/** The serialized runner-config marker. It can only tighten a runner into awaiting a lease. */
export function childAuthorityRunnerRequest(admission: ChildAuthorityLaunchAdmission): ChildAuthorityRunnerRequest | undefined {
	return admission.guarded ? { version: CHILD_AUTHORITY_RUNNER_REQUEST_VERSION } : undefined;
}

function runnerRequested(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as { version?: unknown };
	return record.version === CHILD_AUTHORITY_RUNNER_REQUEST_VERSION;
}
/**
 * End this runner's authority when its work is over.
 *
 * The child closes its own IPC endpoint first: the parent then revokes on the channel close, where its
 * `ChildProcess.connected` is already false, so it writes nothing. Disposing the lease first would send a
 * revoke the parent answers into a pipe the exiting child has already closed.
 */
export function releaseRunnerChildAuthority(authority: RunnerChildAuthority | undefined): void {
	if (!authority) return;
	try {
		globalThis.process.disconnect?.();
	} catch {
		// An already-disconnected endpoint independently revokes the lease.
	}
	try {
		authority.dispose();
	} catch {
		// A channel that is already gone independently revokes the lease.
	}
}

/** The live lease a guarded runner holds, plus the identity check against the child it is about to create. */
export interface RunnerChildAuthority {
	readonly lease: ChildAuthorityLease;
	/**
	 * Bind the lease to the actual child about to load: the runner's own run id, and the agent,
	 * flat index and resolved cwd of the session it is creating. A mismatch refuses the launch.
	 */
	assertBoundTo(actual: { runId: string | undefined; agent: string; index: number; cwd: string }): void;
	dispose(): void;
}

export interface BindRunnerChildAuthorityInput {
	/** The serialized runner config field. Writable configuration may only add this requirement. */
	readonly request?: unknown;
}

function normalizeCwd(value: string): string {
	const resolved = path.resolve(value);
	return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * Await the lease the host prepared for this runner process.
 *
 * The host-created IPC channel is the authority: when this process has one, a live lease is
 * required before any child extension loads, whatever writable configuration says. A config
 * marker without a channel is refused instead of falling back to an unguarded child.
 */
export async function bindRunnerChildAuthority(input: BindRunnerChildAuthorityInput = {}): Promise<RunnerChildAuthority | undefined> {
	const requested = runnerRequested(input.request);
	const channelPresent = typeof process.send === "function" && process.connected === true;
	if (!channelPresent) {
		if (!requested) return undefined;
		throw new ChildAuthorityError("transport-unavailable", "This runner was configured to hold child authority but its process has no host-created IPC channel; refusing to load a child without authority.");
	}
	// Latch before any await: a nested launch attempted during startup, revocation or outside the
	// extension-load scope is refused rather than reaching an unguarded placement.
	latchChildAuthorityRunner();
	const client = createChildAuthorityRunnerClient();
	let lease: ChildAuthorityLease;
	try {
		lease = await client.awaitLease();
	} catch (error) {
		// A runner that never received its lease holds no authority and must not create a child.
		client.dispose();
		if (error instanceof ChildAuthorityError) throw error;
		throw new ChildAuthorityError("transport-unavailable", `Child authority was not delivered to this runner: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		lease,
		assertBoundTo(actual) {
			const identity = lease.identity;
			const mismatches: string[] = [];
			if (actual.runId === undefined || identity.runId !== actual.runId) mismatches.push(`run '${identity.runId}' (this runner runs '${actual.runId ?? "(unknown)"}')`);
			if (identity.agent !== actual.agent) mismatches.push(`agent '${identity.agent}' (this child is '${actual.agent}')`);
			if (identity.index !== actual.index) mismatches.push(`index ${identity.index} (this child is ${actual.index})`);
			if (normalizeCwd(identity.cwd) !== normalizeCwd(actual.cwd)) mismatches.push(`cwd '${identity.cwd}' (this child runs in '${actual.cwd}')`);
			if (mismatches.length > 0) {
				throw new ChildAuthorityError("invalid-identity", `The child authority lease binds ${mismatches.join(", ")}; refusing to load a child the host did not admit.`);
			}
		},
		dispose: () => client.dispose(),
	};
}
