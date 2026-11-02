// Real runner/SDK/registered consumers and IPC; only the installed SRT backend
// and parent's credential-free reviewer verdict are doubles. Never claim/ack here.
import { createDefaultChildSessionFactory, type ChildHookExtension } from "../../forks/pi-subagents/src/runs/shared/child-session.ts";
import { bindRunnerChildAuthority } from "../../forks/pi-subagents/src/runs/shared/child-authority-launch.ts";
import { runChildSession } from "../../forks/pi-subagents/src/runs/background/run-child-session.ts";
import type { InProcessChildLaunch } from "../../forks/pi-subagents/src/runs/shared/child-launch.ts";
import path from "node:path";
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
	steps: Array<{ name: string; input: Record<string, unknown> }>;
}
const config = JSON.parse(process.argv[2]) as Config;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(path.join(path.dirname(config.sdkRoot), "pi-ai/dist/index.js")).href);
const faux = fauxProvider({ provider: "trusted", models: [{ id: "model" }] });
const initialBaseUrl = faux.getModel().baseUrl;
if (config.authEnvHandoff) {
	const nativeResolve = faux.provider.auth.apiKey.resolve;
	faux.provider.auth.apiKey.resolve = async input => {
		const resolution = await nativeResolve(input);
		if (!resolution) return resolution;
		const result = { ...resolution, env: { PI_FIXTURE_ENV: "original" } };
		(globalThis as Record<symbol, unknown>)[Symbol.for("fixture.auth.result")] = result;
		return result;
	};
}
const factory = createDefaultChildSessionFactory({
	// Use the selected genuine SDK/peers in this synthetic layout; no fake runtime.
	loadPiCodingAgent: () => import(pathToFileURL(path.join(config.sdkRoot, "dist/index.js")).href),
});
let authority: Awaited<ReturnType<typeof bindRunnerChildAuthority>>;
const readyAtGenerations: string[][] = [];
const modelAtGenerations: Array<{ baseUrl: string; api: string }> = [];
const headerAtGenerations: Array<string | null | undefined> = [];
const envAtGenerations: Array<string | undefined> = [];
// Passive observation of the genuine faux backend input, before its queued
// onResponse hook. The same native faux implementation still owns execution.
const nativeStream = faux.provider.streamSimple;
faux.provider.streamSimple = (model, context, options) => {
	modelAtGenerations.push({ baseUrl: model.baseUrl, api: model.api });
	headerAtGenerations.push(options?.headers && Object.getOwnPropertyDescriptor(options.headers, "x-fixture")?.value);
	envAtGenerations.push(options?.env && Object.getOwnPropertyDescriptor(options.env, "PI_FIXTURE_ENV")?.value);
	return nativeStream.call(faux.provider, model, context, options);
};
faux.setResponses([
	...(config.callerOptionsHandoff ? [fauxAssistantMessage("Auxiliary options probe completed.")] : []),
	...config.steps.map((step, index) => fauxAssistantMessage(
		fauxToolCall(step.name, step.input, { id: `native-${index}` }), { stopReason: "toolUse" },
	)),
	fauxAssistantMessage("Fixture finished; inspect tool results for expected refusals."),
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
				if (config.configProvider === "overlay") api.registerProvider(faux.provider);
				else if (config.configProvider) api.registerProvider("trusted", { api: faux.api, apiKey: "synthetic-fixture", baseUrl: faux.models[0].baseUrl, models: faux.models, streamSimple: faux.provider.streamSimple });
				else api.registerProvider(faux.provider);
				if (config.virtual) api.registerVirtualModel({ provider: "trusted", id: "virtual", name: "Fixture virtual", contextWindow: 128000, maxTokens: 2048,
					route: () => ({ model: faux.models[0], thinkingLevel: "off" }) });
			} }],
			tools: ["read", "write", "edit", "bash", "ls", "grep", "find"], noSkills: true, noContextFiles: true, runtime,
		},
		capture: { structuredOutput: () => ({ called: false, acceptanceReportProvided: false }), toolDiagnostic: () => undefined,
			runtimeAcknowledgedExtensions: () => undefined, finalDrainHeld: () => false },
		launchResolvedExtensions: { version: 1 }, warnings: [],
	} as unknown as InProcessChildLaunch;
	const result = await runChildSession({ factory, launch, authority,
		prompt: "Execute the credential-free source fixture only.", appendChildEvent() {}, writeOutputLine() {} });
	console.log("PRODUCTION_RESULT " + JSON.stringify({ result, calls: faux.state.callCount, readyAtGenerations, modelAtGenerations, headerAtGenerations, envAtGenerations, initialBaseUrl }));
} catch (error) {
	console.log("PRODUCTION_ERROR " + JSON.stringify({ message: error instanceof Error ? error.message : String(error), calls: faux.state.callCount, readyAtGenerations, modelAtGenerations, headerAtGenerations, envAtGenerations, initialBaseUrl }));
	process.exitCode = 1;
} finally {
	await factory.dispose();
	authority?.dispose();
}
