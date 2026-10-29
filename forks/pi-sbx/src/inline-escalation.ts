/**
 * Codex-shaped inline escalation, so the model asks and runs in one call.
 *
 * Codex trains models on `exec_command({ cmd, sandbox_permissions, justification,
 * prefix_rule, additional_permissions })`: escalating is a parameter of the call
 * that carries the command, not a separate request followed by a re-run. Reusing
 * those names and semantics means a model's prior experience transfers instead of
 * having to be taught our tool.
 *
 * Two tiers, as in Codex: widen the sandbox for this one command
 * (`with_additional_permissions`, path-scoped) and only fall back to running
 * outside it (`require_escalated`) when that cannot work.
 */

export type ScopedTarget = { surface: "read" | "write"; target: string };

export type InlineEscalationPlan =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "host"; justification: string; prefixRule?: string }
  | { kind: "scoped"; justification: string; targets: ScopedTarget[] };

export interface InlineEscalationParams {
  sandbox_permissions?: "use_default" | "require_escalated" | "with_additional_permissions";
  justification?: string;
  prefix_rule?: string[];
  additional_permissions?: {
    network?: { enabled?: boolean };
    file_system?: { read?: string[]; write?: string[] };
  };
}

/** Prefixes that must never become a standing rule: they run arbitrary code. */
const BANNED_PREFIX_HEADS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "exec", "source",
  "env", "sudo", "doas", "xargs", "find", "nohup", "command", "builtin",
  "python", "python3", "node", "perl", "ruby", "rm", "dd", "mkfs", "kill",
]);

export function planInlineEscalation(params: InlineEscalationParams): InlineEscalationPlan {
  const mode = params.sandbox_permissions;
  const justification = params.justification?.trim();

  if (mode === undefined || mode === "use_default") {
    if (justification) return { kind: "invalid", reason: "justification requires sandbox_permissions" };
    if (params.prefix_rule) return { kind: "invalid", reason: "prefix_rule requires sandbox_permissions: require_escalated" };
    if (params.additional_permissions) {
      return { kind: "invalid", reason: "additional_permissions requires sandbox_permissions: with_additional_permissions" };
    }
    return { kind: "none" };
  }

  if (justification === undefined || justification === "") {
    return { kind: "invalid", reason: "justification is required when requesting sandbox_permissions; ask the user a short question" };
  }

  if (mode === "require_escalated") {
    if (params.additional_permissions) {
      return { kind: "invalid", reason: "additional_permissions goes with with_additional_permissions, not require_escalated" };
    }
    const prefix = validatePrefixRule(params.prefix_rule);
    if (prefix !== undefined && typeof prefix !== "string") return { kind: "invalid", reason: prefix.reason };
    return { kind: "host", justification, ...(typeof prefix === "string" ? { prefixRule: prefix } : {}) };
  }

  if (mode === "with_additional_permissions") {
    if (params.prefix_rule) {
      return { kind: "invalid", reason: "prefix_rule goes with require_escalated, not with_additional_permissions" };
    }
    const requested = params.additional_permissions;
    if (requested === undefined) {
      return { kind: "invalid", reason: "additional_permissions is required with with_additional_permissions" };
    }
    if (requested.network?.enabled) {
      return {
        kind: "invalid",
        reason:
          'network access is granted per destination, not as "enabled"; use request_sandbox_exception with surface "network" and target "host:port", or let the proxy report the host',
      };
    }
    const targets: ScopedTarget[] = [];
    for (const [surface, paths] of [["read", requested.file_system?.read], ["write", requested.file_system?.write]] as const) {
      if (paths === undefined) continue;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path.trim() === "")) {
        return { kind: "invalid", reason: `additional_permissions.file_system.${surface} must be an array of paths` };
      }
      for (const path of paths) {
        const value = path.trim();
        if (!value.startsWith("/") && !value.startsWith("~/")) {
          return { kind: "invalid", reason: `additional_permissions.file_system.${surface} needs absolute paths or ~/… (got "${value}")` };
        }
        targets.push({ surface, target: value.replace(/^~/, "~") });
      }
    }
    if (targets.length === 0) {
      return { kind: "invalid", reason: "additional_permissions names no file_system path to widen" };
    }
    return { kind: "scoped", justification, targets };
  }

  return { kind: "invalid", reason: `unknown sandbox_permissions value "${String(mode)}"` };
}

/** A standing rule must be categorical and safe: `["git", "pull"]` → "git pull:*". */
function validatePrefixRule(rule: string[] | undefined): string | { reason: string } | undefined {
  if (rule === undefined) return undefined;
  if (!Array.isArray(rule) || rule.length === 0 || rule.some((word) => typeof word !== "string" || word.trim() === "")) {
    return { reason: "prefix_rule must be a non-empty array of command words, for example [\"git\", \"pull\"]" };
  }
  const words = rule.map((word) => word.trim());
  if (words.some((word) => /[;&|<>`$\n\r*?]/.test(word))) {
    return { reason: "prefix_rule words cannot contain shell metacharacters or wildcards" };
  }
  const head = words[0]!.toLowerCase();
  if (BANNED_PREFIX_HEADS.has(head)) {
    return { reason: `prefix_rule "${head}" would allow arbitrary execution; propose a categorical rule such as ["git", "pull"] instead` };
  }
  return `${words.join(" ")}:*`;
}
