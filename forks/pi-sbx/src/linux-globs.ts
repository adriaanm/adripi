import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { minimatch } from "minimatch";

const GLOB_CHARS = /[*?[]/;

function hasUnsupportedLinuxGlob(pattern: string): boolean {
  return GLOB_CHARS.test(pattern.replace(/[/\\]\*\*$/, ""));
}

function absolutePattern(pattern: string, cwd: string): string {
  let expanded = pattern;
  if (pattern === "~") expanded = homedir();
  else if (pattern.startsWith(`~${sep}`)) expanded = resolve(homedir(), pattern.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function readDirectory(path: string): Dirent[] {
  try { return readdirSync(path, { withFileTypes: true }); } catch { return []; }
}

function expandExistingMatches(pattern: string, cwd: string): string[] {
  const absolute = absolutePattern(pattern, cwd);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  const matches: string[] = [];

  const walk = (base: string, index: number): void => {
    if (index >= segments.length) {
      matches.push(base);
      return;
    }

    const segment = segments[index]!;
    const isLastSegment = index === segments.length - 1;
    if (segment === "**") {
      walk(base, index + 1);
      for (const entry of readDirectory(base)) {
        const candidate = resolve(base, entry.name);
        if (isLastSegment) matches.push(candidate);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(candidate, index);
      }
      return;
    }

    if (GLOB_CHARS.test(segment)) {
      for (const entry of readDirectory(base)) {
        if (!minimatch(entry.name, segment, { dot: true, nocase: false, nonegate: true, nocomment: true })) continue;
        const candidate = resolve(base, entry.name);
        if (isLastSegment) matches.push(candidate);
        else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(candidate, index + 1);
      }
      return;
    }

    const candidate = resolve(base, segment);
    let stat;
    try { stat = lstatSync(candidate); } catch { return; }
    if (isLastSegment) matches.push(candidate);
    else if (stat.isDirectory() && !stat.isSymbolicLink()) walk(candidate, index + 1);
  };

  walk(root, 0);
  return matches;
}

function expandPatternsToLiterals(patterns: string[], cwd: string): string[] {
  const literals = patterns.flatMap((pattern) => {
    if (!hasUnsupportedLinuxGlob(pattern)) return [pattern];
    return expandExistingMatches(pattern, cwd);
  });
  return [...new Set(literals)];
}

/**
 * Bubblewrap only accepts concrete mount paths. Resolve write globs immediately
 * before each command so files that already exist receive literal bind mounts.
 * A matching path created by that same command is still outside this guarantee.
 */
export function expandLinuxWriteGlobs(
  config: SandboxRuntimeConfig,
  cwd: string,
): Partial<SandboxRuntimeConfig> | undefined {
  const { allowWrite, denyWrite } = config.filesystem;
  if (![...allowWrite, ...denyWrite].some(hasUnsupportedLinuxGlob)) return undefined;
  return {
    filesystem: {
      ...config.filesystem,
      allowWrite: expandPatternsToLiterals(allowWrite, cwd),
      denyWrite: expandPatternsToLiterals(denyWrite, cwd),
    },
  };
}
