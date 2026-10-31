import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerRequiredChildExtensions,
  type RequiredChildExtensionRegistration,
} from "../../pi-subagents/src/api/required-child-extensions.ts";
import { resolveRequiredChildExtensions } from "../../pi-subagents/src/shared/required-child-extensions.ts";
import { publishGuardianBrokerForTest, type SandboxExceptionRequest } from "../src/broker.ts";

/**
 * The registered extension must publish the provider from real session
 * lifecycle, bound to the live session id and the parent's baseline, and must
 * revoke it when the session or the policy stops being authoritative.
 */

const state = vi.hoisted(() => ({ agentDir: "", sandboxAvailable: true, sessionScratch: "" }));

vi.mock("../src/scratch.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/scratch.ts")>();
  return { ...actual, createScratchpad: async () => {
    const scratch = await actual.createScratchpad();
    state.sessionScratch = scratch.dir;
    return scratch;
  } };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getAgentDir: () => state.agentDir,
    hasTrustRequiringProjectResources: () => false,
    createBashToolDefinition: () => ({
      name: "bash",
      label: "bash",
      description: "fake bash",
      parameters: {},
      promptGuidelines: [] as string[],
      renderResult: () => ({ render: () => [] }),
      execute: async () => ({ content: [], details: {} }),
    }),
  };
});

// This cross-fork fixture runs under pi-sbx's older dev SDK. The actual detached
// launcher needs its own declared SDK graph (as in its native test host), not
// pi-sbx's 0.84 host dependency. Select that existing graph explicitly; this is
// fixture setup, not a production host fallback or a dependency installation.
vi.mock("../../pi-subagents/src/runs/shared/pi-spawn.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fs = await import("node:fs");
  const url = await import("node:url");
  const root = fs.realpathSync(url.fileURLToPath(new URL("../../pi-subagents/node_modules/@earendil-works/pi-coding-agent", import.meta.url)));
  return { ...actual, resolveHostPiPackageRoot: () => root };
});

vi.mock("../src/bash-operations.ts", () => ({
  createSandboxedBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
}));

