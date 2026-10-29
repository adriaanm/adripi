import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishGuardianBrokerForTest,
  type SandboxExceptionDecision,
  type SandboxExceptionRequest,
} from "../src/broker.ts";
import { registerFileGate } from "../src/file-gate.ts";
import type { HumanChannel } from "../src/human-channel.ts";
import type { FilePolicy } from "../src/path-policy.ts";

type GateResult = { block: true; reason: string } | undefined;
type ToolCallHandler = (event: unknown, ctx: ExtensionContext) => Promise<GateResult>;
type HumanStub = Pick<HumanChannel, "ask">;

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

function broker(decide?: (request: SandboxExceptionRequest) => Promise<SandboxExceptionDecision>) {
  const requests: SandboxExceptionRequest[] = [];
  const review = vi.fn(async (request: SandboxExceptionRequest) => {
    requests.push(request);
    return decide
      ? decide(request)
      : { kind: "allow", scope: "once", review: { rationale: "allowed in test", source: "reviewer" } } as SandboxExceptionDecision;
  });
  disposers.push(publishGuardianBrokerForTest({ review }));
  return { requests, review };
}

function human(decision: Awaited<ReturnType<HumanChannel["ask"]>>): HumanStub {
  return { ask: vi.fn(async () => decision) };
}

function gate(
  root: string,
  policy: FilePolicy,
  options: { enabled?: boolean; human?: HumanStub; signal?: AbortSignal } = {},
): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(event: string, callback: ToolCallHandler) {
      if (event === "tool_call") handler = callback;
    },
  } as unknown as ExtensionAPI;
  registerFileGate(pi, {
    getPolicy: () => ({ policy, enabled: options.enabled ?? true }),
    getHuman: () => options.human ?? { ask: vi.fn(async () => ({ kind: "allow", standing: false }) as const) },
  });
  if (!handler) throw new Error("file gate was not registered");
  const registered = handler;
  return (event) => registered(event, context(root, options.signal));
}

function policy(root: string, overrides: Partial<FilePolicy> = {}): FilePolicy {
  return {
    denyRead: [],
    allowRead: [],
    allowWrite: [root],
    denyWrite: [],
    mandatoryDenyRead: [],
    mandatoryDenyWrite: [],
    ...overrides,
  };
}

function event(toolName: string, input: Record<string, unknown>) {
  return { type: "tool_call", toolCallId: "test", toolName, input };
}

function context(root: string, signal?: AbortSignal): ExtensionContext {
  return { cwd: root, signal } as ExtensionContext;
}

