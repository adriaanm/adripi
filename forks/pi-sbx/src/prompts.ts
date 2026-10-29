import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UnsandboxedDecision = "once" | "always" | "deny";

type ContextProvider = () => ExtensionContext | undefined;

export class PromptCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private pendingNetwork = new Map<string, Promise<boolean>>();
  private readonly abortController = new AbortController();

  constructor(private readonly getContext: ContextProvider) {}

  private enqueue<T>(fallback: T, operation: (ctx: ExtensionContext, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.resolve(fallback);
    let resolveResult!: (value: T) => void;
    const result = new Promise<T>((resolve) => { resolveResult = resolve; });
    const run = async () => {
      const ctx = this.getContext();
      if (this.closed || !ctx?.hasUI) {
        resolveResult(fallback);
        return;
      }
      try {
        resolveResult(await operation(ctx, this.abortController.signal));
      } catch {
        resolveResult(fallback);
      }
    };
    this.tail = this.tail.then(run, run);
    return result;
  }

  requestNetwork(hostPattern: NetworkHostPattern, persist: (host: string) => Promise<void>): Promise<boolean> {
    const key = `${hostPattern.host}:${hostPattern.port ?? "*"}`;
    const existing = this.pendingNetwork.get(key);
    if (existing) return existing;

    const request = this.enqueue(false, async (ctx, signal) => {
      const host = hostPattern.port ? `${hostPattern.host}:${hostPattern.port}` : hostPattern.host;
      const choice = await ctx.ui.select(`Sandbox network request: ${host}`, [
        "Allow once",
        `Always allow ${hostPattern.host}`,
        "Deny",
      ], { signal });
      if (choice === `Always allow ${hostPattern.host}`) {
        try {
          await persist(hostPattern.host);
        } catch (error) {
          ctx.ui.notify(`Could not persist domain: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return true;
      }
      return choice === "Allow once";
    }).finally(() => this.pendingNetwork.delete(key));
    this.pendingNetwork.set(key, request);
    return request;
  }

  requestUnsandboxed(
    command: string,
    persist: (pattern: string) => Promise<void>,
    prefixRule?: string,
  ): Promise<UnsandboxedDecision> {
    const alwaysLabel = prefixRule ? `Always allow ${prefixRule}` : "Always allow this exact command";
    return this.enqueue<UnsandboxedDecision>("deny", async (ctx, signal) => {
      const choice = await ctx.ui.select(`Run outside sandbox?\n${command}`, [
        "Run once",
        alwaysLabel,
        "Deny",
      ], { signal });
      if (choice === alwaysLabel) {
        try {
          await persist(prefixRule ?? command.trim());
        } catch (error) {
          ctx.ui.notify(`Could not persist exclusion: ${error instanceof Error ? error.message : String(error)}`, "warning");
          return "once";
        }
        return "always";
      }
      return choice === "Run once" ? "once" : "deny";
    });
  }

  shutdown(): void {
    this.closed = true;
    this.abortController.abort();
    this.pendingNetwork.clear();
  }
}