vi.mock("../src/manager.ts", () => {
  class SandboxController {
    private state = "disabled";
    getState() { return this.state; }
    getError() { return undefined; }
    checkDependencies() { return { errors: [] as string[], warnings: [] as string[] }; }
    isSupported() { return true; }
    async initialize() {
      if (!state.sandboxAvailable) {
        this.state = "unavailable";
        throw new Error("sandbox unavailable in test");
      }
      this.state = "active";
    }
    refresh() { /* no runtime in these tests */ }
    setSessionEnabled(enabled: boolean) { this.state = enabled ? "active" : "disabled"; }
    canRunSandboxed() { return this.state === "active"; }
    shouldFailClosed() { return false; }
    async reset() { this.state = "disabled"; }
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
import {
  CHILD_AUTHORITY_PROVIDER_KEY,
  publishChildAuthority,
  type ChildAuthorityProvider,
  type ChildAuthorityPublication,
} from "../src/child-authority.ts";

const SIGNAL = (): AbortSignal => new AbortController().signal;
const shutdowns: Array<() => Promise<void>> = [];
const childLeaseSlot = Symbol.for("pi-subagents.child-authority-lease.v1");

type FakePi = {
  pi: ExtensionAPI;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
};

function fakeExtension(): FakePi {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: () => false,
    registerTool: vi.fn(),
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition as { handler: (args: string, ctx: ExtensionContext) => Promise<void> });
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands };
}

interface SessionOptions {
  agentDirName?: string;
  config?: Record<string, unknown> | ((root: string) => Record<string, unknown>);
  withGuardianEntry?: boolean;
  /** `installed` links the real launcher registration module, `broken` omits its entry, `absent` installs nothing. */
  launcher?: "installed" | "broken" | "absent";
  sandboxAvailable?: boolean;
  sessionId?: string;
  /** Runs after fixtures exist and before `session_start` (e.g. to pre-register a session). */
  beforeStart?: (agentDir: string) => void;
}

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    executeTool: vi.fn(),
    sessionManager: { getSessionId: () => sessionId },
    signal: undefined,
    ui: {
      select: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function installGuardianEntry(agentDir: string): string {
  const entry = join(agentDir, "npm", "node_modules", "pi-guardian", "src", "index.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "export default function guardian() {}\n");
  return realpathSync(entry);
}

/** The launcher's own public registration module, as the repo fork ships it. */
const LAUNCHER_REGISTRATION_SOURCE = fileURLToPath(
  new URL("../../pi-subagents/src/api/required-child-extensions.ts", import.meta.url),
);

/**
 * The installed launcher package layout: the built export map points
 * `./required-child-extensions` at a bundled module. The fixture bundle
 * re-exports the repository fork's real module, so the registration this test
 * observes is the launcher's own, sharing its process-global session registry.
 */
function installLauncherPackage(agentDir: string, options: { withEntry?: boolean } = {}): string {
  const packageRoot = join(agentDir, "npm", "node_modules", "pi-subagents");
  mkdirSync(join(packageRoot, "bundle"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: "0.81.0",
    type: "module",
    exports: {
      "./required-child-extensions": {
        types: "./src/api/required-child-extensions.d.ts",
        default: "./bundle/required-child-extensions.js",
      },
    },
  }, null, 2));
  if (options.withEntry === false) return packageRoot;
  writeFileSync(
    join(packageRoot, "bundle", "required-child-extensions.js"),
    `export * from ${JSON.stringify(LAUNCHER_REGISTRATION_SOURCE)};\n`,
  );
  return packageRoot;
}

function buildSession(options: SessionOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-child-provider-")));
  const agentDir = join(root, options.agentDirName ?? "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const config = typeof options.config === "function"
    ? options.config(root)
    : options.config ?? { filesystem: { allowWrite: ["."] } };
  writeFileSync(join(agentDir, "extensions", "sandbox.json"), JSON.stringify(config));
  const sessionId = options.sessionId ?? "session-1";
  if (options.withGuardianEntry !== false) installGuardianEntry(agentDir);
  if ((options.launcher ?? "installed") === "installed") installLauncherPackage(agentDir);
  if (options.launcher === "broken") installLauncherPackage(agentDir, { withEntry: false });
  state.agentDir = agentDir;
  state.sandboxAvailable = options.sandboxAvailable ?? true;
  options.beforeStart?.(agentDir);
  const extension = fakeExtension();
  sandboxExtension(extension.pi);
  const ctx = context(root, sessionId);
  const start = (startCtx: ExtensionContext = ctx) =>
    extension.handlers.get("session_start")!({ type: "session_start" }, startCtx);
  const shutdown = async (): Promise<void> => {
    await extension.handlers.get("session_shutdown")!({ type: "session_shutdown" });
  };
  return { ...extension, ctx, root, agentDir, sessionId, start, shutdown };
}

function createSession(options: SessionOptions = {}) {
  return buildSession(options);
}

async function startSession(options: SessionOptions = {}) {
  const session = buildSession(options);
  await session.start();
  shutdowns.push(session.shutdown);
  return session;
}

function provider(): ChildAuthorityProvider | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY] as ChildAuthorityProvider | undefined;
}

function childWorkspace(root: string, name = "child"): { spelled: string; canonical: string } {
  const spelled = join(root, name);
  mkdirSync(spelled, { recursive: true });
  return { spelled, canonical: realpathSync(spelled) };
}

function prepare(active: ChildAuthorityProvider, sessionId: string, cwd: string, overrides: Partial<{ parentSessionId: string; runId: string; agent: string; index: number }> = {}) {
  return active.prepare({
    parentSessionId: sessionId,
    runId: "run-1",
    agent: "worker",
    index: 0,
    cwd,
    ...overrides,
  }, SIGNAL());
}

beforeEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
  state.sandboxAvailable = true;
});

