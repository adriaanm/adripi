import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, BashToolDetails, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  getAgentDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedBashOperations } from "./bash-operations.ts";
import {
  getInheritedConfigArray,
  getInheritedConfigBoolean,
  getConfigPaths,
  hasProjectConfig,
  loadConfig,
  mutateConfigArrayValue,
  toggleConfigBoolean,
  updateGlobalConfig,
  updateProjectConfig,
  type ConfigScope,
  type EffectiveSandboxConfig,
  type JsonObject,
} from "./config.ts";
import {
  decideSandboxException,
  getProjectPolicyService,
  projectPolicyRule,
  withScopedPaths,
  type PreparedProjectRule,
} from "./broker.ts";
import { ExecutionQueue } from "./execution-queue.ts";
import { planInlineEscalation, type InlineEscalationPlan } from "./inline-escalation.ts";
import { sandboxGuidance } from "./guidance.ts";
import { HumanChannel } from "./human-channel.ts";
import { registerFileGate } from "./file-gate.ts";
import { buildHardeningPaths } from "./hardening.ts";
import { SandboxController, RuntimeSandboxManager } from "./manager.ts";
import { createFilePolicy } from "./path-policy.ts";
import { createScratchpad, SCRATCH_ENV, sweepScratchpads, withScratchpad, type Scratchpad } from "./scratch.ts";
import { SandboxSettingsComponent, type RuleKind, type SandboxSettingId } from "./settings-ui.ts";
import { removeSandboxViolationTags, ViolationTracker } from "./violations.ts";
import { resultText, withTrapHint } from "./trap-hints.ts";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  // Codex-shaped inline escalation: the request travels with the command, so the
  // model asks and runs in one call instead of requesting, waiting, and re-running.
  sandbox_permissions: Type.Optional(Type.Union([
    Type.Literal("use_default"),
    Type.Literal("require_escalated"),
    Type.Literal("with_additional_permissions"),
  ], { description: "Per-command sandbox override. Defaults to use_default; widen for this command with \"with_additional_permissions\", or run outside the sandbox with \"require_escalated\"." })),
  justification: Type.Optional(Type.String({ description: "Short question for the user; required with require_escalated or with_additional_permissions, omit otherwise." })),
  prefix_rule: Type.Optional(Type.Array(Type.String(), { description: "A standing-rule proposal for this command, only with require_escalated; it must be a true prefix of the command, for example [\"git\", \"push\"]." })),
  additional_permissions: Type.Optional(Type.Object({
    file_system: Type.Optional(Type.Object({
      read: Type.Optional(Type.Array(Type.String())),
      write: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false })),
  }, { additionalProperties: false, description: "Paths to widen for this command only; only with with_additional_permissions." })),
}, { additionalProperties: false });

type BashParams = {
  command: string;
  timeout?: number;
  sandbox_permissions?: "use_default" | "require_escalated" | "with_additional_permissions";
  justification?: string;
  prefix_rule?: string[];
  additional_permissions?: {
    file_system?: { read?: string[]; write?: string[] };
  };
};

/**
 * The only bash parameters this extension accepts. `dangerouslyDisableSandbox`
 * and a separate exception request are retired; a legacy key is rejected rather
 * than ignored, so a stale model habit cannot look like a normal call.
 */
const CANONICAL_BASH_PARAMS = new Set([
  "command",
  "timeout",
  "sandbox_permissions",
  "justification",
  "prefix_rule",
  "additional_permissions",
]);

type RuleDefinition = { section?: string; key: string; label: string };

