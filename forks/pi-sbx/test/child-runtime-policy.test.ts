import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decideChildAction, type ChildActionContext } from "../src/action-authorizer.ts";
import { deriveChildPolicy } from "../src/child-authority.ts";
import { childNetworkDisposition, childUnixSocketDirectories, loadChildDomainMatcher, projectChildRuntime, type RuntimeBaseline } from "../src/child-runtime-policy.ts";
import { createFilePolicy } from "../src/path-policy.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-runtime-projection-")));
const CHILD = join(ROOT, "child"); mkdirSync(CHILD);
function baseline(runtime: Partial<SandboxRuntimeConfig> = {}): RuntimeBaseline {
  return { runtime: {
    network: { allowedDomains: ["example.com:443"], deniedDomains: [] },
    filesystem: { allowWrite: [ROOT], denyWrite: [], denyRead: [] },
    ...runtime,
  }, environmentDeny: ["CUSTOM_TOKEN"] };
}
function context(prepared: RuntimeBaseline = baseline(), current = prepared): ChildActionContext {
  const policy = createFilePolicy({ filesystem: current.runtime.filesystem, mandatoryDenyWrite: [] });
  return {
    identity: { agent: "worker", index: 0, runId: "runtime-fixture" }, childCwd: CHILD,
    baseline: { ...current, cwd: ROOT, policy, allowUnsandboxedCommands: true }, ceiling: policy,
    networkCeiling: projectChildRuntime(prepared, ROOT).network, hostCeiling: true,
    human: { ask: vi.fn(async () => ({ kind: "deny" as const, reason: "not admitted" })) },
    decide: vi.fn(async () => ({ kind: "allow" as const, scope: "once" as const, review: { source: "reviewer" as const, rationale: "semantic fixture allow" } })),
  };
}
const network = (options: Partial<SandboxRuntimeConfig["network"]> = {}) => projectChildRuntime(baseline({ network: {
  allowedDomains: ["example.com:443", "*.example.net:8443", "[::1]:443", "127.0.0.1:443"], deniedDomains: [], ...options,
} }), ROOT).network;

