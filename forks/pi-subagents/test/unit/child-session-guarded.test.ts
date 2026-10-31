import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createChildAuthorityLease, withChildAuthority, type ChildAuthorityLease } from "../../src/runs/shared/child-authority.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

function guarded<T>(cwd: string, run: (lease: ChildAuthorityLease) => Promise<T>): Promise<T> {
	const { lease } = createChildAuthorityLease({
		leaseId: "factory-test", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd },
		payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel: () => {}, requestTimeoutMs: 100,
	});
	return withChildAuthority(lease, () => run(lease)).finally(() => lease.dispose());
}

function launch(cwd: string): ChildSessionLaunch {
	return { cwd, projectTrusted: true, model: "trusted/model:low", storage: { kind: "memory" },
		extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] };
}

// Real resource discovery/settings; no model request or real credential store.
function sdk(options: {
	onLoader?: (loader: DefaultResourceLoader, settings: SettingsManager) => void;
	resolve?: () => { model?: { provider: string; id: string }; warning?: string };
	register?: () => void;
	create?: () => unknown;
} = {}): PiCodingAgentModule {
	return {
		SettingsManager, DefaultResourceLoader,
		ModelRuntime: { create: async () => ({ registerProvider: () => options.register?.(), refresh: async () => {} }) },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: options.resolve ?? (() => ({ model: { provider: "trusted", id: "model" } })),
		createAgentSession: async ({ resourceLoader, settingsManager }: { resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }) => {
			options.onLoader?.(resourceLoader, settingsManager);
			if (options.create) return { session: options.create() };
			throw new Error("captured-before-session");
		},
	} as unknown as PiCodingAgentModule;
}

