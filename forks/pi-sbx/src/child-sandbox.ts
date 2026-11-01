import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { getShellConfig, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadInstalledChildConsumerApi, type ChildConsumerApi, type ChildConsumerLease } from "./child-consumer-api.ts";
import { compileChildConfig } from "./child-config.ts";
import { decodeChildPolicy } from "./child-policy.ts";
import { authorizePathAction, type PathAction, type PathAuthorization } from "./path-authorizer.ts";
import { canonicalizeTarget, canRead, canWrite, createFilePolicy, resolveReadTarget } from "./path-policy.ts";
import { createScratchpad, SCRATCH_PREFIX, type Scratchpad } from "./scratch.ts";
import type { ChildAction, ChildActionDecision } from "./action-authorizer.ts";
import type { ChildNativeAuthority } from "./child-native-tools.ts";

const NATIVE_NAMES = ["bash", "read", "write", "edit", "ls", "grep", "find"] as const;
const ownEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Actual consumer binding, never a root publisher, config loader or reviewer.
 * Activation is separate from preparation: main must install native/Bash
 * adapters and activate the real controller before acknowledging this role. */
export class ChildSandbox implements ChildNativeAuthority {
  private phase: "initializing" | "prepared" | "active" | "failed" | "closed" = "initializing";
  private failure = "delegated sandbox is not active";
  private lease?: ChildConsumerLease;
  private policy?: ReturnType<typeof decodeChildPolicy>;
  private sessionId?: string;
  private cwd?: string;
  private cancellation = new AbortController();
  private abortListener?: () => void;
  private shellPath?: string;
  private executionPathValue?: string;
  private executionPins: Array<{ path: string; canonical: string; stamp: string }> = [];
  private executionStamp(path: string): string {
    try { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }
  private prepareExecutionPaths(ctx: ExtensionContext): void {
    const shell = getShellConfig();
    if (!isAbsolute(shell.shell) || shell.args.length !== 1 || shell.args[0] !== "-c" || shell.commandTransport && shell.commandTransport !== "argv") throw new Error("the SDK local shell backend cannot be pinned without substitution");
    this.shellPath = shell.shell;
    this.executionPathValue = process.env.PATH;
    const policy = this.baselinePolicy();
    const directories = (process.env.PATH ?? "").split(delimiter);
    // Shipped SRT/SDK outer helpers must stay the same code after a one-action
    // admission too: directory mtime alone misses edits to an existing binary.
    const helpers = ["bash", "sh", "env", "sandbox-exec", "bwrap", "socat", "rg", "log"];
    const paths = new Set([shell.shell, ...directories, ...directories.flatMap(dir => helpers.map(name => join(dir, name)))]);
    for (const path of paths) {
      if (!path || !isAbsolute(path)) throw new Error("a relative or empty execution PATH component cannot be delegated");
      const canonical = canonicalizeTarget(path, ctx.cwd);
      if (canWrite(canonical, ctx.cwd, policy)) throw new Error("a delegated writable root overlaps a shell/PATH helper namespace");
      this.executionPins.push({ path, canonical, stamp: this.executionStamp(canonical) });
    }
  }
  shell(ctx: ExtensionContext): string { this.assertActive(ctx); return this.shellPath!; }
  scratchpad?: Scratchpad;
  config?: ReturnType<typeof compileChildConfig>;
  get signal(): AbortSignal { return this.cancellation.signal; }

  constructor(private api: ChildConsumerApi, private pi: ExtensionAPI) {}

  async prepare(ctx: ExtensionContext): Promise<void> {
    try {
      if (this.phase !== "initializing") throw new Error("delegated sandbox cannot initialize or rebind a second SDK session");
      if (ctx.hasUI) throw new Error("delegated sandbox supports only a process-isolated native background SDK session");
      this.lease = this.api.claimChildAuthority("pi-sbx", ctx.cwd);
      if (this.lease.version !== this.api.CHILD_AUTHORITY_PROVIDER_VERSION || !["pi-sbx", "pi-guardian"].every(id => this.lease!.requiredConsumers.includes(id))) throw new Error("the live lease does not require both real enforcement consumers");
      this.policy = decodeChildPolicy(this.lease.payload, ctx.cwd);
      this.cwd = ctx.cwd;
      this.sessionId = ctx.sessionManager.getSessionId();
      if (typeof this.sessionId !== "string" || !this.sessionId.trim()) throw new Error("the child SDK has no stable session identity");
      this.config = compileChildConfig(this.policy, ctx.cwd, getAgentDir());
      this.abortListener = () => { if (this.phase !== "closed" && this.phase !== "failed") this.poison("parent authority was revoked or its transport ended"); };
      this.lease.signal.addEventListener("abort", this.abortListener, { once: true });
      this.phase = "prepared";
      this.assertBound(ctx);
      this.assertNativeOwnership();
      this.prepareExecutionPaths(ctx);
      this.scratchpad = await createScratchpad(SCRATCH_PREFIX, { baseDir: this.policy.workspace.canonical, validateBeforeCreate: candidate => {
        this.assertBound(ctx);
        const target = canonicalizeTarget(candidate, ctx.cwd), policy = this.baselinePolicy();
        if (!canWrite(target, ctx.cwd, policy) || !canRead(target, ctx.cwd, policy)) throw new Error("child private scratch is not already held by its workspace policy");
      } });
      this.assertBound(ctx);
    } catch (error) {
      this.poison(message(error));
      try { await this.scratchpad?.dispose(); } catch (cleanup) { this.failure += `; scratch cleanup refused: ${message(cleanup)}`; }
      throw new Error(this.failure);
    }
  }

  /** Called only by the shared dispatcher after real controller initialization. */
  activate(ctx: ExtensionContext, controllerActive: boolean): void {
    try {
      this.assertBound(ctx);
      if (this.phase !== "prepared" || !controllerActive) throw new Error("actual child sandbox controller/adapters are not active");
      this.assertNativeOwnership();
      this.phase = "active";
      this.api.acknowledgeChildAuthority("pi-sbx");
      this.assertBound(ctx);
    } catch (error) { this.poison(message(error)); throw error; }
  }

  private baselinePolicy() {
    if (!this.config) throw new Error(this.failure);
    return createFilePolicy({ filesystem: this.config.runtime.filesystem, credentialFiles: this.config.runtime.credentials?.files,
      mandatoryDenyRead: this.config.hardening.denyRead, mandatoryDenyWrite: this.config.hardening.mandatoryDenyWrite });
  }
  private assertNativeOwnership(): void {
    const registry = this.pi.getAllTools();
    const expected = canonicalizeTarget(ownEntry, this.cwd!);
    for (const name of NATIVE_NAMES) {
      const matches = registry.filter(tool => tool.name === name);
      if (matches.length !== 1 || !matches[0].sourceInfo?.path || canonicalizeTarget(matches[0].sourceInfo.path, this.cwd!) !== expected) {
        throw new Error(`delegated native ${name} is not owned by the actual installed sandbox adapter`);
      }
    }
  }
  private assertBound(ctx: ExtensionContext): void {
    if (!["prepared", "active"].includes(this.phase) || !this.lease || !this.policy || this.signal.aborted || this.lease.signal.aborted) throw new Error(this.failure);
    if (ctx.signal?.aborted || ctx.cwd !== this.cwd || ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("the child SDK action identity/cancellation changed");
    decodeChildPolicy(this.policy, ctx.cwd);
    if (this.shellPath && process.env.PATH !== this.executionPathValue) throw new Error("the SDK execution PATH changed");
    for (const pin of this.executionPins) {
      if (canonicalizeTarget(pin.path, ctx.cwd) !== pin.canonical || this.executionStamp(pin.canonical) !== pin.stamp) throw new Error("the pinned SDK shell/PATH helper provenance changed");
    }
  }
  assertActive(ctx: ExtensionContext): void {
    try {
      this.assertBound(ctx);
      if (this.phase !== "active") throw new Error(this.failure);
      this.lease!.assertReady();
      this.assertNativeOwnership();
    } catch (error) { this.poison(message(error)); throw error; }
  }
  filePolicy(ctx: ExtensionContext) { this.assertActive(ctx); return this.baselinePolicy(); }

  async request(action: ChildAction, ctx: ExtensionContext, signal?: AbortSignal): Promise<ChildActionDecision> {
    this.assertActive(ctx);
    const combined = AbortSignal.any([this.signal, ...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])]);
    if (combined.aborted) throw new Error("child action was cancelled");
    try {
      const decision = await this.lease!.request(action, combined);
      this.assertActive(ctx);
      if (combined.aborted) throw new Error("child action ended before parent decision consumption");
      if (decision.terminate) this.poison(decision.rationale ?? "the parent terminated the child authority");
      return decision;
    } catch (error) { this.poison(message(error)); throw error; }
  }