const SETTINGS_SCOPES: ConfigScope[] = ["session", "global", "project"];
const SETTING_CONFIG_KEYS: Record<Exclude<SandboxSettingId, "mode">, string> = {
  fallback: "allowUnsandboxedCommands",
  failIfUnavailable: "failIfUnavailable",
  weakerNested: "enableWeakerNestedSandbox",
  weakerNetwork: "enableWeakerNetworkIsolation",
  appleEvents: "allowAppleEvents",
  allowPty: "allowPty",
};
const RULE_DEFINITIONS: Record<RuleKind, RuleDefinition> = {
  networkAllow: { section: "network", key: "allowedDomains", label: "Allowed domain" },
  networkDeny: { section: "network", key: "deniedDomains", label: "Denied domain" },
  readAllow: { section: "filesystem", key: "allowRead", label: "Allowed read path" },
  readDeny: { section: "filesystem", key: "denyRead", label: "Denied read path" },
  writeAllow: { section: "filesystem", key: "allowWrite", label: "Allowed write path" },
  writeDeny: { section: "filesystem", key: "denyWrite", label: "Denied write path" },
  environment: { section: "environment", key: "deny", label: "Denied environment variable" },
};

function mandatoryRules(kind: RuleKind, active: EffectiveSandboxConfig): string[] {
  switch (kind) {
    case "readDeny": return active.hardening.denyRead;
    case "writeAllow": return active.hardening.worktreeGitDir ? [active.hardening.worktreeGitDir] : [];
    case "writeDeny": return active.hardening.denyWrite;
    default: return [];
  }
}

