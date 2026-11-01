import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildSandbox, registerChildSandbox } from "../src/child-sandbox.ts";
import { canonicalizeTarget } from "../src/path-policy.ts";
import { deriveChildPolicy } from "../src/child-authority.ts";
import * as api from "../../pi-subagents/src/api/child-authority.ts";
import { createChildAuthorityLease, withChildAuthority, type ChildAuthorityLeaseHandle } from "../../pi-subagents/src/runs/shared/child-authority.ts";

let root: string, cwd: string, agentDir: string;
let handle: ChildAuthorityLeaseHandle;
let binding: ChildSandbox;
let sdkId: string;
let tools: Array<{ name: string; sourceInfo: { path: string } }>;
let requests: Array<{ surface: string; target: string }>;
let beforeDelivery: undefined | (() => void);
let verdict: { outcome: "allow" | "deny" | "unavailable" | "cancelled"; rationale?: string; terminate?: boolean };
let payload: ReturnType<typeof deriveChildPolicy>["payload"];
let saved: Array<PropertyDescriptor | undefined>;
let pathValue: string | undefined;
const keys = [Symbol.for("pi-subagents.child-authority-lease.v1"), Symbol.for("pi-subagents.child-authority-runner.v1")];
const globals = globalThis as Record<PropertyKey, unknown>;
const ctx = (): ExtensionContext => ({ cwd, hasUI: false, sessionManager: { getSessionId: () => sdkId } } as unknown as ExtensionContext);
const pi = (): ExtensionAPI => ({ getAllTools: () => tools } as unknown as ExtensionAPI);
const scope = <T>(callback: () => T): T => withChildAuthority(handle.lease, callback);
const prepare = () => scope(() => binding.prepare(ctx()));
function acknowledgeGuardianFixture() { scope(() => { api.claimChildAuthority("pi-guardian", cwd); api.acknowledgeChildAuthority("pi-guardian"); }); }
async function activateFixture() { await prepare(); acknowledgeGuardianFixture(); scope(() => binding.activate(ctx(), true)); }

beforeEach(() => {
  saved = keys.map(key => Object.getOwnPropertyDescriptor(globals, key)); keys.forEach(key => delete globals[key]);
  pathValue = process.env.PATH;
  root = mkdtempSync(join(tmpdir(), "sbx-child-binding-")); cwd = join(root, "project"); agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir); sdkId = "child-sdk"; requests = []; beforeDelivery = undefined; verdict = { outcome: "allow" };
  tools = ["read", "write", "edit", "bash", "grep", "find", "ls"].map(name => ({ name, sourceInfo: { path: fileURLToPath(new URL("../src/index.ts", import.meta.url)) } }));
  payload = deriveChildPolicy({ agentDir, configDirName: ".pi", identity: { cwd }, baseline: {
    cwd: root, allowUnsandboxedCommands: false, environmentDeny: ["SYNTHETIC_SECRET"],
    runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: [root], denyRead: [], allowRead: [], denyWrite: [] } },
    policy: { allowWrite: [root], denyRead: [], allowRead: [], denyWrite: [], mandatoryDenyRead: [join(agentDir, "auth.json")], mandatoryDenyWrite: [agentDir] },
  } }).payload;
  handle = createChildAuthorityLease({ leaseId: "actual-binding-fixture", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd },
    payload, requiredConsumers: ["pi-sbx", "pi-guardian"], requestTimeoutMs: 1000,
    send(id, action) { requests.push(action); queueMicrotask(() => { beforeDelivery?.(); handle.deliverDecision(id, verdict); }); return true; }, cancel() {} });
  binding = new ChildSandbox(api, pi());
});
afterEach(async () => {
  binding.close(); handle.lease.dispose(); await binding.scratchpad?.dispose();
  if (pathValue === undefined) delete process.env.PATH; else process.env.PATH = pathValue;
  keys.forEach((key, index) => { if (saved[index]) Object.defineProperty(globals, key, saved[index]!); else delete globals[key]; });
  rmSync(root, { recursive: true, force: true });
});

