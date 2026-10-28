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
 * What inside the agent directory is actually sensitive: credentials and the
 * sandbox/guardian configuration. Reads are denied only for these; everything
 * else there (installed packages, skills, extension configs, settings) is data
 * the agent may legitimately need — a SKILL.md under `npm/node_modules` is not a
 * credential store. Writes stay denied wholesale; see hardening below.
 */
export function sensitiveAgentDirReads(agentDir: string): string[] {
  return [
    join(agentDir, "auth.json"),                 // provider credentials and OAuth tokens
    join(agentDir, "models.json"),               // provider definitions, often with API keys
    join(agentDir, "guardian.json"),             // reviewer and broker configuration
    join(agentDir, "extensions", "sandbox.json"), // the sandbox profile itself
    join(agentDir, "guardian-sessions"),         // reviewer transcripts
  ];
}

/** The subset a maintenance project (agentDirWriteProjects) may read. */
export function maintainableAgentDirReads(agentDir: string): string[] {
  return [join(agentDir, "guardian.json"), join(agentDir, "extensions", "sandbox.json")];
}

export function buildHardeningPaths(cwd: string, agentDir: string, globalConfigPath: string, projectConfigPath: string): HardeningPaths {
  const denyWrite = [agentDir, globalConfigPath, projectConfigPath, dirname(projectConfigPath)];
  const gitDir = join(cwd, ".git");
  denyWrite.push(join(gitDir, "config"), join(gitDir, "hooks"));

  const worktreeGitDir = detectWorktreeCommonGitDir(cwd);
  if (worktreeGitDir) denyWrite.push(join(worktreeGitDir, "config"), join(worktreeGitDir, "hooks"));

  return {
    denyRead: sensitiveAgentDirReads(agentDir),
    denyWrite,
    mandatoryDenyWrite: [...denyWrite],
    worktreeGitDir,
  };
}