type ToolResult = AgentToolResult<unknown>;

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level command sandboxing for this process",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("trust-sandbox-config", {
    description: "Allow project .pi/sandbox.json in non-interactive mode",
    type: "boolean",
    default: false,
  });

  const controller = new SandboxController();
  const violations = new ViolationTracker();
  // One bash execution at a time: a scoped command installs a temporary policy
  // in the SRT singleton, and the next command must not observe it.
  let executions = new ExecutionQueue();
  let currentContext: ExtensionContext | undefined;
  let executionSignal: AbortSignal | undefined;
  let config: EffectiveSandboxConfig | undefined;
  let scratchpad: Scratchpad | undefined;
  let configError: string | undefined;
  let sessionEnabled = false;
  let sessionEnabledOverride: boolean | undefined;
  let sessionStarted = false;
  let projectApproved = false;
  let sessionConfig: JsonObject = {};
  let settingsScope: ConfigScope = "session";

  const policyPath = () => getProjectPolicyService()?.path
    ?? join(currentContext?.cwd ?? process.cwd(), CONFIG_DIR_NAME, "guardian.json");
  let humanChannel = new HumanChannel(() => currentContext, policyPath);

  const baseBash = createBashToolDefinition(process.cwd());

  /**
   * Standing permissions are Guardian-owned. There is no fallback that writes
   * sandbox configuration (or a command exclusion) when guardian is absent: the
   * rule is simply not saved, and the user is told why.
   */
  const prepareStandingRule = (rule: string): PreparedProjectRule => {
    const policy = getProjectPolicyService();
    if (!policy) {
      return {
        ok: false,
        reason: `guardian's project-policy service is not published, so no standing rule was saved; add ${rule} to ${policyPath()} by hand if it should persist`,
      };
    }
    return policy.prepareRule(rule);
  };

  const saveStandingRule = (prepared: PreparedProjectRule): void => {
    const saved = prepared.ok ? prepared.commit() : prepared;
    if (!saved.ok) currentContext?.ui.notify(`Standing permission not saved: ${saved.reason}`, "warning");
  };

  /**
   * The network callback is one decision per connection through the same broker
   * and human adapter as every other surface. Nothing is stored: an approved
   * connection does not pre-approve the next one, and a standing rule is only
   * saved through guardian's project policy.
   */
  const networkAsk = async (host: NetworkHostPattern): Promise<boolean> => {
    const signal = executionSignal;
    if (signal?.aborted) return false;
    const hostname = host.host.includes(":") && !host.host.startsWith("[") ? `[${host.host}]` : host.host;
    const target = `${hostname}:${host.port ?? "*"}`;
    const decision = await decideSandboxException({
      surface: "network",
      target,
      scope: "once",
      origin: "trap",
      violation: "network destination is not in the static allowlist",
      cwd: currentContext?.cwd ?? process.cwd(),
    });
    if (signal?.aborted) return false;
    if (decision.kind === "allow") return true;
    if (decision.kind === "deny") {
      currentContext?.ui.notify(`Sandbox network denied: ${decision.reason}`, "warning");
      return false;
    }
    const rule = projectPolicyRule("network", target);
    const prepared = prepareStandingRule(rule);
    const human = await humanChannel.ask({
      surface: "network",
      target,
      reason: "the sandbox network allowlist does not include this destination",
      standingRule: prepared.ok ? rule : undefined,
    }, signal);
    if (human.kind !== "allow") {
      currentContext?.ui.notify(`Sandbox network denied: ${human.reason}`, "warning");
      return false;
    }
    if (signal?.aborted) return false;
    if (human.standing) saveStandingRule(prepared);
    return true;
  };

  async function resolveProjectApproval(ctx: ExtensionContext): Promise<boolean> {
    if (!hasProjectConfig(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME)) return false;
    if (Boolean(pi.getFlag("trust-sandbox-config"))) return true;
    if (hasTrustRequiringProjectResources(ctx.cwd) && ctx.isProjectTrusted()) return true;
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm(
      "Apply project sandbox config?",
      `${ctx.cwd}/${CONFIG_DIR_NAME}/sandbox.json is controlled by this project and may relax sandbox policy.`,
    );
  }

  /** Effective config for a session layer; used for the baseline and per-command snapshots. */
  function buildConfig(ctx: ExtensionContext, sessionLayer: JsonObject): EffectiveSandboxConfig {
    let next = loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      allowProjectConfig: projectApproved,
      sessionConfig: sessionLayer,
    });
    // The scratchpad is policy, not an exception: the agent can always write
    // temporary files there, and nothing else under the temp root opens up.
    if (scratchpad) next = withScratchpad(next, scratchpad.dir);
    return next;
  }

  async function reloadConfig(ctx: ExtensionContext, resetRuntime: boolean): Promise<void> {
    configError = undefined;
    try {
      config = buildConfig(ctx, sessionConfig);
      for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
      sessionEnabled = (sessionEnabledOverride ?? config.enabled) && !Boolean(pi.getFlag("no-sandbox"));
      if (resetRuntime) await controller.reset();
      if (sessionEnabled) {
        try {
          if (!resetRuntime && controller.canRunSandboxed()) controller.refresh(config);
          else await controller.initialize(config, networkAsk);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Sandbox unavailable: ${message}`, config.failIfUnavailable ? "error" : "warning");
        }
      } else {
        controller.refresh(config);
        controller.setSessionEnabled(false);
      }
      if (controller.canRunSandboxed()) {
        violations.start(RuntimeSandboxManager.getSandboxViolationStore());
        for (const warning of controller.checkDependencies().warnings) ctx.ui.notify(warning, "warning");
        for (const pattern of RuntimeSandboxManager.getLinuxGlobPatternWarnings()) {
          ctx.ui.notify(
            `Linux sandbox expands existing glob matches before each command but cannot block matching paths created by that command: ${pattern}`,
            "warning",
          );
        }
      }
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      config = undefined;
      sessionEnabled = false;
      ctx.ui.notify(`Invalid sandbox configuration: ${configError}`, "error");
    }
  }

  async function setSessionSandboxEnabled(ctx: ExtensionContext, enabled: boolean): Promise<void> {
    if (!enabled) {
      sessionEnabledOverride = false;
      sessionEnabled = false;
      controller.setSessionEnabled(false);
      return;
    }
    if (Boolean(pi.getFlag("no-sandbox"))) {
      ctx.ui.notify("Cannot enable sandbox while --no-sandbox is set", "error");
      return;
    }
    if (!config) {
      ctx.ui.notify(configError ?? "No valid sandbox configuration", "error");
      return;
    }
    sessionEnabledOverride = true;
    sessionEnabled = true;
    const enabledConfig = { ...config, enabled: true };
    config = enabledConfig;
    controller.setSessionEnabled(true);
    if (!controller.canRunSandboxed()) {
      try {
        await controller.initialize(enabledConfig, networkAsk);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }

  type ScopedConfigMutator = (
    raw: JsonObject,
    active: EffectiveSandboxConfig,
    scope: ConfigScope,
  ) => JsonObject;

  const ensureSettingsProjectApproved = async (ctx: ExtensionContext): Promise<boolean> => {
    if (settingsScope !== "project" || projectApproved) return true;
    const approved = await ctx.ui.confirm(
      "Apply project sandbox config?",
      `${ctx.cwd}/${CONFIG_DIR_NAME}/sandbox.json may relax sandbox policy for this project.`,
    );
    if (!approved) return false;
    projectApproved = true;
    await reloadConfig(ctx, false);
    if (!config) throw new Error("No valid sandbox configuration");
    return true;
  };

  const applySettingsMutation = async (
    ctx: ExtensionContext,
    mutator: ScopedConfigMutator,
  ): Promise<void> => executions.run(async () => {
    if (!config) throw new Error("No valid sandbox configuration");
    const scope = settingsScope;
    if (!await ensureSettingsProjectApproved(ctx)) return;
    const active = config;
    const base = scope === "session" ? sessionConfig : active.layers[scope];
    const candidate = mutator(base, active, scope);

    // Validate the edited layer as the highest-priority override before touching disk.
    loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      allowProjectConfig: projectApproved,
      sessionConfig: candidate,
    });

    if (scope === "session") {
      sessionConfig = candidate;
    } else if (scope === "global") {
      await updateGlobalConfig(active.globalConfigPath, (raw) => mutator(raw, active, scope));
    } else {
      await updateProjectConfig(active.projectConfigPath, ctx.cwd, (raw) => mutator(raw, active, scope));
    }
    await reloadConfig(ctx, false);
  });

  const changeRule = async (ctx: ExtensionContext, kind: RuleKind, value: string, add: boolean): Promise<void> => {
    const definition = RULE_DEFINITIONS[kind];
    await applySettingsMutation(ctx, (raw, active, scope) => mutateConfigArrayValue(
      raw,
      definition.section,
      definition.key,
      getInheritedConfigArray(active, definition.section, definition.key, scope),
      value,
      add,
      mandatoryRules(kind, active),
    ));
  };

  function localTool(cwd: string) {
    return createBashToolDefinition(cwd);
  }

  function sandboxedTool(cwd: string) {
    return createBashToolDefinition(cwd, {
      exposeSessionEnvironment: false,
      operations: createSandboxedBashOperations(),
      // Tell sandboxed commands where they may write without an exception.
      spawnHook: (context) => ({
        ...context,
        env: { ...context.env, ...(scratchpad ? { [SCRATCH_ENV]: scratchpad.dir } : {}) },
      }),
    });
  }

  const refusal = (reason: string, details: Record<string, unknown> = {}): ToolResult => ({
    content: [{ type: "text", text: `Sandbox escalation rejected: ${reason}. The command did not run.` }],
    details: { refusal: reason, ...details },
  });

  const deferred = (reason: string): ToolResult => ({
    content: [{
      type: "text",
      text: `Sandbox exception deferred: ${reason}. The command did not run; do not retry it in the same mode.`,
    }],
    details: { deferred: true, reason },
  });

  const runSandboxed = async (
    id: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof baseBash.execute>[3],
    ctx: ExtensionContext,
  ): Promise<ToolResult> => {
    const input = { command: params.command, timeout: params.timeout };
    const result = await sandboxedTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
    // A denied command names the exact path; tell the model how to ask for it.
    return withTrapHint(result, resultText(result), { cwd: ctx.cwd, scratchDir: scratchpad?.dir });
  };

  /**
   * Host execution, the reviewed full-host tier. `allowUnsandboxedCommands` and
   * the shape/prefix gate are checked before the broker or a human is asked, so
   * a disabled policy or an ineligible shape never spends a review.
   */
  const runOnHost = async (
    id: string,
    plan: Extract<InlineEscalationPlan, { kind: "host" }>,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof baseBash.execute>[3],
    ctx: ExtensionContext,
    activeConfig: EffectiveSandboxConfig,
  ): Promise<ToolResult> => {
    if (!activeConfig.allowUnsandboxedCommands) {
      return refusal("unsandboxed commands are disabled by sandbox policy (allowUnsandboxedCommands is false)");
    }
    const decision = await decideSandboxException({
      surface: "command",
      target: plan.command.command,
      scope: "once",
      origin: "tool",
      reason: plan.justification,
      command: plan.command.command,
      cwd: ctx.cwd,
    });
    if (decision.kind === "deny") return refusal(`guardian denied host execution: ${decision.reason}`);

    const standingRule = plan.prefixRule ? projectPolicyRule("command", plan.prefixRule) : undefined;
    const prepared = standingRule ? prepareStandingRule(standingRule) : undefined;
    let standingApproved = false;
    if (decision.kind === "defer") {
      const human = await humanChannel.ask({
        surface: "command",
        target: plan.command.command,
        reason: plan.justification,
        standingRule: prepared?.ok ? standingRule : undefined,
      }, signal);
      if (human.kind === "unavailable") return deferred(human.reason);
      if (human.kind === "deny") return refusal(human.reason);
      standingApproved = human.standing;
    } else if (standingRule) {
      // Guardian allowed this call; saving a rule is still the human's decision.
      if (prepared?.ok) standingApproved = await humanChannel.confirmStanding(standingRule, signal);
      else if (prepared) ctx.ui.notify(`Standing permission not saved: ${prepared.reason}`, "warning");
    }
    if (signal?.aborted) return refusal("the command was cancelled before it started");
    if (standingApproved && prepared) saveStandingRule(prepared);

    // Run the reviewed string, not a differently-spaced spelling of it.
    const input = { command: plan.command.command, timeout: params.timeout };
    return localTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
  };

  const restoreBaseline = async (baseline: EffectiveSandboxConfig): Promise<void> => {
    try {
      controller.refresh(baseline);
    } catch (error) {
      // If rollback itself fails, no later command may use a possibly widened
      // singleton. Poison dispatch before attempting cleanup, even if reset fails.
      configError = `Scoped sandbox policy could not be restored: ${error instanceof Error ? error.message : String(error)}`;
      await controller.reset();
      throw new Error(configError);
    }
  };

  /**
   * Widen the sandbox for exactly this execution. Every target is decided
   * before the runtime is touched, so a partial approval runs nothing and
   * leaves no trace; the baseline profile is restored in `finally` on success,
   * failure and cancellation.
   */
  const runScoped = async (
    id: string,
    plan: Extract<InlineEscalationPlan, { kind: "scoped" }>,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof baseBash.execute>[3],
    ctx: ExtensionContext,
    activeConfig: EffectiveSandboxConfig,
  ): Promise<ToolResult> => {
    if (!controller.canRunSandboxed()) {
      return refusal("the sandbox is unavailable, so a command-scoped path permission cannot be applied");
    }
    for (const target of plan.targets) {
      const decision = await decideSandboxException({
        surface: target.surface,
        target: target.target,
        scope: "once",
        origin: "tool",
        reason: plan.justification,
        command: params.command,
        cwd: ctx.cwd,
      });
      if (decision.kind === "deny") {
        return refusal(`guardian denied ${target.surface} ${target.target}: ${decision.reason}`);
      }
      if (decision.kind === "defer") {
        const human = await humanChannel.ask({
          surface: target.surface,
          target: target.target,
          reason: plan.justification,
        }, signal);
        if (human.kind === "unavailable") return deferred(human.reason);
        if (human.kind === "deny") return refusal(human.reason);
      }
    }
    if (signal?.aborted) return refusal("the command was cancelled before it started");

    let scopedConfig: EffectiveSandboxConfig;
    try {
      scopedConfig = buildConfig(ctx, withScopedPaths(sessionConfig, plan.targets));
    } catch (error) {
      return refusal(`the sandbox runtime rejected the scoped path: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      controller.refresh(scopedConfig);
    } catch (error) {
      await restoreBaseline(activeConfig);
      return refusal(`the sandbox runtime rejected the scoped path: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return await runSandboxed(id, params, signal, onUpdate, ctx);
    } finally {
      await restoreBaseline(activeConfig);
    }
  };

  /**
   * The single execution-dispatch seam. Every bash call — default, scoped or
   * host — passes through this function, so the legacy parameter check, the
   * host gate, the review handoff and the baseline restore exist once.
   */
  const dispatch = async (
    id: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof baseBash.execute>[3],
    ctx: ExtensionContext,
  ): Promise<ToolResult> => {
    const unknown = Object.keys(params as unknown as Record<string, unknown>)
      .filter((key) => !CANONICAL_BASH_PARAMS.has(key));
    if (unknown.length > 0) {
      return refusal(
        `unsupported bash parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; ` +
        "escalation is a parameter of this bash call (`sandbox_permissions`, `justification`, `prefix_rule`, `additional_permissions`), " +
        "and `request_sandbox_exception` / `dangerouslyDisableSandbox` are retired",
      );
    }

    if (signal?.aborted) return refusal("the command was cancelled before it started");
    const plan = planInlineEscalation(params);
    if (plan.kind === "invalid") return refusal(plan.reason);
    if (Boolean(pi.getFlag("no-sandbox"))) {
      const input = { command: params.command, timeout: params.timeout };
      return localTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
    }
    if (configError) throw new Error(`Sandbox configuration is invalid: ${configError}`);
    if (!config) throw new Error("Sandbox is not initialized yet; retry after session start");
    const activeConfig = config;
    if (!sessionEnabled) {
      const input = { command: params.command, timeout: params.timeout };
      return localTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
    }

    if (plan.kind === "host") return runOnHost(id, plan, params, signal, onUpdate, ctx, activeConfig);
    if (plan.kind === "scoped") return runScoped(id, plan, params, signal, onUpdate, ctx, activeConfig);

    if (controller.canRunSandboxed()) return runSandboxed(id, params, signal, onUpdate, ctx);
    if (activeConfig.failIfUnavailable) {
      throw new Error(`Sandbox required but unavailable: ${controller.getError() ?? "not initialized"}`);
    }
    if (!activeConfig.allowUnsandboxedCommands) {
      throw new Error("Sandbox unavailable and unsandboxed commands are disabled by sandbox policy");
    }
    // Availability fallback is not an admission bypass: use the same host
    // planner, gate and review as an explicit require_escalated request.
    const fallback = planInlineEscalation({
      command: params.command,
      sandbox_permissions: "require_escalated",
      justification: `The configured sandbox is unavailable: ${controller.getError() ?? "not initialized"}`,
    });
    if (fallback.kind !== "host") return refusal(fallback.kind === "invalid" ? fallback.reason : "host fallback is not eligible");
    return runOnHost(id, fallback, params, signal, onUpdate, ctx, activeConfig);
  };

  pi.registerTool({
    ...baseBash,
    parameters: bashSchema,
    label: "bash (sandbox-aware)",
    promptGuidelines: [
      ...(baseBash.promptGuidelines ?? []),
      "Run bash commands inside the sandbox by default.",
      scratchpad
        ? `Write temporary files under ${scratchpad.dir} (also ${SCRATCH_ENV}); it is writable inside the sandbox and removed when the session ends.`
        : "Write temporary files inside the project; paths outside it may need an exception.",
      "When a command fails because of the sandbox, re-run the same bash call with the request attached: `sandbox_permissions: \"with_additional_permissions\"`, `additional_permissions.file_system.{read,write}`, and a `justification` (widened for that command only), or `sandbox_permissions: \"require_escalated\"` when it must run on the host (host credentials, host services). `prefix_rule` may propose a narrow standing rule such as [\"git\", \"push\"], but only the user can save it.",
      "There is no separate exception tool: network destinations are asked per connection by the proxy, and a path or host exception belongs to the bash call that needs it.",
      "Local git work (status, diff, log, commit, branch, merge, rebase, stash) runs sandboxed; only network git that authenticates with a remote (clone, fetch, pull, push, ls-remote, submodule --remote) and gh/ssh cannot. For those, re-run with `sandbox_permissions: \"require_escalated\"` and a `justification`, and never ask for read access to gh's config or ~/.ssh — permanently denied.",
    ],
    renderResult(result, options, theme, renderContext) {
      const displayResult = {
        ...result,
        details: result.details as BashToolDetails | undefined,
        content: result.content.map((block) => block.type === "text"
          ? { ...block, text: removeSandboxViolationTags(block.text) }
          : block),
      };
      return baseBash.renderResult!(displayResult, options, theme, renderContext);
    },
    async execute(id, params, signal, onUpdate, ctx) {
      return executions.run(async () => {
        currentContext = ctx;
        executionSignal = signal;
        try {
          return await dispatch(id, params, signal, onUpdate, ctx);
        } finally {
          executionSignal = undefined;
        }
      });
    },
  });

  // Sandbox conventions are not trained knowledge; keep them in the prompt while
  // the sandbox is on, and leave it alone when the sandbox is off.
  pi.on("before_agent_start", (event) => {
    if (!sessionEnabled || configError) return;
    const section = sandboxGuidance({
      scratchDir: scratchpad?.dir,
      projectPolicyPath: ".pi/guardian.json (project policy, user-owned)",
    });
    // Pi 1.x exposes structured `sections` (cache-friendly delta); older hosts
    // only have the append slot. Support both without narrowing the vendored types.
    const options = event.systemPromptOptions as typeof event.systemPromptOptions & {
      sections?: Record<string, string>;
    };
    if (options.sections) {
      options.sections = { ...options.sections, sandbox: section };
      return;
    }
    options.appendSystemPrompt = [options.appendSystemPrompt, `<sandbox>\n${section}\n</sandbox>`]
      .filter(Boolean)
      .join("\n\n");
  });

  pi.on("user_bash", (event, ctx) => {
    if (Boolean(pi.getFlag("no-sandbox"))) return;
    if (!sessionStarted) {
      return {
        result: {
          output: "Sandbox is still initializing; retry after session start",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (configError) {
      return {
        result: {
          output: `Sandbox configuration is invalid: ${configError}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (!config || !sessionEnabled) return;
    if (controller.canRunSandboxed()) {
      // A human's own command must not run while a model command holds a
      // temporary policy in the SRT singleton either.
      const operations = createSandboxedBashOperations();
      return {
        operations: {
          exec: (command, cwd, options) => executions.run(async () => {
            currentContext = ctx;
            executionSignal = options.signal;
            try {
              if (options.signal?.aborted) throw new Error("Command cancelled before execution");
              return await operations.exec(command, cwd, options);
            } finally {
              executionSignal = undefined;
            }
          }),
        },
      };
    }
    if (config.failIfUnavailable || !config.allowUnsandboxedCommands) {
      return {
        result: {
          output: `Sandbox required but unavailable: ${controller.getError() ?? "not initialized"}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  // When config is invalid or not loaded, fall back to a hardening-only
  // policy so mandatory write protection never silently disappears.
  const fallbackGatePolicy = (cwd: string) => {
    const paths = getConfigPaths(cwd, getAgentDir(), CONFIG_DIR_NAME);
    const hardening = buildHardeningPaths(cwd, getAgentDir(), paths.global, paths.project);
    return {
      cwd,
      policy: createFilePolicy({
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        mandatoryDenyWrite: hardening.mandatoryDenyWrite,
      }),
      enabled: false,
    };
  };

  // Native file tools always read the baseline policy. A command-scoped grant
  // lives only in the SRT runtime for the duration of one serialized bash call,
  // so `write`/`edit`/`read` can never observe another execution's transient
  // widening.
  registerFileGate(pi, () => {
    const cwd = currentContext?.cwd ?? process.cwd();
    if (!config) return fallbackGatePolicy(cwd);
    return {
      cwd,
      policy: createFilePolicy({
        filesystem: config.runtime.filesystem,
        credentialFiles: config.runtime.credentials?.files,
        mandatoryDenyWrite: config.hardening.mandatoryDenyWrite,
      }),
      enabled: sessionEnabled,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionStarted = false;
    humanChannel.shutdown();
    await executions.close();
    executions = new ExecutionQueue();
    sessionEnabledOverride = undefined;
    currentContext = ctx;
    ctx.ui.setStatus("sandbox", undefined);
    humanChannel = new HumanChannel(() => currentContext, policyPath);
    // Scratch: sweep leftovers from crashed sessions, then create this one's.
    try {
      await sweepScratchpads();
    } catch {
      // best effort
    }
    scratchpad = await createScratchpad();
    projectApproved = await resolveProjectApproval(ctx);
    await reloadConfig(ctx, true);
    sessionStarted = true;
  });

  pi.on("session_shutdown", async () => {
    currentContext?.ui.setStatus("sandbox", undefined);
    humanChannel.shutdown();
    await executions.close();
    violations.stop();
    currentContext = undefined;
    config = undefined;
    sessionEnabled = false;
    sessionEnabledOverride = undefined;
    sessionStarted = false;
    await controller.reset();
    await scratchpad?.dispose();
    scratchpad = undefined;
  });

  pi.registerCommand("sandbox", {
    description: "Inspect and manage the command sandbox",
    handler: async (rawArgs, ctx) => {
      currentContext = ctx;
      const args = rawArgs.trim();
      if (!args) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`Sandbox: ${controller.getState()}`, "info");
          return;
        }
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SandboxSettingsComponent(theme, {
          getConfig: () => config,
          getSessionEnabled: () => sessionEnabled,
          getScope: () => settingsScope,
          getSummary: () => {
            const dependencies = controller.checkDependencies();
            const state = Boolean(pi.getFlag("no-sandbox")) ? "disabled (--no-sandbox)" : controller.getState();
            const source = config?.projectApplied ? "project + global" : "global/defaults";
            return `State: ${state} · Config: ${source} · Dependencies: ${dependencies.errors.length ? dependencies.errors.join(", ") : "ok"} · Violations: ${violations.getTotal()}`;
          },
          cycleScope: () => {
            settingsScope = SETTINGS_SCOPES[(SETTINGS_SCOPES.indexOf(settingsScope) + 1) % SETTINGS_SCOPES.length]!;
          },
          toggle: async (id: SandboxSettingId) => {
            if (id === "mode") {
              await executions.run(() => setSessionSandboxEnabled(ctx, !sessionEnabled));
              return;
            }
            const key = SETTING_CONFIG_KEYS[id];
            await applySettingsMutation(ctx, (raw, active, scope) => toggleConfigBoolean(
              raw,
              key,
              getInheritedConfigBoolean(active, key, scope),
            ));
          },
          add: (kind: RuleKind, value: string) => changeRule(ctx, kind, value, true),
          remove: (kind: RuleKind, value: string) => changeRule(ctx, kind, value, false),
          editRaw: async () => {
            if (!await executions.run(() => ensureSettingsProjectApproved(ctx))) return;
            if (!config) throw new Error("No valid sandbox configuration");
            const scope = settingsScope;
            const initial = scope === "session" ? sessionConfig : config.layers[scope];
            const edited = await ctx.ui.editor(
              `Edit ${scope} sandbox JSON`,
              `${JSON.stringify(initial, null, 2)}\n`,
            );
            if (edited === undefined) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(edited);
            } catch (error) {
              throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Sandbox configuration must be a JSON object");
            }
            const replacement = parsed as JsonObject;
            await applySettingsMutation(ctx, () => replacement);
          },
          close: () => done(undefined),
          requestRender: () => tui.requestRender(),
          reportError: (error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"),
        }));
        return;
      }
      if (args === "off") {
        await executions.run(() => setSessionSandboxEnabled(ctx, false));
        ctx.ui.notify("Sandbox disabled for this session; mandatory policy-file protection remains active", "warning");
        return;
      }
      if (args === "on") {
        await executions.run(() => setSessionSandboxEnabled(ctx, true));
        return;
      }
      if (args === "violations") {
        const recent = violations.getRecent();
        if (!recent.length) {
          ctx.ui.notify(process.platform === "linux" ? "No captured violations; Linux telemetry may be unavailable, inspect command output" : "No sandbox violations captured", "info");
        } else {
          ctx.ui.notify(recent.map((entry) => `${entry.timestamp.toISOString()} ${entry.command ? `${entry.command}: ` : ""}${entry.line}`).join("\n"), "info");
        }
        return;
      }
      ctx.ui.notify("Usage: /sandbox [on|off|violations]", "warning");
    },
  });
}