describe("actual public lease sandbox binding (controller/Guardian fixtures, not composition)", () => {
  it("prepares only held private scratch and cannot acknowledge before real-controller admission", async () => {
    await prepare();
    expect(binding.scratchpad!.dir.startsWith(join(canonicalizeTarget(cwd, cwd), "pi-sbx-scratch-"))).toBe(true);
    expect(() => handle.lease.assertReady()).toThrow(/pi-sbx.*pi-guardian/);
    acknowledgeGuardianFixture(); expect(() => handle.lease.assertReady()).toThrow(/pi-sbx/);
    scope(() => binding.activate(ctx(), true)); expect(() => handle.lease.assertReady()).not.toThrow();
    expect(binding.config!.projectApplied).toBe(false);
  });
  it("refuses a controller that did not become active", async () => {
    await prepare(); acknowledgeGuardianFixture(); expect(() => scope(() => binding.activate(ctx(), false))).toThrow(/not active/);
    expect(handle.lease.signal.aborted).toBe(true);
  });
  it("cannot consume a held local action without the current parent decision", async () => {
    await activateFixture();
    const result = await binding.authorizePath({ surface: "write", target: canonicalizeTarget(join(cwd, "file"), cwd), reason: "one exact action" }, ctx(), new AbortController().signal);
    expect(result).toEqual({ kind: "allow", granted: false }); expect(requests).toHaveLength(1); expect(requests[0].surface).toBe("write");
    verdict = { outcome: "deny", rationale: "baseline changed" };
    expect(await binding.authorizePath({ surface: "write", target: canonicalizeTarget(join(cwd, "file"), cwd), reason: "another exact action" }, ctx(), binding.signal)).toEqual({ kind: "deny", reason: "baseline changed" });
    expect(requests).toHaveLength(2);
  });
  for (const [outcome, kind] of [["unavailable", "deferred"], ["cancelled", "cancelled"]] as const) {
    it(`preserves the terminal parent ${outcome} outcome without asking a local human`, async () => {
      await activateFixture(); verdict = { outcome, rationale: "actual parent terminal reason" };
      expect(await binding.authorizePath({ surface: "write", target: canonicalizeTarget(join(cwd, "file"), cwd), reason: "one exact action" }, ctx(), binding.signal))
        .toEqual({ kind, reason: "actual parent terminal reason" });
      expect(requests).toHaveLength(1);
    });
  }
  it("never asks the parent to override a prepared mandatory exclusion", async () => {
    await activateFixture();
    const result = await binding.authorizePath({ surface: "read", target: join(agentDir, "auth.json"), reason: "not grantable" }, ctx(), binding.signal);
    expect(result.kind).toBe("deny"); expect(requests).toHaveLength(0);
  });
  it("rejects a changed SDK identity before IO or a parent request", async () => {
    await activateFixture(); sdkId = "foreign-sdk";
    expect(() => binding.assertActive(ctx())).toThrow(/identity/); expect(handle.lease.signal.aborted).toBe(true); expect(requests).toHaveLength(0);
  });
  it("discards a pending allow after SDK identity drift", async () => {
    await activateFixture(); beforeDelivery = () => { sdkId = "foreign-sdk"; };
    await expect(binding.request({ surface: "read", target: join(cwd, "file"), reason: "one exact action" }, ctx())).rejects.toThrow(/identity/);
  });
  it("does not consume parent termination as permission", async () => {
    await activateFixture(); verdict = { outcome: "deny", rationale: "terminate now", terminate: true };
    expect((await binding.request({ surface: "read", target: join(cwd, "file"), reason: "one exact action" }, ctx())).outcome).toBe("deny");
    expect(handle.lease.signal.aborted).toBe(true);
  });
  it("keeps root maintenance read/write absent from the compiled child policy", async () => {
    await activateFixture();
    expect(binding.config!.hardening.mandatoryDenyWrite.map(path => canonicalizeTarget(path, cwd))).toContain(canonicalizeTarget(agentDir, cwd));
    const result = await binding.authorizePath({ surface: "write", target: join(agentDir, "settings.json"), reason: "not delegated" }, ctx(), binding.signal);
    expect(result.kind).toBe("deny"); expect(requests).toHaveLength(0);
  });
  it("refuses a foreign or overridden native owner before scratch creation", async () => {
    tools[0].sourceInfo.path = join(root, "different-extension.ts");
    await expect(prepare()).rejects.toThrow(/not owned/); expect(readdirSync(cwd)).toEqual([]); expect(handle.lease.signal.aborted).toBe(true);
  });
  it("checks native owner provenance on every action, not only acknowledgment", async () => {
    await activateFixture(); tools[0].sourceInfo.path = join(root, "different-extension.ts");
    expect(() => binding.assertActive(ctx())).toThrow(/not owned/); expect(handle.lease.signal.aborted).toBe(true);
  });
  it("refuses writable PATH helper namespaces before scratch creation", async () => {
    process.env.PATH = `${cwd}:${pathValue}`;
    await expect(prepare()).rejects.toThrow(/writable root overlaps/); expect(readdirSync(cwd)).toEqual([]);
  });
  it("refuses relative execution PATH components rather than choosing another backend", async () => {
    process.env.PATH = `.:${pathValue}`;
    await expect(prepare()).rejects.toThrow(/relative or empty/); expect(readdirSync(cwd)).toEqual([]);
  });
  it("detects changed PATH values after activation", async () => {
    await activateFixture(); process.env.PATH = `${pathValue}:/another-path`;
    expect(() => binding.assertActive(ctx())).toThrow(/PATH changed/);
  });
  it("detects changed helper directory metadata after activation", async () => {
    const helpers = join(root, "readonly-helpers"); mkdirSync(helpers); process.env.PATH = `${helpers}:${pathValue}`;
    await activateFixture(); writeFileSync(join(helpers, "new-helper"), "fixture");
    expect(() => binding.assertActive(ctx())).toThrow(/provenance changed/);
  });
  it("detects an existing helper edit even when its PATH directory timestamp does not change", async () => {
    const helpers = join(root, "readonly-helpers"); mkdirSync(helpers); writeFileSync(join(helpers, "rg"), "old");
    process.env.PATH = `${helpers}:${pathValue}`;
    await activateFixture(); const before = statSync(helpers, { bigint: true }).mtimeNs;
    writeFileSync(join(helpers, "rg"), "new");
    expect(statSync(helpers, { bigint: true }).mtimeNs).toBe(before);
    expect(() => binding.assertActive(ctx())).toThrow(/provenance changed/);
  });
  it("refuses UI/in-process placement and cannot rebind after shutdown", async () => {
    await expect(scope(() => binding.prepare({ ...ctx(), hasUI: true }))).rejects.toThrow(/native background/);
    binding.close(); await expect(prepare()).rejects.toThrow(/ended|second SDK/);
  });
});

