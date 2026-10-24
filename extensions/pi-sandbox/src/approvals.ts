import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Project-local permanent approvals for host-IPC command prefixes.
 *
 * This file is separate from `config.json` so the approval prompt can extend
 * the policy without rewriting a user-maintained document. It is policy input:
 * sandboxed processes must not be able to write it (see policy.ts).
 */
export const PROJECT_APPROVALS_PATH = join(
  ".pi",
  "extensions",
  "pi-sandbox",
  "approvals.json",
);

export function projectApprovalsPath(cwd: string): string {
  return join(cwd, PROJECT_APPROVALS_PATH);
}

export function loadProjectApprovals(cwd: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(projectApprovalsPath(cwd), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const list = (parsed as { allowCommandPrefixes?: unknown })
      .allowCommandPrefixes;
    if (!Array.isArray(list)) return [];
    return [
      ...new Set(
        list
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ];
  } catch {
    return [];
  }
}

/** Persist one permanent host-IPC prefix. Returns true when it was new. */
export function addProjectApproval(cwd: string, prefix: string): boolean {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return false;
  const current = loadProjectApprovals(cwd);
  if (current.includes(trimmed)) return false;
  const path = projectApprovalsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ allowCommandPrefixes: [...current, trimmed] }, null, 2) +
      "\n",
    "utf8",
  );
  return true;
}
