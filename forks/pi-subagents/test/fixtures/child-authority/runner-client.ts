// Real Node IPC fixture: a child runner that consumes the lease only through the code-only slot.
import {
	acknowledgeChildAuthority,
	claimChildAuthority,
	withChildAuthority,
	type ChildAuthorityDecision,
	type ChildAuthoritySurface,
} from "../../../src/runs/shared/child-authority.ts";
import { createChildAuthorityRunnerClient } from "../../../src/runs/shared/child-authority-ipc.ts";

interface RunnerConfig {
	requestTimeoutMs?: number;
	/** Deterministic async write failure on the actual process endpoint (test only). */
	asyncSendFailure?: "request" | "cancel" | "revoke";
	leaseTimeoutMs?: number;
	consumers?: string[];
	acknowledge?: string[];
	claimCwd?: string;
	requests?: Array<{ surface: string; target: string; reason: string }>;
	/** Abort the first request after this long: the caller-side cancellation path. */
	abortAfterMs?: number;
	/** Dispose the whole client while its request is still pending: the release path. */
	disposeAfterMs?: number;
	/** Stay alive after the requests so late traffic can still arrive. */
	lingerMs?: number;
	/** Wait for the parent to revoke, then try to await a lease again. */
	waitForRevokeMs?: number;
}

const config = JSON.parse(process.argv[2] ?? "{}") as RunnerConfig;
if (config.asyncSendFailure) {
	const send = process.send!.bind(process);
	let injected = false;
	process.send = ((message: unknown, ...args: unknown[]) => {
		if (!injected && (message as { kind?: unknown })?.kind === `child-authority:${config.asyncSendFailure}`) {
			injected = true;
			const callback = args.find(arg => typeof arg === "function") as ((error: Error) => void) | undefined;
			process.nextTick(() => {
				const error = Object.assign(new Error("fixture asynchronous EPIPE"), { code: "EPIPE" });
				if (callback) callback(error); else process.emit("error", error);
			});
			return true;
		}
		return (send as (...args: unknown[]) => boolean)(message, ...args);
	}) as typeof process.send;
}
const client = createChildAuthorityRunnerClient({
	requestTimeoutMs: config.requestTimeoutMs ?? 5_000,
	leaseTimeoutMs: config.leaseTimeoutMs ?? 20_000,
});

let decisionsReceived = 0;
process.on("message", (message: unknown) => {
	if (message && typeof message === "object" && (message as { kind?: unknown }).kind === "child-authority:decision") decisionsReceived += 1;
});

const result: Record<string, unknown> = { pid: process.pid, decisionsReceived: 0 };
const errors: Array<{ step: string; code?: string; message: string }> = [];

function recordError(step: string, error: unknown): void {
	errors.push({ step, code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
	const lease = await client.awaitLease();
	result.leaseId = lease.leaseId;
	result.identity = lease.identity;
	result.payload = lease.payload;
	result.requiredConsumers = [...lease.requiredConsumers];
	result.requests = [];
	result.ready = false;

	if (config.disposeAfterMs !== undefined) {
		// Disposing the whole client while a request is pending is the release-on-disposal path.
		const timer = setTimeout(() => client.dispose(), config.disposeAfterMs);
		timer.unref();
	}

	await withChildAuthority(lease, async () => {
		for (const consumerId of config.consumers ?? []) {
			try {
				const claimed = claimChildAuthority(consumerId, config.claimCwd ?? lease.identity.cwd);
				result.claimedLeaseMatches = result.claimedLeaseMatches !== false && claimed === lease;
			} catch (error) {
				recordError(`claim:${consumerId}`, error);
			}
		}
		for (const consumerId of config.acknowledge ?? []) {
			try {
				acknowledgeChildAuthority(consumerId);
			} catch (error) {
				recordError(`acknowledge:${consumerId}`, error);
			}
		}
		try {
			lease.assertReady();
			result.ready = true;
		} catch (error) {
			recordError("assertReady", error);
		}
		const requests = config.requests ?? [];
		for (const [index, request] of requests.entries()) {
			const requestRecord: { decision?: ChildAuthorityDecision; error?: string } = {};
			try {
				if (index === 0 && config.abortAfterMs !== undefined) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), config.abortAfterMs);
					requestRecord.decision = await lease.request({ surface: request.surface as ChildAuthoritySurface, target: request.target, reason: request.reason }, controller.signal);
					clearTimeout(timer);
				} else {
					requestRecord.decision = await lease.request({ surface: request.surface as ChildAuthoritySurface, target: request.target, reason: request.reason });
				}
			} catch (error) {
				requestRecord.error = error instanceof Error ? error.message : String(error);
			}
			(result.requests as unknown[]).push(requestRecord);
		}
	});

	if (config.lingerMs !== undefined) await sleep(config.lingerMs);
	result.signalAborted = lease.signal.aborted;

	if (config.waitForRevokeMs !== undefined && !lease.signal.aborted) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, config.waitForRevokeMs);
			lease.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
		result.signalAborted = lease.signal.aborted;
	}
	if (config.waitForRevokeMs !== undefined) {
		// A revoked grant must not be handed back as live authority with a readable payload.
		try {
			const stale = await client.awaitLease();
			result.leaseAfterRevoke = { outcome: "returned", leaseId: stale.leaseId, aborted: stale.signal.aborted };
		} catch (error) {
			result.leaseAfterRevoke = { outcome: "rejected", code: (error as { code?: string }).code };
		}
	}
} catch (error) {
	recordError("awaitLease", error);
}

result.decisionsReceived = decisionsReceived;
result.errors = errors;
client.dispose();
if (config.asyncSendFailure) await new Promise<void>(resolve => setImmediate(resolve));
process.stdout.write(`AUTHORITY_RESULT ${JSON.stringify(result)}\n`, () => process.exit(0));