  async authorizePath(action: PathAction, ctx: ExtensionContext, signal: AbortSignal): Promise<PathAuthorization> {
    this.assertActive(ctx);
    const resolve = action.surface === "read" ? resolveReadTarget : canonicalizeTarget;
    const aliases = (action.aliases ?? []).map(spelled => ({ spelled, canonical: resolve(spelled, ctx.cwd) }));
    const result = await authorizePathAction(action, { cwd: ctx.cwd, policy: this.baselinePolicy(), signal: AbortSignal.any([this.signal, signal]),
      requireCurrentDecision: true,
      decide: async request => {
        const decision = await this.request({ surface: action.surface, target: request.target, reason: request.reason ?? "Admit this one delegated path action" }, ctx, signal);
        if (decision.outcome === "allow") return { kind: "allow" };
        const kind = decision.outcome === "unavailable" ? "deferred" : decision.outcome === "cancelled" ? "cancelled" : "deny";
        return { kind, reason: decision.rationale ?? `parent decision: ${decision.outcome}` };
      },
      human: { ask: async () => ({ kind: "unavailable", reason: "a child has no independent human approval channel" }) },
    });
    this.assertActive(ctx);
    if (aliases.some(pin => resolve(pin.spelled, ctx.cwd) !== pin.canonical)) throw new Error("delegated path alias changed during parent admission");
    return result;
  }
  poison(reason: string): void {
    if (this.phase === "closed") return;
    this.failure = reason; this.phase = "failed";
    this.cancellation.abort(new Error(reason)); this.lease?.dispose();
  }
  close(): void {
    this.phase = "closed"; this.failure = "the delegated sandbox session ended";
    if (this.abortListener) this.lease?.signal.removeEventListener("abort", this.abortListener);
    this.cancellation.abort(new Error(this.failure)); this.lease?.dispose();
  }
}

