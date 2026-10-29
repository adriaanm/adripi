import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The one human decision point for every sandbox surface.
 *
 * Paths (one execution), a host command (one execution) and a network
 * connection all differ in what the user is told, not in how the answer is
 * obtained. Keeping one adapter means there is one place that decides what
 * happens when no supported channel exists — which is to fail closed with an
 * explanation, never to infer consent.
 */

export type HumanSurface = "command" | "read" | "write" | "network";

export interface HumanRequest {
  surface: HumanSurface;
  target: string;
  reason?: string;
  /**
   * A validated standing rule (`command:git push:*`, `network:example.com`)
   * the human may save. Only guardian's project-policy service persists it.
   */
  standingRule?: string;
  /** Wording for the once-only option when the action is not a command. */
  onceLabel?: string;
}

export type HumanDecision =
  | { kind: "allow"; standing: boolean }
  | { kind: "deny"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * What the model is told when the process has no UI (print, JSON, headless).
 * A deferred exception needs a person; fabricating an allow would be the
 * failure this message exists to prevent.
 */
export function approvalUnavailableReason(input: { cwd: string; policyPath: string }): string {
  return [
    "no human approval channel is available in this mode (ctx.hasUI is false: print, JSON or headless)",
    "a deferred sandbox exception needs a person to decide, so the action did not run",
    `re-run in an interactive session (TUI or RPC), or ask the user to add the standing rule to the project policy (${input.policyPath}) for ${input.cwd}`,
  ].join("; ");
}

export class HumanChannel {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly abortController = new AbortController();

  private readonly getContext: () => ExtensionContext | undefined;
  private readonly policyPath: () => string;

  constructor(getContext: () => ExtensionContext | undefined, policyPath: () => string) {
    this.getContext = getContext;
    this.policyPath = policyPath;
  }

  private enqueue<T>(
    fallback: T,
    operation: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>,
    commandSignal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.resolve(fallback);
    let resolveResult!: (value: T) => void;
    const result = new Promise<T>((resolve) => { resolveResult = resolve; });
    const run = async () => {
      const ctx = this.getContext();
      const signal = commandSignal
        ? AbortSignal.any([this.abortController.signal, commandSignal])
        : this.abortController.signal;
      if (this.closed || !ctx || signal.aborted) {
        resolveResult(fallback);
        return;
      }
      try {
        const value = await operation(ctx, signal);
        resolveResult(signal.aborted ? fallback : value);
      } catch {
        resolveResult(fallback);
      }
    };
    this.tail = this.tail.then(run, run);
    return result;
  }

  /** Ask once for one execution (or one connection). */
  ask(request: HumanRequest, commandSignal?: AbortSignal): Promise<HumanDecision> {
    if (this.closed) return Promise.resolve({ kind: "deny", reason: "the sandbox approval channel is closed" });
    return this.enqueue<HumanDecision>({ kind: "deny", reason: "the sandbox approval question could not be answered, so the action did not run" }, async (ctx, signal) => {
      if (!ctx.hasUI) {
        return {
          kind: "unavailable",
          reason: approvalUnavailableReason({ cwd: ctx.cwd, policyPath: this.policyPath() }),
        };
      }
      const standingLabel = request.standingRule ? `Always allow ${request.standingRule}` : undefined;
      const allowLabel = request.onceLabel
        ?? (request.surface === "command" ? "Run once outside the sandbox"
          : request.surface === "network" ? "Allow this connection" : "Allow for this command");
      const options = [allowLabel, ...(standingLabel ? [standingLabel] : []), "Deny"];
      const title = [
        request.surface === "command"
          ? `Run this command outside the sandbox?\n${request.target}`
          : `Allow the sandbox exception?\n${request.surface}: ${request.target}`,
        ...(request.reason ? [`\nWhy: ${request.reason}`] : []),
      ].join("");
      const choice = await ctx.ui.select(title, options, { signal });
      if (standingLabel && choice === standingLabel) return { kind: "allow", standing: true };
      if (choice === allowLabel) return { kind: "allow", standing: false };
      return { kind: "deny", reason: "the user denied the sandbox exception" };
    }, commandSignal);
  }

  /**
   * A reviewer already allowed a call, but a proposed standing rule is still the
   * human's decision. No UI means the rule is not saved.
   */
  confirmStanding(rule: string, commandSignal?: AbortSignal): Promise<boolean> {
    return this.enqueue(false, async (ctx, signal) => {
      if (!ctx.hasUI) return false;
      return ctx.ui.confirm(
        "Save a standing permission?",
        `Allow ${rule} for this project? It will be written to ${this.policyPath()} by Guardian and apply in future sessions; the command still has to request the exception.`,
        { signal },
      );
    }, commandSignal);
  }

  shutdown(): void {
    this.closed = true;
    this.abortController.abort();
  }
}
