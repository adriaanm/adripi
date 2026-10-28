import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { minimatch } from "minimatch";

export interface FilePolicy {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  mandatoryDenyWrite: string[];
}

export function expandPolicyPath(value: string, cwd: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith(`~${sep}`) ? resolve(homedir(), value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

export function resolveTarget(value: string, cwd: string): string {
  const stripped = value.replace(/^@/, "");
  const expanded = stripped === "~" ? homedir() : stripped.startsWith(`~${sep}`) ? resolve(homedir(), stripped.slice(2)) : stripped;
  return resolve(cwd, expanded);
}

/** Resolve exactly the path Pi's read tool will try to open. */
export function resolveReadTarget(value: string, cwd: string): string {
  const resolved = resolveTarget(value, cwd);
  if (existsSync(resolved)) return safeRealpath(resolved);
  const nfd = resolved.normalize("NFD");
  const candidates = [
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  const existing = candidates.find((candidate) => candidate !== resolved && existsSync(candidate));
  return existing ? safeRealpath(existing) : canonicalizeTarget(resolved, cwd);
}

/**
 * `existsSync` can succeed while `realpath` is denied: the sandbox filters
 * `realpath` itself, so a *protected* path (a credential file, say) throws EPERM
 * here. Policy evaluation must not throw — fall back to the resolved path, which
 * is what the deny patterns are written against anyway.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function canonicalizeTarget(value: string, cwd: string): string {
  const absolute = resolveTarget(value, cwd);
  if (existsSync(absolute)) return safeRealpath(absolute);
  const suffix: string[] = [];
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
  }
  const canonicalAncestor = existsSync(ancestor) ? safeRealpath(ancestor) : ancestor;
  return resolve(canonicalAncestor, ...suffix);
}

export function isWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalizePattern(pattern: string, cwd: string): string {
  const index = pattern.search(/[*?[]/);
  if (index === -1) return canonicalizeTarget(pattern, cwd);
  const prefix = pattern.slice(0, index).replace(/[\\/]$/, "");
  if (!prefix) return pattern;
  return `${canonicalizeTarget(prefix, cwd)}${pattern.slice(prefix.length)}`;
}

function patternMatches(path: string, rawPattern: string, cwd: string): boolean {
  const expanded = expandPolicyPath(rawPattern, cwd);
  const patterns = new Set([expanded, canonicalizePattern(expanded, cwd)]);
  const normalizedPath = path.split(sep).join("/");
  return [...patterns].some((pattern) => {
    const normalizedPattern = pattern.split(sep).join("/");
    if (/[*?[]/.test(normalizedPattern)) {
      return minimatch(normalizedPath, normalizedPattern, { dot: true, nocase: false, nonegate: true, nocomment: true }) ||
        minimatch(normalizedPath, `${normalizedPattern.replace(/\/$/, "")}/**`, { dot: true, nocase: false, nonegate: true, nocomment: true });
    }
    return isWithin(path, pattern);
  });
}

function specificity(pattern: string): number {
  return pattern.replace(/[*?[]/g, "").length;
}

export function canRead(path: string, cwd: string, policy: FilePolicy): boolean {
  const denied = policy.denyRead.filter((p) => patternMatches(path, p, cwd)).sort((a, b) => specificity(b) - specificity(a))[0];
  const allowed = policy.allowRead.filter((p) => patternMatches(path, p, cwd)).sort((a, b) => specificity(b) - specificity(a))[0];
  if (!denied) return true;
  return Boolean(allowed && specificity(allowed) > specificity(denied));
}

export function canWrite(path: string, cwd: string, policy: FilePolicy): boolean {
  if (policy.mandatoryDenyWrite.some((p) => patternMatches(path, p, cwd))) return false;
  if (!policy.allowWrite.some((p) => patternMatches(path, p, cwd))) return false;
  return !policy.denyWrite.some((p) => patternMatches(path, p, cwd));
}

function staticPrefix(pattern: string, cwd: string): string {
  const expanded = canonicalizePattern(expandPolicyPath(pattern, cwd), cwd);
  const index = expanded.search(/[*?[]/);
  return index === -1 ? expanded : expanded.slice(0, index).replace(/[\\/]$/, "");
}

export function canTraverse(root: string, cwd: string, policy: FilePolicy): boolean {
  const canonicalRoot = canonicalizeTarget(root, cwd);
  if (!canRead(canonicalRoot, cwd, policy)) return false;
  return !policy.denyRead.some((pattern) => {
    const deniedRoot = staticPrefix(pattern, cwd);
    if (!deniedRoot || !isWithin(deniedRoot, canonicalRoot)) return false;
    return !policy.allowRead.some((allow) => isWithin(deniedRoot, staticPrefix(allow, cwd)) && specificity(allow) > specificity(pattern));
  });
}

export function createFilePolicy(config: {
  filesystem: { denyRead: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite: string[] };
  credentialFiles?: Array<{ path: string }>;
  mandatoryDenyWrite: string[];
}): FilePolicy {
  return {
    // Pi file tools cannot present masked credential files, so both deny and
    // mask entries are unreadable outside the OS sandbox.
    denyRead: [...new Set([...config.filesystem.denyRead, ...(config.credentialFiles ?? []).map((entry) => entry.path)])],
    allowRead: config.filesystem.allowRead ?? [],
    allowWrite: config.filesystem.allowWrite,
    denyWrite: config.filesystem.denyWrite,
    mandatoryDenyWrite: config.mandatoryDenyWrite,
  };
}
