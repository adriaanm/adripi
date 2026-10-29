import { Type } from "typebox";
import type { BashToolDetails, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  getAgentDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedBashOperations } from "./bash-operations.ts";
import {
  addAllowedDomain,
  getInheritedConfigArray,
  getInheritedConfigBoolean,
  hasProjectConfig,
  loadConfig,
  mutateConfigArrayValue,
  setExcludedCommand,
  toggleConfigBoolean,
  updateGlobalConfig,
  updateProjectConfig,
  type ConfigScope,
  type EffectiveSandboxConfig,
  type JsonObject,
} from "./config.ts";
import { isCommandExcluded } from "./command-policy.ts";
import { parseSupervisorDecision, supervisorQuestion } from "./supervisor-ask.ts";
import { sandboxGuidance } from "./guidance.ts";
import { planInlineEscalation } from "./inline-escalation.ts";
import { getConfigPaths } from "./config.ts";
import { registerFileGate } from "./file-gate.ts";
import { buildHardeningPaths } from "./hardening.ts";
import { SandboxController, RuntimeSandboxManager } from "./manager.ts";
import { createScratchpad, SCRATCH_ENV, type Scratchpad, sweepScratchpads, withScratchpad } from "./scratch.ts";
import {
  decideSandboxException,
  type SandboxScope,
  type SandboxSurface,
  hasSessionException,
  type SessionLayer,
  withSessionException,
  withoutSessionException,
} from "./broker.ts";
import { applyAfterPersist } from "./overlay.ts";
import { createFilePolicy } from "./path-policy.ts";
import { PromptCoordinator } from "./prompts.ts";
import { removeSandboxViolationTags, ViolationTracker } from "./violations.ts";
import { resultText, withTrapHint } from "./trap-hints.ts";
import { HostCommandGrants, hostCommandRefusal } from "./host-command.ts";
import {
  SandboxSettingsComponent,
  type RuleKind,
  type SandboxSettingId,
} from "./settings-ui.ts";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  dangerouslyDisableSandbox: Type.Optional(Type.Boolean({ description: "Request explicit user approval to run this command outside the sandbox" })),
  // Codex-shaped inline escalation: the request travels with the command, so the
  // model asks and runs in one call instead of requesting, waiting, and re-running.
  sandbox_permissions: Type.Optional(Type.Union([
    Type.Literal("use_default"),
    Type.Literal("require_escalated"),
    Type.Literal("with_additional_permissions"),
  ], { description: "Per-command sandbox override. Defaults to use_default; widen for this command with \"with_additional_permissions\", or run outside the sandbox with \"require_escalated\"." })),
  justification: Type.Optional(Type.String({ description: "Short question for the user; required with require_escalated or with_additional_permissions, omit otherwise." })),
  prefix_rule: Type.Optional(Type.Array(Type.String(), { description: "Reusable approval prefix for this command, only with require_escalated; for example [\"git\", \"pull\"]." })),
  additional_permissions: Type.Optional(Type.Object({
    network: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
    file_system: Type.Optional(Type.Object({
      read: Type.Optional(Type.Array(Type.String())),
      write: Type.Optional(Type.Array(Type.String())),
    })),
  }, { description: "Paths to widen for this command only; only with with_additional_permissions." })),
});