describe("minimal inherited runtime authority", () => {
  it("carries names/static constraints, never credential values or masked injection authority", () => {
    const projected = projectChildRuntime(baseline({
      credentials: {
        envVars: [{ name: "MASKED_TOKEN", mode: "mask", injectHosts: ["example.com"] }, { name: "DENIED_TOKEN", mode: "deny" }],
        files: [{ path: join(ROOT, "credentials"), mode: "mask", injectHosts: ["example.com"] }],
        allowPlaintextInject: true,
      },
      enableWeakerNestedSandbox: true, enableWeakerNetworkIsolation: true, allowAppleEvents: true,
      network: { allowedDomains: ["example.com:443"], deniedDomains: ["*.denied.example"], allowMachLookup: ["privileged.service"] },
      filesystem: { denyRead: [], denyWrite: [], allowWrite: [ROOT], disabled: true, allowGitConfig: true },
      allowPty: true, mandatoryDenySearchDepth: 9,
    }), ROOT);
    expect(projected.environment.deny).toEqual(["CUSTOM_TOKEN", "MASKED_TOKEN", "DENIED_TOKEN", "SSH_AUTH_SOCK", "GPG_AGENT_INFO"]);
    expect(projected.isolation).toEqual({ allowPty: true, mandatoryDenySearchDepth: 9 });
    expect(projected.network.deniedDomains).toEqual(["*.denied.example"]);
    const serialized = JSON.stringify(projected);
    for (const field of ["injectHosts", "credentials", "enableWeaker", "allowAppleEvents", "allowMachLookup", "allowGitConfig", "disabled", "privileged.service"]) expect(serialized).not.toContain(field);
  });

  it("keeps runtime-declared credential files read/write locked even if a native baseline adapter omitted them", async () => {
    const secret = join(CHILD, "credential-source"), parent = baseline({ credentials: { files: [{ path: secret, mode: "mask", injectHosts: ["example.com"] }] } });
    const ctx = context(parent);
    const derived = deriveChildPolicy({ baseline: ctx.baseline, identity: { cwd: CHILD }, configDirName: ".pi", agentDir: join(ROOT, "agent") });
    expect(derived.payload.read.mandatoryDeny).toContain(secret);
    expect(derived.payload.write.mandatoryDeny).toContain(secret);
    for (const surface of ["read", "write"] as const) expect((await decideChildAction({ surface, target: secret, reason: "request a source file" }, ctx)).outcome).toBe("deny");
    expect(ctx.decide).not.toHaveBeenCalled(); expect(ctx.human.ask).not.toHaveBeenCalled();
  });
  it("cannot assign a runtime-declared credential directory as the child's workspace", () => {
    const parent = baseline({ credentials: { files: [{ path: CHILD, mode: "deny" }] } }), ctx = context(parent);
    expect(() => deriveChildPolicy({ baseline: ctx.baseline, identity: { cwd: CHILD }, configDirName: ".pi", agentDir: join(ROOT, "agent") })).toThrow(/mandatory deny-write/);
  });

  for (const field of ["filterRequest", "httpProxyPort", "socksProxyPort", "mitmProxy", "tlsTerminate", "parentProxy"]) {
    it(`refuses network.${field} rather than omitting a restrictive parent service`, () => {
      const parent = baseline();
      Object.assign(parent.runtime.network, { [field]: "sensitive-fixture-value" });
      expect(() => projectChildRuntime(parent, ROOT)).toThrow(`network.${field}`);
      try { projectChildRuntime(parent, ROOT); } catch (error) { expect(String(error)).not.toContain("sensitive-fixture-value"); }
    });
  }
  for (const field of ["ripgrep", "seccomp", "bwrapPath", "socatPath", "javaAgentJarPath"]) {
    it(`refuses custom ${field} instead of replacing the parent's enforcement helper`, () => {
      expect(() => projectChildRuntime(baseline({ [field]: "custom-helper" }), ROOT)).toThrow(/custom parent execution helpers/);
    });
  }
  it("fails closed on missing and unknown future policy", () => {
    expect(() => projectChildRuntime({} as RuntimeBaseline, ROOT)).toThrow(/actual parent baseline/);
    for (const group of ["network", "filesystem", "credentials", "git"] as const) {
      const parent = baseline();
      Object.assign(parent.runtime, { [group]: { ...parent.runtime[group], futureRestriction: true } });
      expect(() => projectChildRuntime(parent, ROOT)).toThrow(/unsupported/);
    }
    const parent = baseline(); Object.assign(parent.runtime, { futureRestriction: true });
    expect(() => projectChildRuntime(parent, ROOT)).toThrow(/unsupported/);
  });

  it("rejects malformed feature flags, depth and environment-name data instead of coercing a restriction away", () => {
    for (const field of ["strictAllowlist", "allowLocalBinding", "allowAllUnixSockets"]) {
      const parent = baseline(); Object.assign(parent.runtime.network, { [field]: "true" });
      expect(() => projectChildRuntime(parent, ROOT)).toThrow(/booleans/);
    }
    for (const depth of [0, -1, 11, 1.5, NaN]) expect(() => projectChildRuntime(baseline({ mandatoryDenySearchDepth: depth }), ROOT)).toThrow(/search depth/);
    expect(() => projectChildRuntime({ ...baseline(), environmentDeny: ["NAME=not-a-name"] }, ROOT)).toThrow(/variable names/);
  });

  it("does not turn parent-wide sockets/temp/maintenance access into a child namespace", () => {
    const parent = baseline({ network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [ROOT, join(ROOT, "private-parent")], allowLocalBinding: true } });
    const projected = projectChildRuntime(parent, ROOT).network;
    const scratch = join(ROOT, "child-private-scratch");
    expect(childUnixSocketDirectories(projected, [CHILD, scratch], ROOT)).toEqual([CHILD, scratch]);
    expect(childUnixSocketDirectories(projected, ["/another-project"], ROOT)).toEqual([]);
    expect(projected.allowLocalBinding).toBe(true);
    const narrow = network({ allowUnixSockets: [join(CHILD, "sockets")] });
    expect(childUnixSocketDirectories(narrow, [CHILD], ROOT)).toEqual([join(CHILD, "sockets")]);
    expect(childUnixSocketDirectories(network(), [CHILD, scratch], ROOT)).toEqual([]);
    expect(childUnixSocketDirectories(network({ allowAllUnixSockets: true }), [CHILD, scratch], ROOT)).toEqual([CHILD, scratch]);
  });

  it("pins original and canonical socket aliases in the same immutable bounded policy", () => {
    const real = join(ROOT, "socket-real"), alias = join(ROOT, "socket-alias"); mkdirSync(real); symlinkSync(real, alias);
    const parent = baseline({ network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [alias] } });
    const policy = createFilePolicy({ filesystem: parent.runtime.filesystem, mandatoryDenyWrite: [] });
    const derived = deriveChildPolicy({ baseline: { ...parent, cwd: ROOT, policy, allowUnsandboxedCommands: false }, identity: { cwd: CHILD }, configDirName: ".pi", agentDir: join(ROOT, "agent") });
    expect(derived.payload.network.unixSocketCeiling.roots).toEqual([real]);
    expect(derived.payload.anchor.paths).toContainEqual({ spelled: alias, canonical: real });
    expect(derived.payload.command.allowHost).toBe(false);
    expect(Object.isFrozen(derived.payload.network.allowedDomains)).toBe(true);
    expect(Object.isFrozen(derived.payload.environment.deny)).toBe(true);
    expect(() => projectChildRuntime(baseline({ network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [join(ROOT, "*")] } }), ROOT)).toThrow(/exact directories/);
  });
});

