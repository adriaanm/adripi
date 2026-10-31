import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerChildGuardian, mayBeDelegatedGuardian } from "../src/child-consumer.ts";
import { parseDelegatedToolRequest } from "../src/delegated-tool.ts";
import { deriveChildPolicy } from "../../pi-sbx/src/child-authority.ts";
import * as bridge from "../../pi-sbx/src/child-consumer-api.ts";
import { createChildAuthorityLease, withChildAuthority, type ChildAuthorityLeaseHandle } from "../../pi-subagents/src/runs/shared/child-authority.ts";

const keys = [Symbol.for("pi-subagents.child-authority-lease.v1"), Symbol.for("pi-subagents.child-authority-runner.v1")];
const globals = globalThis as Record<PropertyKey, unknown>;
let saved: Array<PropertyDescriptor | undefined>;
let originalAgentDir: string | undefined;
let dir: string;
let cwd: string;
let handle: ChildAuthorityLeaseHandle;
let rootCalls: number;
let verdict: Record<string, unknown>;
let sent: Array<{ id: string; action: { surface: string; target: string } }>;
let branch: SessionEntry[];
let childSessionId: string;
let beforeDelivery: () => void;
let coercionCalls: number;
let signal: AbortController;
let hooks: Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>;
let pi: ExtensionAPI;
function ctx(): ExtensionContext {
	return { cwd, signal: signal.signal, sessionManager: { getSessionId: () => childSessionId, getBranch: () => branch } } as unknown as ExtensionContext;
}
async function emit(name: string, event: unknown = {}, context = ctx()): Promise<any> {
	for (const hook of hooks.get(name) ?? []) {
		const value = await hook(event, context);
		if ((value as { block?: boolean } | undefined)?.block) return value;
	}
}
const event = (id = "tool", name = "read", input = { path: "notes" } as Record<string, unknown>) => ({ toolName: name, toolCallId: id, input });
async function initialize(ackSandbox = true): Promise<void> {
	await withChildAuthority(handle.lease, async () => {
		await registerChildGuardian(pi, () => { rootCalls++; }, { loadBridge: async () => bridge });
		await emit("session_start");
		if (ackSandbox) {
			// A Guardian-only fixture: NOT a production sandbox acknowledgment or
			// SDK/SRT composition test. Real sandbox acceptance remains separate.
			const api = await bridge.loadInstalledChildConsumerApi(dir);
			api.claimChildAuthority("pi-sbx", cwd);
			api.acknowledgeChildAuthority("pi-sbx");
		}
	});
}

beforeEach(() => {
	saved = keys.map(key => Object.getOwnPropertyDescriptor(globals, key));
	for (const key of keys) delete globals[key];
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	dir = mkdtempSync(join(tmpdir(), "guardian-child-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	cwd = join(dir, "workspace"); mkdirSync(cwd);
	const agentDir = join(dir, "parent-agent"); mkdirSync(agentDir);
	const payload = deriveChildPolicy({ agentDir, configDirName: ".pi", identity: { cwd }, baseline: {
		cwd: dir, allowUnsandboxedCommands: false, environmentDeny: [],
		runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] } },
		policy: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [], mandatoryDenyRead: [], mandatoryDenyWrite: [agentDir] },
	} }).payload;
	const pkg = join(dir, "npm/node_modules/pi-subagents"); mkdirSync(join(pkg, "bundle"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: { "./child-authority": "./bundle/authority.js" } }));
	writeFileSync(join(pkg, "bundle/authority.js"), `export * from ${JSON.stringify(new URL("../../pi-subagents/src/api/child-authority.ts", import.meta.url).href)};`);
	rootCalls = 0; sent = []; branch = []; childSessionId = "child-session"; beforeDelivery = () => {}; coercionCalls = 0; signal = new AbortController(); verdict = { outcome: "allow" };
	hooks = new Map();
	pi = { on(name: string, handler: (event: any, context: ExtensionContext) => unknown) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); } } as ExtensionAPI;
	handle = createChildAuthorityLease({ leaseId: "guardian-child-fixture", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd },
		payload, requiredConsumers: ["pi-sbx", "pi-guardian"], requestTimeoutMs: 1000,
		send: (id, action) => { sent.push({ id, action }); queueMicrotask(() => { beforeDelivery(); handle.deliverDecision(id, verdict); }); return true; }, cancel: () => {} });
});
afterEach(() => {
	handle.lease.dispose();
	keys.forEach((key, index) => { if (saved[index]) Object.defineProperty(globals, key, saved[index]!); else delete globals[key]; });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(dir, { recursive: true, force: true });
});

