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

export function buildHardeningPaths(cwd: string, agentDir: string, globalConfigPath: string, projectConfigPath: string): HardeningPaths {
  const denyWrite = [agentDir, globalConfigPath, projectConfigPath, dirname(projectConfigPath)];
  const gitDir = join(cwd, ".git");
  denyWrite.push(join(gitDir, "config"), join(gitDir, "hooks"));

  const worktreeGitDir = detectWorktreeCommonGitDir(cwd);
  if (worktreeGitDir) denyWrite.push(join(worktreeGitDir, "config"), join(worktreeGitDir, "hooks"));

  return {
    denyRead: [agentDir],
    denyWrite,
    mandatoryDenyWrite: [...denyWrite],
    worktreeGitDir,
  };
}

