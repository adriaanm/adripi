// Archived review evidence for baseline 2e86f45, not regression acceptance tests.
// Copy to forks/pi-sbx/test/review-probes.test.ts and run Vitest there;
// see docs/review/verification.md. Relative imports assume that staging path.
// All command execution and OS sandboxing are mocked.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const state = vi.hoisted(() => ({ agent: "", root: "", runtime: undefined as any, ask: undefined as any, runs: [] as any[], hold: undefined as any }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<any>(),
  getAgentDir: () => state.agent,
  createBashToolDefinition: (_cwd: string, options?: any) => ({
    name: "bash", promptGuidelines: [],
    async execute(_id: string, input: any) {
      state.runs.push({ command: input.command, sandboxed: !!options?.operations, config: structuredClone(state.runtime) });
      if (state.hold && input.command === "first") await state.hold;
      return { content: [{ type: "text", text: "mock only" }], details: {} };
    },
  }),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async (original) => ({
  ...await original<any>(),
  SandboxManager: {
    isSupportedPlatform: () => true, isSandboxingEnabled: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async (config: any, ask: any) => { state.runtime = config; state.ask = ask; },
    updateConfig: (config: any) => { state.runtime = config; },
    reset: async () => {}, getSandboxViolationStore: () => undefined,
    getLinuxGlobPatternWarnings: () => [],
  },
}));
vi.mock("../src/scratch.ts", async (original) => ({
  ...await original<any>(), sweepScratchpads: async () => [],
  createScratchpad: async () => ({ dir: join(state.root, "scratch"), dispose: async () => {} }),
}));
vi.mock("../src/violations.ts", () => ({
  removeSandboxViolationTags: (x: any) => x,
  ViolationTracker: class { start() {} stop() {} },
}));
import sandboxExtension from "../src/index.ts";
import guardianExtension from "../../pi-guardian/src/index.ts";
import { publishGuardianBrokerForTest } from "../src/broker.ts";
import { hostCommandRefusal } from "../src/host-command.ts";
import { planInlineEscalation } from "../src/inline-escalation.ts";
import { evaluateSandboxRules } from "../../pi-guardian/src/sandbox/rules.ts";
import { persistProjectRule, readProjectPolicy, recordProjectTrust, isProjectPolicyTrusted } from "../../pi-guardian/src/project-policy.ts";