describe("guard before asynchronous installed API lookup", () => {
  it("keeps a real blocking hook when API loading fails", async () => {
    const handlers = new Map<string, Function>(); const root = vi.fn(), install = vi.fn();
    await expect(registerChildSandbox({ on: (name: string, fn: Function) => handlers.set(name, fn) } as unknown as ExtensionAPI, root, install,
      { loadApi: async () => { throw new Error("missing installed API"); } })).rejects.toThrow(/missing installed/);
    expect(handlers.get("tool_call")!({ toolName: "read" }, ctx())).toMatchObject({ block: true, reason: expect.stringContaining("missing installed API") });
    expect(root).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it("allows root registration only after the real public detector proves inactivity", async () => {
    const root = vi.fn(), install = vi.fn();
    await registerChildSandbox({ on: vi.fn() } as unknown as ExtensionAPI, root, install, { loadApi: async () => api });
    expect(root).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled();
  });
  it("installs the actual binding only inside a live scope, without claiming until session start", async () => {
    const root = vi.fn(), install = vi.fn();
    await scope(() => registerChildSandbox({ on: vi.fn() } as unknown as ExtensionAPI, root, install, { loadApi: async () => api }));
    expect(root).not.toHaveBeenCalled(); expect(install).toHaveBeenCalledTimes(1); expect(() => handle.lease.assertReady()).toThrow(/pi-sbx/);
  });
});
