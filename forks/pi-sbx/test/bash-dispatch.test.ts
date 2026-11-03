import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveChildPolicy } from "../src/child-authority.ts";
import { bindChildRuntimeCodePaths, createChildAuthorityLease, withChildAuthority } from "../../pi-subagents/src/runs/shared/child-authority.ts";
import * as childApi from "../../pi-subagents/src/api/child-authority.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PROJECT_POLICY_KEY,
  publishGuardianBrokerForTest,
  type ProjectPolicyService,
  type SandboxExceptionDecision,
  type SandboxExceptionRequest,
} from "../src/broker.ts";

type Recorded = { command: string; runtime: unknown };
type Deferred = { promise: Promise<void>; resolve: () => void };

const state = vi.hoisted(() => ({
  agentDir: "",
  realSdkTools: false,
  localCalls: [] as Recorded[],
  sandboxCalls: [] as Recorded[],
  runtimeCurrent: undefined as unknown,
  runtimeHistory: [] as unknown[],
  sandboxAvailable: true,
  refreshFailures: 0,
  sandboxExecute: undefined as undefined | ((params: { command: string }) => Promise<unknown>),
  askCallback: undefined as undefined | ((host: { host: string; port?: number }) => Promise<boolean>),
}));

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const fakeTool = (sandboxed: boolean) => ({
    name: "bash",
    label: "bash",
    description: "fake bash",
    parameters: {},
    promptGuidelines: [] as string[],
    renderResult: () => ({ render: () => [] }),
    async execute(_id: string, params: { command: string }) {
      if (sandboxed) {
        state.sandboxCalls.push({ command: params.command, runtime: state.runtimeCurrent });
        if (state.sandboxExecute) return state.sandboxExecute(params);
        return { content: [{ type: "text", text: `sandbox:${params.command}` }], details: {} };
      }
      state.localCalls.push({ command: params.command, runtime: state.runtimeCurrent });
      return { content: [{ type: "text", text: `host:${params.command}` }], details: {} };
    },
  });
  return {
    ...actual,
    getAgentDir: () => state.agentDir,
    hasTrustRequiringProjectResources: () => false,
    createBashToolDefinition: (cwd: string, options?: Parameters<typeof actual.createBashToolDefinition>[1]) => state.realSdkTools
      ? actual.createBashToolDefinition(cwd, options) : fakeTool(Boolean(options?.operations)),
  };
});

vi.mock("../src/bash-operations.ts", () => ({
  createSandboxedBashOperations: () => ({ exec: async (...args: Parameters<BashOperations["exec"]>) => {
    if (!state.realSdkTools) return { exitCode: 0 };
    // Actual SDK process/output backend; the OS sandbox is deliberately mocked,
    // not nested inside the test harness. This is dispatch/capture evidence.
    const sdk = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    state.sandboxCalls.push({ command: args[0], runtime: state.runtimeCurrent });
    return sdk.createLocalBashOperations().exec(...args);
  } }),
}));

vi.mock("../src/manager.ts", () => {
  class SandboxController {
    private state = "disabled";
    private error: string | undefined;
    private config: { runtime: unknown } | undefined;

    getState() { return this.state; }
    getError() { return this.error; }
    getConfig() { return this.config; }
    checkDependencies() { return { errors: [] as string[], warnings: [] as string[] }; }
    isSupported() { return true; }

    async initialize(config: { runtime: unknown }, ask?: (host: { host: string; port?: number }) => Promise<boolean>) {
      this.config = config;
      state.askCallback = ask;
      if (!state.sandboxAvailable) {
        this.state = "unavailable";
        this.error = "sandbox unavailable in test";
        throw new Error(this.error);
      }
      state.runtimeCurrent = config.runtime;
      state.runtimeHistory.push(config.runtime);
      this.state = "active";
    }

    refresh(config: { runtime: unknown }) {
      this.config = config;
      if (this.state === "active") {
        state.runtimeCurrent = config.runtime;
        state.runtimeHistory.push(config.runtime);
        if (state.refreshFailures > 0) {
          state.refreshFailures--;
          throw new Error("runtime refresh failed after mutation");
        }
      }
    }

    setSessionEnabled(enabled: boolean) {
      if (!enabled) this.state = "disabled";
      else if (this.config) this.state = "active";
    }

    canRunSandboxed() { return this.state === "active"; }
    shouldFailClosed() { return false; }

    async reset() {
      this.state = "disabled";
      this.error = undefined;
      state.runtimeCurrent = undefined;
    }
  }

  return {
    SandboxController,
    RuntimeSandboxManager: {
      getSandboxViolationStore: () => ({
        getTotalCount: () => 0,
        getViolations: () => [],
        subscribe: () => () => undefined,
      }),
      getLinuxGlobPatternWarnings: () => [] as string[],
      checkDependencies: () => ({ errors: [] as string[], warnings: [] as string[] }),
      reset: async () => undefined,
    },
  };
});

import sandboxExtension from "../src/index.ts";
import { canonicalizeTarget } from "../src/path-policy.ts";

const disposers: Array<() => void> = [];
const shutdowns: Array<() => Promise<void>> = [];
let projectRoot = "";

function setup(options: { allowUnsandboxedCommands?: boolean; failIfUnavailable?: boolean; exclude?: string[]; denyRead?: string[] } = {}) {
  projectRoot = mkdtempSync(join(tmpdir(), "pi-sbx-dispatch-"));
  const agentDir = join(projectRoot, "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "sandbox.json"), JSON.stringify({
    filesystem: { allowWrite: ["."], ...(options.denyRead ? { denyRead: options.denyRead } : {}) },
    ...(options.allowUnsandboxedCommands === false ? { allowUnsandboxedCommands: false } : {}),
    ...(options.failIfUnavailable === false ? { failIfUnavailable: false } : {}),
    ...(options.exclude ? { excludedCommands: options.exclude } : {}),
  }));
  state.agentDir = agentDir;
  return { root: projectRoot, agentDir };
}

type FakePi = {
  pi: ExtensionAPI;
  tools: Array<Record<string, unknown>>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  commands: Map<string, unknown>;
};

function fakeExtension(flags: Record<string, boolean> = {}): FakePi {
  const tools: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, unknown>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: (name: string) => flags[name] ?? false,
    registerTool: (tool: Record<string, unknown>) => { tools.push(tool); },
    registerCommand: (name: string, definition: unknown) => { commands.set(name, definition); },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers, commands };
}

