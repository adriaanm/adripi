import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getArrayLayer,
  getConfigArray,
  getInheritedConfigArray,
  loadConfig,
  mutateConfigArrayValue,
  setExcludedCommand,
  updateGlobalConfig,
  updateProjectConfig,
} from "../src/config.ts";
import { buildHardeningPaths, detectWorktreeCommonGitDir } from "../src/hardening.ts";

describe("config and hardening", () => {
  it("merges trusted project config and appends mandatory rules", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-config-"));
    const agent = join(root, "agent");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["global.test"], deniedDomains: [] } }));
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["project.test"] }, excludedCommands: ["docker:*"] }));

    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: true });
    expect(config.runtime.network.allowedDomains).toEqual(["project.test"]);
    expect(config.excludedCommands).toEqual(["docker:*"]);
    expect(config.runtime.filesystem.denyRead).toContain(agent);
    expect(config.runtime.filesystem.denyWrite).toContain(join(root, ".pi"));
    expect(config.runtime.credentials?.envVars?.some((entry) => entry.name === "ANTHROPIC_API_KEY" && entry.mode === "deny")).toBe(true);
  });

  it("keeps array edits isolated to the selected configuration layer", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-layers-"));
    const agent = join(root, "agent");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["global.test"] } }));
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["project.test"] } }));

    const config = loadConfig({
      cwd: root,
      agentDir: agent,
      configDirName: ".pi",
      allowProjectConfig: true,
      sessionConfig: { network: { allowedDomains: ["session.test"] } },
    });

    expect(getConfigArray(config, "network", "allowedDomains", "global")).toEqual(["global.test"]);
    expect(getConfigArray(config, "network", "allowedDomains", "project")).toEqual(["project.test"]);
    expect(getConfigArray(config, "network", "allowedDomains", "session")).toEqual(["session.test"]);
    expect(getArrayLayer(config, "network", "allowedDomains", "global")).toBe("global");

    const latestGlobal = { network: { allowedDomains: ["concurrent.test"] }, untouched: true };
    const next = mutateConfigArrayValue(
      latestGlobal,
      "network",
      "allowedDomains",
      getInheritedConfigArray(config, "network", "allowedDomains", "global"),
      "added.test",
      true,
    );
    expect(next).toEqual({ network: { allowedDomains: ["concurrent.test", "added.test"] }, untouched: true });
  });

  it("ignores an unapproved project layer", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-untrusted-"));
    const agent = join(root, "agent");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({ enabled: false }));
    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false });
    expect(config.enabled).toBe(true);
    expect(config.warnings.some((warning) => warning.includes("Ignored untrusted"))).toBe(true);
  });

  it("atomically updates project exclusions and rejects a symlinked config directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-write-"));
    const path = join(root, ".pi", "sandbox.json");
    await updateProjectConfig(path, root, (raw) => setExcludedCommand(raw, "docker:*", true));
    expect(JSON.parse(readFileSync(path, "utf8")).excludedCommands).toEqual(["docker:*"]);

    const unsafeRoot = mkdtempSync(join(tmpdir(), "pi-sbx-unsafe-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-config-out-"));
    symlinkSync(outside, join(unsafeRoot, ".pi"));
    writeFileSync(join(outside, "sandbox.json"), JSON.stringify({ enabled: false }));
    expect(() => loadConfig({ cwd: unsafeRoot, agentDir: join(unsafeRoot, "agent"), configDirName: ".pi", allowProjectConfig: true })).toThrow(/symlink|escapes/);
    await expect(updateProjectConfig(join(unsafeRoot, ".pi", "sandbox.json"), unsafeRoot, (raw) => raw)).rejects.toThrow(/symlink|escapes/);
  });

  it("atomically updates global configuration without dropping unrelated fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-global-write-"));
    const path = join(root, "extensions", "sandbox.json");
    mkdirSync(join(root, "extensions"));
    writeFileSync(path, JSON.stringify({ failIfUnavailable: true, network: { allowedDomains: ["old.test"] } }));

    await updateGlobalConfig(path, (raw) => mutateConfigArrayValue(
      raw,
      "network",
      "allowedDomains",
      [],
      "new.test",
      true,
    ));

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      failIfUnavailable: true,
      network: { allowedDomains: ["old.test", "new.test"] },
    });
  });

  it("detects only the worktree common .git directory without protecting ordinary root paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-worktree-"));
    const main = join(root, ".github-project", ".git");
    const worktree = join(root, "worktree");
    mkdirSync(join(main, "worktrees", "feature"), { recursive: true });
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, "worktrees", "feature")}\n`);
    expect(detectWorktreeCommonGitDir(worktree)).toBe(main);

    const hardening = buildHardeningPaths(worktree, join(root, "agent"), join(root, "global.json"), join(worktree, ".pi", "sandbox.json"));
    for (const name of ["HEAD", "objects", "refs", "hooks", "config"]) {
      expect(hardening.denyWrite).not.toContain(join(worktree, name));
    }
  });

  it("fails closed for malformed active configuration files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-invalid-"));
    const agent = join(root, "agent");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), "{ invalid");
    expect(() => loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false })).toThrow(/Could not parse/);

    writeFileSync(join(agent, "extensions", "sandbox.json"), "{}");
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "sandbox.json"), "{ invalid");
    expect(() => loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: true })).toThrow(/Could not parse/);
    expect(() => loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false })).not.toThrow();
  });
});
