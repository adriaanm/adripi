// Real runner/SDK/registered consumers and IPC; only the installed SRT backend
// and parent's credential-free reviewer verdict are doubles. Never claim/ack here.
import { createDefaultChildSessionFactory, type ChildHookExtension } from "../../forks/pi-subagents/src/runs/shared/child-session.ts";
import { withChildAuthority } from "../../forks/pi-subagents/src/runs/shared/child-authority.ts";
import { bindRunnerChildAuthority } from "../../forks/pi-subagents/src/runs/shared/child-authority-launch.ts";
import { runChildSession } from "../../forks/pi-subagents/src/runs/background/run-child-session.ts";
import type { InProcessChildLaunch } from "../../forks/pi-subagents/src/runs/shared/child-launch.ts";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Config {
	cwd: string;
	sdkRoot: string;
	extensions: Array<{ id: string; path: string }>;
	additionalExtensions: string[];
	startupAfterReady?: boolean;
	virtual?: boolean;
	configProvider?: boolean | "overlay";
	authEnvHandoff?: boolean;
	callerOptionsHandoff?: boolean;
	cacheWarming?: boolean;
	classifierRoute?: boolean;
	compactionProbe?: "plain" | "auth-base-url" | "auth-drop" | "auth-change";
	steps: Array<{ name: string; input: Record<string, unknown> }>;
}
const config = JSON.parse(process.argv[2]) as Config;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(path.join(path.dirname(config.sdkRoot), "pi-ai/dist/index.js")).href);
const faux = fauxProvider({ provider: "trusted", models: [{ id: "model" }] });
const initialBaseUrl = faux.getModel().baseUrl;
if (config.cacheWarming) faux.models[0].promptCache = { short: 11 };
let compacting = false, compactAuthReads = 0;
if (config.authEnvHandoff || config.compactionProbe?.startsWith("auth-")) {
	const nativeResolve = faux.provider.auth.apiKey.resolve;
	faux.provider.auth.apiKey.resolve = async input => {
		const resolution = await nativeResolve(input);
		if (!resolution) return resolution;
		const changed = compacting && ++compactAuthReads > 1;
		const baseUrl = changed && config.compactionProbe === "auth-drop" ? undefined : changed && config.compactionProbe === "auth-change" ? "https://changed-auth.invalid" : "https://auth-fixture.invalid";
		const result = { ...resolution,
			...(config.authEnvHandoff ? { env: { PI_FIXTURE_ENV: "original" } } : {}),
			...(config.compactionProbe?.startsWith("auth-") ? { auth: { ...resolution.auth, baseUrl } } : {}) };
		if (config.authEnvHandoff) (globalThis as Record<symbol, unknown>)[Symbol.for("fixture.auth.result")] = result;
		return result;
	};
}
const factory = createDefaultChildSessionFactory({
	// Use the selected genuine SDK/peers in this synthetic layout; no fake runtime.
	loadPiCodingAgent: () => import(pathToFileURL(path.join(config.sdkRoot, "dist/index.js")).href),
});
let authority: Awaited<ReturnType<typeof bindRunnerChildAuthority>>;
const readyAtGenerations: string[][] = [];
const modelAtGenerations: Array<{ baseUrl: string; api: string; maxTokens?: number }> = [];
const headerAtGenerations: Array<string | null | undefined> = [];
const envAtGenerations: Array<string | undefined> = [];
let compaction: unknown, compactionEntry: unknown;
let compactionError: string | undefined;
// Passive observation of the genuine faux backend input, before its queued
// onResponse hook. The same native faux implementation still owns execution.
const nativeStream = faux.provider.streamSimple;
faux.provider.streamSimple = (model, context, options) => {
	modelAtGenerations.push({ baseUrl: model.baseUrl, api: model.api, ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) });
	headerAtGenerations.push(options?.headers && Object.getOwnPropertyDescriptor(options.headers, "x-fixture")?.value);
	envAtGenerations.push(options?.env && Object.getOwnPropertyDescriptor(options.env, "PI_FIXTURE_ENV")?.value);
	return nativeStream.call(faux.provider, model, context, options);
};
faux.setResponses([
	...(config.callerOptionsHandoff ? [fauxAssistantMessage("Auxiliary options probe completed.")] : []),
	...config.steps.flatMap((step, index) => [fauxAssistantMessage(
		fauxToolCall(step.name, step.input, { id: `native-${index}` }), { stopReason: "toolUse" },
	), ...(config.cacheWarming && !config.virtual && index === 0 ? [fauxAssistantMessage("Native cache warm response.")] : [])]),
	fauxAssistantMessage("Fixture finished; inspect tool results for expected refusals."),
	...(config.compactionProbe ? [fauxAssistantMessage("Native synthetic compaction summary."), fauxAssistantMessage("Native synthetic turn summary.")] : []),
].map(response => () => {
	// Observes (and never creates) readiness on every actual native provider call.
	authority!.lease.assertReady();
	readyAtGenerations.push([...authority!.lease.requiredConsumers]);
	return response;
}));
try {
	authority = await bindRunnerChildAuthority();
	if (!authority) throw new Error("real IPC authority was not bound");
	const runtime = { agent: "worker", childIndex: 0, runId: "run", fanoutChild: false, depth: 1,
		waitTool: { enabled: false }, fast: false };
	// The standard runner's launch-shaped input: no alternative session, transport,
	// model engine, approval API or consumer. Full launch-plan acceptance is separate.
	const launch = {
		toolPlan: { extensionArgs: [], requiredExtensions: config.extensions, configuredExtensions: [], runtimeExtensions: [], warnings: [] },
		config: runtime,
		session: {
			cwd: config.cwd, model: config.virtual ? "trusted/virtual" : "trusted/model", storage: { kind: "memory" },
			extensionPaths: config.startupAfterReady ? [...config.extensions.map(item => item.path), ...config.additionalExtensions] : [...config.additionalExtensions, ...config.extensions.map(item => item.path)], requiredExtensions: config.extensions,
			ambientExtensions: false, hooks: [{ name: "fixture-provider", factory: (api: Parameters<ChildHookExtension["factory"]>[0]) => {
				if (config.compactionProbe) api.registerCommand("fixture-compact", { description: "Synthetic native SDK compaction probe", handler: async (_args, ctx) => {
					await ctx.waitForIdle(); compacting = true;
					try { compaction = await new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject })); }
					catch (error) { compactionError = error instanceof Error ? error.message : String(error); throw error; }
					finally {
						const entry = ctx.sessionManager.getEntries().findLast(entry => entry.type === "compaction");
						compactionEntry = entry && { id: entry.id, type: entry.type, summary: entry.summary };
					}
				} });
				if (config.configProvider === "overlay") api.registerProvider(faux.provider);
				else if (config.configProvider) api.registerProvider("trusted", { api: faux.api, apiKey: "synthetic-fixture", baseUrl: faux.models[0].baseUrl, models: faux.models, streamSimple: faux.provider.streamSimple });
				else api.registerProvider(faux.provider);
				if (config.virtual) api.registerVirtualModel({ provider: "trusted", id: "virtual", name: "Fixture virtual", contextWindow: 128000, maxTokens: 2048,
					route: async (request, ctx) => {
						if (config.classifierRoute) {
							const classifier = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
							if (!classifier) throw new Error("Native classifier fixture is absent from the SDK catalogue");
							try { await ctx.modelRegistry.classify(classifier, { state: { probe: "synthetic" }, questions: { approved: { type: "bool", instructions: "Synthetic refusal probe", criteria: { true: "yes", false: "no" } } } }, { signal: request.signal }); }
							catch (error) {
								writeFileSync(path.join(config.cwd, "classifier-refusal.json"), JSON.stringify({ provider: classifier.provider, id: classifier.id, type: classifier.type, error: error instanceof Error ? error.message : String(error) }));
								throw error;
							}
						}
						return { model: faux.models[0], thinkingLevel: "off" };
					} });
			} }],
			tools: ["read", "write", "edit", "bash", "ls", "grep", "find"], noSkills: true, noContextFiles: true, runtime,
		},
		capture: { structuredOutput: () => ({ called: false, acceptanceReportProvided: false }), toolDiagnostic: () => undefined,
			runtimeAcknowledgedExtensions: () => undefined, finalDrainHeld: () => false },
		launchResolvedExtensions: { version: 1 }, warnings: [],
	} as unknown as InProcessChildLaunch;
	if (config.compactionProbe) {
		// Sequence public child/SDK APIs, not fake history or a replacement SDK.
		const child = await withChildAuthority(authority.lease, () => factory.create(launch.session));
		try {
			await child.prompt("Execute the credential-free source fixture only.");
			await child.prompt("/fixture-compact");
			console.log("PRODUCTION_RESULT " + JSON.stringify({ compaction, compactionEntry, compactionError, calls: faux.state.callCount, readyAtGenerations, modelAtGenerations, headerAtGenerations, envAtGenerations, initialBaseUrl }));
		} finally { await child.dispose(); }
	} else {
		const result = await runChildSession({ factory, launch, authority,
			prompt: "Execute the credential-free source fixture only.", appendChildEvent() {}, writeOutputLine() {} });
		console.log("PRODUCTION_RESULT " + JSON.stringify({ result, calls: faux.state.callCount, readyAtGenerations, modelAtGenerations, headerAtGenerations, envAtGenerations, initialBaseUrl }));
	}
} catch (error) {
	console.log("PRODUCTION_ERROR " + JSON.stringify({ message: error instanceof Error ? error.message : String(error), calls: faux.state.callCount, readyAtGenerations, modelAtGenerations, headerAtGenerations, envAtGenerations, initialBaseUrl }));
	process.exitCode = 1;
} finally {
	await factory.dispose();
	authority?.dispose();
}
