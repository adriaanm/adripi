import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/config.ts";
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
import { canRead } from "../src/path-policy.ts";

describe("config and hardening", () => {
  it("merges trusted project config and appends mandatory rules", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-config-"));
    const agent = join(root, "agent");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["global.test"], deniedDomains: [] } }));
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({ network: { allowedDomains: ["project.test"] }, excludedCommands: ["docker:*"] }));

    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: true });
    // The global file owns its policy (it replaces the built-in defaults), but
    // the trusted project layer adds to it instead of replacing it.
    expect(config.runtime.network.allowedDomains).toEqual(["global.test", "project.test"]);
    expect(config.excludedCommands).toEqual(["docker:*"]);
    // The agent dir is no longer read-denied wholesale; only the sensitive
    // files are, so skills and installed packages stay readable.
    expect(config.runtime.filesystem.denyRead).not.toContain(agent);
    for (const sensitive of ["auth.json", "models.json", "guardian.json", "guardian-sessions"]) {
      expect(config.runtime.filesystem.denyRead).toContain(join(agent, sensitive));
    }
    expect(config.runtime.filesystem.denyRead).toContain(join(agent, "extensions", "sandbox.json"));
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

describe("session layer stacking", () => {
  const setup = (global: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-session-"));
    const agent = join(root, "agent");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify(global));
    return { root, agent };
  };

  it("adds session grants to the inherited allowlists instead of replacing them", async () => {
    const { withSessionException } = await import("../src/broker.ts");
    const { root, agent } = setup({
      network: { allowedDomains: ["npmjs.org", "*.npmjs.org"] },
      filesystem: { allowRead: ["/data"], allowWrite: ["."] },
    });
    const sessionConfig = withSessionException(
      withSessionException(withSessionException({}, "network", "repo.maven.apache.org:443"), "read", "/usr/share/x"),
      "write",
      "/home/u/.gradle",
    );
    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false, sessionConfig: sessionConfig as unknown as JsonObject });

    for (const host of ["npmjs.org", "*.npmjs.org", "repo.maven.apache.org:443"]) {
      expect(config.runtime.network.allowedDomains).toContain(host);
    }
    expect(config.runtime.filesystem.allowRead).toContain("/data");
    expect(config.runtime.filesystem.allowRead).toContain("/usr/share/x");
    expect(config.runtime.filesystem.allowWrite).toContain(".");
    expect(config.runtime.filesystem.allowWrite).toContain("/home/u/.gradle");
  });

  it("keeps an any-port network grant loadable (regression: host:* crashed the sandbox)", async () => {
    const { withSessionException } = await import("../src/broker.ts");
    const { root, agent } = setup({ network: { allowedDomains: ["npmjs.org"] } });
    const sessionConfig = withSessionException({}, "network", "registry.example.com:*");
    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false, sessionConfig: sessionConfig as unknown as JsonObject });
    expect(config.runtime.network.allowedDomains).toContain("npmjs.org");
    expect(config.runtime.network.allowedDomains).toContain("registry.example.com");
  });

  it("does not let a session layer clear inherited entries by naming an empty list", async () => {
    const { root, agent } = setup({ network: { allowedDomains: ["npmjs.org"] } });
    const config = loadConfig({
      cwd: root,
      agentDir: agent,
      configDirName: ".pi",
      allowProjectConfig: false,
      sessionConfig: { network: { allowedDomains: [] } } as unknown as JsonObject,
    });
    expect(config.runtime.network.allowedDomains).toContain("npmjs.org");
  });
});

describe("project allow lists", () => {
  it("adds to the global grants without dropping the workspace or the package hosts", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-project-union-"));
    const agent = join(root, "agent");
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({
      network: { allowedDomains: ["npmjs.org"], allowUnixSockets: ["/tmp/global-sock"] },
      filesystem: { allowRead: ["/data"], allowWrite: ["."] },
    }));
    writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({
      network: { allowedDomains: ["127.0.0.1:5555"], allowUnixSockets: ["/tmp/sgo-501", "/private/tmp/sgo-501"], allowLocalBinding: true },
      filesystem: { allowRead: ["/tmp/sgo-501"], allowWrite: ["/tmp/sgo-501"] },
      excludedCommands: ["just ios-device-logs:*"],
    }));

    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: true });
    expect(config.runtime.network.allowedDomains).toContain("npmjs.org");
    expect(config.runtime.network.allowedDomains).toContain("127.0.0.1:5555");
    expect(config.runtime.network.allowUnixSockets).toEqual(["/tmp/global-sock", "/tmp/sgo-501", "/private/tmp/sgo-501"]);
    expect(config.runtime.network.allowLocalBinding).toBe(true);
    expect(config.runtime.filesystem.allowRead).toEqual(["/data", "/tmp/sgo-501"]);
    // The workspace grant must survive a project write grant, or every write
    // inside the repo would need an exception.
    expect(config.runtime.filesystem.allowWrite).toEqual([".", "/tmp/sgo-501"]);
    expect(config.excludedCommands).toEqual(["just ios-device-logs:*"]);
  });
});

