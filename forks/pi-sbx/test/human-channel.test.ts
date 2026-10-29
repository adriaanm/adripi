import { describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalUnavailableReason, HumanChannel } from "../src/human-channel.ts";

function context(options: { hasUI?: boolean; select?: unknown; confirm?: unknown } = {}): ExtensionContext {
  return {
    cwd: "/work/project",
    hasUI: options.hasUI ?? true,
    ui: {
      select: options.select ?? vi.fn(async () => undefined),
      confirm: options.confirm ?? vi.fn(async () => false),
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

const calls = (mock: unknown): unknown[][] => (mock as Mock).mock.calls as unknown[][];

const policyPath = () => "/work/project/.pi/guardian.json";

describe("human approval channel", () => {
  it("fails closed with an actionable reason when there is no UI", async () => {
    const select = vi.fn();
    const channel = new HumanChannel(() => context({ hasUI: false, select }), policyPath);
    const decision = await channel.ask({ surface: "write", target: "/data", reason: "needs the cache" });
    expect(decision).toEqual({
      kind: "unavailable",
      reason: approvalUnavailableReason({ cwd: "/work/project", policyPath: "/work/project/.pi/guardian.json" }),
    });
    expect((decision as { reason: string }).reason).toContain("interactive session");
    expect((decision as { reason: string }).reason).toContain("/work/project/.pi/guardian.json");
    expect(select).not.toHaveBeenCalled();
    expect(await channel.confirmStanding("command:git push:*")).toBe(false);
  });

  it("asks one question and returns the human's decision", async () => {
    const select = vi.fn(async () => "Allow for this command");
    const channel = new HumanChannel(() => context({ select }), policyPath);
    expect(await channel.ask({ surface: "read", target: "/usr/share/x" })).toEqual({ kind: "allow", standing: false });
    expect(select).toHaveBeenCalledTimes(1);
    expect(String(calls(select)[0]?.[0])).toContain("read: /usr/share/x");

    select.mockResolvedValueOnce("Deny");
    expect(await channel.ask({ surface: "write", target: "/data" })).toEqual({
      kind: "deny",
      reason: "the user denied the sandbox exception",
    });
  });

  it("offers a standing rule only when one was proposed and validated", async () => {
    const select = vi.fn(async () => "Always allow command:git push:*");
    const channel = new HumanChannel(() => context({ select }), policyPath);
    expect(await channel.ask({
      surface: "command",
      target: "git push -u origin main",
      standingRule: "command:git push:*",
    })).toEqual({ kind: "allow", standing: true });
    expect((calls(select)[0]?.[1] as string[]).join(" ")).toContain("Always allow command:git push:*");
  });

  it("confirms a standing rule through the same channel", async () => {
    const confirm = vi.fn(async () => true);
    const channel = new HumanChannel(() => context({ confirm }), policyPath);
    expect(await channel.confirmStanding("command:git push:*")).toBe(true);
    expect(String(calls(confirm)[0]?.[1])).toContain("/work/project/.pi/guardian.json");
  });

  it("aborts an in-flight question on shutdown and denies afterwards", async () => {
    let sawSignal: AbortSignal | undefined;
    const select = vi.fn(
      (_title: unknown, _options: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          sawSignal = options?.signal;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const channel = new HumanChannel(() => context({ select }), policyPath);
    const pending = channel.ask({ surface: "read", target: "/data" });
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    channel.shutdown();
    expect(sawSignal?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "deny", reason: "the sandbox approval question could not be answered, so the command did not run" });
    expect(await channel.ask({ surface: "read", target: "/data" })).toEqual({
      kind: "deny",
      reason: "the sandbox approval channel is closed",
    });
  });
});