type BashParams = {
  command: string;
  timeout?: number;
  dangerouslyDisableSandbox?: boolean;
  sandbox_permissions?: "use_default" | "require_escalated" | "with_additional_permissions";
  justification?: string;
  prefix_rule?: string[];
  additional_permissions?: {
    network?: { enabled?: boolean };
    file_system?: { read?: string[]; write?: string[] };
  };
};

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
  command: { key: "excludedCommands", label: "Excluded command" },
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
  let currentContext: ExtensionContext | undefined;
  let config: EffectiveSandboxConfig | undefined;
  let scratchpad: Scratchpad | undefined;
  /** `once` grants expire after the next sandboxed command (network: next connection). */
  let pendingOnceGrants: Array<{ surface: SandboxSurface; target: string; grantedByToolCallId: string }> = [];
  const pendingNetworkOnce = new Set<string>();
  /** Exact commands approved to run on the host (remote git operations). */
  const hostGrants = new HostCommandGrants();
  let configError: string | undefined;
  let sessionEnabled = false;
  let sessionEnabledOverride: boolean | undefined;
  let sessionStarted = false;
  let projectApproved = false;
  let sessionConfig: JsonObject = {};
  let settingsScope: ConfigScope = "session";
  let prompts = new PromptCoordinator(() => currentContext);
  // Session-scoped approvals granted through prompts or /sandbox commands.
  // They apply without trusting the (possibly attacker-controlled) project
  // config layer as a whole.
  const overlay = {
    allowedDomains: new Set<string>(),
    excludedCommands: new Set<string>(),
    unexcludedCommands: new Set<string>(),
  };

  const applyOverlay = (target: EffectiveSandboxConfig) => {
    target.runtime.network.allowedDomains = [
      ...new Set([...target.runtime.network.allowedDomains, ...overlay.allowedDomains]),
    ];
    target.excludedCommands = [
      ...new Set([...target.excludedCommands, ...overlay.excludedCommands]),
    ].filter((pattern) => !overlay.unexcludedCommands.has(pattern));
  };

  const baseBash = createBashToolDefinition(process.cwd());

  const notifyUntrustedPersist = (ctx: ExtensionContext) => {
    if (!projectApproved && hasProjectConfig(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME)) {
      ctx.ui.notify(
        "Saved to project sandbox.json, but the rest of the untrusted project config stays ignored until you approve it",
        "warning",
      );
    }
  };

  const persistDomain = async (host: string) => {
    if (!config || !currentContext) throw new Error("Sandbox has no active session");
    const activeConfig = config;
    const ctx = currentContext;
    await applyAfterPersist(
      () => updateProjectConfig(activeConfig.projectConfigPath, ctx.cwd, (raw) => addAllowedDomain(raw, host)),
      () => overlay.allowedDomains.add(host),
    );
    notifyUntrustedPersist(ctx);
    await reloadConfig(ctx, false);
  };

  const persistExclusion = async (pattern: string) => {
    if (!config || !currentContext) throw new Error("Sandbox has no active session");
    const activeConfig = config;
    const ctx = currentContext;
    await applyAfterPersist(
      () => updateProjectConfig(activeConfig.projectConfigPath, ctx.cwd, (raw) => setExcludedCommand(raw, pattern, true)),
      () => {
        overlay.excludedCommands.add(pattern);
        overlay.unexcludedCommands.delete(pattern);
      },
    );
    notifyUntrustedPersist(ctx);
    await reloadConfig(ctx, false);
  };

  const networkAsk = async (host: NetworkHostPattern) => {
    const target = `${host.host}:${host.port ?? "*"}`;
    if (pendingNetworkOnce.delete(target)) return true;
    const decision = await decideSandboxException({
      surface: "network",
      target,
      scope: "session",
      origin: "trap",
      violation: "network destination is not in the static allowlist",
      cwd: currentContext?.cwd ?? process.cwd(),
    });
    if (decision.kind === "allow") {
      if (decision.scope === "session") {
        if (!currentContext) return false;
        const applied = await applySessionGrant(currentContext, "network", target);
        if (!applied.ok) {
          currentContext.ui.notify(`Sandbox network exception refused: ${applied.reason}`, "error");
          return false;
        }
      }
      return true;
    }
    if (decision.kind === "deny") {
      currentContext?.ui.notify(`Sandbox network denied: ${decision.reason}`, "warning");
      return false;
    }
    return prompts.requestNetwork(host, persistDomain);
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

  async function reloadConfig(ctx: ExtensionContext, resetRuntime: boolean): Promise<void> {
    configError = undefined;
    try {
      config = loadConfig({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        configDirName: CONFIG_DIR_NAME,
        allowProjectConfig: projectApproved,
        sessionConfig,
      });
      // The scratchpad is policy, not an exception: the agent can always write
      // temporary files there, and nothing else under the temp root opens up.
      if (scratchpad) config = withScratchpad(config, scratchpad.dir);
      applyOverlay(config);
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
  ): Promise<void> => {
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
  };

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

  type SessionGrantResult = { ok: true } | { ok: false; reason: string };

  /**
   * Apply a session-scope grant to the in-memory layer and refresh the runtime.
   * The candidate layer is validated first: the runtime schema rejects some
   * targets (e.g. `host:*`, a URL, a relative path), and adopting one would make
   * every later loadConfig fail — which disables the sandbox for the rest of the
   * session instead of refusing that one request.
   */
  const applySessionGrant = async (
    ctx: ExtensionContext,
    surface: SandboxSurface,
    target: string,
  ): Promise<SessionGrantResult> => {
    const candidate = withSessionException(sessionConfig as SessionLayer, surface, target) as typeof sessionConfig;
    try {
      loadConfig({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        configDirName: CONFIG_DIR_NAME,
        allowProjectConfig: projectApproved,
        sessionConfig: candidate,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    sessionConfig = candidate;
    await reloadConfig(ctx, false);
    return { ok: true };
  };

  type HumanExceptionDecision = { kind: "allow"; scope: SandboxScope } | { kind: "deny"; reason?: string };

  /**
   * `executeTool` exists on the context passed to a tool's `execute()` (Pi 1.0+);
   * the vendored types predate it, so it is discovered structurally and its
   * absence is a plain denial.
   */
  type SupervisorChannel = {
    executeTool?: (name: string, args: unknown) => Promise<{
      isError: boolean;
      result: { content: ReadonlyArray<{ type: string; text?: string }> };
    }>;
  };

  /**
   * Human fallback, reached only when guardian defers or is absent. A subagent
   * has no UI, so it asks its supervisor instead (pi-subagents'
   * `contact_supervisor`), which surfaces the question in the parent session.
   */
  const askHumanForException = async (
    ctx: ExtensionContext,
    surface: SandboxSurface,
    target: string,
    reason?: string,
  ): Promise<HumanExceptionDecision> => {
    if (ctx.hasUI) {
      const choice = await ctx.ui.select(`Allow a sandbox exception for ${surface} ${target}?`, [
        "Allow for this session",
        "Deny",
      ]);
      return choice === "Allow for this session" ? { kind: "allow", scope: "session" } : { kind: "deny" };
    }
    const escalate = (ctx as unknown as SupervisorChannel).executeTool;
    if (typeof escalate !== "function") {
      return { kind: "deny", reason: "no UI and no supervisor channel is available" };
    }
    try {
      const outcome = await escalate.call(ctx, "contact_supervisor", {
        reason: "need_decision",
        message: supervisorQuestion({ surface, target, reason, cwd: ctx.cwd }),
      });
      const text = outcome.result.content
        .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
        .join("\n")
        .trim();
      const decision = parseSupervisorDecision(text);
      if (decision) return decision;
      if (outcome.isError) return { kind: "deny", reason: `the supervisor channel failed: ${text.slice(0, 200)}` };
      return { kind: "deny", reason: `the supervisor reply was not a decision: ${text.slice(0, 200)}` };
    } catch (error) {
      return { kind: "deny", reason: error instanceof Error ? error.message : String(error) };
    }
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
      "When a command fails because of the sandbox, re-run the same call with `sandbox_permissions: \"with_additional_permissions\"` plus `additional_permissions.file_system.{read,write}` and a `justification` (widened for that command only), or `sandbox_permissions: \"require_escalated\"` when it must run on the host (host credentials, host services). `prefix_rule` may propose a narrow standing rule such as [\"git\", \"push\"].",
      "Local git work (status, diff, log, commit, branch, merge, rebase, stash) runs sandboxed; only network git that authenticates with a remote (clone, fetch, pull, push, ls-remote, submodule --remote) and gh/ssh cannot. For those, request a `command` exception for the exact command line instead of retrying, and never ask for read access to gh's config or ~/.ssh — permanently denied.",
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
    async execute(id, params: BashParams, signal, onUpdate, ctx) {
      currentContext = ctx;
      const input = { command: params.command, timeout: params.timeout };
      const local = localTool(ctx.cwd);

      if (Boolean(pi.getFlag("no-sandbox"))) {
        return local.execute(id, input, signal, onUpdate, ctx);
      }
      if (configError) throw new Error(`Sandbox configuration is invalid: ${configError}`);
      if (!config) throw new Error("Sandbox is not initialized yet; retry after session start");
      if (!sessionEnabled) {
        return local.execute(id, input, signal, onUpdate, ctx);
      }

      if (isCommandExcluded(params.command, config.excludedCommands)) {
        return local.execute(id, input, signal, onUpdate, ctx);
      }

      // Guardian-approved host execution: exact command only, consumed here, so a
      // granted `git push` can never authorise `git push; something-else`.
      if (hostGrants.consume(params.command)) {
        return local.execute(id, input, signal, onUpdate, ctx);
      }

      const runOutsideSandbox = async (reason: string, prefixRule?: string) => {
        if (!config?.allowUnsandboxedCommands) throw new Error("Unsandboxed commands are disabled by sandbox policy");
        const brokerDecision = await decideSandboxException({
          surface: "command",
          target: params.command,
          scope: "once",
          origin: "tool",
          reason,
          command: params.command,
          cwd: ctx.cwd,
        });
        if (brokerDecision.kind === "deny") {
          throw new Error(`Sandbox exception denied: ${brokerDecision.reason}`);
        }
        if (brokerDecision.kind === "defer") {
          const human = await prompts.requestUnsandboxed(params.command, persistExclusion, prefixRule);
          if (human === "deny") throw new Error("User denied running this command outside the sandbox");
          if (human === "always") await applySessionGrant(ctx, "command", params.command);
          return local.execute(id, input, signal, onUpdate, ctx);
        }
        if (brokerDecision.scope === "session") await applySessionGrant(ctx, "command", params.command);
        return local.execute(id, input, signal, onUpdate, ctx);
      };

      const escalation = planInlineEscalation(params);
      if (escalation.kind === "invalid") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sandbox escalation request rejected: ${escalation.reason}. The command did not run.`,
            },
          ],
          details: { refusal: escalation.reason },
        };
      }
      if (escalation.kind === "host") {
        return runOutsideSandbox(escalation.justification, escalation.prefixRule);
      }
      if (escalation.kind === "scoped") {
        // Widen the sandbox for this one command, run it inside, then take the
        // widening back out — no request round trip, nothing left behind.
        const applied: Array<{ surface: SandboxSurface; target: string }> = [];
        const preexisting = escalation.targets.filter((entry) =>
          hasSessionException(sessionConfig as SessionLayer, entry.surface, entry.target),
        );
        const rollback = async () => {
          const revoke = applied.filter((entry) => !preexisting.some((kept) => kept.surface === entry.surface && kept.target === entry.target));
          if (revoke.length === 0) return;
          for (const entry of revoke) {
            sessionConfig = withoutSessionException(sessionConfig as SessionLayer, entry.surface, entry.target) as typeof sessionConfig;
          }
          await reloadConfig(ctx, false);
        };
        const refuse = async (reason: string) => {
          await rollback();
          return {
            content: [
              {
                type: "text" as const,
                text: `Sandbox escalation refused (${reason}). The command did not run; do not retry it or rephrase the request.`,
              },
            ],
            details: { reason },
          };
        };
        for (const entry of escalation.targets) {
          const decision = await decideSandboxException({
            surface: entry.surface,
            target: entry.target,
            scope: "session",
            origin: "tool",
            reason: escalation.justification,
            cwd: ctx.cwd,
          });
          if (decision.kind === "deny") return refuse(decision.reason);
          if (decision.kind === "defer") {
            const human = await askHumanForException(ctx, entry.surface, entry.target, escalation.justification);
            if (human.kind !== "allow") return refuse(human.reason ?? "the user declined");
          }
          const granted = await applySessionGrant(ctx, entry.surface, entry.target);
          if (!granted.ok) return refuse(granted.reason);
          applied.push(entry);
        }
        try {
          const result = await sandboxedTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
          return withTrapHint(result, resultText(result), { cwd: ctx.cwd, scratchDir: scratchpad?.dir });
        } finally {
          await rollback();
        }
      }

      if (params.dangerouslyDisableSandbox) {
        return runOutsideSandbox("Model requested an unsandboxed retry via dangerouslyDisableSandbox.");
      }

      if (controller.canRunSandboxed()) {
        const sandboxedResult = await sandboxedTool(ctx.cwd).execute(id, input, signal, onUpdate, ctx);
        // A denied command names the exact path; tell the model how to ask for it.
        return withTrapHint(sandboxedResult, resultText(sandboxedResult), {
          cwd: ctx.cwd,
          scratchDir: scratchpad?.dir,
        });
      }
      if (config.failIfUnavailable) {
        throw new Error(`Sandbox required but unavailable: ${controller.getError() ?? "not initialized"}`);
      }
      return local.execute(id, input, signal, onUpdate, ctx);
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

  pi.on("user_bash", (event) => {
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
    if (isCommandExcluded(event.command, config.excludedCommands)) return;
    if (controller.canRunSandboxed()) {
      return {
        operations: createSandboxedBashOperations(),
      };
    }
    if (config.failIfUnavailable) {
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

  registerFileGate(pi, () => {
    const cwd = currentContext?.cwd ?? process.cwd();
    if (!config) return fallbackGatePolicy(cwd);
    const filesystem = controller.canRunSandboxed()
      ? (() => {
          const read = RuntimeSandboxManager.getFsReadConfig();
          const write = RuntimeSandboxManager.getFsWriteConfig();
          return {
            denyRead: read.denyOnly,
            allowRead: read.allowWithinDeny ?? [],
            allowWrite: write.allowOnly,
            denyWrite: write.denyWithinAllow,
          };
        })()
      : config.runtime.filesystem;
    return {
      cwd,
      policy: createFilePolicy({
        filesystem,
        credentialFiles: config.runtime.credentials?.files,
        mandatoryDenyWrite: config.hardening.mandatoryDenyWrite,
      }),
      enabled: sessionEnabled,
    };
  });

  pi.registerTool({
    name: "request_sandbox_exception",
    label: "Request sandbox exception",
    description:
      "Ask for permission to do one specific thing the sandbox blocks: an exact command, a host:port, or an absolute path. One target per call. A `command` exception runs that exact command on the host (for remote git operations such as push/clone/pull); it must be a single plain command with no chaining, redirection, or interpreter. Guardian reviews the request against the conversation, and the user decides when guardian defers. Scratch files belong in PI_SANDBOX_SCRATCH and need no exception.",
    parameters: Type.Object({
      surface: Type.Union([
        Type.Literal("command"),
        Type.Literal("network"),
        Type.Literal("read"),
        Type.Literal("write"),
      ]),
      target: Type.String({
        description: "Exact command, host:port, or absolute path. No wildcards.",
      }),
      scope: Type.Union([Type.Literal("once"), Type.Literal("session")]),
      reason: Type.String({
        description: "Why this exception is needed for the user's current task.",
      }),
    }),
    async execute(id, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      const surface = params.surface as SandboxSurface;
      const scope = params.scope as SandboxScope;
      const decision = await decideSandboxException({
        surface,
        target: params.target,
        scope,
        reason: params.reason,
        origin: "tool",
        cwd: ctx.cwd,
      });
      if (decision.kind === "deny") {
        return {
          content: [{ type: "text" as const, text: `Sandbox exception denied. ${decision.reason}` }],
          details: { decision },
        };
      }
      let human: HumanExceptionDecision | undefined;
      if (decision.kind === "defer") {
        human = await askHumanForException(ctx, surface, params.target, params.reason);
        if (human.kind !== "allow") {
          return {
            content: [
              {
                type: "text" as const,
                text: `The user did not allow this sandbox exception${human.reason ? ` (${human.reason})` : ""}. Do not retry it or rephrase it; ask how to proceed if the step matters.`,
              },
            ],
            details: { decision, refusal: human.reason },
          };
        }
      }
      const grantedScope: SandboxScope = decision.kind === "allow" ? decision.scope : (human?.kind === "allow" ? human.scope : "session");
      if (surface === "command") {
        // Host execution, exact match only. Refuse shapes that could run a
        // second command before spending a review on them.
        const refusal = hostCommandRefusal(params.target);
        if (refusal) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sandbox exception refused: ${refusal}. Ask for one plain command (for example \`git push -u origin main\`) without chaining, redirection, or an interpreter.`,
              },
            ],
            details: { refusal },
          };
        }
        hostGrants.grant(params.target, grantedScope);
        return {
          content: [
            {
              type: "text" as const,
              text: `Host execution granted (${grantedScope}) for exactly: ${params.target.trim()}. Run that command unchanged as the next bash call; it will not run inside the sandbox. ${decision.review.rationale}`,
            },
          ],
          details: { decision },
        };
      }

      const preexisting = hasSessionException(sessionConfig as SessionLayer, surface, params.target);
      if (grantedScope === "once" && surface === "network") {
        // A one-shot connection grant: the proxy asks again for the next one.
        pendingNetworkOnce.add(params.target);
      } else {
        const applied = await applySessionGrant(ctx, surface, params.target);
        if (!applied.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sandbox exception refused: ${applied.reason}. Nothing was granted and the sandbox config is unchanged; pick one target the runtime accepts (a bare host, host:port, or an absolute path) instead of retrying this shape.`,
              },
            ],
            details: { decision, refusal: applied.reason },
          };
        }
        // Expiry is keyed to the tool-call boundary: the grant survives the call
        // that granted it, is usable by the next tool call (bash, write, edit,
        // read...), and is removed once that call returns. A target that already
        // had a session grant stays granted.
        if (grantedScope === "once" && !preexisting) {
          pendingOnceGrants.push({ surface, target: params.target, grantedByToolCallId: id });
        }
      }
      const rationale = decision.review.rationale;
      return {
        content: [
          {
            type: "text" as const,
            text: `Sandbox exception granted (${grantedScope}): ${surface} ${params.target}. ${rationale} Re-run the command now; it will run inside the same sandbox with this grant.`,
          },
        ],
        details: { decision },
      };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    // `once` grants live for exactly one tool call: not the call that granted
    // them, the next one. Expiring here (not only after sandboxed bash) covers
    // write/edit/read and the excluded/unsandboxed bash paths too.
    const expiring = pendingOnceGrants.filter((grant) => grant.grantedByToolCallId !== event.toolCallId);
    pendingOnceGrants = pendingOnceGrants.filter((grant) => grant.grantedByToolCallId === event.toolCallId);
    pendingNetworkOnce.clear();
    if (expiring.length === 0) return;
    for (const grant of expiring) {
      sessionConfig = withoutSessionException(sessionConfig as SessionLayer, grant.surface, grant.target) as typeof sessionConfig;
    }
    if (ctx) await reloadConfig(ctx, false);
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionStarted = false;
    sessionEnabledOverride = undefined;
    currentContext = ctx;
    ctx.ui.setStatus("sandbox", undefined);
    prompts = new PromptCoordinator(() => currentContext);
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
    prompts.shutdown();
    violations.stop();
    currentContext = undefined;
    config = undefined;
    sessionEnabled = false;
    sessionEnabledOverride = undefined;
    sessionStarted = false;
    await controller.reset();
    pendingOnceGrants = [];
    pendingNetworkOnce.clear();
    hostGrants.clear();
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
              await setSessionSandboxEnabled(ctx, !sessionEnabled);
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
            if (!await ensureSettingsProjectApproved(ctx)) return;
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
        await setSessionSandboxEnabled(ctx, false);
        ctx.ui.notify("Sandbox disabled for this session; mandatory policy-file protection remains active", "warning");
        return;
      }
      if (args === "on") {
        await setSessionSandboxEnabled(ctx, true);
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
      const match = args.match(/^(exclude|unexclude)\s+([\s\S]+)$/);
      if (match) {
        if (!config) { ctx.ui.notify("No valid sandbox configuration", "error"); return; }
        const activeConfig = config;
        const add = match[1] === "exclude";
        const pattern = match[2]!.trim();
        await applyAfterPersist(
          () => updateProjectConfig(activeConfig.projectConfigPath, ctx.cwd, (raw) => setExcludedCommand(raw, pattern, add)),
          () => {
            if (add) {
              overlay.excludedCommands.add(pattern);
              overlay.unexcludedCommands.delete(pattern);
            } else {
              overlay.unexcludedCommands.add(pattern);
              overlay.excludedCommands.delete(pattern);
            }
          },
        );
        notifyUntrustedPersist(ctx);
        await reloadConfig(ctx, false);
        ctx.ui.notify(`${add ? "Excluded" : "Removed exclusion"}: ${pattern}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /sandbox [on|off|violations|exclude <pattern>|unexclude <pattern>]", "warning");
    },
  });
}