describe("SRT-owned host normalization and prepared/current network intersection", () => {
  it("matches actual shipped SRT semantics for ports, strict subdomains, IPv6, inet_aton and trailing dots", async () => {
    const matcher = await loadChildDomainMatcher(), policy = network();
    for (const target of ["EXAMPLE.COM.:443", "api.example.net:8443", "[0:0:0:0:0:0:0:1]:443", "127.1:443", "2130706433:443", "0x7f.0.0.1:443"]) {
      expect(childNetworkDisposition(target, policy, policy, matcher), target).toBe("held");
    }
    for (const target of ["example.com:80", "example.net:8443", "badexample.net:8443", "api.example.net:443"]) expect(childNetworkDisposition(target, policy, policy, matcher), target).toBe("ask");
  });
  it("refuses malformed or unknown ports without turning parsing into authority", async () => {
    const matcher = await loadChildDomainMatcher(), policy = network();
    for (const target of ["example.com", "example.com:*", "example.com:0", "example.com:0443", "example.com:65536", "https://example.com:443", "user@example.com:443", "example.com/path:443", "example.com:443\n", "[user@example.com]:443", "[example.com]:443", "[::1/path]:443", "::1:443", "[fe80::1%lo0]:443", "*.example.com:443"]) {
      expect(childNetworkDisposition(target, policy, policy, matcher), target).toBe("deny");
    }
  });
  it("keeps both prepared/current denials and strict off-list denials final", async () => {
    const matcher = await loadChildDomainMatcher(), plain = network();
    for (const [prepared, current] of [
      [network({ deniedDomains: ["example.com:443"] }), plain], [plain, network({ deniedDomains: ["*:443"] })],
      [network({ strictAllowlist: true, allowedDomains: [] }), plain], [plain, network({ strictAllowlist: true, allowedDomains: [] })],
    ]) expect(childNetworkDisposition("example.com:443", prepared, current, matcher)).toBe("deny");
    expect(childNetworkDisposition("example.com:443", plain, network({ allowedDomains: [] }), matcher)).toBe("ask");
    expect(childNetworkDisposition("example.com:443", network({ allowedDomains: [] }), plain, matcher)).toBe("ask");
  });

  it("never reviews or prompts for a final deny; static held destinations have no extra charge", async () => {
    const allowed = context();
    expect((await decideChildAction({ surface: "network", target: "example.com:443", reason: "fetch" }, allowed)).outcome).toBe("allow");
    expect(allowed.decide).not.toHaveBeenCalled(); expect(allowed.human.ask).not.toHaveBeenCalled();
    const denied = context(baseline({ network: { allowedDomains: [], deniedDomains: ["*:443"] } }), baseline());
    expect((await decideChildAction({ surface: "network", target: "example.com:443", reason: "fetch" }, denied)).outcome).toBe("deny");
    expect(denied.decide).not.toHaveBeenCalled(); expect(denied.human.ask).not.toHaveBeenCalled();
  });
  it("routes an unheld connection through the existing parent decision route only", async () => {
    const ctx = context();
    expect((await decideChildAction({ surface: "network", target: "new.example:443", reason: "fetch" }, ctx)).outcome).toBe("allow");
    expect(ctx.decide).toHaveBeenCalledWith(expect.objectContaining({ surface: "network", target: "new.example:443", cwd: ROOT, agentName: "worker" }));
    expect(ctx.human.ask).not.toHaveBeenCalled();
  });
  it("requires actual parent human admission even after a semantic full-host allow", async () => {
    const ctx = context();
    const result = await decideChildAction({ surface: "command", target: "git status", reason: "host access" }, ctx);
    expect(result.outcome).toBe("deny"); expect(ctx.decide).toHaveBeenCalledOnce(); expect(ctx.human.ask).toHaveBeenCalledOnce();
    const noHuman = context(); noHuman.human = { ask: async () => ({ kind: "unavailable", reason: "no actual parent UI" }) };
    expect((await decideChildAction({ surface: "command", target: "git status", reason: "host access" }, noHuman)).outcome).toBe("unavailable");
  });
  it("cannot reopen a prepared host-disabled ceiling when current parent host policy loosens", async () => {
    const ctx = context(); ctx.hostCeiling = false;
    expect((await decideChildAction({ surface: "command", target: "git status", reason: "host" }, ctx)).outcome).toBe("deny");
    expect(ctx.decide).not.toHaveBeenCalled(); expect(ctx.human.ask).not.toHaveBeenCalled();
  });
});