function context(options: { hasUI?: boolean; select?: unknown; confirm?: unknown } = {}): ExtensionContext {
  return {
    cwd: projectRoot,
    mode: options.hasUI === false ? "print" : "tui",
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => false,
    executeTool: vi.fn(),
    sessionManager: { getSessionId: () => "capture-fixture", getSessionFile: () => undefined },
    ui: {
      select: options.select ?? vi.fn(async () => undefined),
      confirm: options.confirm ?? vi.fn(async () => false),
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

type BashTool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; additionalProperties?: boolean };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

async function start(
  options: { allowUnsandboxedCommands?: boolean; failIfUnavailable?: boolean; exclude?: string[]; denyRead?: string[] } = {},
  ctxOptions: { hasUI?: boolean; select?: unknown; confirm?: unknown } = {},
) {
  setup(options);
  const extension = fakeExtension();
  sandboxExtension(extension.pi);
  const sessionContext = context(ctxOptions);
  await extension.handlers.get("session_start")!({ type: "session_start" }, sessionContext);
  const shutdown = extension.handlers.get("session_shutdown");
  if (shutdown) {
    shutdowns.push(async () => { await shutdown({ type: "session_shutdown" }); });
  }
  const tool = extension.tools.find((entry) => entry.name === "bash") as unknown as BashTool;
  return { ...extension, ctx: sessionContext, tool };
}

function publishBroker(decide?: (request: SandboxExceptionRequest) => Promise<SandboxExceptionDecision>) {
  const requests: SandboxExceptionRequest[] = [];
  const review = vi.fn(async (request: SandboxExceptionRequest) => {
    requests.push(request);
    return decide
      ? decide(request)
      : { kind: "allow", scope: "once", review: { rationale: "allowed in test", source: "reviewer" } } as SandboxExceptionDecision;
  });
  disposers.push(publishGuardianBrokerForTest({ review }));
  return { requests, review };
}

function unpublishBroker() {
  disposers.pop()!();
}

function publishPolicy(
  commit: () => ReturnType<Extract<ReturnType<ProjectPolicyService["prepareRule"]>, { ok: true }>["commit"]>,
  options: { alreadyPresent?: boolean } = {},
) {
  const target = globalThis as Record<symbol, unknown>;
  const prepareRule = vi.fn((_rule: string) => ({ ok: true as const, ...options, commit }));
  target[PROJECT_POLICY_KEY] = { path: join(projectRoot, ".pi", "guardian.json"), prepareRule } as ProjectPolicyService;
  disposers.push(() => { delete target[PROJECT_POLICY_KEY]; });
  return prepareRule;
}

function contentText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.type === "text" ? block.text ?? "" : "").join("\n");
}

function details(result: unknown): Record<string, unknown> {
  return ((result as { details?: Record<string, unknown> }).details) ?? {};
}

function callCount(mock: unknown): number {
  return ((mock as { mock: { calls: unknown[][] } }).mock.calls).length;
}

async function invoke(tool: BashTool, ctx: ExtensionContext, id: string, params: Record<string, unknown>) {
  return tool.execute(id, params, undefined, undefined, ctx);
}

const escalateHost = (command: string, extra: Record<string, unknown> = {}) => ({
  command,
  sandbox_permissions: "require_escalated",
  justification: "needs the host",
  ...extra,
});

beforeEach(() => {
  state.realSdkTools = false;
  state.localCalls.length = 0;
  state.sandboxCalls.length = 0;
  state.runtimeCurrent = undefined;
  state.runtimeHistory.length = 0;
  state.sandboxAvailable = true;
  state.refreshFailures = 0;
  state.sandboxExecute = undefined;
  state.askCallback = undefined;
});

afterEach(async () => {
  while (shutdowns.length > 0) await shutdowns.pop()!();
  while (disposers.length > 0) disposers.pop()!();
});

describe("registered native output capture with the actual SDK backend (mocked OS sandbox)", () => {
  beforeEach(() => { state.realSdkTools = true; });

  it("marks refusals and deferrals as SDK errors without erasing native result details", async () => {
    const { tool, ctx, handlers } = await start();
    const refused = await invoke(tool, ctx, "invalid", { command: "printf forbidden", dangerouslyDisableSandbox: false });
    const hook = handlers.get("tool_result")!;
    expect(hook({ toolName: "bash", details: details(refused), isError: false }, ctx)).toEqual({ isError: true });
    expect(details(refused).refusal).toBeTypeOf("string");
    const capture = { path: "/synthetic/partial", complete: false };
    const event = { toolName: "bash", details: { deferred: true, reason: "no parent human", outputCapture: capture } };
    expect(hook(event, ctx)).toEqual({ isError: true });
    expect(event.details.outputCapture).toBe(capture);
    expect(hook({ toolName: "bash", details: { outputCapture: capture } }, ctx)).toBeUndefined();
    expect(hook({ toolName: "read", details: { refusal: "foreign tool" } }, ctx)).toBeUndefined();
  });

  it("captures exact combined output to a private new file without changing the command", async () => {
    const { tool, ctx } = await start();
    const command = "printf stdout; printf stderr >&2";
    const result = await invoke(tool, ctx, "capture", { command, output_file: "capture.log" });
    expect(readFileSync(join(projectRoot, "capture.log"), "utf8")).toContain("stdout");
    expect(readFileSync(join(projectRoot, "capture.log"), "utf8")).toContain("stderr");
    expect(statSync(join(projectRoot, "capture.log")).mode & 0o777).toBe(0o600);
    expect(state.sandboxCalls[0].command).toBe(command);
    expect(details(result).outputCapture).toMatchObject({ created: true, bytes: 12, exitCode: 0, status: "exited", complete: true });
  });

  it("keeps host review a plain exact command while capturing output independently", async () => {
    const broker = publishBroker();
    const { tool, ctx } = await start();
    const command = "printf host-native";
    const result = await invoke(tool, ctx, "capture-host", escalateHost(command, { output_file: "host.log" }));
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]).toMatchObject({ surface: "command", target: command, command });
    expect(readFileSync(join(projectRoot, "host.log"), "utf8")).toBe("host-native");
    expect(details(result).outputCapture).toMatchObject({ exitCode: 0, complete: true });
  });

  it("captures scoped commands and restores baseline without lending the capture destination to the process", async () => {
    const broker = publishBroker();
    const { tool, ctx } = await start();
    const baseline = state.runtimeCurrent;
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-scoped-capture-"));
    const result = await invoke(tool, ctx, "capture-scoped", {
      command: "printf scoped-native", output_file: "scoped.log", sandbox_permissions: "with_additional_permissions",
      justification: "one scoped test path", additional_permissions: { file_system: { write: [outside] } },
    });
    expect(readFileSync(join(projectRoot, "scoped.log"), "utf8")).toBe("scoped-native");
    expect(details(result).outputCapture).toMatchObject({ complete: true });
    expect(state.runtimeCurrent).toEqual(baseline);
    expect(broker.requests.some(request => request.surface === "write" && request.target === realpathSync(outside))).toBe(true);
  });

  it("authorizes an outside log without widening the command's runtime", async () => {
    const broker = publishBroker();
    const { tool, ctx } = await start();
    const baseline = state.runtimeCurrent;
    const refreshes = state.runtimeHistory.length;
    const output = join(mkdtempSync(join(tmpdir(), "pi-sbx-outside-log-")), "result.log");
    await invoke(tool, ctx, "capture-outside", { command: "printf outside-log", output_file: output });
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]).toMatchObject({ surface: "write", target: realpathSync(output) });
    expect(readFileSync(output, "utf8")).toBe("outside-log");
    expect(state.runtimeHistory).toHaveLength(refreshes);
    expect(state.sandboxCalls[0].runtime).toEqual(baseline);
  });

  it("refuses mandatory and denied log targets before reviewing or running the host command", async () => {
    const broker = publishBroker(async () => ({ kind: "deny", reason: "capture refused", review: { source: "rule", rationale: "capture refused" } }));
    const { tool, ctx } = await start();
    const outside = join(mkdtempSync(join(tmpdir(), "pi-sbx-denied-log-")), "result.log");
    for (const output of [join(projectRoot, ".pi", "guardian.json"), join(state.agentDir, "auth.json"), join(state.agentDir, "guardian-sessions", "log"), outside]) {
      const result = await invoke(tool, ctx, "capture-deny", escalateHost("printf forbidden", { output_file: output }));
      expect(contentText(result)).toContain("output_file was not authorized");
      expect(existsSync(output)).toBe(false);
    }
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0].surface).toBe("write");
    expect(state.sandboxCalls).toHaveLength(0);
  });

  it("does not create a log when command admission is refused", async () => {
    publishBroker(async () => ({ kind: "deny", reason: "host refused", review: { source: "rule", rationale: "host refused" } }));
    const { tool, ctx } = await start();
    const result = await invoke(tool, ctx, "capture-host-deny", escalateHost("printf forbidden", { output_file: "not-created.log" }));
    expect(existsSync(join(projectRoot, "not-created.log"))).toBe(false);
    expect(details(result).outputCapture).toMatchObject({ created: false, status: "not_started", complete: false });
  });

  it("refuses an alias retargeted during host admission before opening or executing", async () => {
    const broker = publishBroker(async () => {
      unlinkSync(join(projectRoot, "alias"));
      symlinkSync(join(projectRoot, "second"), join(projectRoot, "alias"));
      return { kind: "allow", scope: "once", review: { source: "rule", rationale: "fixture allow" } };
    });
    const { tool, ctx } = await start();
    mkdirSync(join(projectRoot, "first")); mkdirSync(join(projectRoot, "second"));
    symlinkSync(join(projectRoot, "first"), join(projectRoot, "alias"));
    await expect(invoke(tool, ctx, "capture-drift", escalateHost("printf forbidden", { output_file: "alias/log" }))).rejects.toThrow("changed after authorization");
    expect(broker.requests).toHaveLength(1);
    expect(existsSync(join(projectRoot, "first", "log"))).toBe(false);
    expect(existsSync(join(projectRoot, "second", "log"))).toBe(false);
  });

  it("never overwrites an existing file and preserves nonzero command failures and their logs", async () => {
    const { tool, ctx } = await start();
    writeFileSync(join(projectRoot, "old.log"), "keep");
    await expect(invoke(tool, ctx, "capture-exists", { command: "printf overwrite", output_file: "old.log" })).rejects.toThrow("EEXIST");
    expect(readFileSync(join(projectRoot, "old.log"), "utf8")).toBe("keep");
    expect(state.sandboxCalls).toHaveLength(0);
    await expect(invoke(tool, ctx, "capture-exit", { command: "printf partial; exit 7", output_file: "failure.log" })).rejects.toThrow(/Command exited with code 7[\s\S]*"exitCode":7[\s\S]*"complete":true/);
    expect(readFileSync(join(projectRoot, "failure.log"), "utf8")).toBe("partial");
  });

  it("retains partial output and cancellation status using the SDK's error path", async () => {
    const { tool, ctx } = await start();
    const abort = new AbortController();
    await expect(tool.execute("capture-abort", { command: "printf partial; sleep 5", output_file: "abort.log" }, abort.signal,
      (update: unknown) => { if (contentText(update).includes("partial")) abort.abort(); }, ctx)).rejects.toThrow(/Command aborted[\s\S]*"status":"cancelled"/);
    expect(readFileSync(join(projectRoot, "abort.log"), "utf8")).toBe("partial");
  });

  it("retains timed-out output without reporting completion", async () => {
    const { tool, ctx } = await start();
    await expect(invoke(tool, ctx, "capture-timeout", { command: "printf partial; sleep 5", timeout: 0.1, output_file: "timeout.log" })).rejects.toThrow(/timed out[\s\S]*"status":"timed_out"[\s\S]*"complete":false/);
    expect(readFileSync(join(projectRoot, "timeout.log"), "utf8")).toBe("partial");
  });

  it("rejects malformed capture paths before spending a review", async () => {
    const broker = publishBroker();
    const { tool, ctx } = await start();
    for (const output_file of [null, false, {}, "", "a\nlog", "a".repeat(4097)]) {
      const result = await invoke(tool, ctx, "bad-capture", escalateHost("printf forbidden", { output_file }));
      expect(contentText(result)).toContain("output_file must be");
    }
    expect(broker.requests).toHaveLength(0);
  });
});

