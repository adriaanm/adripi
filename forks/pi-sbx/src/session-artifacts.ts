import { join } from "node:path";

/**
 * Subagent artifacts live in the agent dir, under the session directory
 * (`sessions/<encoded-cwd>/subagent-artifacts/…`), which the sandbox otherwise
 * denies wholesale as part of the agent dir. They are outputs this session's own
 * subagents produced, so the agent must be able to read them back; the dirs are
 * added to the effective profile's allowRead at session start and never to the
 * persisted config.
 *
 * Deliberately narrow: only that one directory. The transcript (`*.jsonl`) and
 * the per-session state directories next to it stay unreadable, and nothing here
 * becomes writable.
 */
export function sessionArtifactsDir(sessionDir: string | undefined): string | undefined {
  if (!sessionDir || sessionDir.trim() === "") return undefined;
  return join(sessionDir, "subagent-artifacts");
}

export interface ReadCarrier {
  runtime: { filesystem: { allowRead?: string[] } };
}

/** Add the artifacts directory to the effective runtime read policy (copy, never mutate). */
export function withSessionArtifacts<T extends ReadCarrier>(config: T, dir: string | undefined): T {
  if (!dir) return config;
  const filesystem = config.runtime.filesystem;
  const allowRead = [...new Set([...(filesystem.allowRead ?? []), dir])];
  return { ...config, runtime: { ...config.runtime, filesystem: { ...filesystem, allowRead } } };
}
