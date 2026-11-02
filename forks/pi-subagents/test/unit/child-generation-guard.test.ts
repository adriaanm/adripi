import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChildAuthorityLease, withChildAuthority, captureChildAuthorityLease, claimChildAuthority, acknowledgeChildAuthority, isChildRuntimeControlTool, markChildStructuredOutputCode, bindChildRuntimeToolInspector } from "../../src/runs/shared/child-authority.ts";
import registerSubagentPromptRuntime from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { guardChildGeneration } from "../../src/runs/shared/child-generation-guard.ts";

// Barrier/SDK-operation fixtures only, NOT production enforcement consumer acks.
function fixture(ready = true, makeResult?: () => any, virtual = false, extra: Record<string, unknown> = {}, route?: (...args: any[]) => any, startupComplete = true, catalogueList?: (model: any, physical: any) => any, authLookup: (...args: any[]) => Promise<unknown> = async () => "owned-cleanup-auth") {
	const { lease } = createChildAuthorityLease({ leaseId: "generation", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: process.cwd() }, payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel: () => {}, requestTimeoutMs: 100 });
	if (ready) withChildAuthority(lease, () => {
		for (const id of lease.requiredConsumers) { claimChildAuthority(id, process.cwd()); acknowledgeChildAuthority(id); }
	});
	const model = { provider: "trusted", id: "model", ...(virtual ? { api: "pi-virtual" } : {}) };
	Object.defineProperties(model, Object.getOwnPropertyDescriptors(extra));
	const tools = [{ name: "read", description: "owned tool", parameters: { [Symbol.for("TypeBox.Kind")]: "Object", properties: { path: { type: "string" } } }, execute: () => "native tool" }];
	const active = ["read"], callable = ["read"];
	const session = { sessionId: "sdk-session", model, agent: { state: { model } },
		getAllTools: () => tools.map(({ name, description, parameters }) => ({ name, description, parameters, sourceInfo: { path: "/owned/tool.ts" } })),
		getToolDefinition: (name: string) => tools.find(tool => tool.name === name), getActiveToolNames: () => [...active], getCallableToolNames: () => [...callable] };
	let calls = 0, options: any, lastModel: unknown;
	const native = (_model: unknown, _context: unknown, value: unknown) => { calls++; options = value; lastModel = _model; return makeResult ? makeResult() : "same-native-result"; };
	const physical = { provider: "physical", id: "routed", api: "faux", baseUrl: "https://physical.invalid", headers: { trace: "original" } };
	const catalogue = { model: physical };
	const providers = ["trusted", "physical"].map(id => ({ id, auth: { resolve: () => undefined }, streamSimple: native }));
	const sources = { native: providers.map(({ id }) => ({ id, streamSimple: native })), config: providers.map(() => ({ streamSimple: native, headers: { trace: "source" } })) };
	const runtime = { stream: native, streamSimple: native, streamDeferred: native, cancelDeferred: native, generateImages: native, classify: native,
		resolveModel: async (...args: any[]) => route ? route(...args) : { model: physical, thinkingLevel: "off" },
		getAllModels: () => catalogueList ? catalogueList(model, physical) : [model, physical],
		getPhysicalModel: (provider: string, id: string) => provider === catalogue.model.provider && id === catalogue.model.id ? catalogue.model : undefined,
		getProviders: () => [...providers], getProvider: (id: string) => providers.find(provider => provider.id === id),
		getRegisteredNativeProvider: (id: string) => sources.native[providers.findIndex(provider => provider.id === id)],
		getRegisteredProviderConfig: (id: string) => sources.config[providers.findIndex(provider => provider.id === id)],
		registerProvider() {}, refresh() {}, getAuth: authLookup };
	const originalAPIs = { getProvider: runtime.getProvider, getProviders: runtime.getProviders, getAuth: runtime.getAuth, getRegisteredNativeProvider: runtime.getRegisteredNativeProvider, getRegisteredProviderConfig: runtime.getRegisteredProviderConfig };
	const guard = guardChildGeneration(runtime, lease, model); guard.bind(session); if (startupComplete) guard.completeStartup();
	return { lease, runtime, originalAPIs, native, guard, model, tools, active, callable, physical, catalogue, providers, sources, session, calls: () => calls, options: () => options, lastModel: () => lastModel };
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
		const guard = guardChildGeneration({ stream() {}, streamSimple() {}, ...f.originalAPIs }, f.lease, f.model); guard.bind(f.session);
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
		it(`prevents selected ${field} mutation while retaining the original model object`, () => {
			const f = fixture(); assert.throws(() => Object.assign(f.model, { [field]: value }), TypeError);
			assert.equal(f.session.model, f.model); assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result");
			assert.equal(f.calls(), 1); f.guard.close();
		});
	}
	it("makes non-enumerable model metadata immutable without dropping it", () => {
		const extra = Object.defineProperty({}, "baseUrl", { value: "original", enumerable: false, writable: true, configurable: true });
		const f = fixture(true, undefined, false, extra);
		assert.equal(Object.getOwnPropertyDescriptor(f.model, "baseUrl")!.value, "original");
		assert.throws(() => Object.defineProperty(f.model, "baseUrl", { value: "changed" }), TypeError);
		assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result"); f.guard.close();
	});
	it("freezes selected data before startup without freezing tool schemas or SDK code", () => {
		const f = starting(); assert.equal(Object.isFrozen(f.model), true);
		assert.equal(Object.isFrozen(f.tools[0].parameters), false); assert.equal(Object.isFrozen(f.native), false);
		assert.equal(f.session.model, f.model); assert.equal(f.calls(), 0); f.guard.close();
	});
	it("freezes only the validated session reference, not a later getter result", () => {
		const f = fixture(); let reads = 0, traps = 0;
		const foreign = new Proxy({}, { ownKeys() { traps++; return []; } });
		Object.defineProperty(f.session, "model", { get() { return ++reads === 1 ? f.model : foreign; } });
		assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result");
		assert.equal(reads, 1); assert.equal(traps, 0);
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /metadata cannot be pinned/);
		assert.equal(traps, 0); assert.equal(f.calls(), 1);
	});
	it("retains and freezes an equivalent SDK session model copy at admission", () => {
		const f = fixture(true, undefined, false, { headers: { trace: "original" } });
		const copy = { ...f.model, headers: { trace: "original" } }; f.session.model = copy;
		assert.equal(f.runtime.streamSimple(copy, {}, {}), "same-native-result");
		assert.equal(f.session.model, copy); assert.equal(Object.isFrozen(copy.headers), true); f.guard.close();
	});
	it("refuses a same-name request with a substituted endpoint rather than treating its key as provenance", () => {
		const f = fixture();
		assert.throws(() => f.runtime.streamSimple({ ...f.model, baseUrl: "https://changed.invalid" }, {}, {}), /metadata|selection/);
		assert.equal(f.calls(), 0);
	});
	const authPrepared = (resolveAuth: (...args: any[]) => Promise<unknown>) => {
		let f: ReturnType<typeof fixture>, candidate: any, backends = 0;
		f = fixture(true, () => {
			const options = f.options();
			return { result: async () => { await f.runtime.getAuth(candidate, { signal: options.signal }); await options.transformHeaders({}); backends++; return "native prepared result"; } };
		}, false, { api: "faux", baseUrl: "https://model.invalid" }, undefined, true, undefined, resolveAuth);
		candidate = { ...f.model, baseUrl: "https://auth.invalid" };
		return { ...f, candidate, backends: () => backends };
	};
	it("admits only a current auth-baseUrl DTO without replacing the model passed to the native method", async () => {
		const f = authPrepared(async () => ({ auth: { baseUrl: "https://auth.invalid" } }));
		const stream = f.runtime.streamSimple(f.candidate, {}, { apiKey: undefined });
		assert.equal(f.lastModel(), f.candidate); assert.equal(Object.isFrozen(f.candidate), true);
		assert.equal(await stream.result(), "native prepared result"); assert.equal(f.backends(), 1); f.guard.close();
	});
	for (const baseUrl of [undefined, "https://other.invalid"]) it(`refuses ${baseUrl ? "changed" : "missing"} current auth override before headers/backend`, async () => {
		const f = authPrepared(async () => ({ auth: { baseUrl } })); let hooks = 0;
		const stream = f.runtime.streamSimple(f.candidate, {}, { apiKey: undefined, transformHeaders: async headers => { hooks++; return headers; } });
		await assert.rejects(() => stream.result(), /auth-prepared model endpoint did not match this operation's native auth resolution/);
		assert.equal(f.backends(), 0); assert.equal(hooks, 0); assert.equal(f.lease.signal.aborted, true);
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /auth-prepared model endpoint did not match/, "teardown retains the first refusal rather than overwriting its evidence");
	});
	it("does not attest a resolver call whose signal ownership changed while it ran", async () => {
		const f = authPrepared(async (_model, options) => { options.signal = new AbortController().signal; return { auth: { baseUrl: "https://auth.invalid" } }; });
		await assert.rejects(() => f.runtime.streamSimple(f.candidate, {}, { apiKey: undefined }).result(), /auth-prepared model endpoint did not match/);
		assert.equal(f.backends(), 0);
	});
	it("does not reuse a prior standalone auth result as authorization for a later operation", async () => {
		let baseUrl: string | undefined = "https://auth.invalid";
		const f = authPrepared(async () => ({ auth: { baseUrl } })); await f.runtime.getAuth(f.model); baseUrl = undefined;
		await assert.rejects(() => f.runtime.streamSimple(f.candidate, {}, { headers: undefined }).result(), /auth-prepared model endpoint did not match/);
		assert.equal(f.backends(), 0);
	});
	for (const change of ["api", "headers", "future"]) it(`does not treat auth-baseUrl provenance as a ${change} metadata grant`, () => {
		const f = authPrepared(async () => ({ auth: { baseUrl: "https://auth.invalid" } }));
		const other = { ...f.candidate, [change]: change === "headers" ? { extra: "not admitted" } : "not admitted" };
		assert.throws(() => f.runtime.streamSimple(other, {}, { apiKey: undefined }), /substituted metadata/);
		assert.equal(f.calls(), 0); assert.equal(f.backends(), 0);
	});
	it("does not cross-borrow auth attestations between concurrent requests sharing a model and caller signal", async () => {
		let f: ReturnType<typeof fixture>, candidate: any, count = 0, backends = 0, announce!: () => void, release!: () => void;
		const started = new Promise<void>(resolve => { announce = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
		f = fixture(true, () => {
			const options = f.options(), first = count++ === 0;
			return { result: async () => {
				await f.runtime.getAuth(candidate, { signal: options.signal, first });
				if (first) { announce(); await held; }
				await options.transformHeaders({}); backends++; return "native prepared result";
			} };
		}, false, { api: "faux", baseUrl: "https://model.invalid" }, undefined, true, undefined, async (_model, options) => ({ auth: options.first ? {} : { baseUrl: "https://auth.invalid" } }));
		candidate = { ...f.model, baseUrl: "https://auth.invalid" }; const signal = new AbortController().signal;
		const a = f.runtime.streamSimple(candidate, {}, { apiKey: undefined, signal }); const aSignal = f.options().signal;
		const pending = a.result(); await started;
		const b = f.runtime.streamSimple(candidate, {}, { apiKey: undefined, signal }); assert.notEqual(f.options().signal, aSignal);
		assert.equal(await b.result(), "native prepared result"); release();
		await assert.rejects(() => pending, /auth-prepared model endpoint did not match/); assert.equal(backends, 1);
	});
	it("admits independent caller header/env maps before lazy SDK work without freezing either owner", () => {
		const f = fixture(), headers = { trace: "original", remove: null }, env = { REGION: "original", UNSET: undefined };
		f.runtime.streamSimple(f.model, {}, { headers, env }); const admitted = f.options();
		assert.notEqual(admitted.headers, headers); assert.notEqual(admitted.env, env);
		headers.trace = "late"; env.REGION = "late"; assert.equal(admitted.headers.trace, "original"); assert.equal(admitted.env.REGION, "original");
		assert.equal(admitted.headers.remove, null); assert.equal(Object.hasOwn(admitted.env, "UNSET"), true);
		admitted.env.REGION = "native owned"; assert.equal(env.REGION, "late"); f.guard.close();
	});
	it("preserves caller map prototypes/non-enumerable keys and supports reuse in later requests", () => {
		const f = fixture(), env = Object.assign(Object.create(null), { REGION: "one" });
		Object.defineProperty(env, "hidden", { value: "not an env override", enumerable: false });
		f.runtime.streamSimple(f.model, {}, { env }); const first = f.options().env; env.REGION = "two";
		f.runtime.streamSimple(f.model, {}, { env }); const second = f.options().env;
		assert.equal(first.REGION, "one"); assert.equal(second.REGION, "two"); assert.equal(Object.getPrototypeOf(first), null);
		assert.deepEqual(Object.keys(first), ["REGION"]); assert.equal(first.hidden, env.hidden); f.guard.close();
	});
	for (const field of ["headers", "env"] as const) for (const shape of ["accessor", "proxy", "array", "bad value", "oversized"] as const) it(`refuses ${shape} caller ${field} before invoking the SDK without inspecting private values`, () => {
		const f = fixture(); let traps = 0;
		const value = shape === "accessor" ? Object.defineProperty({}, "private", { get() { traps++; return "must not read"; } })
			: shape === "proxy" ? new Proxy({}, { ownKeys() { traps++; return []; } }) : shape === "array" ? []
			: shape === "bad value" ? { private: field === "env" ? null : undefined } : { private: "x".repeat(65537) };
		assert.throws(() => f.runtime.streamSimple(f.model, {}, { [field]: value }), /caller SDK request maps cannot be transferred as bounded accessor-free owned data/);
		assert.equal(traps, 0); assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("delegates auth with the exact SDK receiver/arguments and transfers independent complete DTO data", async () => {
		const input = { auth: { apiKey: "synthetic", baseUrl: "https://auth.invalid", headers: { trace: "auth" } }, env: { PI_FIXTURE_ENV: "original" } };
		let receiver: unknown, args: unknown[];
		const f = fixture(true, undefined, false, {}, undefined, true, undefined, async function(this: unknown, ...value) { receiver = this; args = value; return input; });
		const options = { signal: new AbortController().signal }, copy: any = await f.runtime.getAuth(f.model, options);
		assert.equal(receiver, f.runtime); assert.deepEqual(args!, [f.model, options]);
		assert.notEqual(copy, input); assert.notEqual(copy.env, input.env); assert.notEqual(copy.auth, input.auth);
		input.env.PI_FIXTURE_ENV = "late"; input.auth.baseUrl = "https://late.invalid";
		assert.equal(copy.env.PI_FIXTURE_ENV, "original"); assert.equal(copy.auth.baseUrl, "https://auth.invalid");
		copy.env.PI_FIXTURE_ENV = "native owned"; assert.equal(input.env.PI_FIXTURE_ENV, "late"); f.guard.close();
	});
	it("keeps reusable auth/refresh results live for subsequent reads, without freezing producer data", async () => {
		const input = { auth: { apiKey: "synthetic-one" }, env: { PI_FIXTURE_ENV: "one" } };
		const f = fixture(true, undefined, false, {}, undefined, true, undefined, async () => input);
		const first: any = await f.runtime.getAuth(); input.auth.apiKey = "synthetic-two"; input.env.PI_FIXTURE_ENV = "two";
		const second: any = await f.runtime.getAuth(); assert.equal(first.auth.apiKey, "synthetic-one"); assert.equal(second.auth.apiKey, "synthetic-two");
		assert.equal(first.env.PI_FIXTURE_ENV, "one"); assert.equal(second.env.PI_FIXTURE_ENV, "two"); f.guard.close();
	});
	it("retains null prototypes and nested non-enumerable auth/env data without turning it into provider fields", async () => {
		const env = Object.assign(Object.create(null), { PI_FIXTURE_ENV: "visible" });
		Object.defineProperty(env, "hidden", { value: "not an env override", enumerable: false });
		const input = { auth: { headers: { trace: null } }, env };
		const f = fixture(true, undefined, false, {}, undefined, true, undefined, async () => input);
		const copy: any = await f.runtime.getAuth(); assert.equal(Object.getPrototypeOf(copy.env), null);
		assert.deepEqual(Object.keys(copy.env), ["PI_FIXTURE_ENV"]); assert.equal(copy.env.hidden, env.hidden); assert.equal(copy.auth.headers.trace, null); f.guard.close();
	});
	it("preserves native undefined/error auth results and delegates owned cleanup after closure", async () => {
		let failure = false, calls = 0; const error = new Error("native auth failed");
		const f = fixture(true, undefined, false, {}, undefined, true, undefined, async () => { calls++; if (failure) throw error; return undefined; });
		f.guard.close(); assert.equal(await f.runtime.getAuth(), undefined); failure = true;
		await assert.rejects(() => f.runtime.getAuth(), value => value === error); assert.equal(calls, 2);
	});
	for (const shape of ["accessor", "proxy", "code", "oversized"] as const) it(`refuses ${shape} auth DTO data without invoking traps or exposing values`, async () => {
		let traps = 0;
		const env = shape === "accessor" ? Object.defineProperty({}, "private", { get() { traps++; return "must not inspect"; } })
			: shape === "proxy" ? new Proxy({}, { ownKeys() { traps++; return []; } }) : shape === "code" ? { private: () => { traps++; } } : { private: "x".repeat(65537) };
		const f = fixture(true, undefined, false, {}, undefined, true, undefined, async () => ({ auth: {}, env }));
		await assert.rejects(() => f.runtime.getAuth(), /SDK auth result cannot be transferred as bounded accessor-free owned data/);
		assert.equal(traps, 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("transfers completed headers as independent data, leaving producer and SDK maps usable", async () => {
		const f = fixture(), headers = { trace: "original", remove: null };
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => headers });
		const copy = await f.options().transformHeaders({}); assert.notEqual(copy, headers); assert.deepEqual(copy, headers);
		headers.trace = "late"; assert.equal(copy.trace, "original"); copy.trace = "native SDK owned";
		assert.equal(headers.trace, "late"); assert.equal(copy.remove, null); f.guard.close();
	});
	it("permits reusable signing/header maps to change for later requests, not earlier copies", async () => {
		const f = fixture(), headers = { nonce: "one" };
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => headers });
		const first = await f.options().transformHeaders({}); headers.nonce = "two";
		const second = await f.options().transformHeaders({});
		assert.equal(first.nonce, "one"); assert.equal(second.nonce, "two"); assert.notEqual(first, second); f.guard.close();
	});
	it("allows in-place async header changes until the native hook actually completes", async () => {
		const f = fixture(), headers = { trace: "before" };
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async value => { await Promise.resolve(); value.trace = "complete"; return value; } });
		const copy = await f.options().transformHeaders(headers); assert.equal(copy.trace, "complete"); assert.equal(headers.trace, "complete"); f.guard.close();
	});
	it("copies default header callbacks without inventing a caller hook", async () => {
		const f = fixture(), headers = { trace: "default" };
		f.runtime.streamSimple(f.model, {}, {}); const copy = await f.options().transformHeaders(headers);
		assert.notEqual(copy, headers); assert.deepEqual(copy, headers); f.guard.close();
	});
	it("preserves null prototypes and non-enumerability instead of introducing hidden HTTP fields", async () => {
		const f = fixture(), headers = Object.assign(Object.create(null), { trace: "visible", remove: null });
		Object.defineProperty(headers, "hidden", { value: "not an HTTP field", enumerable: false });
		f.runtime.streamSimple(f.model, {}, {}); const copy = await f.options().transformHeaders(headers);
		assert.equal(Object.getPrototypeOf(copy), null); assert.deepEqual(Object.keys(copy), ["trace", "remove"]);
		assert.equal(copy.hidden, headers.hidden); assert.equal(copy.remove, null); f.guard.close();
	});
	for (const shape of ["accessor", "proxy", "array", "undefined", "number value", "object value", "function value", "oversized"] as const) it(`refuses ${shape} completed headers without inspecting code or logging values`, async () => {
		const f = fixture(); let traps = 0;
		const headers = shape === "accessor" ? Object.defineProperty({}, "private", { get() { traps++; return "must not read"; } })
			: shape === "proxy" ? new Proxy({}, { ownKeys() { traps++; return []; } }) : shape === "array" ? [] : shape === "undefined" ? undefined
			: shape === "number value" ? { private: 42 } : shape === "object value" ? { private: {} } : shape === "function value" ? { private: () => { traps++; } } : { private: "x".repeat(65537) };
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => headers });
		await assert.rejects(() => f.options().transformHeaders({}), /completed SDK header hook did not return bounded accessor-free header data/);
		assert.equal(traps, 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("prevents asynchronous header hooks from installing model accessors", async () => {
		const f = fixture(); let reads = 0;
		f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => {
			Object.defineProperty(f.model, "headers", { get() { reads++; return {}; } }); return {};
		} });
		await assert.rejects(() => f.options().transformHeaders({}), TypeError);
		assert.equal(reads, 0); assert.equal(f.lease.signal.aborted, false); f.guard.close();
	});

	it("makes nested aliases immutable without replacing their native references", () => {
		const headers = { trace: "original" }, f = fixture(true, undefined, false, { headers });
		assert.equal((f.model as any).headers, headers); assert.throws(() => { headers.trace = "changed"; }, TypeError);
		assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result"); f.guard.close();
	});
	it("accepts an equivalent accessor-free SDK model copy without replacing native execution", () => {
		const headers = { trace: "original" }, f = fixture(true, undefined, false, { headers });
		const copy = { ...f.model, headers: { ...headers } };
		try {
			assert.equal(f.runtime.streamSimple(copy, {}, {}), "same-native-result");
			assert.equal(Object.isFrozen(copy), true); assert.equal(Object.isFrozen(copy.headers), true);
		} finally { f.guard.close(); }
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
	it("rejects stream results after the SDK switches to a different nested metadata selection", async () => {
		const headers = { trace: "original" };
		const f = fixture(true, () => ({ result: async () => { f.session.model = { ...f.model, headers: { trace: "changed" } }; return "late"; } }), false, { headers });
		await assert.rejects(() => f.runtime.streamSimple(f.model, {}, {}).result(), /metadata/);
	});

	for (const field of ["api", "baseUrl", "headers", "futureMetadata"] as const) it(`pins physical ${field} data before its first native route`, async () => {
		const f = fixture(true, undefined, true);
		Object.assign(f.physical, { [field]: field === "headers" ? { trace: "changed" } : "changed" });
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /physical model metadata changed or was absent/);
		assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("does not adopt catalogue mutation while native routing awaits", async () => {
		const f = fixture(true, undefined, true, {}, async () => { await Promise.resolve(); f.physical.baseUrl = "changed"; return { model: f.physical }; });
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /physical model metadata changed or was absent/); assert.equal(f.calls(), 0);
	});
	it("does not admit a newly appeared physical catalogue identity", async () => {
		const f = fixture(true, undefined, true, {}, () => ({ model: f.catalogue.model }));
		f.catalogue.model = { ...f.physical, id: "new" };
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /physical model metadata changed or was absent/); assert.equal(f.calls(), 0);
	});
	it("keys initial provenance by provider, ID and native model kind without choosing a route", async () => {
		const f = fixture(true, undefined, true, {}, undefined, true, (_model, physical) => [physical, { ...physical, type: "image", api: "image-api" }]);
		assert.equal((await f.runtime.resolveModel(f.model, [], {})).model, f.physical);
		assert.throws(() => { f.runtime.getAllModels = () => []; }, TypeError); f.guard.close();
	});
	for (const shape of ["missing", "proxy", "slot accessor", "metadata accessor", "sparse", "duplicate", "too many", "aggregate bytes", "aggregate nodes"] as const) it(`refuses ${shape} initial catalogue data without a fallback`, () => {
		let traps = 0;
		assert.throws(() => fixture(true, undefined, true, {}, undefined, true, (_model, physical) => {
			if (shape === "missing") return undefined;
			if (shape === "proxy") return new Proxy([], { get() { traps++; }, ownKeys() { traps++; return []; } });
			if (shape === "slot accessor") return Object.defineProperty([physical], "0", { get() { traps++; return physical; } });
			if (shape === "metadata accessor") return [Object.defineProperty({ ...physical }, "extra", { get() { traps++; } })];
			if (shape === "sparse") return new Array(2);
			if (shape === "duplicate") return [physical, { ...physical }];
			if (shape === "too many") return new Array(8193).fill(physical);
			if (shape === "aggregate bytes") return Array.from({ length: 260 }, (_, id) => ({ ...physical, id: String(id), extra: "x".repeat(32768) }));
			return Array.from({ length: 800 }, (_, id) => ({ ...physical, id: String(id), extra: Array(800).fill(0) }));
		}), shape === "metadata accessor" ? /model metadata cannot be pinned as bounded accessor-free SDK data/ : /initial SDK model catalogue cannot be pinned/);
		assert.equal(traps, 0);
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
	it("captures exactly one validated native route model before freezing or recording it", async () => {
		let reads = 0;
		const f = fixture(true, undefined, true, {}, () => ({ get model() { reads++; return f.physical; } }));
		await f.runtime.resolveModel(f.model, [], {});
		assert.equal(reads, 1); assert.equal(Object.isFrozen(f.physical), true);
		assert.equal(f.runtime.streamSimple(f.physical, {}, {}), "same-native-result"); f.guard.close();
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
	it("makes only admitted physical model data immutable and preserves native route reuse", async () => {
		const f = fixture(true, undefined, true);
		assert.equal(Object.isFrozen(f.physical), false);
		const route = await f.runtime.resolveModel(f.model, [], {});
		assert.equal(route.model, f.physical); assert.equal(Object.isFrozen(f.physical.headers), true);
		f.runtime.streamSimple(f.physical, {}, { transformHeaders: async () => { f.physical.headers.trace = "changed"; return {}; } });
		await assert.rejects(() => f.options().transformHeaders({}), TypeError);
		assert.throws(() => { f.physical.baseUrl = "https://changed.invalid"; }, TypeError);
		assert.equal((await f.runtime.resolveModel(f.model, [], {})).model, f.physical);
		assert.equal(f.runtime.streamSimple(f.physical, {}, {}), "same-native-result"); f.guard.close();
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
		const f = fixture(), guard = guardChildGeneration({ stream() {}, streamSimple() {}, ...f.originalAPIs }, f.lease, f.model);
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
	for (const change of ["dispatch", "auth", "metadata", "owner", "API", "auth API"] as const) it(`prevents live provider ${change} drift without substituting native code`, () => {
		const f = fixture();
		const mutate = () => {
			if (change === "dispatch") f.providers[0]!.streamSimple = () => "foreign dispatch";
			if (change === "auth") f.providers[0]!.auth.resolve = () => undefined;
			if (change === "metadata") Object.assign(f.providers[0]!, { baseUrl: "https://changed.invalid" });
			if (change === "owner") f.providers[0] = { ...f.providers[0]! };
			if (change === "API") f.runtime.getProvider = () => f.providers[0];
			if (change === "auth API") f.runtime.getAuth = async () => "borrowed auth";
		};
		if (change === "owner") {
			mutate(); assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider identity changed/);
			assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
		} else {
			assert.throws(mutate, TypeError); assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result");
			assert.equal(f.calls(), 1); f.guard.close();
		}
	});
	it("keeps native provider/lookup function identities and delegates auth through owned-data transfer", () => {
		const f = fixture(); assert.equal(f.providers[0]!.streamSimple, f.native);
		for (const name of ["getProvider", "getProviders", "getRegisteredNativeProvider", "getRegisteredProviderConfig"] as const) assert.equal(f.runtime[name], f.originalAPIs[name]);
		assert.notEqual(f.runtime.getAuth, f.originalAPIs.getAuth, "native auth delegates through the owned-data transfer boundary");
		assert.equal(Object.isFrozen(f.providers[0]), true); assert.equal(Object.isFrozen(f.providers[0]!.auth), true);
		assert.equal(Object.isFrozen(f.native), false, "SDK function objects are not recursively frozen or replaced");
		f.guard.close();
	});
	for (const shape of ["accessor", "proxy"] as const) it(`refuses a ${shape} provider catalogue without executing metadata`, () => {
		const f = fixture(); let traps = 0; let provider: any = { id: "trusted" };
		if (shape === "accessor") Object.defineProperty(provider, "extra", { get() { traps++; } });
		else provider = new Proxy(provider, { ownKeys() { traps++; return []; } });
		assert.throws(() => guardChildGeneration({ ...f.runtime, getProviders: () => [provider] }, f.lease, f.model), /provider catalogue cannot be pinned/);
		assert.equal(traps, 0); assert.equal(f.lease.signal.aborted, true);
	});
	for (const source of ["native", "config"] as const) {
		it(`makes registered ${source} callback data immutable without replacing code`, () => {
			const f = fixture(); const reference = f.sources[source][0]!;
			assert.equal(reference.streamSimple, f.native); assert.equal(Object.isFrozen(reference), true);
			assert.throws(() => { reference.streamSimple = () => "foreign"; }, TypeError);
			assert.equal(f.runtime.streamSimple(f.model, {}, {}), "same-native-result"); f.guard.close();
		});
		it(`revokes a replacement registered ${source} owner before dispatch`, () => {
			const f = fixture(); f.sources[source][0] = { ...f.sources[source][0]! } as never;
			assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider identity changed/); assert.equal(f.calls(), 0);
		});
	}
	it("pins absent registered source slots instead of treating them as unchecked", () => {
		const f = starting(); let source: unknown;
		const runtime = { ...f.runtime, stream: f.native, streamSimple: f.native, getRegisteredProviderConfig: () => source };
		const guard = guardChildGeneration(runtime, f.lease, f.model); guard.bind(f.session); guard.completeStartup();
		source = { streamSimple: f.native };
		assert.throws(() => runtime.streamSimple(f.model, {}, {}), /provider identity changed/); assert.equal(f.calls(), 0);
	});
	for (const name of ["getRegisteredNativeProvider", "getRegisteredProviderConfig"] as const) it(`refuses missing ${name} rather than ignoring a source boundary`, () => {
		const f = fixture(); assert.throws(() => guardChildGeneration({ ...f.runtime, [name]: undefined }, f.lease, f.model), /registered provider provenance boundary/);
	});
	for (const shape of ["accessor", "proxy", "primitive", "oversized"] as const) it(`rejects ${shape} registered config data without invoking metadata`, () => {
		const f = fixture(); let traps = 0;
		const source = shape === "accessor" ? Object.defineProperty({}, "extra", { get() { traps++; } })
			: shape === "proxy" ? new Proxy({}, { ownKeys() { traps++; return []; } }) : shape === "primitive" ? "invalid" : { extra: "x".repeat(65537) };
		assert.throws(() => guardChildGeneration({ ...f.runtime, getRegisteredProviderConfig: () => source }, f.lease, f.model), /provider catalogue cannot be pinned/);
		assert.equal(traps, 0);
	});
	it("does not expose details from a failed registered-source lookup", () => {
		const f = starting();
		let failed = false;
		const runtime = { ...f.runtime, stream: f.native, streamSimple: f.native, getRegisteredProviderConfig: () => { if (failed) throw Error("private-value"); return undefined; } };
		const guard = guardChildGeneration(runtime, f.lease, f.model); guard.bind(f.session); guard.completeStartup(); failed = true;
		assert.throws(() => runtime.streamSimple(f.model, {}, {}), error => /provider provenance lookup failed/.test(String(error)) && !String(error).includes("private-value"));
		assert.equal(f.calls(), 0);
	});
	it("poisons the same lifetime when the pinned provider lookup itself throws", () => {
		const f = fixture(); f.providers.find = () => { throw new Error("untrusted lookup details"); };
		assert.throws(() => f.runtime.streamSimple(f.model, {}, {}), /provider provenance lookup failed/);
		assert.equal(f.calls(), 0); assert.equal(f.lease.signal.aborted, true);
	});
	it("cannot install metadata accessors or proxies after startup", () => {
		for (const kind of ["accessor", "proxy"]) {
			const f = fixture(); let traps = 0;
			const mutate = () => kind === "accessor" ? Object.defineProperty(f.providers[0], "extra", { get() { traps++; } }) : Object.assign(f.providers[0]!, { extra: new Proxy({}, { ownKeys() { traps++; return []; } }) });
			assert.throws(mutate, TypeError); assert.equal(traps, 0); assert.equal(f.calls(), 0); f.guard.close();
		}
	});
	it("rechecks provider ownership after an asynchronous native header callback", async () => {
		const f = fixture(); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { await Promise.resolve(); f.providers[0] = { ...f.providers[0]! }; return {}; } });
		await assert.rejects(() => f.options().transformHeaders({}), /provider identity changed/); assert.equal(f.lease.signal.aborted, true);
	});
	it("still revokes provider drift when an asynchronous callback rejects", async () => {
		const f = fixture(); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { f.providers[0] = { ...f.providers[0]! }; throw new Error("hook failed"); } });
		await assert.rejects(() => f.options().transformHeaders({}), /provider identity changed/); assert.equal(f.lease.signal.aborted, true);
	});
	it("preserves the original hook failure when provenance and lifetime remain current", async () => {
		const f = fixture(), original = new Error("owned hook failure"); f.runtime.streamSimple(f.model, {}, { transformHeaders: async () => { throw original; } });
		await assert.rejects(() => f.options().transformHeaders({}), error => error === original); assert.equal(f.lease.signal.aborted, false); f.guard.close();
	});
	it("rejects changed physical-provider ownership before observing a first native route", async () => {
		const f = fixture(true, undefined, true); f.providers[1] = { ...f.providers[1]! };
		await assert.rejects(() => f.runtime.resolveModel(f.model, [], {}), /provider identity changed/); assert.equal(f.calls(), 0);
	});
	it("does not return a late provider stream result after provider ownership changes", async () => {
		const f = fixture(true, () => ({ result: async () => { f.providers[0] = { ...f.providers[0]! }; return "late"; } }));
		await assert.rejects(() => f.runtime.streamSimple(f.model, {}, {}).result(), /provider identity changed/);
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
	it("revokes changed provider ownership even when a native promise rejects", async () => {
		const f = fixture(true, async () => { f.providers[0] = { ...f.providers[0]! }; throw new Error("native failure"); });
		await assert.rejects(() => f.runtime.cancelDeferred(f.model, {}, {}), /provider identity changed/); assert.equal(f.lease.signal.aborted, true);
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
		assert.throws(() => guardChildGeneration({ ...f.originalAPIs }, f.lease, f.model), /lacks the public stream/);
		assert.equal(f.lease.signal.aborted, true);
	});
});
