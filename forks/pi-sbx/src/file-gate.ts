import { lstatSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { HumanChannel } from "./human-channel.ts";
import { authorizePathAction, mandatoryWriteBlock, type PathAction, type PathAuthorization } from "./path-authorizer.ts";
import type { FilePolicy } from "./path-policy.ts";
import { canonicalizeTarget, canRead, canTraverse, resolveReadTarget, resolveTarget } from "./path-policy.ts";

export interface FileGatePolicy {
  policy: FilePolicy;
  enabled: boolean;
}

export interface FileGateOptions {
  /**
   * Baseline policy for the event's session. A command-scoped widening lives
   * only in the SRT runtime for one serialized bash call, so it is never here.
   */
  getPolicy(ctx: ExtensionContext): FileGatePolicy | undefined;
  /** The one serialized human decision adapter shared with bash and network. */
  getHuman(): Pick<HumanChannel, "ask">;
}

function blocked(result: Exclude<PathAuthorization, { kind: "allow" }>, what: string): { block: true; reason: string } {
  if (result.kind === "deferred") {
    return { block: true, reason: `Sandbox exception deferred: ${result.reason}. ${what} did not run.` };
  }
  return { block: true, reason: `Sandbox policy blocks ${what}: ${result.reason}` };
}

export function registerFileGate(pi: ExtensionAPI, options: FileGateOptions): void {
  pi.on("tool_call", async (event, ctx) => {
    const current = options.getPolicy(ctx);
    if (!current) return;
    const { policy, enabled } = current;
    // The event's own cwd/signal: a concurrent bash call must not lend its
    // context (or its cancellation) to a native tool decision.
    const cwd = ctx.cwd;
    const signal = ctx.signal;

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const lexicalTarget = resolveTarget(event.input.path, cwd);
      const target = canonicalizeTarget(event.input.path, cwd);
      const action: PathAction = {
        surface: "write",
        target,
        aliases: lexicalTarget === target ? [] : [lexicalTarget],
        reason: `the ${event.toolName} tool target is outside the configured write allowlist`,
        origin: "tool",
        violation: "the native tool target is not writable in the baseline profile",
      };
      const what = `writing ${event.input.path}`;
      // Mandatory protection is not a sandbox mode: it stays on when the
      // sandbox is disabled, and no grant can override it.
      if (!enabled) {
        const locked = mandatoryWriteBlock(action.target, action.aliases, cwd, policy);
        return locked ? { block: true, reason: `Sandbox policy blocks ${what}: writing ${locked} is mandatory deny-write` } : undefined;
      }
      const authorization = await authorizePathAction(action, {
        cwd,
        policy,
        human: options.getHuman(),
        signal,
      });
      if (authorization.kind === "allow") {
        if (signal?.aborted) return { block: true, reason: "Sandbox approval was cancelled" };
        if (canonicalizeTarget(event.input.path, cwd) !== target) {
          return { block: true, reason: "Sandbox target changed while authorization was pending; nothing was granted for the new target" };
        }
        return;
      }
      return blocked(authorization, what);
    }
    if (!enabled) return;

    if (isToolCallEventType("read", event)) {
      const target = resolveReadTarget(event.input.path, cwd);
      const what = `reading ${event.input.path}`;
      const authorization = await authorizePathAction({
        surface: "read",
        target,
        aliases: [resolveTarget(event.input.path, cwd)],
        reason: "the read tool target is excluded by the baseline read policy",
        origin: "tool",
        violation: "the native tool target is not readable in the baseline profile",
      }, {
        cwd,
        policy,
        human: options.getHuman(),
        signal,
      });
      if (authorization.kind === "allow") {
        if (signal?.aborted) return { block: true, reason: "Sandbox approval was cancelled" };
        if (resolveReadTarget(event.input.path, cwd) !== target) {
          return { block: true, reason: "Sandbox read target changed while authorization was pending; nothing was granted for the new target" };
        }
        return;
      }
      return blocked(authorization, what);
    }

    // Traversal tools are deliberately not grantable: a one-call path grant
    // authorizes an exact target, never a recursive search of a denied subtree.
    if (isToolCallEventType("grep", event)) {
      const raw = event.input.path ?? cwd;
      const target = canonicalizeTarget(raw, cwd);
      let directory = true;
      try { directory = lstatSync(target).isDirectory(); } catch { /* built-in tool reports missing path */ }
      const allowed = directory ? canTraverse(target, cwd, policy) : canRead(target, cwd, policy);
      if (!allowed) return { block: true, reason: `Sandbox policy blocks searching ${raw}` };
      return;
    }

    if (isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      const raw = event.input.path ?? cwd;
      const target = canonicalizeTarget(raw, cwd);
      if (!canTraverse(target, cwd, policy)) return { block: true, reason: `Sandbox policy blocks traversing ${raw}` };
    }
  });
}
