import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as api from "../../src/api/child-authority.ts";
import {
	CHILD_AUTHORITY_LEASE_SLOT_KEY,
	CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS,
	CHILD_AUTHORITY_MAX_RATIONALE_BYTES,
	CHILD_AUTHORITY_PROVIDER_KEY,
	CHILD_AUTHORITY_PROVIDER_VERSION,
	ChildAuthorityError,
	acknowledgeChildAuthority,
	bindChildAuthorityIdentity,
	claimChildAuthority,
	createChildAuthorityLease,
	parseChildAuthorityAction,
	parseChildAuthorityDecision,
	parseChildAuthorityPayload,
	parseChildAuthorityRequestId,
	prepareChildAuthorityServiceLease,
	readChildAuthorityProvider,
	withChildAuthority,
	type ChildAuthorityAction,
	type ChildAuthorityCancelReason,
	type ChildAuthorityDecision,
	type ChildAuthorityIdentity,
	type ChildAuthorityProvider,
	type ChildAuthorityProviderLease,
} from "../../src/runs/shared/child-authority.ts";

const SESSION_ID = "session-authority-fixture";
const RUN_ID = "run-authority-fixture";
const CWD = "/workspace/project";
const REQUIRED_EXTENSIONS = [
	{ id: "pi-sbx", path: "/fake/extensions/pi-sbx.ts" },
	{ id: "guardian", path: "/fake/extensions/guardian.ts" },
];

const identity = (): ChildAuthorityIdentity => bindChildAuthorityIdentity({ parentSessionId: SESSION_ID, runId: RUN_ID }, { agent: "worker", index: 0, cwd: CWD });

const writeAction: ChildAuthorityAction = { surface: "write", target: "/workspace/project/src/file.ts", reason: "apply the assigned edit" };

interface FakeServiceLeaseOptions {
	payload?: unknown;
	requiredConsumers?: unknown;
	decide?: (action: ChildAuthorityAction, signal: AbortSignal) => Promise<ChildAuthorityDecision>;
	signal?: AbortSignal;
}

function fakeServiceLease(options: FakeServiceLeaseOptions = {}): { lease: ChildAuthorityProviderLease; disposed: () => number } {
	let disposed = 0;
	return {
		lease: {
			payload: (options.payload ?? { version: 1, allowWrite: [CWD] }) as ChildAuthorityProviderLease["payload"],
			requiredConsumers: (options.requiredConsumers ?? ["pi-sbx", "guardian"]) as string[],
			signal: options.signal,
			decide: options.decide ?? (async () => ({ outcome: "allow" })),
			dispose: () => {
				disposed += 1;
			},
		},
		disposed: () => disposed,
	};
}

function fakeProvider(lease: ChildAuthorityProviderLease, extensions = REQUIRED_EXTENSIONS): { provider: ChildAuthorityProvider; prepared: ChildAuthorityIdentity[] } {
	const prepared: ChildAuthorityIdentity[] = [];
	return {
		provider: {
			version: CHILD_AUTHORITY_PROVIDER_VERSION,
			sessionId: SESSION_ID,
			requiredExtensions: extensions,
			prepare: async (identityValue) => {
				prepared.push(identityValue);
				return lease;
			},
		},
		prepared,
	};
}

/** A provider whose preparation never settles on its own, so the caller's bound decides the outcome. */
function pendingProvider(): { provider: ChildAuthorityProvider; resolve: (lease: ChildAuthorityProviderLease) => void } {
	let settle: ((lease: ChildAuthorityProviderLease) => void) | undefined;
	const pending = new Promise<ChildAuthorityProviderLease>((resolve) => {
		settle = resolve;
	});
	return {
		provider: { version: CHILD_AUTHORITY_PROVIDER_VERSION, sessionId: SESSION_ID, requiredExtensions: REQUIRED_EXTENSIONS, prepare: () => pending },
		resolve: (lease) => settle?.(lease),
	};
}

function installProvider(provider: ChildAuthorityProvider): void {
	(globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY] = provider;
}