afterEach(async () => {
  while (shutdowns.length > 0) await shutdowns.pop()!();
  delete (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
});

describe("registered session lifecycle publishing", () => {
  it("publishes one provider bound to the live session and the installed consumers", async () => {
    const session = await startSession();
    const active = provider();
    expect(active).toBeDefined();
    expect(active!.version).toBe(2);
    expect(active!.sessionId).toBe("session-1");
    expect(active!.requiredExtensions.map((entry) => entry.id)).toEqual(["pi-sbx", "pi-guardian"]);
    const guardianEntry = realpathSync(join(session.agentDir, "npm", "node_modules", "pi-guardian", "src", "index.ts"));
    expect(active!.requiredExtensions[1]!.path).toBe(guardianEntry);
    expect(active!.requiredExtensions[0]!.path.endsWith("/pi-sbx/src/index.ts")).toBe(true);

    const child = childWorkspace(session.root);
    const lease = await prepare(active!, session.sessionId, child.spelled);
    expect(lease.requiredConsumers).toEqual(["pi-sbx", "pi-guardian"]);
    expect(lease.payload).toMatchObject({
      version: 2,
      kind: "pi-sbx.child-policy",
      anchor: { cwd: session.root },
      workspace: { spelled: child.spelled, canonical: child.canonical },
    });
    expect(lease.signal.aborted).toBe(false);
  });

  it("removes the provider and revokes leases on session shutdown", async () => {
    const session = await startSession();
    const lease = await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    expect(provider()).toBeDefined();
    await session.shutdown();
    shutdowns.pop();
    expect(provider()).toBeUndefined();
    expect(lease.signal.aborted).toBe(true);
    const decision = await lease.decide({ surface: "read", target: "/etc/hosts", reason: "inspect" }, SIGNAL());
    expect(decision.outcome).toBe("cancelled");
  });

  it("publishes nothing without a host session id", async () => {
    await startSession({ sessionId: "" });
    expect(provider()).toBeUndefined();
  });

  it("keeps fail-closed guard intent when the Guardian entrypoint is missing", async () => {
    const session = await startSession({ withGuardianEntry: false });
    // Guard intent is published before the missing file can be reported: no bare gap.
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/pi-guardian extension entrypoint .* is not an installed file/);
    expect(resolveRequiredChildExtensions(session.sessionId)).toEqual([]);
    await vi.waitFor(() => {
      const notices = (session.ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((call) => String(call[0]));
      expect(notices.some((text) => text.includes("Child delegation authority unavailable") && text.includes("pi-guardian"))).toBe(true);
    });
    await session.shutdown();
    shutdowns.pop();
    expect(provider()).toBeUndefined();
  });

  it("keeps guard intent when required-extension path validation itself fails", async () => {
    const session = await startSession({ agentDirName: "agent[fixture]" });
    const active = provider();
    expect(active).toBeDefined();
    expect(active!.requiredExtensions).toEqual([]);
    await expect(prepare(active!, session.sessionId, childWorkspace(session.root).spelled)).rejects.toThrow(/could not demand/);
    expect((globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY]).toBe(active);
  });

  it("does not replace an explicitly present malformed undefined slot", async () => {
    (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY] = undefined;
    const session = await startSession();
    expect(CHILD_AUTHORITY_PROVIDER_KEY in globalThis).toBe(true);
    expect(provider()).toBeUndefined();
    expect(session.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("second owner"), "warning");
  });

  it("refuses a second owner instead of replacing the live provider", async () => {
    const session = await startSession();
    const live = provider();
    expect(() => publishChildAuthority({
      sessionId: session.sessionId,
      agentDir: session.agentDir,
      configDirName: ".pi",
      getBaseline: () => undefined,
      getHuman: () => ({ ask: async () => ({ kind: "deny", reason: "no human in this test" }) }),
    })).toThrow(/already published/);
    expect(provider()).toBe(live);
  });

  it("refuses to publish root authority inside a live child lease scope", async () => {
    const session = await startSession({ withGuardianEntry: true });
    await session.shutdown();
    shutdowns.pop();
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const storage = new AsyncLocalStorage<{ leaseId: string }>();
    (globalThis as Record<PropertyKey, unknown>)[childLeaseSlot] = { version: 1, storage };
    try {
      await storage.run({ leaseId: "lease-1" }, async () => {
        expect(() => publishChildAuthority({
          sessionId: "child-session",
          agentDir: session.agentDir,
          configDirName: ".pi",
          getBaseline: () => undefined,
          getHuman: () => ({ ask: async () => ({ kind: "deny", reason: "no human in this test" }) }),
          requiredExtensions: [
            { id: "pi-sbx", path: join(session.root, "index.ts") },
            { id: "pi-guardian", path: join(session.root, "guardian.ts") },
          ],
        })).toThrow(/delegated child/);
      });
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[childLeaseSlot];
    }
  });

  it("revokes child authority when the session sandbox is turned off", async () => {
    const session = await startSession();
    const lease = await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    await session.commands.get("sandbox")!.handler("off", session.ctx);
    expect(lease.signal.aborted).toBe(true);
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
  });
});

describe("mandatory launcher registration", () => {
  it("demands the canonical pi-sbx and pi-guardian extensions for the live session", async () => {
    const session = await startSession();
    const live = provider()!;
    const lease = await prepare(live, session.sessionId, childWorkspace(session.root).spelled);
    expect(lease.requiredConsumers).toEqual(["pi-sbx", "pi-guardian"]);

    const snapshot = resolveRequiredChildExtensions(session.sessionId);
    expect(snapshot.map((entry) => entry.id)).toEqual(["pi-sbx", "pi-guardian"]);
    // A mandatory demand is what refuses non-native placements and retained launches.
    expect(snapshot.every((entry) => entry.requireForAllRunners === true)).toBe(true);
    expect(snapshot[0]!.path).toBe(live.requiredExtensions[0]!.path);
    expect(snapshot[1]!.path).toBe(
      realpathSync(join(session.agentDir, "npm", "node_modules", "pi-guardian", "src", "index.ts")),
    );
  });

  it("keeps the registration and the provider when the session sandbox is turned off", async () => {
    const session = await startSession();
    await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    await session.commands.get("sandbox")!.handler("off", session.ctx);

    // Revocation must refuse children, not unregister and reopen a bare launch.
    expect(provider()).toBeDefined();
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root, "child-2").spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
  });

  it("releases the provider and the registration only at terminal shutdown", async () => {
    const session = await startSession();
    await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    await session.shutdown();
    shutdowns.pop();
    expect(provider()).toBeUndefined();
    expect(resolveRequiredChildExtensions(session.sessionId)).toEqual([]);
  });

  it("re-registers a new session and releases the previous session's registration", async () => {
    const session = await startSession();
    await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    expect(resolveRequiredChildExtensions("session-1")).toHaveLength(2);

    const next = context(session.root, "session-2");
    await session.handlers.get("session_start")!({ type: "session_start" }, next);
    await vi.waitFor(() => expect(resolveRequiredChildExtensions("session-2")).toHaveLength(2));
    expect(resolveRequiredChildExtensions("session-1")).toEqual([]);
    expect(provider()!.sessionId).toBe("session-2");
  });

  it("keeps fail-closed provider presence when the registration API fails", async () => {
    const session = await startSession({ launcher: "broken" });
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/could not demand the pi-sbx and pi-guardian child extensions/);
    expect(resolveRequiredChildExtensions(session.sessionId)).toEqual([]);
    await vi.waitFor(() => {
      const notices = (session.ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((call) => String(call[0]));
      expect(notices.some((text) => text.includes("Child delegation authority unavailable"))).toBe(true);
    });
    await session.shutdown();
    shutdowns.pop();
    expect(provider()).toBeUndefined();
  });

  it("refuses a session registration another owner holds and never disposes it", async () => {
    let other: RequiredChildExtensionRegistration | undefined;
    const session = await startSession({
      beforeStart: (agentDir) => {
        other = registerRequiredChildExtensions({
          sessionId: "session-1",
          extensions: [
            { id: "other-sandbox", path: join(agentDir, "extensions", "sandbox.json") },
            {
              id: "other-reviewer",
              path: join(agentDir, "npm", "node_modules", "pi-guardian", "src", "index.ts"),
            },
          ],
          requireForAllRunners: true,
        });
      },
    });
    try {
      // Guard intent stays published, and the other owner's registration is untouched.
      expect(provider()).toBeDefined();
      expect(resolveRequiredChildExtensions("session-1").map((entry) => entry.id))
        .toEqual(["other-sandbox", "other-reviewer"]);
      await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
        .rejects.toThrow(/already registered for session/);
      await session.shutdown();
      shutdowns.pop();
      expect(provider()).toBeUndefined();
      expect(resolveRequiredChildExtensions("session-1").map((entry) => entry.id))
        .toEqual(["other-sandbox", "other-reviewer"]);
    } finally {
      other?.dispose();
    }
  });

  it("keeps guard intent when the session config is invalid", async () => {
    const session = await startSession({ config: { enabled: "yes", filesystem: { allowWrite: ["."] } } });
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
    // An invalid config refuses children; it does not drop the mandatory demand.
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    expect(provider()).toBeDefined();
  });

  it("refuses child authority when the sandbox runtime is unavailable, without unregistering", async () => {
    const session = await startSession({ sandboxAvailable: false });
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
    // An SRT failure refuses the child; the guard itself stays demanded.
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    expect(provider()).toBeDefined();
  });

  it("publishes fail-closed presence and stays quiet when no launcher is installed", async () => {
    const session = await startSession({ launcher: "absent" });
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/could not demand the pi-sbx and pi-guardian child extensions/);
    const notices = (session.ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]));
    expect(notices.some((text) => text.includes("Child delegation authority unavailable"))).toBe(false);
  });
});

