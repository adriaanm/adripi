import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashText } from "./state.ts";
import { parseSandboxRule, validateSandboxRules } from "./sandbox/rules.ts";
import type { SandboxExceptionRules } from "./sandbox/types.ts";

/**
 * Per-project Guardian policy: `<workspace>/.pi/guardian.json`. It exists so a
 * project can carry standing sandbox permissions — "this project may push to its
 * own repo, using the host's gh credentials" — without widening the global
 * profile or asking the human every time.
 *
 * That file sits in the workspace, so it must never be self-granted by an agent.
 * Two things protect it: `pi-sbx` makes `<workspace>/.pi` mandatory deny-write,
 * and Guardian applies the file only when its **content hash** has been approved
 * by a human in a UI session. The hash is recorded in the agent dir, so a subagent
 * (which has no UI) applies the policy only when the parent already approved this
 * exact content; an edited file needs a fresh approval and is otherwise ignored.
 */
export const PROJECT_POLICY_DIR = ".pi";
export const PROJECT_POLICY_FILE = "guardian.json";
const TRUST_FILE = "guardian-project-trust.json";

export interface ProjectPolicy {
  /** Absolute path of the project policy file. */
  path: string;
  /** Hash of the exact content the human approved. */
  hash: string;
  sandboxExceptions: SandboxExceptionRules;
}

export type ProjectPolicyRead =
  | { kind: "none" }
  | { kind: "ok"; policy: ProjectPolicy }
  | { kind: "invalid"; path: string; error: string };

/**
 * The bytes a human approved for this project, which every save is bound to:
 * `hash` is the approved content hash, or `null` when the human approved
 * *creating* the policy file — no policy existed at that moment.
 */
export interface ProjectPolicySnapshot {
  /** Absolute policy path the approval was for. */
  path: string;
  hash: string | null;
}

export interface PersistProjectRuleOptions {
  /** Agent dir holding recorded approvals (`guardian-project-trust.json`). */
  agentDir: string;
  /** Snapshot the human approval was bound to; see `projectPolicySnapshot`. */
  approved: ProjectPolicySnapshot;
}

export type PersistProjectRuleResult =
  | {
      ok: true;
      path: string;
      /** Hash of the bytes now on disk; the only hash the caller may record as trusted. */
      hash: string;
      /** `false` when the rule was already present and nothing was written. */
      added: boolean;
      /** The rules held by exactly those bytes, so the caller never re-reads the file. */
      sandboxExceptions: SandboxExceptionRules;
    }
  | { ok: false; reason: string };

export function projectPolicyPath(cwd: string): string {
  return join(cwd, PROJECT_POLICY_DIR, PROJECT_POLICY_FILE);
}

export function trustFilePath(agentDir: string): string {
  return join(agentDir, TRUST_FILE);
}