describe("guarded SDK child startup", () => {
	let root: string, cwd: string, agent: string;
	let previous: string | undefined;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guarded-factory-"));
		cwd = path.join(root, "workspace"); agent = path.join(root, "agent");
		fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true }); fs.mkdirSync(agent);
		previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
	});
	afterEach(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("does not lend parent project trust to child settings, explicit project entries or auto extensions", async () => {
		const marker = path.join(root, "child-code-ran");
		const bad = `export default function () { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); }`;
		fs.writeFileSync(path.join(cwd, ".pi", "extensions", "auto.ts"), bad);
		fs.writeFileSync(path.join(cwd, ".pi", "explicit.ts"), bad);
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "CHILD", extensions: ["./explicit.ts"] }));
		fs.writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), "CHILD-SYSTEM");
		fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ shellCommandPrefix: "GLOBAL" }));
		let captured = false;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk({ onLoader(loader, settings) {
			captured = true;
			assert.equal(settings.isProjectTrusted(), false);
			assert.deepEqual(settings.getProjectSettings(), {});
			assert.equal(settings.getShellCommandPrefix(), "GLOBAL");
			assert.notEqual(loader.getSystemPrompt(), "CHILD-SYSTEM");
			assert.equal(fs.existsSync(marker), false, "child extension code must never execute during discovery");
		} }) });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /captured-before-session/);
		assert.equal(captured, true);
	});

	it("retains a trusted global provider while excluding the child project provider override", async () => {
		fs.writeFileSync(path.join(agent, "provider.ts"), `export default function(pi) { pi.registerProvider('trusted', {marker: 'global'}); }`);
		fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ extensions: ["./provider.ts"] }));
		fs.writeFileSync(path.join(cwd, ".pi", "evil.ts"), `export default function(pi) { pi.registerProvider('trusted', {marker: 'child'}); }`);
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["./evil.ts"] }));
		const registrations: unknown[] = [];
		const api = sdk({ onLoader: loader => assert.deepEqual(loader.getExtensions().extensions.map(e => e.path), [path.join(agent, "provider.ts")]) });
		// Record registrations without initializing any provider auth/SDK model transport.
		api.ModelRuntime.create = async () => ({ registerProvider: (_id: string, config: unknown) => registrations.push(config), refresh: async () => {} }) as never;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => api });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /captured-before-session/);
		assert.deepEqual(registrations, [{ marker: "global" }]);
	});

	it("rejects a failed non-required provider instead of reverting to a built-in of the same name", async () => {
		fs.writeFileSync(path.join(agent, "provider.ts"), `export default function(pi) { pi.registerProvider('trusted', {}); }`);
		fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ extensions: ["./provider.ts"] }));
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk({ register: () => { throw new Error("provider-broken"); } }) });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /provider.*registration failed.*provider-broken/i);
	});

	it("refuses an SDK that cannot establish untrusted-project semantics", async () => {
		const api = { ...sdk(), SettingsManager: { create: () => ({}) } } as unknown as PiCodingAgentModule;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => api });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /explicit untrusted-project settings support/);
	});

	it("rejects a non-required extension import error instead of silently dropping its provider", async () => {
		fs.writeFileSync(path.join(agent, "broken-provider.ts"), `export default function() { throw new Error('provider-load-broken'); }`);
		fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ extensions: ["./broken-provider.ts"] }));
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk() });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /Guarded child extension failed to load.*provider-load-broken/);
	});

	it("rejects a non-required session_start failure and disposes the partially initialized SDK", async () => {
		let disposed = 0;
		const session = { agent: {}, model: { provider: "trusted", id: "model" },
			bindExtensions: async ({ onError }: { onError: (error: unknown) => void }) => onError({ extensionPath: "/ordinary.ts", event: "session_start", error: "failed startup" }),
			extensionRunner: { hasHandlers: () => false }, dispose: () => { disposed++; } };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk({ create: () => session }) });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /Guarded child extension failed during startup.*failed startup/);
		assert.equal(disposed, 1);
	});

	for (const [name, resolution] of [
		["fuzzy model", { model: { provider: "trusted", id: "other-model" } }],
		["wrong provider", { model: { provider: "other", id: "model" } }],
		["missing model", {}],
		["custom-id fallback warning", { model: { provider: "trusted", id: "model" }, warning: "Using custom model id" }],
	] as const) {
		it(`rejects ${name} before creating a session`, async () => {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk({ resolve: () => resolution }) });
			await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /guarded child.*model/i);
		});
	}

	it("requires an explicit fully qualified model before loading the SDK", async () => {
		let loaded = false;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => { loaded = true; return sdk(); } });
		await assert.rejects(() => guarded(cwd, () => factory.create({ ...launch(cwd), model: undefined })), /guarded child.*model/i);
		assert.equal(loaded, false);
	});

	it("keeps the selected native provider and untrusted context through real SDK session_start without acknowledging authority", async () => {
		const faux = fauxProvider({ provider: "trusted", models: [{ id: "model" }] });
		let projectTrust: boolean | undefined;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
		await guarded(cwd, async lease => {
			const child = await factory.create({ ...launch(cwd), hooks: [
				{ name: "fixture-provider", factory: pi => pi.registerProvider(faux.provider as never) },
				{ name: "trust-probe", factory: pi => { pi.on("session_start", (_event, ctx) => { projectTrust = ctx.isProjectTrusted(); }); } },
			] });
			try {
				assert.equal(child.modelId, "trusted/model");
				assert.equal(projectTrust, false);
				assert.throws(() => lease.assertReady(), /ready|acknowledged|consumer/i);
				assert.equal(child.messages.length, 0, "no model prompt was sent");
			} finally { await child.dispose(); await factory.dispose(); }
		});
	});

	it("does not connect a child-project MCP server in the actual SDK/builtin startup", async () => {
		const marker = path.join(root, "mcp-server-ran");
		const server = path.join(root, "trap.mjs");
		fs.writeFileSync(server, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
		fs.writeFileSync(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { trap: { command: process.execPath, args: [server] } } }));
		const faux = fauxProvider({ provider: "trusted", models: [{ id: "model" }] });
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
		try {
			await assert.rejects(() => guarded(cwd, () => factory.create({ ...launch(cwd), tools: ["codemode"],
				builtinMcpTools: [{ name: "mcp_trap_echo", selector: "trap/echo" }],
				hooks: [{ name: "fixture-provider", factory: pi => pi.registerProvider(faux.provider as never) }],
			})), /Selected built-in MCP tools did not register/);
			assert.equal(fs.existsSync(marker), false);
		} finally { await factory.dispose(); }
	});

	it("refuses a startup model switch and disposes the initialized session", async () => {
		let disposed = 0;
		const session = { agent: {}, model: { provider: "other", id: "model" }, bindExtensions: async () => {},
			extensionRunner: { hasHandlers: () => false }, dispose: () => { disposed++; } };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk({ create: () => session }) });
		await assert.rejects(() => guarded(cwd, () => factory.create(launch(cwd))), /guarded child.*model/i);
		assert.equal(disposed, 1);
	});
});
