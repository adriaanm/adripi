import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS,
	ChildAuthorityError,
	createChildAuthorityController,
	createChildAuthorityRunnerClient,
	readChildAuthorityProvider,
	type ChildAuthorityAction,
	type ChildAuthorityController,
	type ChildAuthorityDecision,
	type ChildAuthorityIdentity,
	type ChildAuthorityProvider,
	type ChildAuthorityProviderLease,
} from "../../src/api/child-authority.ts";
import { CHILD_AUTHORITY_PROVIDER_KEY } from "../../src/runs/shared/child-authority.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(projectRoot, "test/fixtures/child-authority");
const RESULT_PREFIX = "AUTHORITY_RESULT ";

const SESSION_ID = "session-ipc-fixture";
const RUN_ID = "run-ipc-fixture";
const CWD = "/workspace/ipc-fixture";
const REQUIRED_EXTENSIONS = [
	{ id: "pi-sbx", path: "/fake/extensions/pi-sbx.ts" },
	{ id: "guardian", path: "/fake/extensions/guardian.ts" },
];
const PAYLOAD = { version: 1, allowWrite: [CWD], allowRead: { deny: ["/secrets"] } };
const DEFAULT_CONSUMERS = ["pi-sbx", "guardian"];
const WRITE_REQUEST = { surface: "write", target: `${CWD}/src/file.ts`, reason: "apply the assigned edit" };
const REQUEST_CONFIG = { consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST] };

interface FixtureOutcome {
	result: Record<string, unknown>;
	code: number | null;
	stderr: string;
}

interface FixtureHandle {
	child: ChildProcess;
	outcome: Promise<FixtureOutcome>;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - started > timeoutMs) {
				reject(new Error(`timed out waiting for ${label}`));
				return;
			}
			setTimeout(poll, 5);
		};
		poll();
	});
}

function startFixture(name: string, config: unknown): FixtureHandle {
	const child = spawn(process.execPath, ["--experimental-strip-types", path.join(fixtureDir, `${name}.ts`), JSON.stringify(config)], {
		cwd: projectRoot,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let stdout = "";
	let stderr = "";
	let result: Record<string, unknown> | undefined;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
		let newline = stdout.indexOf("\n");
		while (newline >= 0) {
			const line = stdout.slice(0, newline);
			stdout = stdout.slice(newline + 1);
			if (line.startsWith(RESULT_PREFIX)) result = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
			newline = stdout.indexOf("\n");
		}
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const outcome = new Promise<FixtureOutcome>((resolve) => {
		let settled = false;
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ result: result ?? {}, code, stderr });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, 30_000);
		timer.unref();
		child.on("exit", (code) => finish(code));
		child.on("error", () => finish(null));
	});
	return { child, outcome };
}

function clearProvider(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
}

interface FakeServiceLease {
	lease: ChildAuthorityProviderLease;
	disposed: () => number;
	cancelService: () => void;
}

function fakeServiceLease(options: { decide?: (action: ChildAuthorityAction, signal: AbortSignal) => Promise<ChildAuthorityDecision>; signal?: AbortSignal } = {}): FakeServiceLease {
	const serviceAbort = new AbortController();
	let disposed = 0;
	return {
		lease: {
			payload: PAYLOAD,
			requiredConsumers: DEFAULT_CONSUMERS,
			signal: options.signal ?? serviceAbort.signal,
			decide: options.decide ?? (async () => ({ outcome: "allow", rationale: "inside the prepared payload" })),
			dispose: () => {
				disposed += 1;
			},
		},
		disposed: () => disposed,
		cancelService: () => serviceAbort.abort(),
	};
}

interface ProviderLedger {
	readonly prepared: ChildAuthorityIdentity[];
	readonly decisions: Array<{ action: ChildAuthorityAction; identity: ChildAuthorityIdentity; signal: AbortSignal }>;
	disposed: number;
	cancelService(): void;
}

interface FakeProviderOptions {
	decide?: (action: ChildAuthorityAction, signal: AbortSignal) => Promise<ChildAuthorityDecision>;
	payload?: Record<string, unknown>;
	/** Replace prepare entirely so the test controls when (and whether) a lease arrives. */
	prepare?: (identity: ChildAuthorityIdentity, signal: AbortSignal) => Promise<ChildAuthorityProviderLease>;
}