/** Blocking guard precedes asynchronous installed-API lookup. Only the public
 * detector proving inactivity may enter ordinary root registration. */
export async function registerChildSandbox(pi: ExtensionAPI, root: () => void, install: (binding: ChildSandbox) => void,
  options: { loadApi?: () => Promise<ChildConsumerApi> } = {}): Promise<void> {
  let phase: "initializing" | "root" | "child" | "failed" = "initializing";
  let binding: ChildSandbox | undefined;
  let failure = "the delegated sandbox is not initialized";
  pi.on("tool_call", (event, ctx) => {
    if (phase === "root") return;
    try {
      if (phase !== "child" || !binding) throw new Error(failure);
      binding.assertActive(ctx);
      if (!(NATIVE_NAMES as readonly string[]).includes(event.toolName)) throw new Error(`unsupported delegated tool ${event.toolName}; no bounded native adapter is installed`);
    } catch (error) { return { block: true, reason: `Child sandbox blocked the action: ${message(error)}` }; }
  });
  try {
    const api = await (options.loadApi ?? (() => loadInstalledChildConsumerApi(getAgentDir())))();
    const child = api.hasChildAuthorityContext();
    if (typeof child !== "boolean") throw new Error("the public child-context detector returned no boolean role");
    if (!child) { phase = "root"; root(); return; }
    binding = new ChildSandbox(api, pi); phase = "child"; install(binding);
  } catch (error) { phase = "failed"; failure = message(error); binding?.poison(failure); throw error; }
}