function clearProvider(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
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

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

interface CapturedRequest {
	requestId: string;
	action: ChildAuthorityAction;
}

interface CapturedCancel {
	requestId: string;
	reason: ChildAuthorityCancelReason;
}

interface CodeOnlyLeaseOptions {
	requestTimeoutMs?: number;
	send?: (requestId: string, action: ChildAuthorityAction) => boolean;
	requiredConsumers?: string[];
}

function codeOnlyLease(options: CodeOnlyLeaseOptions = {}) {
	const sent: CapturedRequest[] = [];
	const cancels: CapturedCancel[] = [];
	const handle = createChildAuthorityLease({
		leaseId: "lease-fixture-1",
		identity: identity(),
		payload: { version: 1, allowWrite: [CWD] },
		requiredConsumers: options.requiredConsumers ?? ["pi-sbx", "guardian"],
		send: (requestId, action) => {
			sent.push({ requestId, action });
			return options.send ? options.send(requestId, action) : true;
		},
		cancel: (requestId, reason) => {
			cancels.push({ requestId, reason });
		},
		requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
	});
	return { ...handle, sent, cancels };
}

/** A lease whose required consumers have all claimed and acknowledged, so requests are reviewable. */
function readyLease(options: CodeOnlyLeaseOptions = {}) {
	const current = codeOnlyLease(options);
	withChildAuthority(current.lease, () => {
		for (const consumerId of current.lease.requiredConsumers) {
			claimChildAuthority(consumerId, CWD);
			acknowledgeChildAuthority(consumerId);
		}
	});
	return current;
}

describe("child authority provider slot", () => {
	beforeEach(clearProvider);
	afterEach(clearProvider);

	it("reports a missing, foreign-version, or foreign-session service explicitly", () => {
		expectCode(() => readChildAuthorityProvider(), "service-missing");
		installProvider({ version: 1, sessionId: SESSION_ID, requiredExtensions: [], prepare: async () => fakeServiceLease().lease } as unknown as ChildAuthorityProvider);
		expectCode(() => readChildAuthorityProvider(), "version-mismatch");
		installProvider({ version: CHILD_AUTHORITY_PROVIDER_VERSION, sessionId: SESSION_ID, requiredExtensions: REQUIRED_EXTENSIONS, prepare: async () => fakeServiceLease().lease });
		const provider = readChildAuthorityProvider(SESSION_ID);
		assert.equal(provider.sessionId, SESSION_ID);
		assert.deepEqual(provider.requiredExtensions.map((extension) => extension.id), ["pi-sbx", "guardian"]);
		assert.ok(Object.isFrozen(provider));
		expectCode(() => readChildAuthorityProvider("another-session"), "session-mismatch");
		installProvider({ version: CHILD_AUTHORITY_PROVIDER_VERSION, sessionId: SESSION_ID, requiredExtensions: [{ id: "pi-sbx", path: "relative/path.ts" }], prepare: async () => fakeServiceLease().lease });
		expectCode(() => readChildAuthorityProvider(), "service-malformed");
	});

	it("prepares only a bounded payload bound to the loaded required extensions", async () => {
		const oversized = { blob: "x".repeat(64 * 1024) };
		const cases: Array<{ lease: ChildAuthorityProviderLease; code: string }> = [
			{ lease: fakeServiceLease({ payload: oversized }).lease, code: "invalid-payload" },
			{ lease: fakeServiceLease({ payload: [1, 2, 3] }).lease, code: "invalid-payload" },
			{ lease: fakeServiceLease({ requiredConsumers: ["pi-sbx", "model-tool"] }).lease, code: "invalid-lease" },
			{ lease: fakeServiceLease({ requiredConsumers: ["pi-sbx", "pi-sbx"] }).lease, code: "invalid-lease" },
			{ lease: { ...fakeServiceLease().lease, decide: undefined } as unknown as ChildAuthorityProviderLease, code: "service-malformed" },
		];
		for (const entry of cases) {
			const { provider } = fakeProvider(entry.lease);
			await expectRejectedWithCode(
				() => prepareChildAuthorityServiceLease({ provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
				entry.code,
			);
		}
	});

	it("disposes the returned service lease when its payload, consumers, or signal fail validation", async () => {
		const invalidPayload = fakeServiceLease({ payload: [1, 2, 3] });
		await expectRejectedWithCode(
			() => prepareChildAuthorityServiceLease({ provider: fakeProvider(invalidPayload.lease).provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
			"invalid-payload",
		);
		assert.equal(invalidPayload.disposed(), 1, "an unusable payload still releases the provider lease exactly once");

		const invalidConsumers = fakeServiceLease({ requiredConsumers: ["pi-sbx", "model-tool"] });
		await expectRejectedWithCode(
			() => prepareChildAuthorityServiceLease({ provider: fakeProvider(invalidConsumers.lease).provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
			"invalid-lease",
		);
		assert.equal(invalidConsumers.disposed(), 1);

		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		const aborted = fakeServiceLease({ signal: alreadyAborted.signal });
		await expectRejectedWithCode(
			() => prepareChildAuthorityServiceLease({ provider: fakeProvider(aborted.lease).provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
			"cancelled",
		);
		assert.equal(aborted.disposed(), 1, "a cancelled prepared lease is disposed instead of handed out");
	});

	it("disposes malformed provider leases when a usable disposer exists", async () => {
		for (const malformed of [{ decide: undefined }, { signal: {} }]) {
			const service = fakeServiceLease();
			const lease = { ...service.lease, ...malformed } as unknown as ChildAuthorityProviderLease;
			await expectRejectedWithCode(
				() => prepareChildAuthorityServiceLease({ provider: fakeProvider(lease).provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
				"service-malformed",
			);
			assert.equal(service.disposed(), 1);
		}
	});

	it("returns an immutable payload copy", async () => {
		const payload = { version: 1, allowWrite: [CWD], nested: { mode: "intersect" } };
		const { provider } = fakeProvider(fakeServiceLease({ payload }).lease);
		const prepared = await prepareChildAuthorityServiceLease({ provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal });
		assert.deepEqual(prepared.payload, payload);
		assert.ok(Object.isFrozen(prepared.payload));
		assert.ok(Object.isFrozen(prepared.payload.nested));
		payload.allowWrite.push("/elsewhere");
		assert.deepEqual(prepared.payload.allowWrite, [CWD], "the prepared payload is a detached copy");
		assert.equal(typeof prepared.decide(writeAction, new AbortController().signal).then, "function", "decide is always promise-shaped");
	});

	it("bounds preparation even when the provider ignores its signal, and disposes a late lease", async () => {
		const { provider, resolve } = pendingProvider();
		const bound = new AbortController();
		const preparing = prepareChildAuthorityServiceLease({ provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: bound.signal });
		bound.abort(new ChildAuthorityError("timeout", "Child authority preparation did not finish in time."));
		await expectRejectedWithCode(() => preparing, "timeout");

		const late = fakeServiceLease();
		resolve(late.lease);
		await flushMicrotasks();
		assert.equal(late.disposed(), 1, "a lease handed back after the bound is disposed, not retained");
	});

	it("turns a synchronous provider prepare throw into a bounded preparation failure", async () => {
		const provider: ChildAuthorityProvider = {
			version: CHILD_AUTHORITY_PROVIDER_VERSION,
			sessionId: SESSION_ID,
			requiredExtensions: REQUIRED_EXTENSIONS,
			prepare: () => {
				throw new Error("sync provider failure");
			},
		};
		await expectRejectedWithCode(
			() => prepareChildAuthorityServiceLease({ provider, requiredExtensions: REQUIRED_EXTENSIONS, identity: identity(), signal: new AbortController().signal }),
			"service-malformed",
		);
	});
});

describe("child authority identity, action, and decision bounds", () => {
	it("binds the host audience and refuses child-supplied parent ids or a relative cwd", () => {
		const bound = bindChildAuthorityIdentity({ parentSessionId: SESSION_ID, runId: RUN_ID }, { agent: "worker", index: 2, cwd: CWD });
		assert.deepEqual(bound, { parentSessionId: SESSION_ID, runId: RUN_ID, agent: "worker", index: 2, cwd: CWD });
		assert.ok(Object.isFrozen(bound));
		expectCode(() => bindChildAuthorityIdentity({ parentSessionId: SESSION_ID, runId: RUN_ID }, { agent: "worker", index: 0, cwd: CWD, parentSessionId: "other" }), "invalid-identity");
		expectCode(() => bindChildAuthorityIdentity({ parentSessionId: SESSION_ID, runId: RUN_ID }, { agent: "worker", index: 0, cwd: CWD, runId: "other" }), "invalid-identity");
		expectCode(() => bindChildAuthorityIdentity({ parentSessionId: SESSION_ID, runId: RUN_ID }, { agent: "worker", index: 0, cwd: "relative/dir" }), "invalid-identity");
		expectCode(() => bindChildAuthorityIdentity({ parentSessionId: "", runId: RUN_ID }, { agent: "worker", index: 0, cwd: CWD }), "invalid-identity");
	});

	it("rejects actions that would overwrite identity or cwd", () => {
		assert.deepEqual(parseChildAuthorityAction(writeAction), writeAction);
		for (const invalid of [
			{ ...writeAction, cwd: "/etc" },
			{ ...writeAction, parentSessionId: "other" },
			{ ...writeAction, surface: "escalate" },
			{ ...writeAction, target: "x".repeat(4_000) },
			{ surface: "write", target: "", reason: "empty target" },
			{ surface: "write", target: "/etc/passwd", reason: "y".repeat(2_000) },
		]) {
			expectCode(() => parseChildAuthorityAction(invalid), "invalid-action");
		}
	});

	it("carries full Unicode tool JSON under a separate budget without enlarging ordinary actions or policy", () => {
		const tool = { surface: "tool", target: JSON.stringify({ tool_name: "write", input: { content: "界".repeat(21000) } }), reason: "review exact content" };
		assert.ok(Buffer.byteLength(tool.target) > 32 * 1024);
		assert.deepEqual(parseChildAuthorityAction(tool), tool);
		expectCode(() => parseChildAuthorityAction({ ...tool, surface: "write" }), "invalid-action");
		expectCode(() => parseChildAuthorityPayload({ value: tool.target }), "invalid-payload");
		expectCode(() => parseChildAuthorityAction({ ...tool, target: "x".repeat(64001) }), "invalid-action");
		expectCode(() => parseChildAuthorityAction({ ...tool, reason: "x".repeat(513) }), "invalid-action");
		expectCode(() => parseChildAuthorityAction({ ...tool, identity: { parentSessionId: "forged" } }), "invalid-action");
	});

	it("forwards a typed parent batch termination only on a non-allow verdict", () => {
		assert.deepEqual(parseChildAuthorityDecision({ outcome: "deny", terminate: true }), { outcome: "deny", terminate: true });
		assert.deepEqual(parseChildAuthorityDecision({ outcome: "allow", terminate: false }), { outcome: "allow" });
		expectCode(() => parseChildAuthorityDecision({ outcome: "allow", terminate: true }), "invalid-decision");
		expectCode(() => parseChildAuthorityDecision({ outcome: "deny", terminate: "true" }), "invalid-decision");
	});

	it("accepts only the four terminal outcomes and bounds the rationale", () => {
		for (const outcome of ["allow", "deny", "unavailable", "cancelled"] as const) assert.equal(parseChildAuthorityDecision({ outcome }).outcome, outcome);
		expectCode(() => parseChildAuthorityDecision({ outcome: "defer" }), "invalid-decision");
		expectCode(() => parseChildAuthorityDecision({ outcome: "ALLOW" }), "invalid-decision");
		expectCode(() => parseChildAuthorityDecision({ text: "ALLOW" }), "invalid-decision");
		expectCode(() => parseChildAuthorityDecision({ outcome: "allow", note: "extra" }), "invalid-decision");
		const bounded = parseChildAuthorityDecision({ outcome: "deny", rationale: `denied: ${"réason ".repeat(400)}` });
		assert.equal(bounded.outcome, "deny");
		assert.ok(bounded.rationale !== undefined && Buffer.byteLength(bounded.rationale, "utf8") <= CHILD_AUTHORITY_MAX_RATIONALE_BYTES);
		assert.deepEqual(parseChildAuthorityDecision({ outcome: "deny", rationale: "   " }), { outcome: "deny" });
	});

	it("bounds request ids so a correlated reply stays cheap and loggable", () => {
		assert.equal(parseChildAuthorityRequestId("0f2c1a3e-1b2c-4d5e-8f90-123456789abc"), "0f2c1a3e-1b2c-4d5e-8f90-123456789abc");
		expectCode(() => parseChildAuthorityRequestId("x".repeat(400)), "invalid-lease");
		expectCode(() => parseChildAuthorityRequestId("../escape"), "invalid-lease");
		expectCode(() => parseChildAuthorityRequestId(""), "invalid-lease");
		expectCode(() => parseChildAuthorityRequestId(42), "invalid-lease");
	});

	it("bounds the prepared payload shape", () => {
		expectCode(() => parseChildAuthorityPayload("not-an-object"), "invalid-payload");
		expectCode(() => parseChildAuthorityPayload({ nested: { a: { b: { c: { d: { e: { f: 1 } } } } } } }), "invalid-payload");
		expectCode(() => parseChildAuthorityPayload({ value: Number.POSITIVE_INFINITY }), "invalid-payload");
		expectCode(() => parseChildAuthorityPayload({ value: new Date() }), "invalid-payload");
		expectCode(() => parseChildAuthorityPayload({ value: "x".repeat(9_000) }), "invalid-payload");
	});
});

describe("child authority code-only consumption", () => {
	it("requires every required consumer to claim and acknowledge before readiness", () => {
		let current = codeOnlyLease();
		expectCode(() => current.lease.assertReady(), "not-ready");
		expectCode(() => claimChildAuthority("pi-sbx", CWD), "invalid-lease");
		expectCode(() => acknowledgeChildAuthority("pi-sbx"), "invalid-lease");

		withChildAuthority(current.lease, () => {
			const claimed = claimChildAuthority("pi-sbx", CWD);
			assert.equal(claimed, current.lease, "claiming hands the consumer the live lease for its tool callbacks");
			expectCode(() => claimChildAuthority("pi-sbx", CWD), "invalid-lease");
			expectCode(() => claimChildAuthority("model-tool", CWD), "invalid-lease");
			expectCode(() => claimChildAuthority("guardian", "/workspace/other"), "invalid-lease");
			expectCode(() => current.lease.assertReady(), "not-ready");
			expectCode(() => acknowledgeChildAuthority("guardian"), "not-ready");
			acknowledgeChildAuthority("pi-sbx");
			const partial = expectCode(() => current.lease.assertReady(), "not-ready");
			assert.match(partial.message, /guardian/, "the missing consumer is named");
		});

		withChildAuthority(current.lease, () => {
			claimChildAuthority("guardian", `${CWD}/`);
			acknowledgeChildAuthority("guardian");
			current.lease.assertReady();
		});

		current.lease.dispose();
		expectCode(() => current.lease.assertReady(), "disposed");
		current = codeOnlyLease();
		withChildAuthority(current.lease, () => assert.equal(typeof api.claimChildAuthority, "function"));
		current.lease.dispose();
	});

	it("refuses to request authority before every required consumer acknowledged", async () => {
		const current = codeOnlyLease();
		const early = await current.lease.request(writeAction);
		assert.equal(early.outcome, "unavailable", "an unbound adapter set must not reach the parent for review");
		assert.match(early.rationale ?? "", /not ready/);
		assert.equal(current.sent.length, 0, "nothing was sent to the parent");
		withChildAuthority(current.lease, () => {
			claimChildAuthority("pi-sbx", CWD);
			claimChildAuthority("guardian", CWD);
			acknowledgeChildAuthority("pi-sbx");
		});
		assert.equal((await current.lease.request(writeAction)).outcome, "unavailable", "one acknowledged consumer is not readiness");
		withChildAuthority(current.lease, () => acknowledgeChildAuthority("guardian"));
		const pending = current.lease.request(writeAction);
		assert.equal(current.sent.length, 1, "a ready lease reaches the parent");
		current.deliverDecision(current.sent[0]!.requestId, { outcome: "allow" });
		assert.equal((await pending).outcome, "allow");
		current.lease.dispose();
	});

	it("shares one versioned lease slot across a second module copy", async () => {
		const specifier = new URL("../../src/runs/shared/child-authority.ts?copy=bundle", import.meta.url).href;
		const copy = (await import(specifier)) as typeof import("../../src/runs/shared/child-authority.ts");
		assert.notEqual(copy.claimChildAuthority, claimChildAuthority, "the second instance is a distinct module copy");
		assert.equal(copy.CHILD_AUTHORITY_LEASE_SLOT_KEY, CHILD_AUTHORITY_LEASE_SLOT_KEY);
		const current = codeOnlyLease();
		withChildAuthority(current.lease, () => {
			copy.claimChildAuthority("pi-sbx", CWD);
			claimChildAuthority("guardian", CWD);
			copy.acknowledgeChildAuthority("pi-sbx");
			acknowledgeChildAuthority("guardian");
			current.lease.assertReady();
		});
		current.lease.dispose();
	});

	it("refuses a forged lease object and a malformed lease slot", () => {
		expectCode(() => withChildAuthority({} as never, () => undefined), "invalid-lease");
		const slotKey = CHILD_AUTHORITY_LEASE_SLOT_KEY;
		const previous = (globalThis as Record<PropertyKey, unknown>)[slotKey];
		try {
			(globalThis as Record<PropertyKey, unknown>)[slotKey] = { version: 2, storage: previous };
			expectCode(() => claimChildAuthority("pi-sbx", CWD), "service-malformed");
		} finally {
			(globalThis as Record<PropertyKey, unknown>)[slotKey] = previous;
		}
		assert.ok((globalThis as Record<PropertyKey, unknown>)[slotKey] !== undefined, "the slot is process-wide and versioned");
	});
});

describe("child authority lease requests", () => {
	it("correlates one parent decision per request id and ignores stale ids", async () => {
		const current = readyLease();
		const pending = current.lease.request(writeAction);
		assert.equal(current.sent.length, 1);
		const requestId = current.sent[0]!.requestId;
		assert.deepEqual(current.sent[0]!.action, writeAction);
		assert.equal(current.deliverDecision(requestId, { outcome: "allow", rationale: "inside the assigned workspace" }), "delivered");
		assert.deepEqual(await pending, { outcome: "allow", rationale: "inside the assigned workspace" });
		assert.equal(current.deliverDecision(requestId, { outcome: "allow" }), "ignored");
		assert.equal(current.deliverDecision("unknown-request", { outcome: "allow" }), "ignored");
		assert.equal(current.deliverDecision("", { outcome: "allow" }), "ignored");
		assert.equal(current.deliverDecision("x".repeat(400), { outcome: "allow" }), "ignored", "an out-of-bound reply id is not applied");

		const second = current.lease.request(writeAction);
		const secondId = current.sent[1]!.requestId;
		assert.notEqual(secondId, requestId);
		assert.equal(current.deliverDecision(secondId, { outcome: "ALLOW" }), "delivered");
		const malformed = await second;
		assert.equal(malformed.outcome, "unavailable", "a malformed decision is never read as consent");
		current.lease.dispose();
	});

	it("releases parent review work on timeout, caller cancellation, and disposal", async () => {
		const timedOut = readyLease({ requestTimeoutMs: 20 });
		assert.equal((await timedOut.lease.request(writeAction)).outcome, "unavailable");
		assert.deepEqual(timedOut.cancels, [{ requestId: timedOut.sent[0]!.requestId, reason: "timeout" }], "a timeout tells the parent to stop reviewing");

		const cancelledByCaller = readyLease();
		const callerAbort = new AbortController();
		const cancelled = cancelledByCaller.lease.request(writeAction, callerAbort.signal);
		callerAbort.abort();
		assert.equal((await cancelled).outcome, "cancelled");
		assert.deepEqual(cancelledByCaller.cancels, [{ requestId: cancelledByCaller.sent[0]!.requestId, reason: "cancelled" }]);
		assert.equal((await cancelledByCaller.lease.request(writeAction, AbortSignal.abort())).outcome, "cancelled");

		const closed = readyLease({ send: () => false });
		assert.equal((await closed.lease.request(writeAction)).outcome, "cancelled");

		const throwing = readyLease({ send: () => { throw new Error("transport fault"); } });
		assert.equal((await throwing.lease.request(writeAction)).outcome, "cancelled", "a synchronous transport throw settles the request");
		assert.equal((await throwing.lease.request(writeAction)).outcome, "cancelled", "and leaves no pending entry behind");

		const disposed = readyLease();
		const pending = disposed.lease.request(writeAction);
		disposed.lease.dispose();
		assert.equal((await pending).outcome, "cancelled");
		assert.deepEqual(disposed.cancels, [{ requestId: disposed.sent[0]!.requestId, reason: "disposed" }], "disposal releases the parent's review work");
		assert.equal(disposed.lease.signal.aborted, true);
		assert.equal((await disposed.lease.request(writeAction)).outcome, "cancelled");
	});

	it("validates the request timeout input", () => {
		expectCode(() => createChildAuthorityLease({ leaseId: "lease-fixture-2", identity: identity(), payload: {}, requiredConsumers: [], send: () => true, cancel: () => {}, requestTimeoutMs: 0 }), "invalid-lease");
		expectCode(() => createChildAuthorityLease({ leaseId: "lease-fixture-2", identity: identity(), payload: {}, requiredConsumers: [], send: () => true, cancel: () => {}, requestTimeoutMs: 1.5 }), "invalid-lease");
	});

	it("bounds inflight requests and keeps pending work distinguishable from a denial", async () => {
		const current = readyLease();
		const inflight = Array.from({ length: CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS }, () => current.lease.request(writeAction));
		assert.equal(current.sent.length, CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS);
		const overflow = await current.lease.request(writeAction);
		assert.equal(overflow.outcome, "unavailable");
		for (const [index, requestId] of current.sent.map((request) => request.requestId).entries()) {
			current.deliverDecision(requestId, index % 2 === 0 ? { outcome: "allow" } : { outcome: "deny", rationale: "outside the assigned workspace" });
		}
		const outcomes = (await Promise.all(inflight)).map((decision) => decision.outcome);
		assert.equal(outcomes.filter((outcome) => outcome === "allow").length, CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS / 2);
		assert.equal(outcomes.filter((outcome) => outcome === "deny").length, CHILD_AUTHORITY_MAX_INFLIGHT_REQUESTS / 2);
		current.lease.dispose();
	});
});

describe("child authority public surface", () => {
	it("re-exports the code-only contract and the IPC transport without a second registry", () => {
		assert.equal(api.ChildAuthorityError, ChildAuthorityError);
		assert.equal(api.claimChildAuthority, claimChildAuthority);
		assert.equal(api.acknowledgeChildAuthority, acknowledgeChildAuthority);
		assert.equal(api.withChildAuthority, withChildAuthority);
		assert.equal(api.readChildAuthorityProvider, readChildAuthorityProvider);
		assert.equal(CHILD_AUTHORITY_PROVIDER_KEY, Symbol.for("pi-sbx.session-authority.v1"), "the provider slot mirrors pi-sbx and is only read here");
		assert.equal(CHILD_AUTHORITY_LEASE_SLOT_KEY, Symbol.for("pi-subagents.child-authority-lease.v1"));
		assert.equal(api.CHILD_AUTHORITY_PROVIDER_VERSION, 2);
		assert.equal(typeof api.createChildAuthorityController, "function");
		assert.equal(typeof api.createChildAuthorityRunnerClient, "function");
		assert.equal(api.CHILD_AUTHORITY_ENVELOPE_VERSION, 2);
		assert.equal(api.CHILD_AUTHORITY_DEFAULT_PREPARE_TIMEOUT_MS, 30_000);
		assert.equal(api.CHILD_AUTHORITY_DEFAULT_DECISION_TIMEOUT_MS, 600_000);
		assert.equal(api.CHILD_AUTHORITY_DEFAULT_REQUEST_TIMEOUT_MS, 605_000);
	});
});