function publishFakeProvider(options: FakeProviderOptions = {}): { provider: ChildAuthorityProvider; ledger: ProviderLedger } {
	const serviceAbort = new AbortController();
	let disposed = 0;
	const ledger: ProviderLedger = {
		prepared: [],
		decisions: [],
		get disposed() {
			return disposed;
		},
		set disposed(value: number) {
			disposed = value;
		},
		cancelService: () => serviceAbort.abort(),
	} as ProviderLedger;
	const provider: ChildAuthorityProvider = {
		version: 1,
		sessionId: SESSION_ID,
		requiredExtensions: REQUIRED_EXTENSIONS,
		prepare: async (identity: ChildAuthorityIdentity, signal: AbortSignal) => {
			ledger.prepared.push(identity);
			if (options.prepare) return await options.prepare(identity, signal);
			return {
				payload: options.payload ?? PAYLOAD,
				requiredConsumers: DEFAULT_CONSUMERS,
				signal: serviceAbort.signal,
				decide: async (action: ChildAuthorityAction, decisionSignal: AbortSignal) => {
					ledger.decisions.push({ action, identity, signal: decisionSignal });
					return options.decide ? await options.decide(action, decisionSignal) : { outcome: "allow", rationale: "inside the prepared payload" };
				},
				dispose: () => {
					disposed += 1;
				},
			};
		},
	};
	(globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY] = provider;
	return { provider, ledger };
}

interface Harness {
	fixture: FixtureHandle;
	controller: ChildAuthorityController;
	ledger: ProviderLedger;
}

function harness(options: { fixture?: string; config?: unknown; provider?: FakeProviderOptions; decisionTimeoutMs?: number; prepareTimeoutMs?: number } = {}): Harness {
	const { ledger } = publishFakeProvider(options.provider ?? {});
	const fixture = startFixture(options.fixture ?? "runner-client", options.config ?? {});
	const controller = createChildAuthorityController({
		child: fixture.child,
		provider: readChildAuthorityProvider(SESSION_ID),
		sessionId: SESSION_ID,
		runId: RUN_ID,
		decisionTimeoutMs: options.decisionTimeoutMs,
		prepareTimeoutMs: options.prepareTimeoutMs,
	});
	return { fixture, controller, ledger };
}

function decisionsOf(result: Record<string, unknown>): Array<{ decision?: ChildAuthorityDecision; error?: string }> {
	return (result.requests ?? []) as Array<{ decision?: ChildAuthorityDecision; error?: string }>;
}

function errorsOf(result: Record<string, unknown>): Array<{ step: string; code?: string; message: string }> {
	return (result.errors ?? []) as Array<{ step: string; code?: string; message: string }>;
}

function expectCode(run: () => unknown, code: string): ChildAuthorityError {
	try {
		run();
	} catch (error) {
		assert.ok(error instanceof ChildAuthorityError, `expected a ChildAuthorityError, got ${String(error)}`);
		assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
		return error;
	}
	assert.fail(`expected a ChildAuthorityError with code ${code}`);
}

async function expectRejectedWithCode(operation: () => Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof ChildAuthorityError, `expected a ChildAuthorityError, got ${String(error)}`);
		assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
		return true;
	});
}

function grantOf(prepared: { leaseId: string; identity: ChildAuthorityIdentity; payload: unknown; requiredConsumers: readonly string[] }): Record<string, unknown> {
	return {
		kind: "child-authority:lease",
		version: 1,
		sessionId: SESSION_ID,
		runId: RUN_ID,
		leaseId: prepared.leaseId,
		identity: prepared.identity,
		payload: prepared.payload,
		requiredConsumers: prepared.requiredConsumers,
	};
}