let cleanup: (() => void) | undefined;
let shutdown: (() => Promise<void>) | undefined;
const empty = { allow: [], deny: [], defer: [] };
function harness() {
  const handlers = new Map<string, Function[]>(); const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
    registerFlag() {}, getFlag: () => false, registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer() {}, appendEntry() {},
  } as any;
  const ctx = { cwd: state.root, hasUI: false, mode: "json", signal: undefined,
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {} },
    sessionManager: { getBranch: () => [], getSessionId: () => "review" },
  } as any;
  const emit = async (name: string, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  return { pi, ctx, tools, commands, emit };
}
async function sbx(allowUnsandboxedCommands = true) {
  await writeFile(join(state.agent, "extensions", "sandbox.json"), JSON.stringify({ allowUnsandboxedCommands }));
  const h = harness(); sandboxExtension(h.pi); await h.emit("session_start"); shutdown = () => h.emit("session_shutdown");
  return h;
}
function broker(kind: "allow" | "defer" = "allow") {
  cleanup = publishGuardianBrokerForTest({ review: async () => kind === "allow"
    ? { kind: "allow", scope: "once", review: { source: "rule", rationale: "mock decision" } }
    : { kind: "defer", review: { source: "rule", rationale: "mock defer" } } });
}
beforeEach(async () => {
  state.root = await mkdtemp(join(process.cwd(), "review-probe-")); state.agent = join(state.root, "agent");
  await mkdir(join(state.agent, "extensions"), { recursive: true }); state.runs = []; state.hold = undefined;
});
afterEach(async () => {
  cleanup?.(); cleanup = undefined; await shutdown?.(); shutdown = undefined;
  delete (globalThis as any)[Symbol.for("pi-guardian:project-policy")];
  delete (globalThis as any)[Symbol.for("pi-guardian:sandbox-broker")];
  await rm(state.root, { recursive: true, force: true });
});
it("inline host path skips standalone newline-shape refusal", async () => {
  const h = await sbx(); broker(); const command = "echo review\nprintf review";
  expect(hostCommandRefusal(command)).toBe("multi-line command");
  expect(evaluateSandboxRules(empty, { surface: "command", target: command, cwd: state.root } as any, state.agent).outcome).toBe("review");
  await h.tools.get("bash").execute("host", { command, sandbox_permissions: "require_escalated", justification: "probe" }, undefined, undefined, h.ctx);
  expect(state.runs[0]).toMatchObject({ command, sandboxed: false });
});
it("standalone host grant bypasses allowUnsandboxedCommands false", async () => {
  const h = await sbx(false); broker();
  await h.tools.get("request_sandbox_exception").execute("grant", { surface: "command", target: "echo review", scope: "once", reason: "probe" }, undefined, undefined, h.ctx);
  await h.tools.get("bash").execute("run", { command: "echo review" }, undefined, undefined, h.ctx);
  expect(state.runs[0].sandboxed).toBe(false);
});
it("network once grant is erased by its own tool_result", async () => {
  const h = await sbx(); broker();
  await h.tools.get("request_sandbox_exception").execute("grant", { surface: "network", target: "example.test:443", scope: "once", reason: "probe" }, undefined, undefined, h.ctx);
  await h.emit("tool_result", { toolCallId: "grant" }); cleanup?.(); cleanup = undefined;
  // With no pending once token, a missing broker defers then headless denies.
  expect(await state.ask({ host: "example.test", port: 443 })).toBe(false);
});
it("concurrent ordinary command observes another call's scoped widening", async () => {
  const h = await sbx(); broker(); const target = join(state.root, "..", "outside-review-cache");
  let release!: () => void; state.hold = new Promise<void>((resolve) => { release = resolve; });
  const first = h.tools.get("bash").execute("a", { command: "first", sandbox_permissions: "with_additional_permissions", additional_permissions: { file_system: { write: [target] } }, justification: "probe" }, undefined, undefined, h.ctx);
  await vi.waitFor(() => expect(state.runs).toHaveLength(1));
  await h.tools.get("bash").execute("b", { command: "second" }, undefined, undefined, h.ctx);
  expect(state.runs[1].config.filesystem.allowWrite).toContain(target); release(); await first;
  expect(state.runtime.filesystem.allowWrite).not.toContain(target);
});
it("host inline defer cannot use supervisor channel", async () => {
  const h = await sbx(); broker("defer"); h.ctx.executeTool = vi.fn(async () => ({ isError: false, result: { content: [{ type: "text", text: "ALLOW once" }] } }));
  await expect(h.tools.get("bash").execute("host", { command: "echo review", sandbox_permissions: "require_escalated", justification: "probe" }, undefined, undefined, h.ctx)).rejects.toThrow("User denied");
  expect(h.ctx.executeTool).not.toHaveBeenCalled();
});
it("prefix proposals are not bound to the current command", () => {
  expect(planInlineEscalation({ sandbox_permissions: "require_escalated", justification: "probe", prefix_rule: ["git", "push"] })).toMatchObject({ kind: "host", prefixRule: "git push:*" });
  expect(hostCommandRefusal("/bin/sh -c true")).toBeUndefined();
  expect(hostCommandRefusal("python3 -c 'print(1)'")).toBeUndefined();
});
it("network port rules discard explicit port boundaries", () => {
  const outcome = evaluateSandboxRules({ ...empty, allow: ["network:example.test:443"] }, { surface: "network", target: "example.test:8443", cwd: state.root } as any, state.agent);
  expect(outcome.outcome).toBe("allow");
});
it("saving one rule can trust preexisting unapproved policy entries", async () => {
  await mkdir(join(state.root, ".pi")); const path = join(state.root, ".pi", "guardian.json");
  await writeFile(path, JSON.stringify({ sandboxExceptions: { allow: ["command:echo:*"] } }));
  const before = readProjectPolicy(state.root); expect(before.kind).toBe("ok");
  if (before.kind !== "ok") return;
  expect(isProjectPolicyTrusted(state.agent, path, before.policy.hash)).toBe(false);
  const saved = persistProjectRule(state.root, "command:git push:*"); expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  recordProjectTrust(state.agent, saved.path, saved.hash); const after = readProjectPolicy(state.root);
  expect(after.kind === "ok" && after.policy.sandboxExceptions.allow).toContain("command:echo:*");
  expect(isProjectPolicyTrusted(state.agent, saved.path, saved.hash)).toBe(true);
});
it("explicit grants accept wildcard network targets despite the no-wildcards contract", async () => {
  const h = await sbx(); broker();
  const result = await h.tools.get("request_sandbox_exception").execute("grant", { surface: "network", target: "*.example.test", scope: "session", reason: "probe" }, undefined, undefined, h.ctx);
  // The mock narrows to once; the request is nevertheless accepted as granted.
  expect(result.content[0].text).toContain("granted");
});
it("enabling Guardian after disabled startup does not publish its broker", async () => {
  await writeFile(join(state.agent, "guardian.json"), JSON.stringify({ enabled: false, reviewer: { model: "fake/model" } }));
  const h = harness(); guardianExtension(h.pi); await h.emit("session_start");
  const key = Symbol.for("pi-guardian:sandbox-broker"); expect((globalThis as any)[key]).toBeUndefined();
  await h.commands.get("guardian").handler("on", h.ctx); expect((globalThis as any)[key]).toBeUndefined();
  await h.emit("session_shutdown");
});
it("guardian toggles do not update broker publication and shutdown leaves project service", async () => {
  await writeFile(join(state.agent, "guardian.json"), JSON.stringify({ reviewer: { model: "fake/model" }, sandboxExceptions: { allow: ["command:echo:*"] } }));
  const h = harness(); guardianExtension(h.pi); await h.emit("session_start");
  const key = Symbol.for("pi-guardian:sandbox-broker"); const original = (globalThis as any)[key]; expect(original).toBeDefined();
  await h.commands.get("guardian").handler("off", h.ctx); expect((globalThis as any)[key]).toBe(original);
  await h.emit("session_shutdown"); expect((globalThis as any)[key]).toBeUndefined();
  expect((globalThis as any)[Symbol.for("pi-guardian:project-policy")]).toBeDefined();
});
