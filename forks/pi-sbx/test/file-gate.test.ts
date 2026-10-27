import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerFileGate } from "../src/file-gate.ts";
import type { FilePolicy } from "../src/path-policy.ts";

type ToolCallHandler = (event: unknown) => Promise<{ block: true; reason: string } | undefined>;

function gate(root: string, policy: FilePolicy, enabled = true): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(event: string, callback: ToolCallHandler) {
      if (event === "tool_call") handler = callback;
    },
  } as unknown as ExtensionAPI;
  registerFileGate(pi, () => ({ cwd: root, policy, enabled }));
  if (!handler) throw new Error("file gate was not registered");
  return handler;
}

function policy(root: string, overrides: Partial<FilePolicy> = {}): FilePolicy {
  return {
    denyRead: [],
    allowRead: [],
    allowWrite: [root],
    denyWrite: [],
    mandatoryDenyWrite: [],
    ...overrides,
  };
}

function event(toolName: string, input: Record<string, unknown>) {
  return { type: "tool_call", toolCallId: "test", toolName, input };
}

describe("file gate", () => {
  it("checks the actual read fallback but does not apply read fallbacks to grep", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-gate-read-"));
    const literal = join(root, "don't.txt");
    const curly = join(root, "don’t.txt");
    writeFileSync(literal, "literal");
    writeFileSync(curly, "curly");
    const handler = gate(root, policy(root, { denyRead: [curly] }));

    expect(await handler(event("read", { path: literal }))).toBeUndefined();

    const missing = join(root, "isn't.txt");
    const fallback = join(root, "isn’t.txt");
    writeFileSync(fallback, "fallback");
    const fallbackHandler = gate(root, policy(root, { denyRead: [fallback] }));
    expect(await fallbackHandler(event("read", { path: missing }))).toMatchObject({ block: true });
    expect(await fallbackHandler(event("grep", { pattern: "x", path: missing }))).toBeUndefined();
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

    expect(await handler(event("ls", { path: root }))).toMatchObject({ block: true });
    expect(await handler(event("write", { path: join(root, "token.key"), content: "x" }))).toMatchObject({ block: true });
    expect(await handler(event("edit", { path: join(protectedDir, "sandbox.json"), edits: [] }))).toMatchObject({ block: true });

    const disabledHandler = gate(root, policy(root, { mandatoryDenyWrite: [protectedDir] }), false);
    expect(await disabledHandler(event("write", { path: join(root, "normal.txt"), content: "x" }))).toBeUndefined();
    expect(await disabledHandler(event("write", { path: join(protectedDir, "sandbox.json"), content: "x" }))).toMatchObject({ block: true });
  });
});