describe("child authority over real process IPC", () => {
	let cleanups: Array<() => void> = [];

	beforeEach(() => {
		clearProvider();
		cleanups = [];
	});

	afterEach(() => {
		for (const cleanup of cleanups.reverse()) {
			try {
				cleanup();
			} catch {
				// Cleanup must not mask a test failure.
			}
		}
		cleanups = [];
		clearProvider();
	});

	function attach(options: Parameters<typeof harness>[0] = {}): Harness {
		const created = harness(options);
		cleanups.push(() => {
			created.controller.dispose();
			created.fixture.child.kill("SIGKILL");
		});
		return created;
	}

	it("prepares a lease over the child's real IPC channel and correlates a parent allow", async () => {
		const { fixture, controller, ledger } = attach({ config: REQUEST_CONFIG });
		// A spawned ChildProcess has no authority listeners of its own; any residue after dispose is a leak.
		const baselineMessageListeners = fixture.child.listenerCount("message");
		const baselineExitListeners = fixture.child.listenerCount("exit");

		const prepared = await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		assert.match(prepared.leaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "the lease id is an opaque host-allocated id");
		assert.ok(Object.isFrozen(prepared));
		assert.ok(Object.isFrozen(prepared.identity));
		assert.ok(Object.isFrozen(prepared.payload));
		assert.deepEqual(prepared.requiredConsumers, DEFAULT_CONSUMERS);
		await expectRejectedWithCode(() => controller.prepare({ agent: "worker", index: 0, cwd: CWD }), "already-prepared");

		const { result, code } = await fixture.outcome;
		assert.equal(code, 0, `fixture stderr: ${String(result)}`);
		assert.notEqual(result.pid, process.pid, "the grant and the decision crossed a real process boundary");
		assert.equal(result.leaseId, prepared.leaseId);
		assert.deepEqual(result.identity, prepared.identity);
		assert.deepEqual(result.payload, PAYLOAD);
		assert.deepEqual(result.requiredConsumers, DEFAULT_CONSUMERS);
		assert.equal(result.claimedLeaseMatches, true, "the required consumer received the live lease from its claim");
		assert.equal(result.ready, true);
		const requests = decisionsOf(result);
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0]?.decision, { outcome: "allow", rationale: "inside the prepared payload" });
		assert.deepEqual(ledger.prepared, [{ parentSessionId: SESSION_ID, runId: RUN_ID, agent: "worker", index: 0, cwd: CWD }]);
		assert.deepEqual(ledger.decisions.map((entry) => entry.action), [WRITE_REQUEST]);

		controller.dispose();
		assert.equal(ledger.disposed, 1);
		assert.equal(fixture.child.listenerCount("message"), baselineMessageListeners, "the controller removes its channel listeners");
		assert.equal(fixture.child.listenerCount("exit"), baselineExitListeners);
		controller.dispose();
		assert.equal(ledger.disposed, 1, "dispose is idempotent");
	});

	it("refuses a concurrent second preparation before it awaits anything", async () => {
		const { fixture, controller, ledger } = attach({ config: REQUEST_CONFIG });
		const first = controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const second = controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await expectRejectedWithCode(() => second, "already-prepared");
		const prepared = await first;
		assert.equal(ledger.prepared.length, 1, "only one preparation reached the service");
		const { result } = await fixture.outcome;
		assert.equal(result.leaseId, prepared.leaseId);
	});

	it("bounds preparation, releases a late lease, and refuses a retry", async () => {
		let releaseLate: ((lease: ChildAuthorityProviderLease) => void) | undefined;
		const lateLease = fakeServiceLease();
		const { fixture, controller, ledger } = attach({
			config: { leaseTimeoutMs: 400 },
			prepareTimeoutMs: 100,
			provider: {
				prepare: () =>
					new Promise<ChildAuthorityProviderLease>((resolve) => {
						releaseLate = resolve;
					}),
			},
		});
		const started = Date.now();
		await expectRejectedWithCode(() => controller.prepare({ agent: "worker", index: 0, cwd: CWD }), "timeout");
		assert.ok(Date.now() - started < 5_000, "an abort-ignoring provider cannot hang the launch path");
		await expectRejectedWithCode(() => controller.prepare({ agent: "worker", index: 0, cwd: CWD }), "already-prepared");

		releaseLate?.(lateLease.lease);
		await waitFor(() => lateLease.disposed() === 1, "the late provider lease to be disposed");
		const { result } = await fixture.outcome;
		assert.equal(errorsOf(result)[0]?.code, "transport-unavailable", "the child never received a lease");
		assert.equal(ledger.prepared.length, 1);
		assert.equal(fixture.child.listenerCount("message"), 0, "a failed preparation leaves no listeners behind");
	});

	it("disposes the service lease when its payload is invalid", async () => {
		const { fixture, controller, ledger } = attach({
			config: { leaseTimeoutMs: 400 },
			provider: { payload: [1, 2, 3] as unknown as Record<string, unknown> },
		});
		await expectRejectedWithCode(() => controller.prepare({ agent: "worker", index: 0, cwd: CWD }), "invalid-payload");
		assert.equal(ledger.disposed, 1, "an unusable prepared lease is released exactly once");
		const { result } = await fixture.outcome;
		assert.equal(errorsOf(result)[0]?.code, "transport-unavailable");
		assert.equal(ledger.disposed, 1, "no second dispose after the failure path");
	});

	it("aborts preparation when the child channel disappears while the service is still preparing", async () => {
		const { fixture, controller } = attach({
			config: { leaseTimeoutMs: 400 },
			provider: { prepare: () => new Promise<ChildAuthorityProviderLease>(() => {}) },
		});
		const preparing = controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const started = Date.now();
		await waitFor(() => fixture.child.connected, "the channel to be live");
		fixture.child.kill("SIGKILL");
		await expectRejectedWithCode(() => preparing, "cancelled");
		assert.ok(Date.now() - started < 5_000, "channel loss ends the wait instead of leaving it pending");
	});

	it("keeps consecutive requests independent and preserves a provider denial", async () => {
		const { fixture, controller, ledger } = attach({
			provider: { decide: async (action) => (action.target.endsWith(".md") ? { outcome: "deny", rationale: "outside the assigned workspace" } : { outcome: "allow" }) },
			config: { consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST, { surface: "write", target: `${CWD}/notes.md`, reason: "write release notes" }] },
		});
		await controller.prepare({ agent: "worker", index: 3, cwd: CWD });
		const { result } = await fixture.outcome;
		const requests = decisionsOf(result);
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.decision?.outcome, "allow");
		assert.equal(requests[1]?.decision?.outcome, "deny");
		assert.equal(requests[1]?.decision?.rationale, "outside the assigned workspace");
		assert.equal(ledger.decisions.length, 2, "each request reached the parent authorizer once");
		assert.notEqual(ledger.decisions[0]?.action.target, ledger.decisions[1]?.action.target);
		assert.equal(ledger.prepared[0]?.index, 3);
	});

	it("refuses readiness until every required consumer has claimed and acknowledged the lease", async () => {
		const partial = attach({ config: { consumers: ["pi-sbx"], acknowledge: ["pi-sbx"], requests: [WRITE_REQUEST] } });
		await partial.controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const partialResult = (await partial.fixture.outcome).result;
		assert.equal(partialResult.ready, false);
		const readyError = errorsOf(partialResult).find((entry) => entry.step === "assertReady");
		assert.equal(readyError?.code, "not-ready");
		assert.match(readyError?.message ?? "", /guardian/, "the missing consumer is named");
		assert.equal(decisionsOf(partialResult)[0]?.decision?.outcome, "unavailable", "an unready child cannot reach the parent for review");
		assert.match(decisionsOf(partialResult)[0]?.decision?.rationale ?? "", /not ready/);
		assert.equal(partial.ledger.decisions.length, 0);

		const foreignCwd = attach({ config: { consumers: DEFAULT_CONSUMERS, acknowledge: ["guardian"], claimCwd: "/workspace/elsewhere" } });
		await foreignCwd.controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const foreignResult = (await foreignCwd.fixture.outcome).result;
		assert.equal(foreignResult.ready, false);
		const errors = errorsOf(foreignResult);
		assert.equal(errors.filter((entry) => entry.step.startsWith("claim:") && entry.code === "invalid-lease").length, 2, "a claim bound to another cwd is refused");
		assert.equal(errors.find((entry) => entry.step === "acknowledge:guardian")?.code, "not-ready", "acknowledging before claiming is refused");
	});

	it("ignores requests that name another audience, another run, or a forged lease", async () => {
		const { fixture, controller, ledger } = attach({
			fixture: "raw-peer",
			config: {
				waitMs: 400,
				steps: [
					{ requestId: "wrong-session", overrides: { sessionId: "session-other" } },
					{ requestId: "wrong-run", overrides: { runId: "run-other" } },
					{ requestId: "forged-lease", overrides: { leaseId: "lease-forged" } },
				],
			},
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		assert.deepEqual(result.received, [], "the child receives no decision for a lease it does not hold");
		assert.equal(ledger.decisions.length, 0, "the parent authorizer is never consulted for a foreign audience");
	});

	it("decides a replayed request id exactly once", async () => {
		const { fixture, controller, ledger } = attach({
			fixture: "raw-peer",
			config: { waitMs: 400, steps: [{ requestId: "replayed-request", delayMs: 50 }, { requestId: "replayed-request", delayMs: 50 }] },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		assert.equal(ledger.decisions.length, 1, "a duplicate id is never decided twice");
		const received = (result.received ?? []) as Array<{ requestId: string; decision: ChildAuthorityDecision }>;
		assert.equal(received.length, 1);
		assert.equal(received[0]?.requestId, "replayed-request");
		assert.equal(received[0]?.decision.outcome, "allow");
	});

	it("keeps replay refused for the whole lease and revokes when its id budget is exhausted", async () => {
		const budget = CHILD_AUTHORITY_MAX_DECIDED_REQUEST_IDS;
		const steps: Array<Record<string, unknown>> = [];
		for (let index = 1; index <= budget; index += 1) steps.push({ requestId: `budget-${index}` });
		// One id past the budget: the lease must revoke instead of forgetting the oldest ids.
		steps.push({ requestId: `budget-${budget + 1}` });
		// The very first id is replayed after the budget is spent: it must never be decided again.
		steps.push({ requestId: "budget-1", waitForDecision: false });
		steps.push({ requestId: "after-revoke", waitForDecision: false });
		const { fixture, controller, ledger } = attach({ fixture: "raw-peer", config: { sequential: true, stepTimeoutMs: 10_000, waitMs: 200, steps } });
		const prepared = await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		const received = (result.received ?? []) as Array<{ requestId: string; decision: ChildAuthorityDecision }>;
		assert.equal(received.length, budget + 1, "only accepted ids receive a decision, and the spent budget is reported");
		assert.equal(received[budget]?.requestId, `budget-${budget + 1}`);
		assert.equal(received[budget]?.decision.outcome, "unavailable", "exhaustion fails closed");
		assert.match(received[budget]?.decision.rationale ?? "", /revoked/);
		assert.equal(ledger.decisions.length, budget, "no id is ever re-decided, including the oldest one");
		assert.deepEqual(result.revokes, [prepared.leaseId], "the lease is revoked on exhaustion");
	});

	it("denies malformed or oversized actions, ignores protocol noise, and keeps serving", async () => {
		const { fixture, controller, ledger } = attach({
			fixture: "raw-peer",
			config: {
				waitMs: 500,
				steps: [
					{ raw: "not-an-envelope" },
					{ raw: { kind: "child-authority:request", version: 1, leaseId: "x" } },
					{ requestId: "identity-override", action: { surface: "write", target: "/etc/passwd", reason: "escape the workspace", cwd: "/etc" } },
					{ requestId: "bad-surface", action: { surface: "escalate", target: "/etc/passwd", reason: "escalate the sandbox" } },
					{ requestId: "oversized-target", action: { surface: "write", target: "x".repeat(3_000), reason: "oversized target" } },
					{ requestId: "no-request-id", drop: ["requestId"] },
					{ requestId: "x".repeat(400) },
					{ requestId: "valid-request", action: { surface: "read", target: `${CWD}/src/file.ts`, reason: "read the assigned file" } },
				],
			},
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		const received = (result.received ?? []) as Array<{ requestId: string; decision: ChildAuthorityDecision }>;
		const byId = new Map(received.map((entry) => [entry.requestId, entry.decision]));
		for (const requestId of ["identity-override", "bad-surface", "oversized-target"]) {
			const decision = byId.get(requestId);
			assert.equal(decision?.outcome, "deny", `${requestId} must fail closed`);
			assert.match(decision?.rationale ?? "", /malformed|bounds/i);
		}
		assert.equal(byId.get("valid-request")?.outcome, "allow", "the channel keeps serving after protocol noise");
		assert.equal(byId.has("no-request-id"), false);
		assert.equal(byId.has("x".repeat(400)), false, "an out-of-bound request id is ignored");
		assert.equal(ledger.decisions.length, 1, "only the well-formed action reaches the parent authorizer");
		assert.equal(ledger.decisions[0]?.action.target, `${CWD}/src/file.ts`);
	});

	it("never forwards a malformed, failed, or stalled provider decision as consent", async () => {
		const malformed = attach({ provider: { decide: async () => ({ outcome: "ALLOW" }) as unknown as ChildAuthorityDecision }, config: REQUEST_CONFIG });
		await malformed.controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const malformedDecision = decisionsOf((await malformed.fixture.outcome).result)[0]?.decision;
		assert.equal(malformedDecision?.outcome, "unavailable", "a free-form ALLOW is never a decision");

		const failed = attach({
			provider: {
				decide: async () => {
					throw new Error("provider exploded");
				},
			},
			config: REQUEST_CONFIG,
		});
		await failed.controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const failedDecision = decisionsOf((await failed.fixture.outcome).result)[0]?.decision;
		assert.equal(failedDecision?.outcome, "unavailable");
		assert.match(failedDecision?.rationale ?? "", /could not decide/);

		const stalled = attach({ provider: { decide: () => new Promise<ChildAuthorityDecision>(() => {}) }, decisionTimeoutMs: 50, config: REQUEST_CONFIG });
		await stalled.controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const stalledDecision = decisionsOf((await stalled.fixture.outcome).result)[0]?.decision;
		assert.equal(stalledDecision?.outcome, "unavailable");
		assert.match(stalledDecision?.rationale ?? "", /in time/, "the parent decision timeout is reported as a timeout");
	});

	it("keeps serving after a provider decide throws synchronously", async () => {
		let calls = 0;
		const { fixture, controller, ledger } = attach({
			provider: {
				decide: () => {
					calls += 1;
					if (calls === 1) throw new Error("synchronous provider throw");
					return Promise.resolve<ChildAuthorityDecision>({ outcome: "allow", rationale: "the host survived the synchronous throw" });
				},
			},
			config: { consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST, { surface: "read", target: `${CWD}/src/file.ts`, reason: "read the assigned file" }] },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		const requests = decisionsOf(result);
		assert.equal(requests[0]?.decision?.outcome, "unavailable", "a synchronous throw is a failed decision, not a host fault");
		assert.equal(requests[1]?.decision?.outcome, "allow", "the next request is decided normally");
		assert.equal(ledger.decisions.length, 2);
	});

	it("propagates a child request cancellation so the parent aborts review and no stale approval lands", async () => {
		let resolveLate: ((decision: ChildAuthorityDecision) => void) | undefined;
		const { fixture, controller, ledger } = attach({
			provider: {
				decide: (action, signal) =>
					new Promise<ChildAuthorityDecision>((resolve) => {
						resolveLate = resolve;
						signal.addEventListener("abort", () => {
							// The provider itself ignores the abort and answers late; the parent must still not deliver it.
							setTimeout(() => resolve({ outcome: "allow", rationale: "stale approval" }), 100);
						}, { once: true });
					}),
			},
			config: { ...REQUEST_CONFIG, abortAfterMs: 50, lingerMs: 500 },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await waitFor(() => ledger.decisions.length === 1, "the parent to review the request");
		await waitFor(() => ledger.decisions[0]?.signal.aborted === true, "the parent to abort the review on cancellation");
		resolveLate?.({ outcome: "allow", rationale: "stale approval" });
		const { result } = await fixture.outcome;
		const decision = decisionsOf(result)[0]?.decision;
		assert.equal(decision?.outcome, "cancelled", "cancellation is not consent");
		assert.equal(result.decisionsReceived, 0, "no decision travels for a released request");
		assert.equal(ledger.decisions.length, 1);
	});

	it("propagates a child client disposal as a release of the parent's review work", async () => {
		const { fixture, controller, ledger } = attach({
			provider: { decide: () => new Promise<ChildAuthorityDecision>(() => {}) },
			config: { ...REQUEST_CONFIG, disposeAfterMs: 50, lingerMs: 300 },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await waitFor(() => ledger.decisions.length === 1, "the parent to review the request");
		await waitFor(() => ledger.disposed === 1, "client disposal to release the provider lease");
		assert.equal(fixture.child.exitCode, null, "release must not depend on process exit");
		const { result } = await fixture.outcome;
		assert.equal(decisionsOf(result)[0]?.decision?.outcome, "cancelled");
		assert.equal(result.decisionsReceived, 0);
		assert.equal(ledger.decisions[0]?.signal.aborted, true, "client disposal aborts the parent's pending decision");
		assert.equal(ledger.disposed, 1, "client disposal releases the whole provider lease before process exit");
	});

	it("revokes pending work and the child lease when the parent disposes authority", async () => {
		const { fixture, controller, ledger } = attach({
			provider: {
				decide: (_action, signal) =>
					new Promise<ChildAuthorityDecision>((resolve) => {
						signal.addEventListener("abort", () => resolve({ outcome: "allow", rationale: "late provider decision" }), { once: true });
					}),
			},
			config: { requestTimeoutMs: 20_000, waitForRevokeMs: 5_000, consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST] },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await waitFor(() => ledger.decisions.length === 1, "the parent to review the request");
		controller.dispose();
		const { result } = await fixture.outcome;
		assert.equal(decisionsOf(result)[0]?.decision?.outcome, "cancelled", "disposal is not consent");
		assert.equal(result.signalAborted, true, "the child lease signal aborts on revocation");
		assert.equal(result.decisionsReceived, 0, "revocation does not travel as a decision");
		assert.equal(ledger.disposed, 1, "the provider lease is disposed");
		assert.equal(ledger.decisions[0]?.signal.aborted, true, "the in-flight provider decision is aborted");
		assert.deepEqual(result.leaseAfterRevoke, { outcome: "rejected", code: "cancelled" }, "a revoked grant is never handed back as live authority");
	});

	it("reports a timed-out request as unavailable and releases the parent's review work", async () => {
		const { fixture, controller, ledger } = attach({
			provider: { decide: () => new Promise<ChildAuthorityDecision>((resolve) => setTimeout(() => resolve({ outcome: "allow", rationale: "late provider decision" }), 250)) },
			config: { requestTimeoutMs: 60, lingerMs: 500, consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST] },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		const { result } = await fixture.outcome;
		assert.equal(decisionsOf(result)[0]?.decision?.outcome, "unavailable", "a timeout is not an allow");
		assert.equal(ledger.decisions.length, 1);
		assert.equal(ledger.decisions[0]?.signal.aborted, true, "the child's timeout aborts the parent's review work");
		assert.equal(result.decisionsReceived, 0, "the late provider answer is never delivered");
	});

	it("disposes the provider lease when the child process disappears", async () => {
		const { fixture, controller, ledger } = attach({
			provider: { decide: () => new Promise<ChildAuthorityDecision>(() => {}) },
			config: { requestTimeoutMs: 20_000, consumers: DEFAULT_CONSUMERS, acknowledge: DEFAULT_CONSUMERS, requests: [WRITE_REQUEST] },
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await waitFor(() => ledger.decisions.length === 1, "the parent to review the request");
		fixture.child.kill("SIGKILL");
		await waitFor(() => ledger.disposed === 1, "the provider lease to be disposed");
		assert.equal(fixture.child.listenerCount("message"), 0, "a vanished child leaves no listeners behind");
		assert.equal(ledger.decisions[0]?.signal.aborted, true);
	});

	it("revokes the child lease when the authority service aborts", async () => {
		const { fixture, controller, ledger } = attach({ config: { waitForRevokeMs: 5_000 } });
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		ledger.cancelService();
		const { result } = await fixture.outcome;
		assert.equal(result.signalAborted, true);
		assert.equal(ledger.disposed, 1);
		assert.equal(fixture.child.listenerCount("message"), 0);
	});

	it("fails a replayed lease grant closed instead of granting twice", async () => {
		const { fixture, controller } = attach({ config: { waitForRevokeMs: 5_000 } });
		const prepared = await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		fixture.child.send(grantOf(prepared));
		const { result } = await fixture.outcome;
		assert.equal(result.signalAborted, true, "the second grant revokes the held lease");
		assert.deepEqual(result.leaseAfterRevoke, { outcome: "rejected", code: "already-prepared" });
	});

	it("ignores a revoke that matches the lease id but not the audience", async () => {
		const { fixture, controller } = attach({ config: { waitForRevokeMs: 300 } });
		const prepared = await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		fixture.child.send({ kind: "child-authority:revoke", version: 1, sessionId: "session-other", runId: RUN_ID, leaseId: prepared.leaseId });
		const { result } = await fixture.outcome;
		assert.equal(result.signalAborted, false, "another session's revoke does not revoke this lease");
		assert.deepEqual(result.leaseAfterRevoke, { outcome: "returned", leaseId: prepared.leaseId, aborted: false });
	});

	it("ignores a release that names another lease", async () => {
		let release: (decision: ChildAuthorityDecision) => void = () => {};
		const decision = new Promise<ChildAuthorityDecision>((resolve) => { release = resolve; });
		const { fixture, controller, ledger } = attach({
			fixture: "raw-peer",
			provider: { decide: () => decision },
			config: {
				waitMs: 400,
				steps: [
					{ requestId: "kept-request", delayMs: 50 },
					{ requestId: "kept-request", overrides: { kind: "child-authority:cancel", reason: "cancelled", leaseId: "lease-forged" }, waitForDecision: false },
				],
			},
		});
		let forgedCancelSeen = false;
		fixture.child.on("message", (message: { kind?: string; leaseId?: string }) => {
			if (message.kind === "child-authority:cancel" && message.leaseId === "lease-forged") forgedCancelSeen = true;
		});
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD });
		await waitFor(() => forgedCancelSeen, "the forged cancel to reach the parent's listener");
		assert.equal(ledger.decisions.length, 1);
		assert.equal(ledger.decisions[0]?.signal.aborted, false, "the forged cancel arrived while the review was still pending");
		release({ outcome: "allow", rationale: "reviewed" });
		const { result } = await fixture.outcome;
		const received = (result.received ?? []) as Array<{ requestId: string; decision: ChildAuthorityDecision }>;
		assert.equal(received.length, 1, "a forged lease id cannot release the parent's review");
		assert.equal(received[0]?.decision.outcome, "allow");
		assert.equal(ledger.decisions.length, 1);
	});

	it("fails closed on a grant envelope this build cannot read", async () => {
		const fixture = startFixture("runner-client", { leaseTimeoutMs: 5_000 });
		cleanups.push(() => fixture.child.kill("SIGKILL"));
		fixture.child.send({ kind: "child-authority:lease", version: 2, sessionId: SESSION_ID, runId: RUN_ID, leaseId: "lease-from-the-future" });
		const { result } = await fixture.outcome;
		assert.equal(errorsOf(result)[0]?.step, "awaitLease");
		assert.equal(errorsOf(result)[0]?.code, "version-mismatch", "an unreadable grant never becomes authority");
	});

	it("refuses to attach authority without a service or with a foreign session", async () => {
		const fixture = startFixture("runner-client", { leaseTimeoutMs: 400 });
		cleanups.push(() => fixture.child.kill("SIGKILL"));
		await assert.rejects(
			() => Promise.resolve().then(() => readChildAuthorityProvider(SESSION_ID)),
			(error: unknown) => error instanceof ChildAuthorityError && error.code === "service-missing",
		);
		const { provider } = publishFakeProvider();
		await assert.rejects(
			() => Promise.resolve().then(() => createChildAuthorityController({ child: fixture.child, provider, sessionId: "session-other", runId: RUN_ID })),
			(error: unknown) => error instanceof ChildAuthorityError && error.code === "session-mismatch",
		);
		const { result } = await fixture.outcome;
		const errors = errorsOf(result);
		assert.equal(errors[0]?.code, "transport-unavailable", "a child that never receives a lease fails closed");
		assert.match(errors[0]?.message ?? "", /within 400ms/);
	});

	it("validates timeout inputs instead of accepting an unbounded wait", async () => {
		const fixture = startFixture("runner-client", { leaseTimeoutMs: 400 });
		cleanups.push(() => fixture.child.kill("SIGKILL"));
		const { provider } = publishFakeProvider();
		for (const invalid of [0, -1, 1.5, Number.NaN]) {
			for (const key of ["decisionTimeoutMs", "prepareTimeoutMs"] as const) {
				await assert.rejects(
					() => Promise.resolve().then(() => createChildAuthorityController({ child: fixture.child, provider, sessionId: SESSION_ID, runId: RUN_ID, [key]: invalid })),
					(error: unknown) => error instanceof ChildAuthorityError && error.code === "invalid-identity",
				);
			}
		}
	});

	it("binds the runner's own process endpoint instead of an injected peer", () => {
		expectCode(() => createChildAuthorityRunnerClient(), "transport-unavailable");
		// A fake handle passed as an option is ignored: only the runner's own IPC channel can carry a lease.
		expectCode(
			() => (createChildAuthorityRunnerClient as (options: unknown) => unknown)({ process: { send: () => true, on: () => undefined, off: () => undefined, connected: true } }),
			"transport-unavailable",
		);
	});
});
