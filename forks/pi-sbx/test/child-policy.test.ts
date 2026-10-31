import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveChildPolicy } from "../src/child-authority.ts";
import { decodeChildPolicy } from "../src/child-policy.ts";

let root: string;
let cwd: string;
let payload: ReturnType<typeof deriveChildPolicy>["payload"];
const clone = (): any => JSON.parse(JSON.stringify(payload));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbx-child-policy-"));
  cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(agentDir);
  payload = deriveChildPolicy({ agentDir, configDirName: ".pi",
    identity: { cwd },
    baseline: { cwd: root, allowUnsandboxedCommands: false, environmentDeny: ["SYNTHETIC_SECRET"],
      runtime: { network: { allowedDomains: ["example.invalid:443"], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] } },
      policy: { denyRead: ["secrets", "~/.adripi-fixture-only", "secrets/**/key"], allowRead: ["secrets/public"],
        allowWrite: [root], denyWrite: ["blocked"],
        mandatoryDenyRead: [join(agentDir, "auth.json")], mandatoryDenyWrite: [agentDir] } },
  }).payload;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("full current-v2 child policy decoder (not authority)", () => {
  it("accepts the actual producer, independently freezes it and retains every ceiling", () => {
    const input = clone();
    const decoded = decodeChildPolicy(input, cwd);
    expect(decoded).toEqual(payload);
    expect(Object.isFrozen(decoded.network.unixSocketCeiling.roots)).toBe(true);
    input.command.allowHost = true;
    expect(decoded.command.allowHost).toBe(false);
    expect(() => (decoded.read.deny as string[]).push("/other")).toThrow();
  });

  it("expands relative and tilde paths at the parent and preserves glob prefixes", () => {
    expect(payload.read.deny).toEqual([join(root, "secrets"), join(homedir(), ".adripi-fixture-only"), join(root, "secrets/**/key")]);
    expect(payload.read.allow).toEqual([join(root, "secrets/public")]);
    expect(payload.write.deny).toEqual([join(root, "blocked")]);
    expect(payload.anchor.paths).toContainEqual({ spelled: join(root, "secrets"), canonical: join(realpathSync(root), "secrets") });
    expect(decodeChildPolicy(payload, cwd).read.deny).not.toContain(join(cwd, "secrets"));
  });

  for (const [label, mutate] of [
    ["old version", (p: any) => { p.version = 1; }],
    ["unknown version", (p: any) => { p.version = 3; }],
    ["wrong kind", (p: any) => { p.kind = "sandbox-config"; }],
    ["early skeletal-v2 payload", (p: any) => { delete p.environment; }],
    ["extra root flag", (p: any) => { p.enabled = false; }],
    ["missing path pins", (p: any) => { p.anchor.paths = []; }],
    ["missing anchor cwd", (p: any) => { delete p.anchor.cwd; }],
    ["extra anchor config", (p: any) => { p.anchor.allowWrite = ["/"]; }],
    ["duplicate anchor", (p: any) => { p.anchor.paths.push(p.anchor.paths[0]); }],
    ["relative anchor", (p: any) => { p.anchor.paths[0].spelled = "."; }],
    ["relative canonical anchor", (p: any) => { p.anchor.paths[0].canonical = "project"; }],
    ["unknown anchor field", (p: any) => { p.anchor.paths[0].trusted = true; }],
    ["foreign workspace", (p: any) => { p.workspace.spelled = root; }],
    ["wrong canonical workspace", (p: any) => { p.workspace.canonical = root; }],
    ["glob workspace", (p: any) => { p.workspace.spelled += "*"; }],
    ["workspace trust flag", (p: any) => { p.workspace.projectTrusted = true; }],
    ["read policy switch", (p: any) => { p.read.policy = "allowlist"; }],
    ["write policy switch", (p: any) => { p.write.policy = "deny-based"; }],
    ["relative deny", (p: any) => { p.read.deny = ["secrets"]; }],
    ["tilde deny", (p: any) => { p.read.deny = ["~/.adripi-fixture-only"]; }],
    ["relative allow", (p: any) => { p.read.allow = ["secrets/public"]; }],
    ["duplicate rule", (p: any) => { p.read.deny.push(p.read.deny[0]); }],
    ["non-string rule", (p: any) => { p.write.deny = [false]; }],
    ["missing mandatory write", (p: any) => { delete p.write.mandatoryDeny; }],
    ["missing workspace hold", (p: any) => { p.write.allow = []; }],
    ["glob write root", (p: any) => { p.write.allow.push(join(root, "*")); }],
    ["unanchored read allow", (p: any) => { p.read.allow.push(join(root, "unprepared")); }],
    ["unanchored mandatory deny", (p: any) => { p.read.mandatoryDeny.push(join(root, "unprepared")); }],
    ["network policy switch", (p: any) => { p.network.policy = "local-review"; }],
    ["unknown network restriction", (p: any) => { p.network.filterRequest = "ignored"; }],
    ["non-string network deny", (p: any) => { p.network.deniedDomains = [7]; }],
    ["non-boolean strict network", (p: any) => { p.network.strictAllowlist = "false"; }],
    ["non-boolean local bind", (p: any) => { p.network.allowLocalBinding = 0; }],
    ["missing Unix ceiling", (p: any) => { delete p.network.unixSocketCeiling; }],
    ["unknown Unix field", (p: any) => { p.network.unixSocketCeiling.allowAll = true; }],
    ["non-boolean Unix ceiling", (p: any) => { p.network.unixSocketCeiling.all = 1; }],
    ["glob Unix root", (p: any) => { p.network.unixSocketCeiling.roots = [join(root, "*")]; }],
    ["unanchored Unix root", (p: any) => { p.network.unixSocketCeiling.roots = [join(root, "unprepared")]; }],
    ["environment values", (p: any) => { p.environment.deny = ["NAME=value"]; }],
    ["unknown environment injection", (p: any) => { p.environment.inject = {}; }],
    ["empty environment name", (p: any) => { p.environment.deny = [""]; }],
    ["non-boolean PTY", (p: any) => { p.isolation.allowPty = "false"; }],
    ["unknown isolation relaxation", (p: any) => { p.isolation.enableWeakerNestedSandbox = true; }],
    ["non-integer depth", (p: any) => { p.isolation.mandatoryDenySearchDepth = 1.5; }],
    ["zero depth", (p: any) => { p.isolation.mandatoryDenySearchDepth = 0; }],
    ["excess depth", (p: any) => { p.isolation.mandatoryDenySearchDepth = 11; }],
    ["command policy switch", (p: any) => { p.command.policy = "local-human"; }],
    ["non-boolean host ceiling", (p: any) => { p.command.allowHost = 1; }],
    ["unknown standing grant", (p: any) => { p.command.standing = ["*"]; }],
    ["NUL", (p: any) => { p.read.deny = ["/bad\0path"]; }],
    ["oversized string", (p: any) => { p.network.allowedDomains = ["x".repeat(8193)]; }],
    ["oversized array", (p: any) => { p.network.allowedDomains = Array.from({ length: 257 }, (_, i) => `${i}.invalid`); }],
    ["oversized total payload", (p: any) => { p.network.allowedDomains = Array.from({ length: 50 }, (_, i) => `${i}${"x".repeat(700)}`); }],
  ] as Array<[string, (p: any) => void]>) {
    it(`refuses ${label} without coercion or truncation`, () => {
      const input = clone(); mutate(input);
      expect(() => decodeChildPolicy(input, cwd)).toThrow();
    });
  }

  it("allows normal materialization without reinterpreting a pinned path", () => {
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "example"), "synthetic");
    expect(decodeChildPolicy(payload, cwd)).toEqual(payload);
  });

  it("refuses drift of an extra prepared alias, not just fields in the schema", () => {
    const first = join(root, "first"); const second = join(root, "second"); const alias = join(root, "alias");
    mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
    const input = clone(); input.anchor.paths.push({ spelled: alias, canonical: realpathSync(first) });
    expect(decodeChildPolicy(input, cwd)).toEqual(input);
    unlinkSync(alias); symlinkSync(second, alias);
    expect(() => decodeChildPolicy(input, cwd)).toThrow(/retargeted/);
  });

  it("does not accept a policy snapshot as a foreign-cwd lease", () => {
    expect(() => decodeChildPolicy(payload, root)).toThrow(/consumer cwd/);
  });
});
