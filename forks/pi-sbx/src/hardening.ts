import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface HardeningPaths {
  denyRead: string[];
  denyWrite: string[];
  mandatoryDenyWrite: string[];
  worktreeGitDir?: string;
}

export function detectWorktreeCommonGitDir(cwd: string): string | undefined {
  const dotGit = join(cwd, ".git");
  try {
    const content = readFileSync(dotGit, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return undefined;
    const gitdir = resolve(cwd, match[1].trim());
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const markerIndex = gitdir.lastIndexOf(marker);
    if (markerIndex <= 0) return undefined;
    return gitdir.slice(0, markerIndex + `${sep}.git`.length);
  } catch {
    return undefined;
  }
}

/**
 * The one agent-dir file that must never be read: provider credentials and OAuth
 * tokens. Everything else there is readable — installed packages, skills, session
 * transcripts, settings, the sandbox and reviewer configuration — because the
 * agent legitimately needs them and none of them carries a secret.
 */
export function protectedAgentDirReads(agentDir: string): string[] {
  return [join(agentDir, "auth.json")];
}

/**
 * Files no project may write, not even one granted `agentDirWriteProjects`:
 * credentials, and the reviewer's own audit trail. The sandbox and reviewer
 * configuration is writable only from a granted project (the whole agent dir is
 * otherwise deny-write).
 */
export function protectedAgentDirWrites(agentDir: string): string[] {
  return [join(agentDir, "auth.json"), join(agentDir, "guardian-sessions")];
}

export function buildHardeningPaths(cwd: string, agentDir: string, globalConfigPath: string, projectConfigPath: string): HardeningPaths {
  const denyWrite = [agentDir, globalConfigPath, projectConfigPath, dirname(projectConfigPath)];
  const gitDir = join(cwd, ".git");
  denyWrite.push(join(gitDir, "config"), join(gitDir, "hooks"));

  const worktreeGitDir = detectWorktreeCommonGitDir(cwd);
  if (worktreeGitDir) denyWrite.push(join(worktreeGitDir, "config"), join(worktreeGitDir, "hooks"));

  return {
    denyRead: protectedAgentDirReads(agentDir),
    denyWrite,
    mandatoryDenyWrite: [...denyWrite],
    worktreeGitDir,
  };
}