describe("registered bash tool as one execution seam", () => {
  it("registers one canonical API and rejects legacy parameters instead of ignoring them", async () => {
    const broker = publishBroker();
    const { tool, tools } = await start();
    expect(tools.filter((entry) => entry.name === "bash")).toHaveLength(1);
    expect(tools.some((entry) => entry.name === "request_sandbox_exception")).toBe(false);

    const properties = Object.keys(tool.parameters.properties ?? {}).sort();
    expect(properties).toEqual([
      "additional_permissions",
      "command",
      "justification",
      "output_file",
      "prefix_rule",
      "sandbox_permissions",
      "timeout",
    ]);
    expect(tool.parameters.additionalProperties).toBe(false);

    for (const legacy of [{ dangerouslyDisableSandbox: true }, { dangerouslyDisableSandbox: false }]) {
      const result = await invoke(tool, context(), "legacy", { command: "git push", ...legacy });
      expect(contentText(result)).toContain("dangerouslyDisableSandbox");
      expect(contentText(result)).toContain("retired");
    }
    expect(state.localCalls).toHaveLength(0);
    expect(state.sandboxCalls).toHaveLength(0);
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("checks host policy, shape and prefix before spending a review", async () => {
    const disabledBroker = publishBroker();
    const disabledRun = await start({ allowUnsandboxedCommands: false });
    const disabledResult = await invoke(disabledRun.tool, disabledRun.ctx, "disabled", escalateHost("git push"));
    expect(contentText(disabledResult)).toContain("allowUnsandboxedCommands");
    expect(disabledBroker.review).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);
    unpublishBroker();

    state.localCalls.length = 0;
    const broker = publishBroker();
    const { tool, ctx } = await start();
    for (const params of [
      escalateHost("git push\ngit clone https://example.test/a/b"),
      escalateHost("/bin/sh -c 'git push'"),
      escalateHost("python3 -c 'print(1)'"),
      escalateHost("git push; curl https://example.test"),
      escalateHost("git push", { prefix_rule: ["git", "pull"] }),
    ]) {
      const result = await invoke(tool, ctx, "ineligible", params);
      expect(details(result).refusal, String(params.command)).toBeTypeOf("string");
    }
    expect(broker.review).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);
    expect(state.sandboxCalls).toHaveLength(0);
  });

  it("runs an approved host command exactly once and keeps no grant", async () => {
    const broker = publishBroker();
    const confirm = vi.fn(async () => false);
    const { tool, ctx } = await start({}, { confirm });
    const result = await invoke(tool, ctx, "host", escalateHost("git push -u origin main", {
      prefix_rule: ["git", "push"],
    }));
    expect(contentText(result)).toBe("host:git push -u origin main");
    expect(state.localCalls.map((call) => call.command)).toEqual(["git push -u origin main"]);
    expect(broker.requests).toEqual([expect.objectContaining({
      surface: "command",
      target: "git push -u origin main",
      scope: "once",
      origin: "tool",
    })]);
    // No persistence service means no misleading offer to save a rule.
    expect(confirm).not.toHaveBeenCalled();

    // The grant was for this execution, not the session: the same command runs
    // sandboxed next time.
    const followUp = await invoke(tool, ctx, "follow-up", { command: "git push -u origin main" });
    expect(contentText(followUp)).toContain("sandbox:git push -u origin main");
    expect(state.localCalls).toHaveLength(1);
  });

  it.each(["rule", "reviewer"] as const)("persists a new standing rule after a %s allow only after a UI yes", async (source) => {
    publishBroker(async () => ({ kind: "allow", scope: "once", review: { rationale: "allowed", source } }));
    const commit = vi.fn(() => ({ ok: true as const, path: join(projectRoot, ".pi", "guardian.json"), hash: "h", added: true }));
    const confirm = vi.fn(async () => {
      expect(prepareRule).toHaveBeenCalledWith("command:git push:*");
      expect(commit).not.toHaveBeenCalled();
      return true;
    });
    const { tool, ctx } = await start({}, { confirm });
    const prepareRule = publishPolicy(commit);
    const sandboxPath = join(state.agentDir, "extensions", "sandbox.json");
    const before = readFileSync(sandboxPath, "utf8");
    await invoke(tool, ctx, "persist", escalateHost("git push -u origin main", { prefix_rule: ["git", "push"] }));
    expect(commit).toHaveBeenCalledOnce();
    expect(readFileSync(sandboxPath, "utf8")).toBe(before);
    expect(readFileSync(sandboxPath, "utf8")).not.toContain("excludedCommands");
    expect(confirm).toHaveBeenCalled();
  });

  it.each(["rule", "reviewer"] as const)("does not re-offer a saved prefix after a %s allow", async (source) => {
    const broker = publishBroker(async () => ({ kind: "allow", scope: "once", review: { rationale: "allowed", source } }));
    const confirm = vi.fn(async () => true);
    const { tool, ctx } = await start({}, { confirm });
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: false }));
    publishPolicy(commit, { alreadyPresent: true });
    for (let index = 0; index < 3; index++) {
      const result = await invoke(tool, ctx, `saved-${index}`, escalateHost("just ios-bindings-test", { prefix_rule: ["just"] }));
      expect(contentText(result)).toBe("host:just ios-bindings-test");
    }
    expect(broker.review).toHaveBeenCalledTimes(3);
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(3);
  });

  it("a saved prefix never bypasses a broker deny", async () => {
    publishBroker(async () => ({ kind: "deny", reason: "global deny", review: { rationale: "restricted", source: "rule" } }));
    const confirm = vi.fn(async () => true);
    const { tool, ctx } = await start({}, { confirm });
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: false }));
    publishPolicy(commit, { alreadyPresent: true });
    const result = await invoke(tool, ctx, "saved-denied", escalateHost("just ios-bindings-test", { prefix_rule: ["just"] }));
    expect(contentText(result)).toContain("global deny");
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);
  });

  it("a saved prefix still requires one-action human admission on broker defer", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "global defer", source: "rule" } }));
    const select = vi.fn(async (_title: string, options: string[]) => {
      expect(options.some((option) => /always/i.test(option))).toBe(false);
      return options[0];
    });
    const confirm = vi.fn(async () => true);
    const { tool, ctx } = await start({}, { select, confirm });
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: false }));
    publishPolicy(commit, { alreadyPresent: true });
    await invoke(tool, ctx, "saved-deferred", escalateHost("just ios-bindings-test", { prefix_rule: ["just"] }));
    expect(select).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(1);
  });

  it("does not fall back to sandbox exclusions when guardian has no policy service", async () => {
    publishBroker();
    const sandboxPath = join(state.agentDir, "extensions", "sandbox.json");
    const before = readFileSync(sandboxPath, "utf8");
    const confirm = vi.fn(async () => true);
    const { tool, ctx } = await start({}, { confirm });
    await invoke(tool, ctx, "no-policy", escalateHost("git push", { prefix_rule: ["git", "push"] }));
    expect(readFileSync(sandboxPath, "utf8")).toBe(before);
    expect((ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some((call) => String(call[0]).includes("not saved"))).toBe(true);
    expect(state.localCalls.map((call) => call.command)).toEqual(["git push"]);
  });

  it("fails closed on a deferred request with no UI and never calls a model-only tool", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const select = vi.fn();
    const { tool } = await start({}, { hasUI: false, select });
    const headless = context({ hasUI: false, select });
    const host = await invoke(tool, headless, "defer-host", escalateHost("git push"));
    expect(contentText(host)).toContain("Sandbox exception deferred");
    expect(contentText(host)).toContain("no human approval channel");
    expect(details(host).deferred).toBe(true);
    expect(callCount((headless as unknown as { executeTool: unknown }).executeTool)).toBe(0);
    expect(select).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);

    const scoped = await invoke(tool, headless, "defer-scoped", {
      command: "go build ./...",
      sandbox_permissions: "with_additional_permissions",
      justification: "needs the cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } },
    });
    expect(contentText(scoped)).toContain("Sandbox exception deferred");
    expect(state.sandboxCalls).toHaveLength(0);
  });

  it("serializes executions and keeps a scoped grant out of the native gate", async () => {
    const broker = publishBroker(async (request) => request.surface === "write" && request.command === "scoped"
      ? { kind: "allow", scope: "once", review: { rationale: "scoped command", source: "reviewer" } }
      : { kind: "deny", reason: "a native write needs its own decision", review: { rationale: "no", source: "reviewer" } });
    const release = deferred();
    const started = deferred();
    state.sandboxExecute = async (params) => {
      if (params.command === "scoped") {
        started.resolve();
        await release.promise;
      }
      return { content: [{ type: "text", text: `sandbox:${params.command}` }], details: {} };
    };
    const { tool, ctx, handlers } = await start();
    const scopedPath = join(tmpdir(), `pi-sbx-scoped-${process.pid}`);
    const first = invoke(tool, ctx, "scoped", {
      command: "scoped",
      sandbox_permissions: "with_additional_permissions",
      justification: "needs the cache",
      additional_permissions: { file_system: { write: [scopedPath] } },
    });
    await started.promise;

    const scopedRuntime = state.sandboxCalls[0]!.runtime as { filesystem: { allowWrite: string[] } };
    expect(scopedRuntime.filesystem.allowWrite).toContain(canonicalizeTarget(scopedPath, ctx.cwd));

    // A native write to the path the scoped command may write is still decided
    // against the baseline, not against the temporary OS widening.
    const gate = handlers.get("tool_call")! as unknown as (event: unknown, ctx: unknown) => Promise<unknown>;
    const blocked = await gate({ toolName: "write", input: { path: join(scopedPath, "x") } }, ctx);
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("its own decision") });
    expect(broker.requests.some((request) => request.surface === "write" && request.target.endsWith("/x"))).toBe(true);
    const allowed = await gate({ toolName: "write", input: { path: join(projectRoot, "ok.txt") } }, ctx);
    expect(allowed).toBeUndefined();

    // A concurrent command waits for the first to restore the baseline.
    const second = invoke(tool, ctx, "plain", { command: "plain" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.sandboxCalls).toHaveLength(1);

    release.resolve();
    await expect(first).resolves.toBeTruthy();
    await expect(second).resolves.toBeTruthy();
    expect(state.sandboxCalls).toHaveLength(2);
    const secondRuntime = state.sandboxCalls[1]!.runtime as { filesystem: { allowWrite: string[] } };
    expect(secondRuntime.filesystem.allowWrite).not.toContain(canonicalizeTarget(scopedPath, ctx.cwd));
    const restored = state.runtimeCurrent as { filesystem: { allowWrite: string[] } };
    expect(restored.filesystem.allowWrite).not.toContain(canonicalizeTarget(scopedPath, ctx.cwd));
  });

  it("routes one native path action through the same broker and fails closed when headless", async () => {
    const broker = publishBroker(async (request) => request.surface === "write" && request.target.endsWith("/native.txt")
      ? { kind: "defer", review: { rationale: "ask a human", source: "reviewer" } }
      : { kind: "allow", scope: "once", review: { rationale: "allowed", source: "reviewer" } });
    const select = vi.fn();
    const { handlers } = await start({}, { hasUI: false, select });
    const headless = context({ hasUI: false, select });
    const gate = handlers.get("tool_call")! as unknown as (event: unknown, ctx: unknown) => Promise<unknown>;
    const outside = join(tmpdir(), `pi-sbx-native-${process.pid}`, "native.txt");

    const result = await gate({ toolName: "write", input: { path: outside, content: "x" } }, headless);
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Sandbox exception deferred") });
    expect((result as { reason: string }).reason).toContain("no human approval channel");
    expect(broker.requests).toEqual([expect.objectContaining({ surface: "write", scope: "once", origin: "tool" })]);
    expect(broker.requests[0]?.target.endsWith("/native.txt")).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(state.sandboxCalls).toHaveLength(0);
    expect(state.localCalls).toHaveLength(0);
  });

  it("uses the real human adapter for a deferred native write and retains no grant", async () => {
    const broker = publishBroker(async () => ({ kind: "defer", review: { rationale: "ask", source: "rule" } }));
    const select = vi.fn(async () => "Allow this one file change");
    const { handlers, ctx } = await start({}, { select });
    const gate = handlers.get("tool_call")!;
    const path = join(tmpdir(), `pi-sbx-native-ui-${process.pid}`, "new.txt");
    expect(await gate({ toolName: "write", input: { path, content: "x" } }, ctx)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining("\nwrite:")]));
    expect(await gate({ toolName: "write", input: { path, content: "y" } }, ctx)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    expect(broker.requests).toHaveLength(2);
    expect(state.sandboxCalls).toHaveLength(0);
    expect(state.localCalls).toHaveLength(0);
  });

  it("refuses a scoped alias retargeted during approval before touching the runtime", async () => {
    const { tool, ctx } = await start();
    const fixture = mkdtempSync(join(tmpdir(), "sbx-scoped-alias-"));
    const first = join(fixture, "first"), second = join(fixture, "second"), alias = join(fixture, "alias");
    mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
    const refreshes = state.runtimeHistory.length;
    publishBroker(async () => {
      unlinkSync(alias); symlinkSync(second, alias);
      return { kind: "allow", scope: "once", review: { source: "reviewer", rationale: "first target only" } };
    });
    try {
      const result = await invoke(tool, ctx, "alias", { command: "build", sandbox_permissions: "with_additional_permissions", justification: "one exact directory",
        additional_permissions: { file_system: { write: [alias] } } });
      expect(contentText(result)).toMatch(/path.*changed|target.*changed/i);
      expect(state.sandboxCalls).toHaveLength(0); expect(state.localCalls).toHaveLength(0);
      expect(state.runtimeHistory).toHaveLength(refreshes);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("installs only an admitted canonical scope, never an alias the runtime could reinterpret", async () => {
    const { tool, ctx } = await start();
    const fixture = mkdtempSync(join(tmpdir(), "sbx-scoped-stable-"));
    const target = join(fixture, "target"), alias = join(fixture, "alias");
    mkdirSync(target); symlinkSync(target, alias);
    const baseline = state.runtimeCurrent;
    publishBroker();
    try {
      await invoke(tool, ctx, "canonical", { command: "build", sandbox_permissions: "with_additional_permissions", justification: "one exact directory",
        additional_permissions: { file_system: { write: [alias] } } });
      const runtime = state.sandboxCalls[0].runtime as { filesystem: { allowWrite: string[] } };
      expect(runtime.filesystem.allowWrite).toContain(realpathSync(target));
      expect(runtime.filesystem.allowWrite).not.toContain(alias);
      expect(state.runtimeCurrent).toEqual(baseline);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("rechecks earlier scoped aliases after later target approvals", async () => {
    const { tool, ctx } = await start();
    const fixture = mkdtempSync(join(tmpdir(), "sbx-scoped-many-"));
    const first = join(fixture, "first"), replacement = join(fixture, "replacement"), last = join(fixture, "last"), alias = join(fixture, "alias");
    for (const dir of [first, replacement, last]) mkdirSync(dir);
    symlinkSync(first, alias);
    let reviews = 0;
    publishBroker(async () => {
      if (++reviews === 2) { unlinkSync(alias); symlinkSync(replacement, alias); }
      return { kind: "allow", scope: "once", review: { source: "reviewer", rationale: "one target" } };
    });
    try {
      const result = await invoke(tool, ctx, "many", { command: "build", sandbox_permissions: "with_additional_permissions", justification: "two exact directories",
        additional_permissions: { file_system: { write: [alias, last] } } });
      expect(reviews).toBe(2); expect(contentText(result)).toMatch(/path.*changed|target.*changed/i);
      expect(state.sandboxCalls).toHaveLength(0); expect(state.localCalls).toHaveLength(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("builds a scoped profile from its authoritative baseline rather than newly read ambient files", async () => {
    const { tool, ctx } = await start();
    const baseline = state.runtimeCurrent;
    publishBroker(async () => {
      writeFileSync(join(state.agentDir, "extensions/sandbox.json"), "not a new authority source while an action is pending");
      return { kind: "allow", scope: "once", review: { source: "reviewer", rationale: "one exact target" } };
    });
    const target = join(tmpdir(), `sbx-baseline-scope-${process.pid}`);
    await invoke(tool, ctx, "baseline", { command: "build", sandbox_permissions: "with_additional_permissions", justification: "one exact target",
      additional_permissions: { file_system: { write: [target] } } });
    expect(state.sandboxCalls).toHaveLength(1);
    expect((state.sandboxCalls[0].runtime as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite).toContain(canonicalizeTarget(target, ctx.cwd));
    expect(state.runtimeCurrent).toEqual(baseline);
  });

  it("reviews scoped reads, installs their carve-out once and restores baseline", async () => {
    const broker = publishBroker();
    const deniedRoot = join(tmpdir(), `pi-sbx-readable-${process.pid}`);
    const { tool, ctx, handlers } = await start({ denyRead: [deniedRoot] });
    const agentDir = state.agentDir;
    const target = join(deniedRoot, "public.txt");
    await invoke(tool, ctx, "read-once", {
      command: "build", sandbox_permissions: "with_additional_permissions", justification: "read build input",
      additional_permissions: { file_system: { read: [target] } },
    });
    expect(broker.requests).toEqual([expect.objectContaining({ surface: "read", command: "build" })]);
    expect((state.sandboxCalls[0]!.runtime as { filesystem: { allowRead: string[] } }).filesystem.allowRead).toContain(canonicalizeTarget(target, ctx.cwd));
    expect((state.runtimeCurrent as { filesystem: { allowRead: string[] } }).filesystem.allowRead).not.toContain(canonicalizeTarget(target, ctx.cwd));
    const history = state.runtimeHistory.length;
    const credential = await invoke(tool, ctx, "auth", {
      command: "build", sandbox_permissions: "with_additional_permissions", justification: "not allowed",
      additional_permissions: { file_system: { read: [join(agentDir, "auth.json")] } },
    });
    expect(contentText(credential)).toContain("never grantable");
    expect(broker.requests).toHaveLength(1);
    expect(state.runtimeHistory).toHaveLength(history);
    expect(await handlers.get("tool_call")!({ toolName: "read", input: { path: target } }, ctx)).toBeUndefined();
    expect(broker.requests).toHaveLength(2);
  });

  it("uses the event signal and baseline for a native action during a scoped command", async () => {
    const broker = publishBroker();
    const release = deferred();
    const started = deferred();
    state.sandboxExecute = async () => {
      started.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "sandbox:scoped" }], details: {} };
    };
    const { tool, ctx, handlers } = await start();
    const commandSignal = new AbortController();
    const first = tool.execute("hold", {
      command: "scoped",
      sandbox_permissions: "with_additional_permissions",
      justification: "needs the cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } },
    }, commandSignal.signal, undefined, ctx);
    await started.promise;

    const gate = handlers.get("tool_call")! as unknown as (event: unknown, ctx: unknown) => Promise<unknown>;
    const outside = join(tmpdir(), `pi-sbx-native-parallel-${process.pid}`, "x.txt");
    try {
      // The active command is not cancelled, so the native action is admitted
      // by its own decision while the scoped OS profile is installed.
      const granted = await gate({ toolName: "write", input: { path: outside, content: "x" } }, ctx);
      expect(granted).toBeUndefined();
      expect(broker.requests.some((request) => request.target.endsWith("/x.txt"))).toBe(true);

      // An aborted event signal refuses even though the command signal is live.
      const aborted = new AbortController();
      aborted.abort();
      const blocked = await gate({ toolName: "write", input: { path: join(outside, "y.txt") } }, { ...ctx, signal: aborted.signal });
      expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("cancelled") });
    } finally {
      release.resolve();
      await first;
    }
  });

  it("restores the baseline on errors, cancellations and partial approval", async () => {
    publishBroker();
    const { tool, ctx } = await start();
    const baselineRuntime = state.runtimeCurrent;
    const scopedParams = {
      command: "scoped",
      sandbox_permissions: "with_additional_permissions",
      justification: "needs the cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } },
    };

    // Failure inside a widened execution.
    state.sandboxExecute = async () => { throw new Error("command exploded"); };
    await expect(invoke(tool, ctx, "error", scopedParams)).rejects.toThrow("command exploded");
    expect(state.runtimeCurrent).toEqual(baselineRuntime);

    // Cancellation inside a widened execution.
    state.sandboxExecute = async () => { throw new Error("The operation was aborted"); };
    await expect(invoke(tool, ctx, "cancelled", scopedParams)).rejects.toThrow("aborted");
    expect(state.runtimeCurrent).toEqual(baselineRuntime);

    // Partial approval: the first path is allowed, the second denied, nothing runs.
    unpublishBroker();
    publishBroker(async (request) => request.target.endsWith("/pi-sbx-extra")
      ? { kind: "allow", scope: "once", review: { rationale: "ok", source: "reviewer" } }
      : { kind: "deny", reason: "no", review: { rationale: "no", source: "reviewer" } });
    const historyBefore = state.runtimeHistory.length;
    const partial = await invoke(tool, ctx, "partial", {
      ...scopedParams,
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra", "/tmp/pi-sbx-denied"] } },
    });
    expect(details(partial).refusal).toContain("denied");
    expect(state.sandboxCalls).toHaveLength(2);
    expect(state.runtimeHistory.length).toBe(historyBefore);
    expect(state.runtimeCurrent).toEqual(baselineRuntime);
  });

  it("serializes the human's own bash behind a command holding a scoped policy", async () => {
    publishBroker();
    const release = deferred();
    const started = deferred();
    state.sandboxExecute = async () => {
      started.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "sandbox:scoped" }], details: {} };
    };
    const { tool, ctx, handlers } = await start();
    const scoped = invoke(tool, ctx, "hold", {
      command: "scoped",
      sandbox_permissions: "with_additional_permissions",
      justification: "needs the cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } },
    });
    await started.promise;

    const event = handlers.get("user_bash")!({ command: "echo hi", cwd: projectRoot, excludeFromContext: false }) as {
      operations: { exec: (command: string, cwd: string, options: unknown) => Promise<{ exitCode: number }> };
    };
    let settled = false;
    const human = event.operations.exec("echo hi", projectRoot, { onData: () => undefined }).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    release.resolve();
    await scoped;
    await human;
    expect(settled).toBe(true);
  });

  it("decides each network connection once through the broker or the one human channel", async () => {
    const broker = publishBroker(async (request) => request.surface === "network" && request.target === "example.test:443"
      ? { kind: "defer", review: { rationale: "unknown host", source: "reviewer" } }
      : { kind: "allow", scope: "once", review: { rationale: "allowlisted", source: "rule" } });
    const select = vi.fn(async () => "Allow this connection");
    const { handlers } = await start({}, { select });
    expect(handlers.get("before_agent_start")).toBeTypeOf("function");
    const ask = state.askCallback!;
    expect(await ask({ host: "registry.npmjs.org", port: 443 })).toBe(true);
    expect(broker.requests[0]).toMatchObject({ surface: "network", target: "registry.npmjs.org:443", scope: "once", origin: "trap" });

    const historyBefore = state.runtimeHistory.length;
    // The deferred destination asks the human for this connection only: no
    // network token survives to the next connection.
    expect(await ask({ host: "example.test", port: 443 })).toBe(true);
    expect(await ask({ host: "example.test", port: 443 })).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
    // No session grant was installed, so the runtime policy is unchanged.
    expect(state.runtimeHistory.length).toBe(historyBefore);
  });

  it("routes unavailable-sandbox fallback through the same host gate and review", async () => {
    state.sandboxAvailable = false;
    const broker = publishBroker();
    const { tool, ctx } = await start({ failIfUnavailable: false });
    const invalid = await invoke(tool, ctx, "fallback-wrapper", { command: "/bin/sh -c x" });
    expect(details(invalid).refusal).toContain("not eligible");
    expect(broker.review).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);
    await invoke(tool, ctx, "fallback-host", { command: "git push" });
    expect(broker.requests).toEqual([expect.objectContaining({ surface: "command", target: "git push", scope: "once" })]);
    expect(state.localCalls).toHaveLength(1);
  });

  it("never executes or saves after cancellation while a human is answering", async () => {
    publishBroker();
    const prompted = deferred();
    const release = deferred();
    const confirm = vi.fn(async () => { prompted.resolve(); await release.promise; return true; });
    const { tool, ctx } = await start({}, { confirm });
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: true }));
    publishPolicy(commit);
    const abort = new AbortController();
    const pending = tool.execute("cancel-prompt", escalateHost("git push", { prefix_rule: ["git", "push"] }), abort.signal, undefined, ctx);
    await prompted.promise;
    abort.abort();
    release.resolve();
    expect(contentText(await pending)).toContain("cancelled");
    expect(commit).not.toHaveBeenCalled();
    expect(state.localCalls).toHaveLength(0);
  });

  it("refuses a queued command cancelled before its turn", async () => {
    const held = deferred();
    const started = deferred();
    state.sandboxExecute = async () => { started.resolve(); await held.promise; return { content: [], details: {} }; };
    const { tool, ctx } = await start();
    const first = invoke(tool, ctx, "first", { command: "first" });
    await started.promise;
    const abort = new AbortController();
    const second = tool.execute("second", { command: "second" }, abort.signal, undefined, ctx);
    abort.abort();
    held.resolve();
    await first;
    expect(contentText(await second)).toContain("cancelled");
    expect(state.sandboxCalls).toHaveLength(1);
  });

  it("waits for scoped rollback before applying a human sandbox-off change", async () => {
    publishBroker();
    const held = deferred();
    const started = deferred();
    state.sandboxExecute = async () => { started.resolve(); await held.promise; return { content: [], details: {} }; };
    const { tool, ctx, commands } = await start();
    const baseline = state.runtimeCurrent;
    const pending = invoke(tool, ctx, "hold-policy", {
      command: "hold-policy", sandbox_permissions: "with_additional_permissions", justification: "cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } },
    });
    await started.promise;
    const sandbox = commands.get("sandbox") as { handler(args: string, ctx: ExtensionContext): Promise<void> };
    let changed = false;
    const change = sandbox.handler("off", ctx).then(() => { changed = true; });
    await Promise.resolve();
    expect(changed).toBe(false);
    held.resolve();
    await pending;
    await change;
    expect(state.runtimeCurrent).toEqual(baseline);
    await invoke(tool, ctx, "after-human-off", { command: "plain" });
    expect(state.localCalls.map((call) => call.command)).toEqual(["plain"]);
  });

  it("rolls back a partial runtime update and fails closed if rollback fails", async () => {
    publishBroker();
    const { tool, ctx } = await start();
    const baseline = state.runtimeCurrent;
    const params = { command: "scoped", sandbox_permissions: "with_additional_permissions", justification: "cache",
      additional_permissions: { file_system: { write: ["/tmp/pi-sbx-extra"] } } };
    state.refreshFailures = 1;
    expect(details(await invoke(tool, ctx, "partial-update", params)).refusal).toContain("runtime rejected");
    expect(state.runtimeCurrent).toEqual(baseline);
    expect(state.sandboxCalls).toHaveLength(0);
    state.refreshFailures = 2;
    await expect(invoke(tool, ctx, "failed-rollback", params)).rejects.toThrow("could not be restored");
    expect(state.runtimeCurrent).toBeUndefined();
    await expect(invoke(tool, ctx, "after-rollback-failure", { command: "plain" })).rejects.toThrow("could not be restored");
    expect(state.sandboxCalls).toHaveLength(0);
    expect(state.localCalls).toHaveLength(0);
  });

  it("saves only the network endpoint shown, with a snapshot prepared before the prompt", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "ask", source: "rule" } }));
    const select = vi.fn(async () => {
      expect(prepare).toHaveBeenCalledWith("network:example.test:443");
      expect(commit).not.toHaveBeenCalled();
      return "Always allow network:example.test:443";
    });
    await start({}, { select });
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: true }));
    const prepare = publishPolicy(commit);
    expect(await state.askCallback!({ host: "example.test", port: 443 })).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("rejects invalid scoped target syntax before asking the broker", async () => {
    const broker = publishBroker();
    const { tool, ctx } = await start();
    for (const additional_permissions of [
      { file_system: { read: ["/tmp/*"] } },
      { file_system: { write: ["/tmp/x\n/tmp/y"] } },
      { file_system: { read: ["/tmp/x"] }, network: { enabled: false } },
      { file_system: { read: ["/tmp/x"], extra: [] } },
    ]) {
      expect(details(await invoke(tool, ctx, "invalid-target", {
        command: "plain", sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions,
      })).refusal).toBeTypeOf("string");
    }
    expect(broker.review).not.toHaveBeenCalled();
    expect(state.sandboxCalls).toHaveLength(0);
  });

  it("refuses a nonempty excludedCommands configuration before any execution", async () => {
    const broker = publishBroker();
    const started = await start({ exclude: ["docker:*"] });
    await expect(invoke(started.tool, started.ctx, "excluded", { command: "docker ps" }))
      .rejects.toThrow(/excludedCommands is retired/);
    expect(state.localCalls).toHaveLength(0);
    expect(broker.review).not.toHaveBeenCalled();
  });
});

