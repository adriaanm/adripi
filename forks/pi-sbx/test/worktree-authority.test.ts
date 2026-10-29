import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { registerFileGate } from "../src/file-gate.ts";
import { canonicalizeTarget, canWrite, createFilePolicy } from "../src/path-policy.ts";

// Real local Git + registered native gate/core-tool fixture. This is NOT a Pi
// child launch, SRT enforcement test, authenticated Git test or approval bridge.
it("provisions an external fixture worktree, gates edits and integrates cleanly", async () => {
  const root = mkdtempSync(join(process.env.PI_SANDBOX_SCRATCH ?? tmpdir(), "pi-sbx-git-flow-"));
  const repo = join(root, "parent");
  const tree = join(root, "external-child");
  const sibling = join(root, "sibling");
  const agentDir = join(root, "agent");
  mkdirSync(repo); mkdirSync(sibling); mkdirSync(agentDir);
  const sentinel = join(sibling, "sentinel.txt");
  writeFileSync(sentinel, "unchanged\n");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Authority Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let complete = false;
  try {
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "note.txt"), "seed\n");
    git(repo, "add", "note.txt"); git(repo, "commit", "-m", "seed fixture");
    git(repo, "worktree", "add", "-b", "child", tree);
    const config = loadConfig({ cwd: tree, agentDir, configDirName: ".pi", allowProjectConfig: false,
      globalConfig: { agentDirWriteProjects: [repo], filesystem: { allowWrite: ["."] } } });
    const policy = createFilePolicy({ filesystem: config.runtime.filesystem,
      mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
    expect(canWrite(join(tree, "note.txt"), tree, policy)).toBe(true);
    expect(canWrite(join(repo, "note.txt"), tree, policy)).toBe(false);
    expect(canWrite(join(agentDir, "settings.json"), tree, policy)).toBe(false);
    expect(canWrite(canonicalizeTarget(join(repo, ".git", "objects", "fixture"), tree), tree, policy)).toBe(true);
    expect(canWrite(canonicalizeTarget(join(repo, ".git", "config"), tree), tree, policy)).toBe(false);
    let gate!: (event: unknown, ctx: ExtensionContext) => Promise<{ block: true; reason: string } | undefined>;
    registerFileGate({ on: (_name: string, handler: typeof gate) => { gate = handler; } } as unknown as ExtensionAPI, {
      getPolicy: () => ({ policy, enabled: true }),
      getHuman: () => ({ ask: async () => { throw new Error("No approval channel is installed in this fixture"); } }),
    });
    const ctx = { cwd: tree } as ExtensionContext;
    const scratch = join(tree, "scratch-probe");
    writeFileSync(scratch, "preflight\n");
    expect(readFileSync(scratch, "utf8")).toBe("preflight\n");
    rmSync(scratch);
    symlinkSync(sibling, join(tree, "sibling-link"));
    for (const path of [sentinel, join(tree, "sibling-link", "sentinel.txt"), join(tree, ".pi", "guardian.json")]) {
      expect(await gate({ toolName: "write", input: { path, content: "must not run" } }, ctx)).toMatchObject({ block: true });
    }
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
    rmSync(join(tree, "sibling-link"));
    const input = { path: "note.txt", content: "child edit\n" };
    expect(await gate({ toolName: "write", input }, ctx)).toBeUndefined();
    await createWriteToolDefinition(tree).execute("fixture-write", input, undefined, undefined, ctx);
    git(tree, "add", "note.txt"); git(tree, "commit", "-m", "child fixture edit");
    expect(git(repo, "diff", "main...child")).toContain("child edit");
    git(repo, "merge", "--ff-only", "child");
    expect(readFileSync(join(repo, "note.txt"), "utf8")).toBe("child edit\n");
    expect(git(tree, "status", "--porcelain")).toBe("");
    git(repo, "worktree", "remove", tree); // no --force: dirty work is preserved
    git(repo, "branch", "-d", "child");
    expect(existsSync(tree)).toBe(false);
    complete = true;
  } finally {
    if (complete) rmSync(root, { recursive: true, force: true });
    else console.error(`Preserved failed Git/worktree fixture: ${root}`);
  }
});
