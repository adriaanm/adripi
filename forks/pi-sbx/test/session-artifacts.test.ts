import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { canRead } from "../src/path-policy.ts";
import { sessionArtifactsDir, withSessionArtifacts } from "../src/session-artifacts.ts";

const sessionDir = "/home/u/.pi/agent/sessions/--home-u-project--";

describe("subagent artifacts", () => {
  it("derives the artifacts directory from the session directory", () => {
    expect(sessionArtifactsDir(sessionDir)).toBe(`${sessionDir}/subagent-artifacts`);
    expect(sessionArtifactsDir(undefined)).toBeUndefined();
    expect(sessionArtifactsDir("")).toBeUndefined();
  });

  it("adds the directory to allowRead without mutating the input", () => {
    const config = { runtime: { filesystem: { allowRead: ["/data"], allowWrite: ["."] } } };
    const next = withSessionArtifacts(config, `${sessionDir}/subagent-artifacts`);
    expect(next.runtime.filesystem.allowRead).toEqual([
      "/data",
      `${sessionDir}/subagent-artifacts`,
    ]);
    expect(withSessionArtifacts(next, `${sessionDir}/subagent-artifacts`).runtime.filesystem.allowRead).toHaveLength(2);
    expect(config.runtime.filesystem.allowRead).toEqual(["/data"]);
    // Creates the list when the profile has none.
    const bare = withSessionArtifacts({ runtime: { filesystem: { allowRead: undefined as string[] | undefined } } }, "/a");
    expect(bare.runtime.filesystem.allowRead).toEqual(["/a"]);
  });

  it("opens exactly the artifacts dir inside a locked agent directory", () => {
    const agentDir = "/home/u/.pi/agent";
    // The sandbox config's own denyRead carries the agent dir (hardening).
    const config = loadConfig({
      cwd: "/home/u/project",
      agentDir,
      configDirName: ".pi",
      allowProjectConfig: false,
      globalConfig: { filesystem: { denyRead: [], allowRead: [], allowWrite: ["."], denyWrite: [] } },
    });
    const policy = (candidate: typeof config) => ({
      denyRead: candidate.runtime.filesystem.denyRead ?? [],
      allowRead: candidate.runtime.filesystem.allowRead ?? [],
      allowWrite: candidate.runtime.filesystem.allowWrite,
      denyWrite: candidate.runtime.filesystem.denyWrite ?? [],
      mandatoryDenyWrite: config.hardening.mandatoryDenyWrite,
    });
    const locked = policy(config);
    const artifact = `${sessionDir}/subagent-artifacts/outputs/2588bad8/.local/tmp/review-fa13ee6.md`;

    expect(canRead(artifact, "/home/u/project", locked)).toBe(false);
    const opened = policy(withSessionArtifacts(config, sessionArtifactsDir(sessionDir)));
    expect(canRead(artifact, "/home/u/project", opened)).toBe(true);
    // The transcript, sibling session state and the rest of the agent dir stay shut.
    expect(canRead(`${sessionDir}/2026-10-28T07-16-43-729Z_01a1815e.jsonl`, "/home/u/project", opened)).toBe(false);
    expect(canRead(`${agentDir}/settings.json`, "/home/u/project", opened)).toBe(false);
    expect(canRead(`${agentDir}/auth.json`, "/home/u/project", opened)).toBe(false);
    // Another project's artifacts are not opened by this session's grant.
    expect(canRead("/home/u/.pi/agent/sessions/--other--/subagent-artifacts/x.md", "/home/u/project", opened)).toBe(false);
  });
});