describe("registered production child sandbox entry (actual API/SDK backends, mocked SRT and Guardian acknowledgment)", () => {
  async function childFixture(run: (fixture: { tool: BashTool; ctx: ExtensionContext; tools: FakePi["tools"]; requests: Array<{ surface: string; target: string }>; handlers: FakePi["handlers"] }) => Promise<void>, options: { available?: boolean } = {}) {
    const keys = [Symbol.for("pi-subagents.child-authority-lease.v1"), Symbol.for("pi-subagents.child-authority-runner.v1")];
    const globals = globalThis as Record<PropertyKey, unknown>;
    const saved = keys.map(key => Object.getOwnPropertyDescriptor(globals, key)); keys.forEach(key => delete globals[key]);
    const { root: fixtureRoot, agentDir } = setup();
    const root = join(fixtureRoot, "child"); mkdirSync(root); projectRoot = root;
    const launcher = join(agentDir, "npm/node_modules/pi-subagents"); mkdirSync(launcher, { recursive: true });
    writeFileSync(join(launcher, "package.json"), JSON.stringify({ type: "module", exports: { "./child-authority": "./authority.js" } }));
    writeFileSync(join(launcher, "authority.js"), `export * from ${JSON.stringify(new URL("../../pi-subagents/src/api/child-authority.ts", import.meta.url).href)};`);
    // Real child dispatch must not consult this ambient profile at all.
    writeFileSync(join(agentDir, "extensions/sandbox.json"), "poison ambient root profile");
    const baseline = { cwd: root, allowUnsandboxedCommands: true, environmentDeny: ["SYNTHETIC_SECRET"],
      runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: [root], denyRead: [], allowRead: [], denyWrite: [] } },
      policy: { allowWrite: [root], denyRead: [], allowRead: [], denyWrite: [], mandatoryDenyRead: [join(agentDir, "auth.json")], mandatoryDenyWrite: [agentDir] } };
    const payload = deriveChildPolicy({ agentDir, configDirName: ".pi", identity: { cwd: root }, baseline }).payload;
    const requests: Array<{ surface: string; target: string }> = [];
    const handle = createChildAuthorityLease({ leaseId: "registered-entry", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: root }, payload,
      requiredConsumers: ["pi-sbx", "pi-guardian"], requestTimeoutMs: 1000, cancel() {},
      send(id, action) { requests.push(action); queueMicrotask(() => handle.deliverDecision(id, { outcome: "allow" })); return true; } });
    const extension = fakeExtension({ "no-sandbox": true, "trust-sandbox-config": true });
    const owner = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    (extension.pi as any).getAllTools = () => extension.tools.map(tool => ({ ...tool, sourceInfo: { path: owner } }));
    const ctx = context({ hasUI: false });
    state.realSdkTools = true; state.sandboxAvailable = options.available ?? true;
    try {
      await withChildAuthority(handle.lease, async () => {
        // Explicit factory-metadata fixture; the actual factory is covered by the SDK/IPC matrix.
        bindChildRuntimeCodePaths(handle.lease, [{ path: owner, resolvedPath: owner, sourceInfo: { origin: "top-level" } }]);
        await sandboxExtension(extension.pi);
        expect(extension.pi.registerFlag).not.toHaveBeenCalled(); expect(extension.commands.size).toBe(0);
        childApi.claimChildAuthority("pi-guardian", root); childApi.acknowledgeChildAuthority("pi-guardian"); // Explicit fixture, not composition.
        if (!state.sandboxAvailable) {
          await expect(extension.handlers.get("session_start")!({ type: "session_start" }, ctx)).rejects.toThrow(/unavailable/);
          expect(handle.lease.signal.aborted).toBe(true); return;
        }
        await extension.handlers.get("session_start")!({ type: "session_start" }, ctx);
        expect(() => handle.lease.assertReady()).not.toThrow();
        await run({ tool: extension.tools.find(tool => tool.name === "bash") as unknown as BashTool, ctx, tools: extension.tools, requests, handlers: extension.handlers });
      });
    } finally {
      await extension.handlers.get("session_shutdown")?.({ type: "session_shutdown" }); handle.lease.dispose();
      keys.forEach((key, index) => { if (saved[index]) Object.defineProperty(globals, key, saved[index]!); else delete globals[key]; });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  it("claims/acks actual installed adapters without root config, flags, command or local reviewer", async () => {
    await childFixture(async ({ tools, requests, ctx }) => {
      expect(tools.map(tool => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
      const write = tools.find(tool => tool.name === "write") as unknown as BashTool;
      await write.execute("write", { path: "native.txt", content: "actual SDK" }, undefined, undefined, ctx);
      expect(readFileSync(join(projectRoot, "native.txt"), "utf8")).toBe("actual SDK");
      expect(requests.map(request => request.surface)).toEqual(["write"]);
    });
  });
  it("uses the real SDK Bash and independent output-file parent admission while ignoring no-sandbox flags", async () => {
    await childFixture(async ({ tool, ctx, requests }) => {
      const result = await invoke(tool, ctx, "child-capture", { command: "printf child-native", output_file: "child.log" });
      expect(readFileSync(join(projectRoot, "child.log"), "utf8")).toBe("child-native");
      expect(details(result).outputCapture).toMatchObject({ complete: true, exitCode: 0 });
      expect(state.sandboxCalls).toHaveLength(1); expect(requests.map(request => request.surface)).toEqual(["write"]);
    });
  });
  it("keeps scoped grants in one SRT snapshot and never lends them to native tools", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sbx-child-scoped-"));
    try { await childFixture(async ({ tool, ctx, requests }) => {
      const baseline = state.runtimeCurrent;
      await invoke(tool, ctx, "scope", { command: "printf scoped-child", sandbox_permissions: "with_additional_permissions", justification: "one directory", additional_permissions: { file_system: { write: [outside] } } });
      expect(state.runtimeCurrent).toEqual(baseline);
      expect(requests).toEqual([expect.objectContaining({ surface: "write", target: canonicalizeTarget(outside, ctx.cwd) })]);
    }); } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("delegates exact host admission without publishing a local broker or saving a standing rule", async () => {
    await childFixture(async ({ tool, ctx, requests }) => {
      const result = await invoke(tool, ctx, "host", escalateHost("printf host-child"));
      expect(contentText(result)).toContain("host-child");
      expect(requests).toEqual([expect.objectContaining({ surface: "command", target: "printf host-child" })]);
      expect(state.sandboxCalls).toHaveLength(0);
    });
  });
  it("refuses unavailable runtime without acknowledging or taking the host fallback", async () => {
    await childFixture(async () => { throw new Error("unavailable child ran"); }, { available: false });
    expect(state.sandboxCalls).toHaveLength(0); expect(state.localCalls).toHaveLength(0);
  });
  it("blocks unknown tools and unreviewed user_bash even after adapter activation", async () => {
    await childFixture(async ({ handlers, ctx }) => {
      expect(await handlers.get("tool_call")!({ toolName: "unsafe_mcp" }, ctx)).toMatchObject({ block: true });
      expect(await handlers.get("user_bash")!({ command: "printf forbidden" }, ctx)).toMatchObject({ result: { exitCode: 1 } });
      expect(state.sandboxCalls).toHaveLength(0);
    });
  });
});

describe("decision attribution and lazy standing snapshots", () => {
  it("attributes a human host-command refusal to the human, not to guardian", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const select = vi.fn(async () => "Deny");
    const { tool, ctx } = await start({}, { select });
    const result = await invoke(tool, ctx, "human-deny", escalateHost("git push"));
    expect(select).toHaveBeenCalledOnce();
    expect(contentText(result)).toContain("the user denied the sandbox exception");
    expect(contentText(result)).not.toContain("guardian denied");
    expect(state.localCalls).toHaveLength(0);
  });

  it("snapshots a network standing rule only when the connection reaches the human", async () => {
    const prepareRule = publishPolicy(() => ({ ok: true as const, path: "p", hash: "h", added: true }));
    publishBroker();
    const select = vi.fn(async () => "Allow this connection");
    await start({}, { select });
    expect(await state.askCallback!({ host: "registry.npmjs.org", port: 443 })).toBe(true);
    // A rule/reviewer-allowed connection never spends a trusted policy snapshot.
    expect(prepareRule).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("does not misattribute a missing human network channel to Guardian", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "ask human", source: "reviewer" } }));
    const { ctx } = await start({}, { hasUI: false });
    expect(await state.askCallback!({ host: "example.test", port: 443 })).toBe(false);
    const notices = (ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]));
    expect(notices.some((text) => text.includes("unavailable (no human approval channel)"))).toBe(true);
    expect(notices.some((text) => text.includes("denied by Guardian"))).toBe(false);
  });

  it("keeps a deferred connection prompt but omits an already saved network rule", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "global defer", source: "rule" } }));
    const commit = vi.fn(() => ({ ok: true as const, path: "p", hash: "h", added: false }));
    publishPolicy(commit, { alreadyPresent: true });
    const select = vi.fn(async (_title: string, options: string[]) => {
      expect(options).toEqual(["Allow this connection", "Deny"]);
      return "Allow this connection";
    });
    await start({}, { select });
    expect(await state.askCallback!({ host: "example.test", port: 443 })).toBe(true);
    expect(select).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("prepares the network standing snapshot before the deferred prompt", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unknown host", source: "reviewer" } }));
    const prepareRule = publishPolicy(() => ({ ok: true as const, path: "p", hash: "h", added: true }));
    const select = vi.fn(async () => {
      expect(prepareRule).toHaveBeenCalledWith("network:example.test:443");
      return "Allow this connection";
    });
    await start({}, { select });
    expect(await state.askCallback!({ host: "example.test", port: 443 })).toBe(true);
    expect(prepareRule).toHaveBeenCalledOnce();
  });
});
