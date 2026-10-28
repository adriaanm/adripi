import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashText } from "./state.ts";
import { validateSandboxRules } from "./sandbox/rules.ts";
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
  writeFileSync(trustFilePath(agentDir), `${JSON.stringify(trust, null, 2)}\n`);
}

export function isProjectPolicyTrusted(agentDir: string, path: string, hash: string): boolean {
  return readProjectTrust(agentDir)[path] === hash;
}

/**
 * Read and validate the project policy. Only `sandboxExceptions` is honoured:
 * a project may add standing exception rules, never change the reviewer, the
 * permission system, or the global rules.
 */
export function readProjectPolicy(cwd: string): ProjectPolicyRead {
  const path = projectPolicyPath(cwd);
  if (!existsSync(path)) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { kind: "invalid", path, error: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", path, error: "must contain a JSON object" };
  }
  const file = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(file).filter((key) => key !== "sandboxExceptions");
  if (unknownKeys.length > 0) {
    return { kind: "invalid", path, error: `unsupported keys: ${unknownKeys.join(", ")} (only sandboxExceptions)` };
  }
  const configured = file.sandboxExceptions;
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) {
    return { kind: "invalid", path, error: "sandboxExceptions must be an object" };
  }
  const rules = (configured ?? {}) as { allow?: unknown; defer?: unknown; deny?: unknown };
  const unsupported = Object.keys(rules).filter((key) => key !== "allow" && key !== "defer" && key !== "deny");
  if (unsupported.length > 0) {
    return { kind: "invalid", path, error: `unsupported sandboxExceptions keys: ${unsupported.join(", ")}` };
  }
  try {
    return {
      kind: "ok",
      policy: {
        path,
        hash: hashText(readFileSync(path, "utf8")),
        sandboxExceptions: {
          allow: validateSandboxRules(rules.allow, "sandboxExceptions.allow"),
          defer: validateSandboxRules(rules.defer, "sandboxExceptions.defer"),
          deny: validateSandboxRules(rules.deny, "sandboxExceptions.deny"),
        },
      },
    };
  } catch (error) {
    return { kind: "invalid", path, error: error instanceof Error ? error.message : String(error) };
  }
}