describe("guard intent precedes startup", () => {
  it("publishes unavailable guard intent synchronously, before the first await", async () => {
    const session = createSession();
    const pending = session.start();
    // No await has run yet: the provider slot must already exist, so a failing
    // queue/scratch/project/config/consumer step cannot leave a bare session.
    expect(provider()).toBeDefined();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
    await pending;
    shutdowns.push(session.shutdown);
    // The same provider becomes usable once startup succeeded.
    const lease = await prepare(provider()!, session.sessionId, childWorkspace(session.root, "after").spelled);
    expect(lease.requiredConsumers).toEqual(["pi-sbx", "pi-guardian"]);
  });

  it("keeps one guard when the same live session reinitializes", async () => {
    const session = await startSession();
    const previousLease = await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    const before = provider();
    const reinitializing = session.start();
    // Revocation must happen synchronously, before any fallible/async startup work.
    expect(previousLease.signal.aborted).toBe(true);
    expect(provider()).toBe(before);
    await reinitializing;
    expect(provider()).toBe(before);
    // No duplicate-registration failure and no bare window.
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    const lease = await prepare(provider()!, session.sessionId, childWorkspace(session.root, "again").spelled);
    expect(lease.requiredConsumers).toEqual(["pi-sbx", "pi-guardian"]);
  });

  it("keeps the guard when a same-session reinitialization fails", async () => {
    const session = await startSession();
    await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    const before = provider();
    writeFileSync(join(session.agentDir, "extensions", "sandbox.json"), JSON.stringify({ enabled: "yes" }));
    await session.start();
    expect(provider()).toBe(before);
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root, "blocked").spelled))
      .rejects.toThrow(/not initialized, valid and enabled/);
  });
});

