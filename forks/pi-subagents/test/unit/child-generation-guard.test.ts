import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildAuthorityLease, withChildAuthority, captureChildAuthorityLease, claimChildAuthority, acknowledgeChildAuthority, isChildRuntimeControlTool, markChildStructuredOutputCode, bindChildRuntimeToolInspector } from "../../src/runs/shared/child-authority.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { guardChildGeneration } from "../../src/runs/shared/child-generation-guard.ts";

// Barrier/SDK-operation fixtures only, NOT production enforcement consumer acks.
function fixture(ready = true, makeResult?: () => any, virtual = false, extra: Record<string, unknown> = {}, route?: (...args: any[]) => any, startupComplete = true) {
	const { lease } = createChildAuthorityLease({ leaseId: "generation", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: process.cwd() }, payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel: () => {}, requestTimeoutMs: 100 });
	if (ready) withChildAuthority(lease, () => {
		for (const id of lease.requiredConsumers) { claimChildAuthority(id, process.cwd()); acknowledgeChildAuthority(id); }
	});
	const model = { provider: "trusted", id: "model", ...(virtual ? { api: "pi-virtual" } : {}), ...extra };
	const tools = [{ name: "read", description: "owned tool", parameters: { [Symbol.for("TypeBox.Kind")]: "Object", properties: { path: { type: "string" } } }, execute: () => "native tool" }];
	const active = ["read"], callable = ["read"];
	const session = { sessionId: "sdk-session", model, agent: { state: { model } },
		getAllTools: () => tools.map(({ name, description, parameters }) => ({ name, description, parameters, sourceInfo: { path: "/owned/tool.ts" } })),
		getToolDefinition: (name: string) => tools.find(tool => tool.name === name), getActiveToolNames: () => [...active], getCallableToolNames: () => [...callable] };
	let calls = 0, options: any;
	const native = (_model: unknown, _context: unknown, value: unknown) => { calls++; options = value; return makeResult ? makeResult() : "same-native-result"; };
	const physical = { provider: "physical", id: "routed", api: "faux", baseUrl: "https://physical.invalid", headers: { trace: "original" } };
	const catalogue = { model: physical };
	const providers = ["trusted", "physical"].map(id => ({ id, auth: { resolve: () => undefined }, streamSimple: native }));
	const runtime = { stream: native, streamSimple: native, streamDeferred: native, cancelDeferred: native, generateImages: native, classify: native,
		resolveModel: async (...args: any[]) => route ? route(...args) : { model: physical, thinkingLevel: "off" },
		getPhysicalModel: (provider: string, id: string) => provider === catalogue.model.provider && id === catalogue.model.id ? catalogue.model : undefined,
		getProviders: () => [...providers], getProvider: (id: string) => providers.find(provider => provider.id === id),
		registerProvider() {}, refresh() {}, getAuth: async () => "owned-cleanup-auth" };
	const guard = guardChildGeneration(runtime, lease, model); guard.bind(session); if (startupComplete) guard.completeStartup();
	return { lease, runtime, guard, model, tools, active, callable, physical, catalogue, providers, session, calls: () => calls, options: () => options };
}

