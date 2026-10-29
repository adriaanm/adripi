import { decideSandboxException } from "./broker.ts";
import type { HumanChannel, HumanRequest } from "./human-channel.ts";
import { canRead, canWrite, matchesPolicyPath, type FilePolicy } from "./path-policy.ts";

/**
 * The one action-bound path decision, shared by command-scoped Bash execution
 * and the native read/write/edit gate.
 *
 * A path grant is bound to the operation that requested it: it is decided
 * against the baseline profile, it never mutates that profile, and it never
 * survives the call. Before any reviewer or human sees the request the action
 * is checked for feasibility — a mandatory policy/credential/audit exclusion or
 * a configured deny-write entry is a final refusal. Non-mandatory read denies
 * may be reopened only when an exact allowRead carve-out is more specific.
 */

export type PathActionSurface = "read" | "write";

export interface PathAction {
  surface: PathActionSurface;
  /** The path the operation actually opens, after symlink resolution. */
  target: string;
  /**
   * Other spellings of the same operation (for a write, the lexical path whose
   * canonical form is `target`) that must also pass mandatory locks.
   */
  aliases?: string[];
  /** Why this action is outside the baseline profile; shown to the reviewer/human. */
  reason: string;
  origin?: "tool" | "trap";
  command?: string;
  violation?: string;
}

export interface PathAuthorizationContext {
  cwd: string;
  /** Baseline policy only: never a profile widened for another call. */
  policy: FilePolicy;
  /** The one serialized human decision adapter shared with every surface. */
  human: Pick<HumanChannel, "ask">;
  /** The actual context signal for this event, not another call's signal. */
  signal?: AbortSignal;
  /** Injected in tests; production asks the published Guardian broker. */
  decide?: typeof decideSandboxException;
}

export type PathAuthorization =
  | { kind: "allow"; granted: boolean }
  | { kind: "deny"; reason: string }
  | { kind: "deferred"; reason: string }
  | { kind: "cancelled"; reason: string };

function candidates(target: string, aliases: readonly string[] | undefined): string[] {
  return [...new Set([target, ...(aliases ?? [])])];
}

/**
 * Mandatory write protection (workspace `.pi`, credentials, audit) applies to
 * the lexical and the resolved spelling and is never grantable.
 */
export function mandatoryWriteBlock(
  target: string,
  aliases: readonly string[] | undefined,
  cwd: string,
  policy: FilePolicy,
): string | undefined {
  return candidates(target, aliases).find((candidate) =>
    policy.mandatoryDenyWrite.some((pattern) => matchesPolicyPath(candidate, pattern, cwd)),
  );
}

export function mandatoryReadBlock(target: string, aliases: readonly string[] | undefined, cwd: string, policy: FilePolicy): string | undefined {
  return candidates(target, aliases).find((candidate) =>
    policy.mandatoryDenyRead.some((pattern) => matchesPolicyPath(candidate, pattern, cwd)),
  );
}

export function pathActionAllowed(action: PathAction, cwd: string, policy: FilePolicy): boolean {
  return action.surface === "read"
    ? canRead(action.target, cwd, policy)
    : canWrite(action.target, cwd, policy);
}

/**
 * Decide whether a one-call grant could work before spending a review or a
 * human question. Credential/`auth.json` reads are never grantable; other read
 * exclusions may accept a strictly more-specific one-call carve-out. A write is
 * grantable only when the sole obstacle is a missing allow root; mandatory and
 * configured deny-write entries win.
 */
export function pathGrantFeasibility(
  action: PathAction,
  cwd: string,
  policy: FilePolicy,
): { ok: true } | { ok: false; reason: string } {
  if (action.surface === "read") {
    const locked = mandatoryReadBlock(action.target, action.aliases, cwd, policy);
    if (locked) return { ok: false, reason: `reading ${locked} is a credential or auth.json exclusion and is never grantable` };
    const widened: FilePolicy = { ...policy, allowRead: [...policy.allowRead, action.target] };
    if (canRead(action.target, cwd, widened)) return { ok: true };
    return { ok: false, reason: `reading ${action.target} cannot be admitted by a more-specific exact read carve-out` };
  }
  const locked = mandatoryWriteBlock(action.target, action.aliases, cwd, policy);
  if (locked) {
    return { ok: false, reason: `writing ${locked} is a mandatory deny-write path and cannot be granted for a single call` };
  }
  const widened: FilePolicy = { ...policy, allowWrite: [...policy.allowWrite, action.target] };
  if (canWrite(action.target, cwd, widened)) return { ok: true };
  return { ok: false, reason: `writing ${action.target} is blocked by a configured deny-write entry or cannot be expressed as an exact allow root` };
}

/**
 * The common review/defer/cancellation/refusal path for one path action.
 *
 * `allow` admits exactly the target the caller named. Nothing is stored: the
 * next call starts from the baseline policy again and asks again.
 */
export async function authorizePathAction(
  action: PathAction,
  context: PathAuthorizationContext,
): Promise<PathAuthorization> {
  if (context.signal?.aborted) return cancelled();
  // Mandatory locks precede baseline allows, including lexical aliases.
  if (action.surface === "read") {
    const locked = mandatoryReadBlock(action.target, action.aliases, context.cwd, context.policy);
    if (locked) return { kind: "deny", reason: `reading ${locked} is a credential or auth.json exclusion and is never grantable` };
  } else {
    const locked = mandatoryWriteBlock(action.target, action.aliases, context.cwd, context.policy);
    if (locked) {
      return { kind: "deny", reason: `writing ${locked} is a mandatory deny-write path and cannot be granted for a single call` };
    }
  }
  if (pathActionAllowed(action, context.cwd, context.policy)) return { kind: "allow", granted: false };
  const feasibility = pathGrantFeasibility(action, context.cwd, context.policy);
  if (!feasibility.ok) return { kind: "deny", reason: feasibility.reason };

  const decide = context.decide ?? decideSandboxException;
  const decision = await decide({
    surface: action.surface,
    target: action.target,
    scope: "once",
    origin: action.origin ?? "tool",
    reason: action.reason,
    command: action.command,
    violation: action.violation,
    cwd: context.cwd,
  });
  if (context.signal?.aborted) return cancelled();
  if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
  if (decision.kind === "allow") return { kind: "allow", granted: true };

  const request: HumanRequest = {
    surface: action.surface,
    target: action.target,
    reason: action.reason,
    onceLabel: action.command ? "Allow for this command"
      : action.surface === "write" ? "Allow this one file change" : "Allow this one file read",
  };
  const human = await context.human.ask(request, context.signal);
  if (context.signal?.aborted) return cancelled();
  if (human.kind === "unavailable") return { kind: "deferred", reason: human.reason };
  if (human.kind === "deny") return { kind: "deny", reason: human.reason };
  return { kind: "allow", granted: true };
}

function cancelled(): PathAuthorization {
  return { kind: "cancelled", reason: "the sandbox approval was cancelled, so the action did not run" };
}