describe("file gate", () => {
  it("checks the actual read fallback but does not apply read fallbacks to grep", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-read-"));
    const literal = join(root, "don't.txt");
    const curly = join(root, "don’t.txt");
    writeFileSync(literal, "literal");
    writeFileSync(curly, "curly");
    const handler = gate(root, policy(root, { denyRead: [curly] }));

    expect(await handler(event("read", { path: literal }), context(root))).toBeUndefined();

    const missing = join(root, "isn't.txt");
    const fallback = join(root, "isn’t.txt");
    writeFileSync(fallback, "fallback");
    const fallbackHandler = gate(root, policy(root, { denyRead: [fallback] }));
    expect(await fallbackHandler(event("read", { path: missing }), context(root))).toMatchObject({ block: true });
    expect(await fallbackHandler(event("grep", { pattern: "x", path: missing }), context(root))).toBeUndefined();
  });

  it("enforces read traversal, normal writes, and mandatory writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-policy-"));
    const secret = join(root, "secret");
    const protectedDir = join(root, ".pi");
    mkdirSync(secret);
    mkdirSync(protectedDir);
    const handler = gate(root, policy(root, {
      denyRead: [secret],
      denyWrite: [join(root, "*.key")],
      mandatoryDenyWrite: [protectedDir],
    }));

    expect(await handler(event("ls", { path: root }), context(root))).toMatchObject({ block: true });
    expect(await handler(event("write", { path: join(root, "token.key"), content: "x" }), context(root))).toMatchObject({ block: true });
    expect(await handler(event("edit", { path: join(protectedDir, "sandbox.json"), edits: [] }), context(root))).toMatchObject({ block: true });

    const disabledHandler = gate(root, policy(root, { mandatoryDenyWrite: [protectedDir] }), { enabled: false });
    expect(await disabledHandler(event("write", { path: join(root, "normal.txt"), content: "x" }), context(root))).toBeUndefined();
    expect(await disabledHandler(event("write", { path: join(protectedDir, "sandbox.json"), content: "x" }), context(root))).toMatchObject({ block: true });
  });

  it("refuses a symlink retargeted during an asynchronous decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-retarget-"));
    const first = mkdtempSync(join(tmpdir(), "pi-sbx-gate-first-"));
    const second = mkdtempSync(join(tmpdir(), "pi-sbx-gate-second-"));
    const link = join(root, "link");
    symlinkSync(first, link);
    broker(async () => {
      unlinkSync(link); symlinkSync(second, link);
      return { kind: "allow", scope: "once", review: { rationale: "old target", source: "rule" } };
    });
    const handler = gate(root, policy(root));
    expect(await handler(event("write", { path: join(link, "x") }), context(root))).toMatchObject({
      block: true, reason: expect.stringContaining("target changed"),
    });
  });

  it("asks the one path authorizer for a grantable write and authorizes that exact target once", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-grant-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-outside-"));
    const reviewer = broker();
    const humanAsk = vi.fn();
    const handler = gate(root, policy(root), { human: { ask: humanAsk } });
    const target = join(outside, "new.txt");

    expect(await handler(event("write", { path: target, content: "x" }), context(root))).toBeUndefined();
    expect(reviewer.requests).toEqual([expect.objectContaining({
      surface: "write",
      target: join(realpathSync.native(outside), "new.txt"),
      scope: "once",
      origin: "tool",
    })]);
    expect(humanAsk).not.toHaveBeenCalled();

    // The grant belonged to the first call; the next call starts at baseline.
    expect(await handler(event("write", { path: target, content: "y" }), context(root))).toBeUndefined();
    expect(reviewer.review).toHaveBeenCalledTimes(2);
  });

  it("blocks on a final denial and never asks a human", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-deny-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-denied-"));
    broker(async () => ({ kind: "deny", reason: "not allowed by review", review: { rationale: "no", source: "reviewer" } }));
    const humanAsk = vi.fn();
    const handler = gate(root, policy(root), { human: { ask: humanAsk } });

    const result = await handler(event("write", { path: join(outside, "x"), content: "x" }), context(root));
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("not allowed by review") });
    expect(humanAsk).not.toHaveBeenCalled();
  });

  it("fails closed when Guardian publishes no broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-broker-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-nobroker-"));
    const humanAsk = vi.fn();
    const handler = gate(root, policy(root), { human: { ask: humanAsk } });

    const result = await handler(event("write", { path: join(outside, "x"), content: "x" }), context(root));
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("No guardian sandbox broker") });
    expect(humanAsk).not.toHaveBeenCalled();
  });

  it("fails closed on a deferred action with no human channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-headless-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-defer-"));
    broker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const handler = gate(root, policy(root), {
      human: { ask: vi.fn(async () => ({ kind: "unavailable", reason: "no human approval channel is available in this mode" }) as const) },
    });

    const result = await handler(event("write", { path: join(outside, "x"), content: "x" }), context(root));
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Sandbox exception deferred") });
    expect(result?.reason).toContain("no human approval channel");
  });

  it("does not authorize an action after cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-cancel-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-aborted-"));
    const reviewer = broker(async () => ({ kind: "defer", review: { rationale: "ask", source: "reviewer" } }));
    const controller = new AbortController();
    controller.abort();
    const handler = gate(root, policy(root), { signal: controller.signal });

    const result = await handler(event("write", { path: join(outside, "x"), content: "x" }), context(root));
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("cancelled") });
    expect(reviewer.review).not.toHaveBeenCalled();

    // Cancellation that arrives while the human is deciding still refuses.
    const pending = new AbortController();
    const late = gate(root, policy(root), {
      signal: pending.signal,
      human: {
        ask: vi.fn(async () => {
          pending.abort();
          return { kind: "allow", standing: false } as const;
        }),
      },
    });
    const lateResult = await late(event("write", { path: join(outside, "y"), content: "x" }), context(root));
    expect(lateResult).toMatchObject({ block: true, reason: expect.stringContaining("cancelled") });
  });

  it("resolves a new file through a symlink and authorizes the canonical target", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-link-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-link-out-"));
    mkdirSync(join(outside, "dir"));
    symlinkSync(outside, join(root, "link"));
    const reviewer = broker();
    const handler = gate(root, policy(root));

    const lexical = join(root, "link", "dir", "new.txt");
    expect(await handler(event("write", { path: lexical, content: "x" }), context(root))).toBeUndefined();
    expect(reviewer.requests[0]?.target).toBe(join(realpathSync.native(outside), "dir", "new.txt"));
    expect(reviewer.requests[0]?.target).not.toBe(lexical);
  });

  it("never lets a lexical alias or a deny list bypass mandatory and configured locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-locks-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-gate-locks-out-"));
    symlinkSync(outside, join(root, ".pi"));
    const reviewer = broker();
    const humanAsk = vi.fn();
    const handler = gate(root, policy(root, { mandatoryDenyWrite: [join(root, ".pi")] }), { human: { ask: humanAsk } });

    // Lexical `.pi` is mandatory deny-write even though the canonical target is
    // outside the workspace.
    const viaLink = await handler(event("write", { path: join(root, ".pi", "config.json"), content: "x" }), context(root));
    expect(viaLink).toMatchObject({ block: true, reason: expect.stringContaining("mandatory") });
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(humanAsk).not.toHaveBeenCalled();

    const denyHandler = gate(root, policy(root, { denyWrite: [join(outside, "*.key")] }));
    const denied = await denyHandler(event("write", { path: join(outside, "secret.key"), content: "x" }), context(root));
    expect(denied).toMatchObject({ block: true, reason: expect.stringContaining("deny-write") });
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("does not grant a credential read and never widens grep/find/ls", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-readlock-"));
    const secret = join(root, "auth.json");
    writeFileSync(secret, "{}");
    const reviewer = broker();
    const handler = gate(root, policy(root, { denyRead: [secret], mandatoryDenyRead: [secret] }));

    const read = await handler(event("read", { path: secret }), context(root));
    expect(read).toMatchObject({ block: true, reason: expect.stringContaining("never grantable") });

    const protectedDir = join(root, "vault");
    mkdirSync(protectedDir);
    const traversalHandler = gate(root, policy(root, { denyRead: [protectedDir] }));
    expect(await traversalHandler(event("grep", { pattern: "x", path: protectedDir }), context(root)))
      .toMatchObject({ block: true, reason: expect.stringContaining("Sandbox policy blocks searching") });
    expect(await traversalHandler(event("find", { path: protectedDir }), context(root)))
      .toMatchObject({ block: true, reason: expect.stringContaining("Sandbox policy blocks traversing") });
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("decides with the event context rather than a stored one", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-context-"));
    const other = mkdtempSync(join(tmpdir(), "pi-sbx-gate-other-"));
    let seen: string | undefined;
    let handler: ToolCallHandler | undefined;
    const pi = {
      on(_event: string, callback: ToolCallHandler) { handler = callback; },
    } as unknown as ExtensionAPI;
    registerFileGate(pi, {
      getPolicy: (ctx) => {
        seen = ctx.cwd;
        return { policy: policy(ctx.cwd), enabled: true };
      },
      getHuman: () => ({ ask: vi.fn() }),
    });

    expect(await handler!(event("write", { path: join(other, "x"), content: "x" }), context(other))).toBeUndefined();
    expect(seen).toBe(other);
    expect(root).not.toBe(other);
  });
});
