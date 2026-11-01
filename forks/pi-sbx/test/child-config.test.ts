import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathGrantFeasibility } from "../src/path-authorizer.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveChildPolicy } from "../src/child-authority.ts";
import { CHILD_BOOTSTRAP_ENV_DENY, childExecutionEnvironment, compileChildConfig } from "../src/child-config.ts";
import { canonicalizeTarget, canRead, canWrite, createFilePolicy } from "../src/path-policy.ts";

let root: string, cwd: string, agentDir: string;
let payload: ReturnType<typeof deriveChildPolicy>["payload"];
const clone = (): any => JSON.parse(JSON.stringify(payload));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbx-child-config-"));
  cwd = join(root, "workspace"); agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  payload = deriveChildPolicy({ agentDir, configDirName: ".pi", identity: { cwd }, baseline: {
    cwd: root, allowUnsandboxedCommands: false, environmentDeny: ["SYNTHETIC_SECRET"],
    runtime: { network: { allowedDomains: ["example.invalid:443"], deniedDomains: ["blocked.invalid"],
      strictAllowlist: true, allowAllUnixSockets: true, allowUnixSockets: [root], allowLocalBinding: true, allowMachLookup: ["*root*"] },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      enableWeakerNestedSandbox: true, enableWeakerNetworkIsolation: true, allowAppleEvents: true, allowPty: true,
      mandatoryDenySearchDepth: 7,
      credentials: { files: [{ path: join(root, "synthetic-credential"), mode: "deny" }], envVars: [{ name: "OTHER_SYNTHETIC", mode: "deny" }] },
    },
    policy: { denyRead: [join(root, "excluded")], allowRead: [join(root, "excluded", "public")], allowWrite: [root], denyWrite: [join(cwd, "blocked")],
      mandatoryDenyRead: [join(agentDir, "auth.json")], mandatoryDenyWrite: [agentDir] },
  } }).payload;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("child runtime compiler (data translation, not readiness/OS proof)", () => {
  it("uses the real producer/schema without reading ambient profiles or running Git discovery", () => {
    writeFileSync(join(agentDir, "extensions/sandbox.json"), "malformed ambient global profile");
    writeFileSync(join(cwd, ".pi/sandbox.json"), "malformed child profile");
    writeFileSync(join(cwd, ".git"), `gitdir: ${join(root, "foreign/.git/worktrees/escape")}\n`);
    const config = compileChildConfig(payload, cwd, agentDir);
    expect(config.enabled).toBe(true); expect(config.failIfUnavailable).toBe(true);
    expect(config.allowUnsandboxedCommands).toBe(false);
    expect(config.layers).toEqual({ defaults: {}, global: {}, project: {}, session: {} });
    expect(config.projectApplied).toBe(false); expect(config.hardening.worktreeGitDir).toBeUndefined();
    expect(config.runtime.filesystem.allowWrite).toEqual(payload.write.allow);
    expect(config.runtime.filesystem.allowWrite).not.toContain(root);
  });

  it("routes all connections parentward and never copies broad static bypass/Unix/loopback/Mach/PTY authority", () => {
    const { runtime } = compileChildConfig(payload, cwd, agentDir);
    expect(runtime.network).toMatchObject({ allowedDomains: [], deniedDomains: ["blocked.invalid"], strictAllowlist: false,
      allowAllUnixSockets: false, allowUnixSockets: [], allowLocalBinding: false, allowMachLookup: [] });
    expect(runtime.allowPty).toBe(false); expect(runtime.allowAppleEvents).toBe(false);
    expect(runtime.enableWeakerNestedSandbox).toBe(false); expect(runtime.enableWeakerNetworkIsolation).toBe(false);
    expect(runtime.git?.safeDirectories).toEqual([]); expect(runtime.filesystem.allowGitConfig).toBe(false);
    expect(runtime.mandatoryDenySearchDepth).toBe(7);
  });

  it("translates all mandatory read locks to SRT credential DENY, never a weaker allowRead or mask", () => {
    const config = compileChildConfig(payload, cwd, agentDir);
    expect(config.runtime.credentials?.files).toEqual(payload.read.mandatoryDeny.map(path => ({ path, mode: "deny" })));
    const policy = createFilePolicy({ filesystem: config.runtime.filesystem, credentialFiles: config.runtime.credentials?.files,
      mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
    expect(canRead(join(agentDir, "auth.json"), cwd, policy)).toBe(false);
    expect(canRead(join(root, "synthetic-credential"), cwd, policy)).toBe(false);
    // Native gate addresses the canonical operation target, not /var's alias.
    expect(canWrite(canonicalizeTarget(join(cwd, "file"), cwd), cwd, policy)).toBe(true);
    expect(canWrite(join(root, "sibling"), cwd, policy)).toBe(false);
    expect(canWrite(join(cwd, ".pi/guardian.json"), cwd, policy)).toBe(false);
    expect(canWrite(join(cwd, "blocked"), cwd, policy)).toBe(false);
  });

  it("also locks the actual SDK agent namespace when it differs from the parent's prepared agent directory", () => {
    const actual = join(root, "different-agent"); mkdirSync(actual);
    const config = compileChildConfig(payload, cwd, actual);
    const policy = createFilePolicy({ filesystem: config.runtime.filesystem, credentialFiles: config.runtime.credentials?.files,
      mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
    for (const agent of [actual, agentDir]) {
      expect(pathGrantFeasibility({ surface: "read", target: join(agent, "auth.json"), reason: "not grantable" }, cwd, policy).ok).toBe(false);
      expect(pathGrantFeasibility({ surface: "write", target: join(agent, "settings.json"), reason: "not grantable" }, cwd, policy).ok).toBe(false);
    }
  });

  it("never admits a write exception against the actual loaded enforcement package", () => {
    const config = compileChildConfig(payload, cwd, agentDir);
    const policy = createFilePolicy({ filesystem: config.runtime.filesystem, credentialFiles: config.runtime.credentials?.files,
      mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
    const ownCode = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    expect(pathGrantFeasibility({ surface: "write", target: ownCode, reason: "not delegated" }, cwd, policy).ok).toBe(false);
  });

  it("refuses a relative actual agent directory rather than rebasing authority", () => {
    expect(() => compileChildConfig(payload, cwd, "relative-agent")).toThrow(/absolute actual agent/);
  });

  it("carries only DENY environment names and removes shell bootstrap inputs before the outer backend", () => {
    const config = compileChildConfig(payload, cwd, agentDir);
    const names = config.environment.deny;
    expect(names).toEqual(expect.arrayContaining(["SYNTHETIC_SECRET", "OTHER_SYNTHETIC", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", ...CHILD_BOOTSTRAP_ENV_DENY]));
    expect(config.runtime.credentials?.envVars).toEqual(names.map(name => ({ name, mode: "deny" })));
    const source = { PATH: "/synthetic/bin", KEEP: "kept", SYNTHETIC_SECRET: "fake", BASH_ENV: "workspace/script", ENV: "workspace/script", ZDOTDIR: "workspace",
      SHELLOPTS: "xtrace", PS4: "workspace/script", "BASH_FUNC_wrapper%%": "() { synthetic; }" };
    expect(childExecutionEnvironment(source, names)).toEqual({ PATH: "/synthetic/bin", KEEP: "kept" });
    expect(source.BASH_ENV).toBe("workspace/script");
    expect(JSON.stringify(config)).not.toContain("workspace/script");
  });

  it("leaves null search depth absent so the shipped SRT default, not a new default, wins", () => {
    const input = clone(); input.isolation.mandatoryDenySearchDepth = null;
    expect(compileChildConfig(input, cwd, agentDir).runtime.mandatoryDenySearchDepth).toBeUndefined();
  });

  for (const name of ["bad-name", "0", "bad name", "unset;payload", "-option"]) {
    it(`refuses unrepresentable deny name ${name} instead of interpolating a shell identifier`, () => {
      const input = clone(); input.environment.deny = [name];
      expect(() => compileChildConfig(input, cwd, agentDir)).toThrow(/variable name/);
    });
  }

  it("preserves the immutable host ceiling without enabling implicit availability fallback", () => {
    const input = clone(); input.command.allowHost = true;
    const result = compileChildConfig(input, cwd, agentDir);
    expect(result.allowUnsandboxedCommands).toBe(true); expect(result.failIfUnavailable).toBe(true);
    expect(input.network.allowedDomains).toEqual(["example.invalid:443"]);
    expect(result.runtime.network.allowedDomains).toEqual([]);
    expect(result.runtime.filesystem.allowWrite).toContain(realpathSync(cwd));
  });

  it("rejects a malformed policy before runtime translation", () => {
    expect(() => compileChildConfig({ version: 2 }, cwd, agentDir)).toThrow(/Invalid child policy/);
    expect(() => compileChildConfig(payload, root, agentDir)).toThrow(/consumer cwd/);
  });
});