describe("production Guardian semantic consumer (sandbox fixture only)", () => {
	it("uses the actual public claim/ack, installs only forwarding/lifecycle hooks and never starts root Guardian", async () => {
		await initialize();
		assert.equal(rootCalls, 0);
		assert.deepEqual([...hooks.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_result"]);
		assert.doesNotThrow(() => handle.lease.assertReady());
		assert.equal(await emit("tool_call", event()), undefined);
		assert.equal(sent.length, 1, "one exact semantic review, no message_end prefetch/local reviewer");
		assert.deepEqual(JSON.parse(sent[0].action.target), { tool_name: "read", tool_call_id: "tool", input: { path: "notes" }, cwd });
	});

	it("routes the actual registered entry through the co-installed source facade without root config or a local broker", async () => {
		const modules = join(dir, "npm/node_modules");
		const guardian = join(modules, "pi-guardian"), sandbox = join(modules, "pi-sbx");
		cpSync(new URL("../src/", import.meta.url), join(guardian, "src"), { recursive: true });
		cpSync(new URL("../../pi-sbx/src/", import.meta.url), join(sandbox, "src"), { recursive: true });
		writeFileSync(join(guardian, "package.json"), JSON.stringify({ type: "module", version: "0.2.0" }));
		writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module", version: "0.1.3" }));
		writeFileSync(join(dir, "guardian.json"), "not valid root configuration");
		mkdirSync(join(modules, "@earendil-works"));
		for (const dependency of ["pi-coding-agent", "pi-tui"]) {
			symlinkSync(realpathSync(fileURLToPath(new URL(`../node_modules/@earendil-works/${dependency}`, import.meta.url))), join(modules, "@earendil-works", dependency), "dir");
		}
		symlinkSync(realpathSync(fileURLToPath(new URL("../../pi-sbx/node_modules/minimatch", import.meta.url))), join(modules, "minimatch"), "dir");
		const loader = new DefaultResourceLoader({ cwd, agentDir: dir,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
			noExtensions: true, additionalExtensionPaths: [join(guardian, "src/index.ts")],
			noSkills: true, noPromptTemplates: true, noThemes: true });
		await withChildAuthority(handle.lease, async () => {
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			assert.equal(loaded.extensions.length, 1);
			assert.equal(loaded.extensions[0].commands.size, 0);
			hooks = loaded.extensions[0].handlers as typeof hooks;
			await emit("session_start");
		});
		assert.equal(rootCalls, 0);
		assert.deepEqual([...hooks.keys()].sort(), ["session_shutdown", "session_start", "tool_call", "tool_result"]);
		assert.throws(() => handle.lease.assertReady(), /pi-sbx/);
	});

	it("cannot execute a tool before the other real consumer acknowledges", async () => {
		await initialize(false);
		const result = await emit("tool_call", event());
		assert.equal(result.block, true); assert.equal(result.terminate, true);
		assert.equal(sent.length, 0); assert.equal(handle.lease.signal.aborted, true);
	});

	it("forwards large exact write input above the ordinary path bound without granting path/host scope", async () => {
		await initialize();
		const input = { path: "/outside-workspace/log", content: "界".repeat(3500) };
		assert.equal(await emit("tool_call", event("large", "write", input)), undefined);
		assert.deepEqual(JSON.parse(sent[0].action.target).input, input);
		assert.equal(sent[0].action.surface, "tool"); assert.equal(sent.length, 1);
	});

	it("retains dense arrays that fit the actual JSON budget without counting index names as fields", async () => {
		await initialize();
		const input = { values: Array.from({ length: 20_000 }, () => "") };
		assert.equal(await emit("tool_call", event("dense", "custom", input)), undefined);
		assert.deepEqual(JSON.parse(sent[0].action.target).input, input);
	});

	it("locks actual execution arguments, not just a clone, across async review and later handlers", async () => {
		await initialize();
		const input = { path: "reviewed", nested: { value: "exact" } };
		const call = event("immutable", "custom", input);
		beforeDelivery = () => {
			assert.throws(() => { input.path = "unreviewed"; }, TypeError);
			assert.throws(() => { input.nested.value = "unreviewed"; }, TypeError);
		};
		assert.equal(await emit("tool_call", call), undefined);
		assert.deepEqual(JSON.parse(sent[0].action.target).input, input);
		assert.throws(() => { call.input = { path: "substituted" }; }, TypeError);
		assert.equal(Object.isFrozen(input), true); assert.equal(Object.isFrozen(input.nested), true);
	});

	const nonJson: Array<[string, () => Record<string, unknown>]> = [
		["undefined field", () => ({ value: undefined })],
		["function field", () => ({ value() {} })],
		["nonfinite number", () => ({ value: Number.NaN })],
		["negative zero", () => ({ value: -0 })],
		["custom prototype", () => ({ value: new Date() })],
		["sparse array", () => ({ value: Array(2) })],
		["getter", () => ({ get value() { coercionCalls++; return "hidden effect"; } })],
		["toJSON", () => ({ toJSON() { coercionCalls++; return { misleading: true }; } })],
		["shared reference", () => { const value = {}; return { left: value, right: value }; }],
		["cycle", () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
	];
	for (const [label, make] of nonJson) {
		it(`refuses lossy ${label} without executing coercion or requesting approval`, async () => {
			await initialize();
			assert.equal((await emit("tool_call", event("non-json", "custom", make()))).block, true);
			assert.equal(sent.length, 0); assert.equal(coercionCalls, 0); assert.equal(handle.lease.signal.aborted, true);
		});
	}

	it("forwards complete active/branch parent evidence using the same strict parent wire shape", async () => {
		await initialize();
		branch = [{ type: "message", id: "outer-entry", parentId: null, timestamp: new Date().toISOString(), message: {
			role: "assistant", content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "outer exact code" } }], stopReason: "toolUse" } }] as unknown as SessionEntry[];
		assert.equal(await emit("tool_call", { ...event("middle", "codemode", { code: "middle exact code" }), parentToolCallId: "outer" }), undefined);
		assert.equal(await emit("tool_call", { ...event("inner"), parentToolCallId: "middle" }), undefined);
		const parsed = parseDelegatedToolRequest({ identity: handle.lease.identity, action: sent[1].action.target });
		assert.deepEqual(parsed.action.parent_actions, [
			{ tool_name: "codemode", tool_call_id: "outer", input: { code: "outer exact code" } },
			{ tool_name: "codemode", tool_call_id: "middle", input: { code: "middle exact code" } },
		]);
	});

	for (const parent of ["tool", "unknown-parent"]) {
		it(`refuses invalid parent ${parent} without truncating or inventing evidence`, async () => {
			await initialize();
			const result = await emit("tool_call", { ...event(), parentToolCallId: parent });
			assert.equal(result.block, true); assert.equal(sent.length, 0); assert.equal(handle.lease.signal.aborted, true);
		});
	}

	it("refuses a parent chain beyond the exact-action bound instead of omitting ancestors", async () => {
		await initialize();
		branch = [{ type: "message", id: "outer-entry", parentId: null, timestamp: new Date().toISOString(), message: {
			role: "assistant", content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "outer" } }], stopReason: "toolUse" } }] as unknown as SessionEntry[];
		for (let index = 0; index < 32; index++) {
			assert.equal(await emit("tool_call", { ...event(`nested-${index}`), parentToolCallId: index ? `nested-${index - 1}` : "outer" }), undefined);
		}
		assert.equal((await emit("tool_call", { ...event("too-deep"), parentToolCallId: "nested-31" })).block, true);
		assert.equal(sent.length, 32);
	});

	it("refuses replay of an active tool id rather than replacing its parent evidence", async () => {
		await initialize();
		assert.equal(await emit("tool_call", event()), undefined);
		assert.equal((await emit("tool_call", event())).block, true);
		assert.equal(sent.length, 1); assert.equal(handle.lease.signal.aborted, true);
	});

	it("bounds active evidence even if an SDK never supplies tool_result cleanup", async () => {
		await initialize();
		for (let index = 0; index < 256; index++) assert.equal(await emit("tool_call", event(`active-${index}`)), undefined);
		assert.equal((await emit("tool_call", event("overflow"))).block, true);
		assert.equal(sent.length, 256); assert.equal(handle.lease.signal.aborted, true);
	});

	it("returns the parent's denial/termination and cannot start a local approval path", async () => {
		await initialize(); verdict = { outcome: "deny", rationale: "parent fixed restriction", terminate: true };
		const result = await emit("tool_call", event());
		assert.equal(result.block, true); assert.equal(result.terminate, true);
		assert.match(result.reason, /parent fixed restriction/); assert.equal(sent.length, 1); assert.equal(rootCalls, 0);
	});

	it("fails closed when a latched runner has no live scope, not back to root config", async () => {
		globals[keys[1]] = undefined;
		assert.equal(mayBeDelegatedGuardian(), true);
		await registerChildGuardian(pi, () => { rootCalls++; }, { loadBridge: async () => bridge });
		await assert.rejects(() => emit("session_start"), /active withChildAuthority/);
		assert.equal((await emit("tool_call", event())).block, true); assert.equal(rootCalls, 0);
	});

	it("leaves an actual blocking hook after public bridge failure", async () => {
		await assert.rejects(() => registerChildGuardian(pi, () => { rootCalls++; }, { loadBridge: async () => { throw new Error("unavailable public API"); } }), /unavailable public API/);
		assert.equal((await emit("tool_call", event())).block, true); assert.equal(rootCalls, 0);
	});

	it("preserves ordinary root mode only after the actual public detector proves an inactive context", async () => {
		await registerChildGuardian(pi, () => { rootCalls++; }, { loadBridge: async () => bridge });
		assert.equal(rootCalls, 1); assert.equal(await emit("tool_call", event()), undefined); assert.equal(sent.length, 0);
	});

	it("never rebinds a second SDK session or reopens authority after shutdown", async () => {
		await initialize();
		await assert.rejects(() => emit("session_start"), /second SDK session/);
		assert.equal((await emit("tool_call", event())).block, true);
		await emit("session_shutdown");
		assert.equal((await emit("tool_call", event())).block, true); assert.equal(rootCalls, 0);
	});

	it("rejects changed session identity before sending an action", async () => {
		await initialize(); childSessionId = "foreign-session";
		assert.equal((await emit("tool_call", event())).block, true); assert.equal(sent.length, 0);
		assert.equal(handle.lease.signal.aborted, true);
	});

	for (const mutation of ["session", "parent loss", "cancellation"]) {
		it(`discards a pending parent allow after ${mutation}`, async () => {
			await initialize();
			beforeDelivery = () => {
				if (mutation === "session") childSessionId = "foreign-session";
				if (mutation === "parent loss") handle.lease.dispose();
				if (mutation === "cancellation") signal.abort();
			};
			assert.equal((await emit("tool_call", event())).block, true);
			assert.equal(sent.length, 1); assert.equal(handle.lease.signal.aborted, true);
		});
	}

	it("refuses malformed full policy before becoming a usable consumer", async () => {
		const identity = handle.lease.identity;
		handle.lease.dispose();
		handle = createChildAuthorityLease({ leaseId: "malformed-policy", identity, payload: { version: 2 }, requiredConsumers: ["pi-sbx", "pi-guardian"], requestTimeoutMs: 100, send: () => false, cancel: () => {} });
		await assert.rejects(() => initialize(), /Invalid child policy/);
		assert.equal(handle.lease.signal.aborted, true); assert.equal(rootCalls, 0);
		assert.equal((await emit("tool_call", event())).block, true);
	});

	it("refuses a foreign startup cwd rather than borrowing another workspace's root policy", async () => {
		cwd = join(dir, "foreign-workspace"); mkdirSync(cwd);
		await assert.rejects(() => initialize(), /cwd/);
		assert.equal(rootCalls, 0); assert.equal((await emit("tool_call", event())).block, true);
	});

	it("revalidates local pins after an asynchronous parent allow", async () => {
		await initialize();
		const target = join(dir, "retargeted-workspace"); mkdirSync(target);
		beforeDelivery = () => { rmdirSync(cwd); symlinkSync(target, cwd); };
		assert.equal((await emit("tool_call", event())).block, true);
		assert.equal(sent.length, 1); assert.equal(handle.lease.signal.aborted, true);
	});

	it("refuses oversize exact arguments rather than truncating them for approval", async () => {
		await initialize();
		const result = await emit("tool_call", event("oversize", "write", { path: "file", content: "x".repeat(65_000) }));
		assert.equal(result.block, true); assert.equal(sent.length, 0);
	});

	it("keeps a revoked lease blocked even after its ALS scope has ended", async () => {
		await initialize(); handle.lease.dispose();
		assert.equal((await emit("tool_call", event())).block, true); assert.equal(sent.length, 0); assert.equal(rootCalls, 0);
	});
});
