import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { PromptCoordinator } from "../src/prompts.ts";
import { removeSandboxViolationTags, ViolationTracker } from "../src/violations.ts";

function context(select: (...args: unknown[]) => Promise<string | undefined>): ExtensionContext {
  return {
    hasUI: true,
    ui: { select, notify: vi.fn() },
  } as unknown as ExtensionContext;
}

describe("prompts and violations", () => {
  it("deduplicates concurrent network prompts for the same host", async () => {
    const select = vi.fn(async () => "Allow once");
    const coordinator = new PromptCoordinator(() => context(select));
    const persist = vi.fn(async () => undefined);
    const [first, second] = await Promise.all([
      coordinator.requestNetwork({ host: "example.test", port: 443 }, persist),
      coordinator.requestNetwork({ host: "example.test", port: 443 }, persist),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("persists always-allow and fails closed after shutdown", async () => {
    const select = vi.fn(async () => "Always allow example.test");
    const persist = vi.fn(async () => undefined);
    const coordinator = new PromptCoordinator(() => context(select));
    expect(await coordinator.requestNetwork({ host: "example.test", port: undefined }, persist)).toBe(true);
    expect(persist).toHaveBeenCalledWith("example.test");
    coordinator.shutdown();
    expect(await coordinator.requestUnsandboxed("echo ok", async () => undefined)).toBe("deny");
  });

  it("aborts an in-flight prompt on shutdown", async () => {
    let sawSignal: AbortSignal | undefined;
    const select = vi.fn(
      (_title: unknown, _options: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          sawSignal = opts?.signal;
          opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const coordinator = new PromptCoordinator(() => context(select as never));
    const pending = coordinator.requestNetwork({ host: "hang.test", port: undefined }, async () => undefined);
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    coordinator.shutdown();
    expect(sawSignal?.aborted).toBe(true);
    expect(await pending).toBe(false);
  });

  it("tracks recent violations and removes model-only tags", () => {
    const store = new SandboxViolationStore();
    const tracker = new ViolationTracker();
    tracker.start(store);
    store.addViolation({ line: "deny file-write", command: "test", timestamp: new Date() });
    expect(tracker.getTotal()).toBe(1);
    expect(tracker.getRecent()[0]?.line).toBe("deny file-write");
    expect(removeSandboxViolationTags("visible\n<sandbox_violations>\ndeny\n</sandbox_violations>")).toBe("visible");
    tracker.stop();
  });
});