describe("agentDirWriteProjects", () => {
  const setup = (projects: unknown, globalExtra: Record<string, unknown> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-agentdir-"));
    const agent = join(root, "agentdir");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({ agentDirWriteProjects: projects, ...globalExtra }));
    return { root, agent };
  };

  it("lifts the agent-dir lock only for a listed project root", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-sbx-proj-"));
    const { root, agent } = setup([project]);
    const config = loadConfig({ cwd: project, agentDir: agent, configDirName: ".pi", allowProjectConfig: false });

    expect(config.hardening.mandatoryDenyWrite).not.toContain(agent);
    expect(config.hardening.denyRead).not.toContain(agent);
    // Writes are allowlist-based: the grant must add an allow root, not just
    // lift the deny, or bash would still get EPERM.
    expect(config.runtime.filesystem.allowWrite).toContain(agent);
    expect(config.runtime.filesystem.denyWrite).not.toContain(agent);
    // Credentials and Guardian's transcripts stay protected, and the project's
    // own policy file stays mandatory deny-write.
    expect(config.hardening.mandatoryDenyWrite).toContain(join(agent, "auth.json"));
    expect(config.hardening.mandatoryDenyWrite).toContain(join(agent, "guardian-sessions"));
    expect(config.hardening.mandatoryDenyWrite).toContain(join(project, ".pi"));

    const outside = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false });
    expect(outside.hardening.mandatoryDenyWrite).toContain(agent);
    expect(outside.runtime.filesystem.allowWrite).not.toContain(agent);
  });

  it("covers subdirectories of a listed root but not a sibling prefix", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-sbx-proj-"));
    const nested = join(project, "forks", "pi-sbx");
    mkdirSync(nested, { recursive: true });
    const { agent } = setup([project]);
    expect(loadConfig({ cwd: nested, agentDir: agent, configDirName: ".pi", allowProjectConfig: false }).hardening.mandatoryDenyWrite).not.toContain(agent);

    // A sibling whose name shares the prefix is a different project.
    const sibling = `${project}-evil`;
    mkdirSync(sibling, { recursive: true });
    const { agent: agent2 } = setup([project]);
    expect(loadConfig({ cwd: sibling, agentDir: agent2, configDirName: ".pi", allowProjectConfig: false }).hardening.mandatoryDenyWrite).toContain(agent2);
  });

  it("ignores the key in a project layer and rejects malformed values", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-sbx-proj-"));
    const { agent } = setup([], {});
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify({ agentDirWriteProjects: [project] }));
    const config = loadConfig({ cwd: project, agentDir: agent, configDirName: ".pi", allowProjectConfig: true });
    expect(config.hardening.mandatoryDenyWrite).toContain(agent);
    expect(config.warnings).toContain("Ignored agentDirWriteProjects outside the global profile");

    const { agent: agent2 } = setup(["relative/path"]);
    const malformed = loadConfig({ cwd: project, agentDir: agent2, configDirName: ".pi", allowProjectConfig: false });
    expect(malformed.hardening.mandatoryDenyWrite).toContain(agent2);
    expect(malformed.warnings.some((warning) => warning.startsWith("Ignored agentDirWriteProjects"))).toBe(true);
  });
});

describe("agent dir read policy", () => {
  const setup = (projects: unknown = []) => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-agentread-"));
    const agent = join(root, "agentdir");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    mkdirSync(join(agent, "sessions", "--proj--"), { recursive: true });
    writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({ agentDirWriteProjects: projects }));
    return { root, agent };
  };
  const reads = (config: ReturnType<typeof loadConfig>, path: string) =>
    canRead(path, "/work/project", {
      denyRead: config.hardening.denyRead,
      allowRead: config.runtime.filesystem.allowRead ?? [],
      allowWrite: config.runtime.filesystem.allowWrite,
      denyWrite: config.runtime.filesystem.denyWrite ?? [],
      mandatoryDenyWrite: config.hardening.mandatoryDenyWrite,
    });

  it("reads skills, packages and settings, but not credentials or config", () => {
    const { root, agent } = setup();
    const config = loadConfig({ cwd: root, agentDir: agent, configDirName: ".pi", allowProjectConfig: false });

    // Normal, useful reads.
    expect(reads(config, join(agent, "npm", "node_modules", "pi-subagents", "skills", "x", "SKILL.md"))).toBe(true);
    expect(reads(config, join(agent, "sessions", "--proj--", "subagent-artifacts", "outputs", "a", "review.md"))).toBe(true);
    expect(reads(config, join(agent, "settings.json"))).toBe(true);
    expect(reads(config, join(agent, "guardian-policy.md"))).toBe(true);
    // Nothing under the sandbox/guardian config or the credential stores.
    expect(reads(config, join(agent, "auth.json"))).toBe(false);
    expect(reads(config, join(agent, "models.json"))).toBe(false);
    expect(reads(config, join(agent, "guardian.json"))).toBe(false);
    expect(reads(config, join(agent, "extensions", "sandbox.json"))).toBe(false);
    expect(reads(config, join(agent, "guardian-sessions", "s.jsonl"))).toBe(false);
  });

  it("lets a maintenance project read its config but still not the secrets", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-sbx-proj-"));
    const { agent } = setup([project]);
    const config = loadConfig({ cwd: project, agentDir: agent, configDirName: ".pi", allowProjectConfig: false });

    expect(reads(config, join(agent, "extensions", "sandbox.json"))).toBe(true);
    expect(reads(config, join(agent, "guardian.json"))).toBe(true);
    expect(reads(config, join(agent, "auth.json"))).toBe(false);
    expect(reads(config, join(agent, "guardian-sessions", "s.jsonl"))).toBe(false);
  });
});
