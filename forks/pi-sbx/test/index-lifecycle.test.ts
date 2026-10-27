import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sandboxExtension from "../src/index.ts";

describe("extension lifecycle gates", () => {
  it("fails user bash closed before session initialization", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const tools: Array<{ name: string; renderResult?: unknown }> = [];
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      registerTool(tool: { name: string; renderResult?: unknown }) { tools.push(tool); },
      registerCommand: vi.fn(),
      on(event: string, handler: (...args: unknown[]) => unknown) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);
    const result = handlers.get("user_bash")?.({ command: "echo unsafe", cwd: process.cwd(), excludeFromContext: false });
    expect(result).toMatchObject({ result: { exitCode: 1, output: expect.stringContaining("initializing") } });
    expect(tools.find((tool) => tool.name === "bash")?.renderResult).toBeTypeOf("function");
  });
});