describe("guarded SDK generation lifetime (opaque API/transport fixtures)", () => {
	const starting = () => fixture(true, undefined, false, {}, undefined, false);
	const structured = () => {
		const f = starting(); let captured = 0, tool: any;
		withChildAuthority(f.lease, () => registerSubagentPromptRuntime({ on() {}, registerTool(value: any) { if (value.name === "structured_output") tool = value; } } as never,
			{ fanoutChild: false, depth: 1, fast: false, waitTool: { enabled: false }, structuredOutput: { schema: { type: "object" }, capture() { captured++; } } }));
		f.tools.push(tool); f.active.push(tool.name); f.callable.push(tool.name); f.guard.completeStartup();
		return { ...f, tool, captured: () => captured };
	};
	it("does not authenticate a foreign implementation by its tool name", () => {
		const f = starting(); f.tools.push({ ...f.tools[0]!, name: "structured_output" }); f.guard.completeStartup();
		assert.equal(isChildRuntimeControlTool(f.lease, "structured_output"), false);
		assert.equal(bindChildRuntimeToolInspector(f.lease, () => true), false, "a later inspector cannot turn a code refusal into admission");
		assert.equal(isChildRuntimeControlTool(f.lease, "structured_output"), false); f.guard.close();
	});
	it("does not authenticate code branded to a different otherwise-identical lease", () => {
		const f = starting(), other = fixture(); const execute = () => "foreign lease";
		markChildStructuredOutputCode(other.lease, execute);
		assert.throws(() => markChildStructuredOutputCode(f.lease, execute), /redefine/);
		f.tools.push({ ...f.tools[0]!, name: "structured_output", execute }); f.guard.completeStartup();
		assert.equal(isChildRuntimeControlTool(f.lease, "structured_output"), false); f.guard.close(); other.guard.close();
	});
	it("authenticates only the actual current SDK definition and captures/terminates without path scope", async () => {
		const f = structured(); assert.equal(isChildRuntimeControlTool(f.lease, "structured_output"), true);
		assert.equal(isChildRuntimeControlTool(f.lease, "structured_output", () => {}), false);
		assert.equal(isChildRuntimeControlTool(f.lease, "bash"), false);
		const result = await f.tool.execute("output", { value: {} }); assert.equal(result.terminate, true);
		assert.equal(f.captured(), 1); assert.equal(f.calls(), 0); f.guard.close();
	});
	for (const change of ["revocation", "cancellation", "definition"] as const) it(`refuses ${change} during async validation before structured capture`, async () => {
		const f = structured(), caller = new AbortController();
		queueMicrotask(() => { if (change === "revocation") f.lease.dispose(); if (change === "cancellation") caller.abort(); if (change === "definition") f.tool.execute = () => "foreign code"; });
		await assert.rejects(f.tool.execute("output", { value: {} }, caller.signal), /disposed|ended|cancelled|provenance changed/);
		assert.equal(f.captured(), 0); f.guard.close();
	});
	it("does not capture structured output with invalid schema data", async () => {
		const f = structured(); await assert.rejects(f.tool.execute("output", { value: "not an object" }), /validation failed/);
		assert.equal(f.captured(), 0); f.guard.close();
	});
	for (const method of ["stream", "streamSimple", "streamDeferred", "cancelDeferred", "generateImages", "classify"] as const) {
		it(`does not dispatch ${method} during SDK startup even with both consumers ready`, () => {
			const f = starting();
			assert.throws(() => f.runtime[method](f.model, {}, {}), /startup.*not completed/);
			assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
		});
	}
	it("seals SDK startup additions once and rejects their subsequent mutation", () => {
		const f = starting(); f.tools.push({ ...f.tools[0]!, name: "contact_supervisor" });
		f.active.push("contact_supervisor"); f.callable.push("contact_supervisor");
		f.guard.completeStartup(); assert.equal(f.runtime.stream(f.model, {}, {}), "same-native-result");
		f.tools[1]!.description = "changed after startup";
		assert.throws(() => f.runtime.stream(f.model, {}, {}), /schemas or source provenance changed/);
		assert.equal(f.calls(), 1);
	});
	for (const mutation of ["schema", "owner", "API", "removal"] as const) it(`rejects existing ${mutation} drift during startup without rebasing it`, () => {
		const f = starting();
		if (mutation === "schema") f.tools[0]!.description = "changed during startup";
		if (mutation === "owner") f.tools[0]!.execute = () => "foreign tool";
		if (mutation === "API") f.session.getAllTools = () => [];
		if (mutation === "removal") f.tools.splice(0);
		assert.throws(() => f.guard.completeStartup(), /provenance.*changed/);
		assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	for (const selection of ["active", "callable"] as const) it(`cannot widen a pre-existing ${selection} selection during startup`, () => {
		const f = fixture(); f[selection].splice(0);
		const guard = guardChildGeneration({ stream() {}, streamSimple() {}, getProvider: f.runtime.getProvider, getProviders: f.runtime.getProviders, getAuth: f.runtime.getAuth }, f.lease, f.model); guard.bind(f.session);
		f[selection].push("read"); assert.throws(() => guard.completeStartup(), /selected ceiling during startup/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("allows startup to narrow an existing selection", () => {
		const f = starting(); f.active.splice(0); f.callable.splice(0); f.guard.completeStartup();
		assert.equal(f.runtime.stream(f.model, {}, {}), "same-native-result"); f.guard.close();
	});
	it("cannot seal a second time to adopt a later loadout", () => {
		const f = fixture(); assert.throws(() => f.guard.completeStartup(), /cannot complete or rebind/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("cannot seal after lease revocation", () => {
		const f = starting(); f.lease.dispose(); assert.throws(() => f.guard.completeStartup(), /cannot complete or rebind/);
		assert.equal(f.calls(), 0);
	});
	for (const method of ["stream", "streamSimple", "streamDeferred", "cancelDeferred", "generateImages", "classify"] as const) {
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
	for (const [field, value] of [["api", "substituted-api"], ["baseUrl", "https://changed.invalid"], ["headers", { "x-changed": "endpoint" }], ["compat", { supportsDeveloperRole: false }]] as const) {
		it(`rejects changed selected ${field} metadata even when provider/model names are unchanged`, () => {
			const f = fixture(); Object.assign(f.model, { [field]: value });
			assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /metadata|selection/);
			assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
		});
	}
	it("compares non-enumerable model metadata rather than silently ignoring it", () => {
		const f = fixture(); Object.defineProperty(f.model, "baseUrl", { value: "https://changed.invalid", enumerable: false });
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /metadata/); assert.equal(f.calls(), 0);
	});
	it("refuses a same-name request with a substituted endpoint rather than treating its key as provenance", () => {
		const f = fixture();
		assert.throws(() => f.runtime.streamSimple({ ...f.model, baseUrl: "https://changed.invalid" }, {}, {}), /metadata|selection/);
		assert.equal(f.calls(), 0);
	});
	it("rechecks model metadata after asynchronous headers without invoking accessors", async () => {
		const f = fixture(); let reads = 0;
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => {
			Object.defineProperty(f.model, "headers", { get() { reads++; return {}; } }); return {};
		} });
		await assert.rejects(() => f.options().transformHeaders({}), /metadata|accessor/);
		assert.equal(reads, 0); assert.equal(f.lease.signal.aborted, true);
	});

	it("retains nested metadata independently rather than adopting a mutated header alias", () => {
		const headers = { trace: "original" }, f = fixture(true, undefined, false, { headers });
		headers.trace = "changed";
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /metadata/); assert.equal(f.calls(), 0);
	});
	it("accepts an equivalent accessor-free SDK model copy without replacing native execution", () => {
		const headers = { trace: "original" }, f = fixture(true, undefined, false, { headers });
		try { assert.equal(f.runtime.streamSimple({ ...f.model, headers: { ...headers } }, {}, {}), "same-native-result"); }
		finally { f.guard.close(); }
	});
	for (const [label, value] of [["cycle", (() => { const value: any = {}; value.self = value; return value; })()],
		["oversized string", "x".repeat(65537)], ["sparse array length", new Array(1025)]]) {
		it(`refuses ${label} metadata instead of truncating or iterating an unbounded shape`, () => {
			assert.throws(() => fixture(true, undefined, false, { extra: value }), /metadata cannot be pinned/);
		});
	}
	it("refuses proxy metadata without triggering its inspection traps", () => {
		let traps = 0;
		const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
		assert.throws(() => fixture(true, undefined, false, { extra: proxy }), /metadata cannot be pinned/); assert.equal(traps, 0);
	});
	it("rejects stream results after nested metadata drift during native execution", async () => {
		const headers = { trace: "original" };
		const f = fixture(true, () => ({ result: async () => { headers.trace = "changed"; return "late"; } }), false, { headers });
		await assert.rejects(() => f.runtime.streamSimple(f.model, {}, {}).result(), /metadata/);
	});

	it("preserves virtual selection while using only the actual native routed physical reference", async () => {
		const f = fixture(true, undefined, true);
		try {
			const result = await f.runtime.resolveModel(f.model, [], {});
			assert.equal(result.model, f.physical); assert.equal(f.session.agent.state.model, f.model);
			assert.equal(f.runtime.streamSimple(result.model, {}, {}), "same-native-result");
			// The same SDK-owned reference may be reused by native cache warming.
			assert.equal(f.runtime.streamSimple(result.model, {}, {}), "same-native-result");
		} finally { f.guard.close(); }
	});
	it("does not invent route provenance from physical agent state or a known catalogue name", () => {
		const f = fixture(true, undefined, true); f.session.agent.state.model = f.physical;
		assert.throws(() => f.runtime.streamSimple(f.physical, {}, {}), /not the bound.*native routed reference/);
		assert.equal(f.calls(), 0);
	});
	it("does not admit copied physical references merely because a native route was observed", async () => {
		const f = fixture(true, undefined, true); await f.runtime.resolveModel(f.model, [], {});
		assert.throws(() => f.runtime.streamSimple({ ...f.physical }, {}, {}), /native routed reference/); assert.equal(f.calls(), 0);
	});
	it("refuses native routing before readiness and forwards cancellation to the existing router", async () => {
		let called = false;
		const f = fixture(false, undefined, true, {}, () => { called = true; });
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /consumer|acknowledged|not ready/); assert.equal(called, false);
		const caller = new AbortController();
		const g = fixture(true, undefined, true, {}, (_model, _messages, options) => { caller.abort(); assert.equal(options.signal.aborted, true); return { model: g.physical }; });
		await assert.rejects(() => g.runtime.resolveModel(g.model, [], { signal: caller.signal }), /cancelled|lifetime ended/); assert.equal(g.calls(), 0);
	});
	it("pins routed metadata across generation hooks and later router resolutions", async () => {
		for (const phase of ["headers", "route"]) {
			const f = fixture(true, undefined, true); await f.runtime.resolveModel(f.model, [], {});
			if (phase === "headers") {
				f.runtime.streamSimple(f.physical, {}, { transformHeaders: async () => { f.physical.headers.trace = "changed"; return {}; } });
				await assert.rejects(() => f.options().transformHeaders({}), /metadata changed/);
			} else {
				f.physical.baseUrl = "https://changed.invalid";
				await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /metadata changed/); assert.equal(f.calls(), 0);
			}
			assert.equal(f.lease.signal.aborted, true);
		}
	});
	it("rejects an old routed reference after the native catalogue data changes", async () => {
		const f = fixture(true, undefined, true); await f.runtime.resolveModel(f.model, [], {});
		f.catalogue.model = { ...f.physical, baseUrl: "https://catalogue-changed.invalid" };
		assert.throws(() => f.runtime.streamSimple(f.physical, {}, {}), /catalogue no longer matches/); assert.equal(f.calls(), 0);
	});
	it("requires native route output to equal the physical catalogue data and pins lookup identity", async () => {
		const f = fixture(true, undefined, true, {}, () => ({ model: { ...f.physical, baseUrl: "https://substituted.invalid" } }));
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /physical SDK catalogue/); assert.equal(f.calls(), 0);
		const g = fixture(true, undefined, true); g.runtime.getPhysicalModel = () => g.physical;
		await assert.rejects(() => g.runtime.resolveModel(g.model, [], {}), /catalogue lookup changed/); assert.equal(g.calls(), 0);
	});
	for (const mutation of ["schema", "code", "active", "callable", "lookup"] as const) {
		it(`rejects changed selected tool ${mutation} before generation`, () => {
			const f = fixture();
			if (mutation === "schema") f.tools[0].parameters.properties.path.type = "number";
			if (mutation === "code") f.tools[0] = { ...f.tools[0], execute: () => "foreign" };
			if (mutation === "active") f.active.push("write");
			if (mutation === "callable") f.callable.push("write");
			if (mutation === "lookup") f.session.getAllTools = () => [];
			assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /tool.*changed|tool loadout exceeded/); assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
		});
	}
	it("permits a narrower tool loadout without granting a new tool", () => {
		const f = fixture(); f.active.length = 0; f.callable.length = 0;
		try { assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result"); } finally { f.guard.close(); }
	});
	it("does not invoke metadata accessors in a changed native schema", () => {
		const f = fixture(); let calls = 0;
		Object.defineProperty(f.tools[0].parameters, "get", { get: () => { calls++; return "must not execute"; } });
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /tool loadout cannot be pinned/); assert.equal(calls, 0);
	});
	it("refuses proxy code metadata without inspecting or invoking it", () => {
		const f = fixture(); let traps = 0;
		Object.defineProperty(f.tools[0], "execute", { value: new Proxy(() => {}, { apply() { traps++; }, ownKeys() { traps++; return []; } }) });
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /tool loadout cannot be pinned/); assert.equal(traps, 0);
	});
	it("bounds malformed active/callable selections and closes the same lifetime", () => {
		for (const target of ["active", "callable"] as const) {
			const f = fixture(); f[target].push(...Array(256).fill("read"));
			assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /tool selection is not bounded/); assert.equal(f.lease.signal.aborted, true); assert.equal(f.calls(), 0);
		}
	});
	it("refuses a missing public tool API during binding without inventing a replacement view", () => {
		const f = fixture(), guard = guardChildGeneration({ stream() {}, streamSimple() {}, getProvider: f.runtime.getProvider, getProviders: f.runtime.getProviders, getAuth: f.runtime.getAuth }, f.lease, f.model);
		assert.throws(() => guard.bind({ ...f.session, getAllTools: undefined } as never), /lacks the public getAllTools/); assert.equal(f.lease.signal.aborted, true);
	});
	it("rechecks schema fidelity after an asynchronous generation hook", async () => {
		const f = fixture();
		f.runtime.streamSimple(f.model, {}, { onPayload: async () => { f.tools[0].description = "changed"; } });
		await assert.rejects(() => f.options().onPayload({}), /tool definitions.*changed/); assert.equal(f.lease.signal.aborted, true);
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
	for (const method of ["classify", "generateImages", "cancelDeferred"] as const) {
		it(`rejects a late ${method} result after session drift`, async () => {
			let change: () => void = () => {};
			const f = fixture(true, async () => { await Promise.resolve(); change(); return "late"; });
			change = () => { f.session.sessionId = "different"; };
			await assert.rejects(() => f.runtime[method](f.model, {}, {}), /identity changed/);
		});
	}
	for (const change of ["dispatch", "auth", "metadata", "owner", "API", "auth API"] as const) it(`rejects live provider ${change} drift without a new registry call`, () => {
		const f = fixture();
		if (change === "dispatch") f.providers[0]!.streamSimple = () => "foreign dispatch";
		if (change === "auth") f.providers[0]!.auth.resolve = () => undefined;
		if (change === "metadata") Object.assign(f.providers[0]!, { baseUrl: "https://changed.invalid" });
		if (change === "owner") f.providers[0] = { ...f.providers[0]! };
		if (change === "API") f.runtime.getProvider = () => f.providers[0];
		if (change === "auth API") f.runtime.getAuth = async () => "borrowed auth";
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider.*changed/);
		assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("poisons the same lifetime when the pinned provider lookup itself throws", () => {
		const f = fixture(); f.providers.find = () => { throw new Error("untrusted lookup details"); };
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider provenance lookup failed/);
		assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("does not inspect provider accessors or proxies after startup", () => {
		for (const kind of ["accessor", "proxy"]) {
			const f = fixture(); let traps = 0;
			if (kind === "accessor") Object.defineProperty(f.providers[0], "extra", { get() { traps++; } });
			else Object.assign(f.providers[0]!, { extra: new Proxy({}, { ownKeys() { traps++; return []; } }) });
			assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider provenance.*accessor-free/);
			assert.equal(traps, 0); assert.equal(f.calls(), 0);
		}
	});
	it("rechecks provider code after an asynchronous native header callback", async () => {
		const f = fixture(); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { await Promise.resolve(); f.providers[0]!.auth.resolve = () => undefined; return {}; } });
		await assert.rejects(() => f.options().transformHeaders({}), /provider code, auth or metadata provenance changed/); assert.equal(f.lease.signal.aborted, true);
	});
	it("still revokes provider drift when an asynchronous callback rejects", async () => {
		const f = fixture(); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { f.providers[0]!.auth.resolve = () => undefined; throw new Error("hook failed"); } });
		await assert.rejects(() => f.options().transformHeaders({}), /provider code, auth or metadata provenance changed/); assert.equal(f.lease.signal.aborted, true);
	});
	it("preserves the original hook failure when provenance and lifetime remain current", async () => {
		const f = fixture(), original = new Error("owned hook failure"); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { throw original; } });
		await assert.rejects(() => f.options().transformHeaders({}), error => error === original); assert.equal(f.lease.signal.aborted, false); f.guard.close();
	});
	it("rejects changed physical-provider code before observing a first native route", async () => {
		const f = fixture(true, undefined, true); f.providers[1]!.streamSimple = () => "foreign physical code";
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /provider code, auth or metadata provenance changed/); assert.equal(f.calls(), 0);
	});
	it("does not return a late provider stream result after provider code changes", async () => {
		const f = fixture(true, () => ({ result: async () => { f.providers[0]!.auth.resolve = () => undefined; return "late"; } }));
		await assert.rejects(() => f.runtime.streamSimple(f.model, {}, {}).result(), /provider code, auth or metadata provenance changed/);
	});
	it("requires the genuine public provider boundary instead of inventing a registry view", () => {
		const f = fixture(); assert.throws(() => guardChildGeneration({ stream() {}, streamSimple() {} }, f.lease, f.model), /public provider provenance boundary/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("bounds each provider before startup instead of accepting an uninspectable event path", () => {
		const f = fixture(); assert.throws(() => guardChildGeneration({ ...f.runtime, getProviders: () => [{ id: "trusted", extra: "x".repeat(65537) }] }, f.lease, f.model), /provider catalogue cannot be pinned/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("bounds the startup provider catalogue instead of truncating the future route set", () => {
		const f = fixture(); assert.throws(() => guardChildGeneration({ ...f.runtime, getProviders: () => Array.from({ length: 257 }, (_, i) => ({ id: String(i) })) }, f.lease, f.model), /provider catalogue cannot be pinned/);
		assert.equal(f.lease.signal.aborted, true);
	});
	it("does not lend remote cancellation after close while keeping SDK cleanup authentication available", async () => {
		const f = fixture(); f.guard.close(); assert.throws(() => f.runtime.cancelDeferred(f.model, {}, {}), /lifetime ended/);
		assert.equal(await f.runtime.getAuth(), "owned-cleanup-auth"); assert.equal(f.calls(), 0);
	});
	it("revokes changed provider code even when a native promise rejects", async () => {
		const f = fixture(true, async () => { f.providers[0]!.auth.resolve = () => undefined; throw new Error("native failure"); });
		await assert.rejects(() => f.runtime.cancelDeferred(f.model, {}, {}), /provider code, auth or metadata provenance changed/); assert.equal(f.lease.signal.aborted, true);
	});
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
		assert.throws(() => guardChildGeneration({ getProvider: f.runtime.getProvider, getProviders: f.runtime.getProviders, getAuth: f.runtime.getAuth }, f.lease, f.model), /lacks the public stream/);
		assert.equal(f.lease.signal.aborted, true);
	});
});
