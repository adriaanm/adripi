import { checkPrefixRule, parseHostCommand, type HostCommand } from "./host-command.ts";

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
 * outside it (`require_escalated`) when that cannot work. This planner is pure:
 * it binds a proposal to the command in the same call and refuses shapes before
 * any reviewer or human is asked.
 */

export type ScopedTarget = { surface: "read" | "write"; target: string };

export type InlineEscalationPlan =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "host"; justification: string; command: HostCommand; prefixRule?: string }
  | { kind: "scoped"; justification: string; targets: ScopedTarget[] };

export interface InlineEscalationParams {
  command: string;
  sandbox_permissions?: "use_default" | "require_escalated" | "with_additional_permissions";
  justification?: string;
  prefix_rule?: string[];
  additional_permissions?: {
    file_system?: { read?: string[]; write?: string[] };
  };
}

export function planInlineEscalation(params: InlineEscalationParams): InlineEscalationPlan {
  if (typeof params.command !== "string" || params.command.trim() === "") {
    return { kind: "invalid", reason: "command is required" };
  }
  const mode = params.sandbox_permissions;
  const justification = typeof params.justification === "string" ? params.justification.trim() : undefined;

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
    const parsed = parseHostCommand(params.command);
    if (!parsed.ok) return { kind: "invalid", reason: `host execution is not eligible: ${parsed.reason}` };
    const prefix = checkPrefixRule(parsed.command, params.prefix_rule);
    if (!prefix.ok) return { kind: "invalid", reason: prefix.reason };
    return {
      kind: "host",
      justification,
      command: parsed.command,
      ...(prefix.pattern ? { prefixRule: prefix.pattern } : {}),
    };
  }

  if (mode === "with_additional_permissions") {
    if (params.prefix_rule) {
      return { kind: "invalid", reason: "prefix_rule goes with require_escalated, not with_additional_permissions" };
    }
    const requested = params.additional_permissions;
    if (requested === undefined) {
      return { kind: "invalid", reason: "additional_permissions is required with with_additional_permissions" };
    }
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
      return { kind: "invalid", reason: "additional_permissions must be an object" };
    }
    if ("network" in requested) {
      return {
        kind: "invalid",
        reason:
          'network access is granted per destination, not as "enabled": run the command and approve the destination the sandbox reports for that connection',
      };
    }
    if (Object.keys(requested).some((key) => key !== "file_system")) {
      return { kind: "invalid", reason: "additional_permissions only supports file_system" };
    }
    const filesystem = requested.file_system;
    if (filesystem !== undefined && (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem) ||
      Object.keys(filesystem).some((key) => key !== "read" && key !== "write"))) {
      return { kind: "invalid", reason: "additional_permissions.file_system only supports read and write path arrays" };
    }
    const targets: ScopedTarget[] = [];
    for (const [surface, paths] of [["read", requested.file_system?.read], ["write", requested.file_system?.write]] as const) {
      if (paths === undefined) continue;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path.trim() === "")) {
        return { kind: "invalid", reason: `additional_permissions.file_system.${surface} must be an array of paths` };
      }
      for (const path of paths) {
        const value = path.trim();
        if (/[\u0000-\u001f\u007f*?\[\]]/.test(value)) {
          return { kind: "invalid", reason: "scoped permissions require exact paths without wildcards or control characters" };
        }
        if (!value.startsWith("/") && !value.startsWith("~/")) {
          return { kind: "invalid", reason: `additional_permissions.file_system.${surface} needs absolute paths or ~/… (got "${value}")` };
        }
        targets.push({ surface, target: value });
      }
    }
    if (targets.length === 0) {
      return { kind: "invalid", reason: "additional_permissions names no file_system path to widen" };
    }
    return { kind: "scoped", justification, targets };
  }

  return { kind: "invalid", reason: `unknown sandbox_permissions value "${String(mode)}"` };
}