describe("derived child policy from the parent baseline", () => {
  it("scopes writes to the assigned workspace plus verified Git metadata only", async () => {
    const session = await startSession({
      config: { filesystem: { allowWrite: ["."], denyRead: ["secrets"], allowRead: ["secrets/public"] } },
    });
    const child = childWorkspace(session.root);
    mkdirSync(join(child.canonical, ".git"), { recursive: true });
    writeFileSync(join(child.canonical, ".git", "HEAD"), "ref: refs/heads/main\n");

    const lease = await prepare(provider()!, session.sessionId, child.spelled);
    const payload = lease.payload as unknown as {
      read: { deny: string[]; allow: string[]; mandatoryDeny: string[] };
      write: { allow: string[]; deny: string[]; mandatoryDeny: string[] };
      anchor: { cwd: string };
    };
    expect(payload.anchor.cwd).toBe(session.root);
    // Reads stay deny-based with the parent's own spellings; relative entries are
    // anchored at the parent cwd, never at the child's.
    expect(payload.read.deny).toEqual(["secrets", join(session.agentDir, "auth.json")]);
    expect(payload.read.allow).toEqual(["secrets/public"]);
    expect(payload.read.mandatoryDeny).toEqual([join(session.agentDir, "auth.json")]);
    // Writes are the assigned workspace and its verified git metadata: no parent
    // write root, no temp root, no maintenance grant.
    expect(payload.write.allow).toEqual([child.canonical, join(child.canonical, ".git")]);
    expect(payload.write.allow).not.toContain(session.root);
    expect(payload.write.allow).not.toContain(tmpdir());
    expect(payload.write.mandatoryDeny).toEqual(expect.arrayContaining([
      session.agentDir,
      join(child.canonical, ".pi"),
      join(child.canonical, ".git", "config"),
      join(child.canonical, ".git", "hooks"),
    ]));
    expect(payload.write.deny).toContain(session.agentDir);
  });

  it("admits no Git metadata the parent does not already hold", async () => {
    const session = await startSession({ config: { filesystem: { allowWrite: ["."], denyWrite: ["child/.git"] } } });
    const child = childWorkspace(session.root);
    mkdirSync(join(child.canonical, ".git"), { recursive: true });
    writeFileSync(join(child.canonical, ".git", "HEAD"), "ref: refs/heads/main\n");
    const lease = await prepare(provider()!, session.sessionId, child.spelled);
    const payload = lease.payload as unknown as { write: { allow: string[] } };
    expect(payload.write.allow).toEqual([child.canonical]);
  });

  it("never delegates an unheld canonical Git directory through a workspace symlink", async () => {
    const session = await startSession({ config: (root) => ({ filesystem: { allowWrite: [join(root, "child")] } }) });
    const child = childWorkspace(session.root);
    const foreignGit = join(session.root, "foreign-git");
    mkdirSync(foreignGit);
    writeFileSync(join(foreignGit, "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(foreignGit, join(child.spelled, ".git"));
    const lease = await prepare(provider()!, session.sessionId, child.spelled);
    expect(lease.payload.write.allow).toEqual([child.canonical]);
    expect(lease.payload.write.mandatoryDeny).toContain(join(realpathSync(foreignGit), "config"));
    await expect(lease.decide({ surface: "write", target: join(child.spelled, ".git", "config"), reason: "change Git configuration" }, SIGNAL()))
      .resolves.toMatchObject({ outcome: "deny" });
  });

  it("allows a held canonical Git target while retaining its config/hooks exclusions", async () => {
    const session = await startSession();
    const child = childWorkspace(session.root);
    const heldGit = join(session.root, "held-git");
    mkdirSync(heldGit);
    writeFileSync(join(heldGit, "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(heldGit, join(child.spelled, ".git"));
    const lease = await prepare(provider()!, session.sessionId, child.spelled);
    expect(lease.payload.write.allow).toEqual([child.canonical, realpathSync(heldGit)]);
    expect(lease.payload.write.mandatoryDeny).toContain(join(realpathSync(heldGit), "config"));
    expect(lease.payload.write.mandatoryDeny).toContain(join(child.spelled, ".git", "hooks"));
  });

  it("admits a verified linked-worktree git dir and ignores an unverified pointer", async () => {
    const session = await startSession();
    const child = childWorkspace(session.root);
    const gitDir = join(session.root, ".git", "worktrees", "child");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(child.canonical, ".git"), `gitdir: ${gitDir}\n`);
    const lease = await prepare(provider()!, session.sessionId, child.spelled);
    const payload = lease.payload as unknown as { write: { allow: string[]; mandatoryDeny: string[] } };
    expect(payload.write.allow).toEqual([child.canonical, realpathSync(gitDir)]);
    expect(payload.write.mandatoryDeny).toEqual(expect.arrayContaining([join(realpathSync(gitDir), "config")]));

    // A pointer at a directory that is not git metadata admits nothing.
    const fakeGitDir = join(session.root, "not-a-git-dir");
    mkdirSync(fakeGitDir, { recursive: true });
    writeFileSync(join(child.canonical, ".git"), `gitdir: ${fakeGitDir}\n`);
    const second = await prepare(provider()!, session.sessionId, child.spelled);
    expect((second.payload as unknown as { write: { allow: string[] } }).write.allow).toEqual([child.canonical]);
  });

  it("refuses a proposed workspace inside the granted agent dir or the parent scratchpad", async () => {
    const session = await startSession({
      // The granted shape this repo installs: the agent dir is an allow root.
      config: (root) => ({ filesystem: { allowWrite: ["."] }, agentDirWriteProjects: [root] }),
    });
    const agentChild = join(session.agentDir, "child");
    mkdirSync(agentChild, { recursive: true });
    await expect(prepare(provider()!, session.sessionId, agentChild))
      .rejects.toThrow(/agent directory or the parent's private scratchpad/);

    // The scratchpad exists only after startup and is read live.
    // Bind the actual session's allocation, never diff global temp directories:
    // other parallel test workers may allocate scratch during this startup.
    const scratchRoot = state.sessionScratch;
    expect(scratchRoot).toBeTruthy();
    const scratchChild = join(scratchRoot, "child");
    mkdirSync(scratchChild, { recursive: true });
    await expect(prepare(provider()!, session.sessionId, scratchChild))
      .rejects.toThrow(/agent directory or the parent's private scratchpad/);

    // An alias of the agent dir is refused too.
    const alias = join(session.root, "agent-alias");
    symlinkSync(session.agentDir, alias, "dir");
    await expect(prepare(provider()!, session.sessionId, alias))
      .rejects.toThrow(/agent directory|mandatory deny-write path/);
  });

  it("refuses an ancestor workspace that would sweep the agent directory into child write scope", async () => {
    const session = await startSession({
      config: (root) => ({ filesystem: { allowWrite: ["."] }, agentDirWriteProjects: [root] }),
    });
    await expect(prepare(provider()!, session.sessionId, session.root))
      .rejects.toThrow(/overlaps.*agent directory/);
  });

  it("retains unavailable guard intent until asynchronous shutdown finishes", async () => {
    const session = await startSession();
    const before = provider()!;
    const lease = await prepare(before, session.sessionId, childWorkspace(session.root).spelled);
    const closing = session.shutdown();
    expect(lease.signal.aborted).toBe(true);
    expect(provider()).toBe(before);
    expect(resolveRequiredChildExtensions(session.sessionId)).toHaveLength(2);
    await closing;
    shutdowns.pop();
    expect(provider()).toBeUndefined();
    expect(resolveRequiredChildExtensions(session.sessionId)).toEqual([]);
  });

  it("refuses a workspace the parent does not hold", async () => {
    const session = await startSession();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-child-outside-")));
    await expect(prepare(provider()!, session.sessionId, outside)).rejects.toThrow(/outside the parent's writable scope/);
  });

  it("refuses a foreign session identity before deriving anything", async () => {
    const session = await startSession();
    await expect(prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled, { parentSessionId: "other-session" }))
      .rejects.toThrow(/foreign child authority identity/);
  });
});

describe("registered provider composed with the real launcher and parent approval route", () => {
  it("carries parent-baseline and one-action human decisions over real runner IPC", async () => {
    const session = await startSession();
    const child = childWorkspace(session.root);
    const evidence = join(session.root, "evidence");
    mkdirSync(evidence);
    const requests = [
      { surface: "write", target: join(child.canonical, "held.txt"), reason: "inside delegated scope" },
      { surface: "write", target: join(session.root, "outside-child.txt"), reason: "one sibling action" },
      { surface: "write", target: join(child.canonical, ".pi", "blocked.json"), reason: "must be denied" },
    ];
    const seen: SandboxExceptionRequest[] = [];
    const unpublish = publishGuardianBrokerForTest({ review: async (request) => {
      seen.push(request);
      return { kind: "allow", scope: "once", review: { source: "reviewer", rationale: "semantic fixture allow" } };
    } });
    const select = vi.fn(async (_title: string) => "Allow this one file change");
    session.ctx.ui.select = select as typeof session.ctx.ui.select;
    const factoryModule = new URL("../../pi-subagents/src/runs/shared/child-session.ts", import.meta.url).href;
    const { childSessionFactoryModule, setChildSessionFactoryModule } = await import(factoryModule);
    const beforeFactory = childSessionFactoryModule();
    const envKeys = ["CHILD_AUTHORITY_LAUNCH_EVIDENCE", "CHILD_AUTHORITY_LAUNCH_REQUESTS"] as const;
    const beforeEnv = envKeys.map((key) => process.env[key]);
    try {
      setChildSessionFactoryModule(fileURLToPath(new URL("../../pi-subagents/test/fixtures/child-authority/launch-consumer-factory.ts", import.meta.url)));
      process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE = evidence;
      process.env.CHILD_AUTHORITY_LAUNCH_REQUESTS = JSON.stringify(requests);
      // Load the cross-fork execution graph at runtime: it has its own SDK and
      // ES2023 typecheck, independent of pi-sbx's ES2022 source/test graph.
      const launcherModule = new URL("../../pi-subagents/src/runs/background/async-execution.ts", import.meta.url).href;
      const { executeAsyncSingle } = await import(launcherModule);
      const result = await executeAsyncSingle(`provider-composition-${Date.now()}`, {
        agent: "fixture", task: "composed authority fixture", cwd: child.canonical,
        agentConfig: { name: "fixture", description: "controlled consumer, not production policy", systemPrompt: "", systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false },
        ctx: { pi: { events: { emit() {} } }, cwd: session.root, currentSessionId: session.sessionId },
        artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
        shareEnabled: false,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const events = () => {
        try { return readFileSync(join(evidence, "launch-evidence.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
        catch { return []; }
      };
      await vi.waitFor(() => {
        const asyncDir = result.details?.asyncDir;
        const read = (name: string) => {
          try { return readFileSync(join(String(asyncDir), name), "utf8").slice(-4000); } catch { return "missing"; }
        };
        expect(events().some((entry) => entry.event === "dispose"), JSON.stringify({ events: events(), status: read("status.json"), stderr: read("runner.stderr.log") })).toBe(true);
      }, { timeout: 20_000 });
      expect(events().filter((entry) => entry.event === "decision").map((entry) => entry.decision.outcome)).toEqual(["allow", "allow", "deny"]);
      expect(events().map((entry) => entry.event)).toEqual(["create", "decision", "decision", "decision", "prompt", "dispose"]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ cwd: session.root, target: requests[1]!.target, surface: "write", agentName: "fixture" });
      expect(select).toHaveBeenCalledOnce();
      expect(select.mock.calls[0]?.[0]).toContain("outside-child.txt");
    } finally {
      setChildSessionFactoryModule(beforeFactory);
      for (const [index, key] of envKeys.entries()) {
        if (beforeEnv[index] === undefined) delete process.env[key];
        else process.env[key] = beforeEnv[index];
      }
      unpublish();
    }
  }, 30_000);
});

describe("provider disposal is terminal", () => {
  it("revokes leases and unregisters the published provider", async () => {
    const session = await startSession();
    const lease = await prepare(provider()!, session.sessionId, childWorkspace(session.root).spelled);
    const publication = provider() as unknown as ChildAuthorityPublication["provider"];
    expect(publication).toBeDefined();
    await session.shutdown();
    shutdowns.pop();
    expect(lease.signal.aborted).toBe(true);
    expect(provider()).toBeUndefined();
  });
});
