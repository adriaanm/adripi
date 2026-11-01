import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildAuthorityLease, withChildAuthority, captureChildAuthorityLease, claimChildAuthority, acknowledgeChildAuthority } from "../../src/runs/shared/child-authority.ts";
import { guardChildGeneration } from "../../src/runs/shared/child-generation-guard.ts";

// Barrier/SDK-operation fixtures only, NOT production enforcement consumer acks.
function fixture(ready = true, makeResult?: () => any) {
	const { lease } = createChildAuthorityLease({ leaseId: "generation", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: process.cwd() }, payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel: () => {}, requestTimeoutMs: 100 });
	if (ready) withChildAuthority(lease, () => {
		for (const id of lease.requiredConsumers) { claimChildAuthority(id, process.cwd()); acknowledgeChildAuthority(id); }
	});
	const model = { provider: "trusted", id: "model" };
	const session = { sessionId: "sdk-session", model, agent: { state: { model } } };
	let calls = 0, options: any;
	const native = (_model: unknown, _context: unknown, value: unknown) => { calls++; options = value; return makeResult ? makeResult() : "same-native-result"; };
	const runtime = { stream: native, streamSimple: native, streamDeferred: native, generateImages: native, classify: native,
		registerProvider() {}, refresh() {}, getAuth: async () => "owned-cleanup-auth" };
	const guard = guardChildGeneration(runtime, lease, "trusted/model"); guard.bind(session);
	return { lease, runtime, guard, model, session, calls: () => calls, options: () => options };
}

describe("guarded SDK generation lifetime (opaque API/transport fixtures)", () => {
	for (const method of ["stream", "streamSimple", "streamDeferred", "generateImages", "classify"] as const) {
		it(`does not dispatch ${method} before required consumer readiness`, () => {
			const f = fixture(false);
			assert.throws(() => f.runtime[method](f.model, {}, {}), /not ready|acknowledged|consumer/i);
			assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
		});
	}
	it("keeps the native method/result and combines lease/request cancellation", () => {
		const f = fixture(); const caller = new AbortController();
		try {
			assert.equal(f.runtime.streamSimple(f.model, {}, { signal: caller.signal }), "same-native-result");
			assert.equal(f.calls(), 1); assert.equal(f.options().signal.aborted, false);
			caller.abort(); assert.equal(f.options().signal.aborted, true);
		} finally { f.guard.close(); }
	});
	it("rechecks after asynchronous transport headers instead of consuming a stale identity", async () => {
		const f = fixture();
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { f.session.sessionId = "different"; return {}; } });
		await assert.rejects(() => f.options().transformHeaders({}), /identity changed/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("rechecks after asynchronous payload hooks and propagates revocation to transport", async () => {
		const f = fixture();
		f.runtime.streamSimple(f.model, {}, { onPayload: async () => { f.lease.dispose(); return {}; } });
		await assert.rejects(() => f.options().onPayload({}), /lifetime ended|cancelled/);
		assert.equal(f.options().signal.aborted, true);
	});
	it("does not accept a lifetime session model switch or a different request model", () => {
		for (const mutation of ["selection", "request"]) {
			const f = fixture(); const other = { provider: "other", id: "model" };
			if (mutation === "selection") f.session.model = other;
			assert.throws(() => f.runtime.streamSimple(other, {}, {}), /identity changed|not the bound/);
			assert.equal(f.calls(), 0);
		}
	});
	it("keeps SDK virtual routing tied to the current live routed agent model", () => {
		const f = fixture(); const physical = { provider: "physical", id: "routed" };
		Object.assign(f.session.model, { api: "pi-virtual" }); f.session.agent.state.model = physical;
		try { assert.equal(f.runtime.streamSimple(physical, {}, {}), "same-native-result"); }
		finally { f.guard.close(); }
	});
	it("refuses a virtual request that is not the live SDK-routed physical model", () => {
		const f = fixture(); Object.assign(f.session.model, { api: "pi-virtual" });
		assert.throws(() => f.runtime.streamSimple({ provider: "physical", id: "unselected" }, {}, {}), /not the bound/);
		assert.equal(f.calls(), 0);
	});
	it("rejects a late native stream result after session drift", async () => {
		let change: () => void = () => {};
		const f = fixture(true, () => ({ result: async () => { await Promise.resolve(); change(); return "late"; } }));
		change = () => { f.session.sessionId = "different"; };
		const stream = f.runtime.streamSimple(f.model, {}, {});
		await assert.rejects(() => stream.result(), /identity changed/);
	});
	it("never yields native stream events after cancellation", async () => {
		let cancel: () => void = () => {};
		const f = fixture(true, () => ({ async *[Symbol.asyncIterator]() { yield "first"; cancel(); yield "late"; } }));
		cancel = () => f.lease.dispose(); const received: string[] = [];
		await assert.rejects(async () => { for await (const event of f.runtime.streamSimple(f.model, {}, {})) received.push(event); }, /lifetime ended/);
		assert.deepEqual(received, ["first"]);
	});
	for (const method of ["classify", "generateImages"] as const) {
		it(`rejects a late ${method} result after session drift`, async () => {
			let change: () => void = () => {};
			const f = fixture(true, async () => { await Promise.resolve(); change(); return "late"; });
			change = () => { f.session.sessionId = "different"; };
			await assert.rejects(() => f.runtime[method](f.model, {}, {}), /identity changed/);
		});
	}
	it("does not permit replacement of the guarded dispatch or selected provider registry", () => {
		const f = fixture();
		assert.throws(() => { f.runtime.streamSimple = () => "replaced"; }, TypeError);
		assert.throws(() => f.runtime.registerProvider(), /registry cannot be replaced/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("never dispatches again after close and does not fence off authentication needed for owned cleanup", async () => {
		const f = fixture(); f.guard.close();
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /lifetime ended/);
		assert.equal(await f.runtime.getAuth(), "owned-cleanup-auth"); assert.equal(f.calls(), 0);
	});
	it("captures only the actual scoped lease without inventing a consumer claim", () => {
		const f = fixture(false);
		withChildAuthority(f.lease, () => {
			assert.equal(captureChildAuthorityLease(process.cwd()), f.lease);
			assert.throws(() => captureChildAuthorityLease("/different-cwd"), /own live.*identity/);
		});
		assert.throws(() => captureChildAuthorityLease(process.cwd()), /live.*identity/);
		assert.throws(() => f.lease.assertReady(), /pi-sbx.*pi-guardian/); f.guard.close();
	});
	it("refuses an SDK without the public generation boundary rather than wrapping another engine", () => {
		const f = fixture();
		assert.throws(() => guardChildGeneration({}, f.lease, "trusted/model"), /lacks the public stream/);
		assert.equal(f.lease.signal.aborted, true);
	});
});