/** Project policies keyed by absolute path, each pinned to the approved hash. */
export function readProjectTrust(agentDir: string): Record<string, string> {
  const path = trustFilePath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function recordProjectTrust(agentDir: string, path: string, hash: string): void {
  const trust = { ...readProjectTrust(agentDir), [path]: hash };
  mkdirSync(agentDir, { recursive: true });
  writeFileAtomic(trustFilePath(agentDir), `${JSON.stringify(trust, null, 2)}\n`);
}

export function isProjectPolicyTrusted(agentDir: string, path: string, hash: string): boolean {
  return readProjectTrust(agentDir)[path] === hash;
}

/**
 * Snapshot for a save: the exact path and content hash a human approved, or
 * `{ hash: null }` when they approved creating the file where none exists yet.
 * An unreadable policy has no approvable snapshot (`undefined`).
 */
export function projectPolicySnapshot(cwd: string, read: ProjectPolicyRead): ProjectPolicySnapshot | undefined {
  if (read.kind === "none") return { path: projectPolicyPath(cwd), hash: null };
  if (read.kind === "ok") return { path: read.policy.path, hash: read.policy.hash };
  return undefined;
}

/**
 * Read and validate the project policy. Only `sandboxExceptions` is honoured:
 * a project may add standing exception rules, never change the reviewer, the
 * permission system, or the global rules.
 */
export function readProjectPolicy(cwd: string): ProjectPolicyRead {
  const file = readPolicyFile(cwd);
  if (file.kind === "absent") return { kind: "none" };
  if (file.kind === "invalid") return { kind: "invalid", path: file.path, error: file.error };
  const parsed = parseProjectPolicy(file.text);
  if ("error" in parsed) return { kind: "invalid", path: file.path, error: parsed.error };
  return { kind: "ok", policy: { path: file.path, hash: file.hash, sandboxExceptions: parsed.sandboxExceptions } };
}

/**
 * Append one human-approved standing rule to the project policy, creating the
 * file when the approval covered a project without one, and report the hash of
 * exactly the bytes written with the rules they hold: that hash is the only thing
 * the caller may record as trusted, and those rules are the only ones it may
 * apply. The caller must not read the file again to find out what it now says,
 * because a concurrent writer could have replaced it.
 *
 * `options.approved` is the snapshot the human approved. Nothing already on disk
 * is trusted by this save: appending to unapproved bytes would mean that
 * approving "save this one rule" also activates whatever else the file contains.
 * The recorded approval for the project (`guardian-project-trust.json`) decides
 * which bytes may be extended, and the supplied snapshot must still describe
 * them — so a file that changed after the prompt, a policy that appeared after
 * its absence was approved, a stale snapshot and an approval for another path
 * all fail with a reason the caller can show instead of writing.
 *
 * Read, parse and hash use one read of the file; the write is an atomic replace;
 * the function is synchronous, so no other save in this process can interleave
 * between the snapshot comparison and the rename. Two processes saving at the
 * same instant are still last-writer-wins — there is no file lock.
 */
export function persistProjectRule(
  cwd: string,
  rule: string,
  options: PersistProjectRuleOptions,
): PersistProjectRuleResult {
  const { agentDir, approved } = options;
  let text: string;
  try {
    text = parseSandboxRule(rule).text;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const path = projectPolicyPath(cwd);
  if (approved.path !== path) {
    return {
      ok: false,
      reason: `the standing rule was approved for ${approved.path}, not ${path}; approve this project's policy again`,
    };
  }
  const file = readPolicyFile(cwd);
  if (file.kind === "invalid") return { ok: false, reason: `${file.path}: ${file.error}` };

  let rules: SandboxExceptionRules;
  if (file.kind === "absent") {
    if (approved.hash !== null) {
      return {
        ok: false,
        reason: `${file.path} was approved with content ${shortHash(approved.hash)} but no longer exists; review the project policy again before saving a standing rule`,
      };
    }
    rules = { allow: [text], defer: [], deny: [] };
  } else {
    // F5: the recorded approval, not whatever is on disk now, decides which bytes
    // this save is allowed to build on. Bytes nobody approved cannot be extended
    // — that would make "save this one rule" approve every entry already there.
    const trustedHash = readProjectTrust(agentDir)[file.path];
    if (trustedHash === undefined) {
      return {
        ok: false,
        reason: `${file.path} is not an approved project policy, so a new rule cannot be added to it without trusting its existing entries too; review that file and approve it (or add the rule by hand)`,
      };
    }
    if (trustedHash !== file.hash) {
      return {
        ok: false,
        reason: `${file.path} changed after it was approved (approved ${shortHash(trustedHash)}, found ${shortHash(file.hash)}); review the new content before saving a standing rule`,
      };
    }
    if (approved.hash === null) {
      return {
        ok: false,
        reason: `the approval covers creating ${file.path}, but it now holds approved content ${shortHash(file.hash)}; review and approve that policy before saving a standing rule`,
      };
    }
    if (approved.hash !== file.hash) {
      return {
        ok: false,
        reason: `the approval supplied is for ${shortHash(approved.hash)}, but ${file.path} holds approved content ${shortHash(file.hash)}; review and approve that policy before saving a standing rule`,
      };
    }
    const parsed = parseProjectPolicy(file.text);
    if ("error" in parsed) return { ok: false, reason: `${file.path}: ${parsed.error}` };
    const existing = parsed.sandboxExceptions;
    if (existing.allow.includes(text)) {
      // Already covered by the approved bytes: write nothing, so the caller can
      // only keep trusting the hash it already had.
      return { ok: true, path: file.path, hash: file.hash, added: false, sandboxExceptions: existing };
    }
    rules = { ...existing, allow: dedupe([...existing.allow, text]) };
  }

  const next = serializePolicy(rules);
  try {
    writePolicyFile(cwd, next);
  } catch (error) {
    return { ok: false, reason: `could not write ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, path, hash: hashText(next), added: true, sandboxExceptions: rules };
}

type PolicyFileRead =
  | { kind: "absent"; path: string }
  | { kind: "bytes"; path: string; text: string; hash: string }
  | { kind: "invalid"; path: string; error: string };

/**
 * One read for parse and hash: the returned hash always describes the exact bytes
 * that were or will be validated, so no other writer can slip content in between.
 */
function readPolicyFile(cwd: string): PolicyFileRead {
  const path = projectPolicyPath(cwd);
  // The `.pi` directory is inspected whenever it exists, so a symlinked or
  // escaping directory is refused even before a policy file appears inside it.
  if (!linkExists(dirname(path))) return { kind: "absent", path };
  const unsafe = unsafePolicyPathReason(cwd, path);
  if (unsafe) return { kind: "invalid", path, error: unsafe };
  if (!linkExists(path)) return { kind: "absent", path };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "invalid", path, error: error instanceof Error ? error.message : String(error) };
  }
  return { kind: "bytes", path, text, hash: hashText(text) };
}

/**
 * Refuse a policy path Guardian must not read or write with host authority: a
 * symlinked `.pi` or policy file, a non-directory `.pi`, or a directory that
 * resolves outside the project. Returns the reason, or `undefined` when safe.
 */
function unsafePolicyPathReason(cwd: string, path: string): string | undefined {
  try {
    const root = realpathSync.native(resolve(cwd));
    const dir = dirname(path);
    if (linkExists(dir)) {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink()) return `${dir} must not be a symlink`;
      if (!stat.isDirectory()) return `${dir} must be a directory`;
      const realDir = realpathSync.native(dir);
      if (!isWithin(root, realDir)) return `${dir} resolves outside the project root ${root}`;
    }
    if (linkExists(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return `${path} must not be a symlink`;
      if (!stat.isFile()) return `${path} must be a regular file`;
    }
    return undefined;
  } catch (error) {
    return `cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** `existsSync` follows symlinks; a dangling symlink must still count as present. */
function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseProjectPolicy(text: string): { sandboxExceptions: SandboxExceptionRules } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "must contain a JSON object" };
  }
  const file = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(file).filter((key) => key !== "sandboxExceptions");
  if (unknownKeys.length > 0) {
    return { error: `unsupported keys: ${unknownKeys.join(", ")} (only sandboxExceptions)` };
  }
  const configured = file.sandboxExceptions;
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) {
    return { error: "sandboxExceptions must be an object" };
  }
  const rules = (configured ?? {}) as { allow?: unknown; defer?: unknown; deny?: unknown };
  const unsupported = Object.keys(rules).filter((key) => key !== "allow" && key !== "defer" && key !== "deny");
  if (unsupported.length > 0) {
    return { error: `unsupported sandboxExceptions keys: ${unsupported.join(", ")}` };
  }
  try {
    return {
      sandboxExceptions: {
        allow: validateSandboxRules(rules.allow, "sandboxExceptions.allow"),
        defer: validateSandboxRules(rules.defer, "sandboxExceptions.defer"),
        deny: validateSandboxRules(rules.deny, "sandboxExceptions.deny"),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Preserve order, drop repeats: re-saving a rule must not duplicate its entry. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Serialize without empty `defer`/`deny` lists, so a save only ever adds its rule. */
function serializePolicy(rules: SandboxExceptionRules): string {
  const sandboxExceptions = {
    allow: rules.allow,
    ...(rules.defer.length > 0 ? { defer: rules.defer } : {}),
    ...(rules.deny.length > 0 ? { deny: rules.deny } : {}),
  };
  return `${JSON.stringify({ sandboxExceptions }, null, 2)}\n`;
}

function writePolicyFile(cwd: string, text: string): void {
  const path = projectPolicyPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  // `mkdirSync` accepts an existing symlink to a directory, so re-check after
  // creating it: the write has to land in a real directory inside the project.
  const unsafe = unsafePolicyPathReason(cwd, path);
  if (unsafe) throw new Error(unsafe);
  writeFileAtomic(path, text);
}

let tempSequence = 0;

/**
 * Replace a file atomically: a sibling temp file created exclusively with `0600`,
 * flushed, then renamed over the target, so a partial write is never read back as
 * policy (or as an approval) and the target always holds one complete version.
 */
function writeFileAtomic(path: string, text: string): void {
  const dir = dirname(path);
  // The sequence keeps two saves in the same millisecond (a policy save and the
  // trust record right after it) off the same exclusive-create temp name.
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${++tempSequence}.tmp`);
  let handle: number | undefined;
  try {
    handle = openSync(temp, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // the handle may already be closed
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // the temp file may not exist yet
    }
    throw error;
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
