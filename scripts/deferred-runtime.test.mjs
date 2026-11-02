// Genuine SDK ModelRuntime/AgentSession/faux-backend boundary, source + compiled
// guard. Explicit manual barrier acks: NOT factory/consumer/IPC/SRT/remote proof.
import "../forks/pi-subagents/test/support/isolated-temp-root.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { before } from "node:test";
import { createChildAuthorityLease, withChildAuthority, claimChildAuthority, acknowledgeChildAuthority } from "../forks/pi-subagents/src/runs/shared/child-authority.ts";
import { findHostPeerPackageDir } from "../forks/pi-subagents/src/runs/background/runner-aliases.ts";
import { verifyBuiltArtifact } from "../forks/pi-subagents/scripts/verify-build.mjs";

// This isolated test-file process needs no inherited credentials, proxies,
// preloads or live Pi configuration. Remove by name without inspecting values.
const safeEnv = new Set(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "NODE_TEST_CONTEXT", "PI_SUBAGENTS_TEMP_ROOT", "PI_SUBAGENTS_TEST_LOADER", "PI_SUBAGENTS_NATIVE_PI_ROOT"]);
for (const name of Object.keys(process.env)) if (!safeEnv.has(name)) delete process.env[name];
const repo = fileURLToPath(new URL("../", import.meta.url));
const subagents = path.join(repo, "forks/pi-subagents");
const sdkRoot = realpathSync(process.env.PI_SUBAGENTS_NATIVE_PI_ROOT ?? path.join(subagents, "node_modules/@earendil-works/pi-coding-agent"));
const manifest = JSON.parse(readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const aiRoot = findHostPeerPackageDir(sdkRoot, "@earendil-works/pi-ai"); assert.ok(aiRoot, "selected SDK must supply its real native peer");
const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const ai = await import(pathToFileURL(path.join(aiRoot, "dist/index.js")).href);
before(() => verifyBuiltArtifact({ root: subagents }));

async function fixture(guardChildGeneration, { foreign = false, pendingFetches = 0, virtual = false } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "native-deferred-")), agentDir = path.join(root, "agent"); mkdirSync(agentDir);
	let guard, session, lease;
	const close = () => { guard?.close(); session?.dispose(); lease?.dispose(); rmSync(root, { recursive: true, force: true }); };
	try {
		const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
		const faux = ai.fauxProvider({ provider: "trusted", models: [{ id: "model" }], deferred: { pendingFetches } });
		runtime.registerNativeProvider(faux.provider);
		await runtime.setRuntimeApiKey("trusted", "synthetic-native-fixture");
		const physical = runtime.getPhysicalModel("trusted", "model"); assert.ok(physical);
		if (virtual) runtime.registerVirtualModel({ provider: "trusted", id: "virtual", name: "Native deferred virtual", contextWindow: 128000, maxTokens: 2048, route: () => ({ model: physical, thinkingLevel: "off" }) });
		// Virtual registration queues a native refresh. Settle that through the
		// same supported refresh used by the factory before pinning provenance.
		await runtime.refresh({ allowNetwork: false });
		const model = virtual ? runtime.getModel("trusted", "virtual") : physical; assert.ok(model);
		faux.setResponses([ai.fauxAssistantMessage("Native owned deferred result."), ai.fauxAssistantMessage("Second native deferred result.")]);
		const prior = foreign ? await runtime.streamSimple(model, { messages: [] }, { deferred: true }).result() : undefined;
		if (foreign) { assert.equal(prior.stopReason, "deferred"); assert.ok(prior.deferred); }
		const settings = sdk.SettingsManager.inMemory({});
		const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Synthetic ownership test only.", appendSystemPrompt: [] });
		await loader.reload();
		session = (await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory() })).session;
		({ lease } = createChildAuthorityLease({ leaseId: "native-deferred", identity: { parentSessionId: "parent", runId: "fixture", agent: "fixture", index: 0, cwd: root }, payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel() {}, requestTimeoutMs: 100 }));
		withChildAuthority(lease, () => { for (const role of lease.requiredConsumers) { claimChildAuthority(role, root); acknowledgeChildAuthority(role); } });
		guard = guardChildGeneration(runtime, lease, model); guard.bind(session); guard.completeStartup();
		return { runtime, faux, model, physical, prior, guard, close };
	} catch (error) { close(); throw error; }
}
const text = message => message.content.filter(part => part.type === "text").map(part => part.text).join("");
for (const variant of ["source", "compiled"]) {
	const modulePath = variant === "source" ? "src/runs/shared/child-generation-guard.ts" : "dist-pkg/src/runs/shared/child-generation-guard.js";
	const load = async options => fixture((await import(pathToFileURL(path.join(subagents, modulePath)).href)).guardChildGeneration, options);
	for (const method of ["streamDeferred", "cancelDeferred"]) test(`SDK${manifest.version} ${variant}: foreign ${method} never reaches native IO`, async () => {
		const f = await load({ foreign: true });
		try {
			assert.throws(() => f.runtime[method](f.model, f.prior.deferred), /not observed from this live SDK child/);
			assert.equal(f.faux.state.callCount, 1); assert.equal(f.faux.state.deferredFetchCount, 0); assert.deepEqual(f.faux.state.cancelledDeferred, []);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: native result handles retain native polling and cancellation`, async () => {
		const f = await load({ pendingFetches: 1 });
		try {
			const submitted = await f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true }).result();
			const pending = await f.runtime.streamDeferred(f.model, submitted.deferred).result(); assert.equal(pending.stopReason, "deferred");
			const done = await f.runtime.fetchDeferred(f.model, pending.deferred); assert.equal(text(done), "Native owned deferred result.");
			assert.equal(done.stopReason, "stop"); await f.runtime.cancelDeferred(f.model, submitted.deferred);
			assert.equal(f.faux.state.callCount, 1); assert.equal(f.faux.state.deferredFetchCount, 2); assert.equal(f.faux.state.cancelledDeferred.length, 1);
			assert.equal(Object.isFrozen(submitted.deferred), false);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: native virtual recursion attests its physical deferred handle`, async () => {
		const f = await load({ virtual: true, pendingFetches: 1 });
		try {
			const submitted = await f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true }).result();
			assert.equal(submitted.stopReason, "deferred", JSON.stringify({ error: submitted.errorMessage, calls: f.faux.state.callCount }));
			assert.equal(submitted.deferred.modelId, "model"); assert.equal(f.model.id, "virtual");
			const pending = await f.runtime.fetchDeferred(f.physical, submitted.deferred); assert.equal(pending.stopReason, "deferred");
			const done = await f.runtime.fetchDeferred(f.physical, pending.deferred); assert.equal(text(done), "Native owned deferred result.");
			await f.runtime.cancelDeferred(f.physical, submitted.deferred); assert.equal(f.faux.state.deferredFetchCount, 2); assert.equal(f.faux.state.cancelledDeferred.length, 1);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: native iterator handles retain cancellation and native cancelled errors`, async () => {
		const f = await load();
		try {
			let submitted;
			for await (const event of f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true })) if (event.type === "done") submitted = event.message;
			assert.equal(submitted.stopReason, "deferred"); await f.runtime.cancelDeferred(f.model, submitted.deferred);
			const result = await f.runtime.fetchDeferred(f.model, submitted.deferred);
			assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /was cancelled/);
			assert.equal(f.faux.state.deferredFetchCount, 1); assert.equal(f.faux.state.cancelledDeferred.length, 1);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: an awaited native header hook cannot redirect handle IO`, async () => {
		const f = await load();
		try {
			const submitted = await f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true }).result(); const ownedId = submitted.deferred.id;
			const result = await f.runtime.fetchDeferred(f.model, submitted.deferred, { transformHeaders: async headers => { await Promise.resolve(); submitted.deferred.id = "late-foreign-id"; return headers; } });
			assert.equal(text(result), "Native owned deferred result."); assert.equal(result.stopReason, "stop"); assert.equal(f.faux.state.deferredFetchCount, 1);
			assert.equal(submitted.deferred.id, "late-foreign-id"); assert.notEqual(submitted.deferred.id, ownedId);
			assert.throws(() => f.runtime.cancelDeferred(f.model, submitted.deferred), /handle metadata changed/); assert.deepEqual(f.faux.state.cancelledDeferred, []);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: a native partial alias cannot forge completed handle provenance`, async () => {
		const f = await load();
		try {
			const iterator = f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true })[Symbol.asyncIterator]();
			const start = await iterator.next(); assert.equal(start.value.type, "start");
			start.value.partial.deferred.id = "forged-through-partial";
			await assert.rejects(() => iterator.next(), /deferred response changed after exposure/);
			assert.equal(f.faux.state.callCount, 1); assert.equal(f.faux.state.deferredFetchCount, 0); assert.deepEqual(f.faux.state.cancelledDeferred, []);
		} finally { f.close(); }
	});
	test(`SDK${manifest.version} ${variant}: own handles still require the live lease, not just remembered provenance`, async () => {
		const f = await load();
		try {
			const submitted = await f.runtime.streamSimple(f.model, { messages: [] }, { deferred: true }).result();
			f.guard.close(); assert.throws(() => f.runtime.streamDeferred(f.model, submitted.deferred), /lifetime ended/);
			assert.throws(() => f.runtime.cancelDeferred(f.model, submitted.deferred), /lifetime ended/);
			assert.equal(f.faux.state.deferredFetchCount, 0); assert.deepEqual(f.faux.state.cancelledDeferred, []);
		} finally { f.close(); }
	});
}
