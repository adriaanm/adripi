import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  localExec: vi.fn(),
  wrapWithSandbox: vi.fn(),
  annotate: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createLocalBashOperations: () => ({ exec: mocks.localExec }),
  };
});

vi.mock("../src/manager.ts", () => ({
  RuntimeSandboxManager: {
    wrapWithSandbox: mocks.wrapWithSandbox,
    annotateStderrWithSandboxFailures: mocks.annotate,
    cleanupAfterCommand: mocks.cleanup,
  },
}));

import { createSandboxedBashOperations } from "../src/bash-operations.ts";

describe("sandboxed bash operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wrapWithSandbox.mockResolvedValue("wrapped");
    mocks.localExec.mockResolvedValue({ exitCode: 0 });
    mocks.annotate.mockImplementation((_id: string, output: string) => output);
  });

  it("does not add the macOS settle delay on Linux", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const operations = createSandboxedBashOperations();
    await operations.exec("echo ok", "/tmp", { onData: vi.fn() });
    expect(timeout).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    platform.mockRestore();
    timeout.mockRestore();
  });

  it("emits model-visible violation annotations", async () => {
    mocks.localExec.mockImplementation(async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
      options.onData(Buffer.from("output"));
      return { exitCode: 1 };
    });
    mocks.annotate.mockImplementation((_id: string, output: string) => `${output}\n<sandbox_violations>deny</sandbox_violations>`);
    const onData = vi.fn();
    await createSandboxedBashOperations().exec("blocked", "/tmp", { onData });
    expect(Buffer.concat(onData.mock.calls.map(([data]) => data)).toString()).toContain("<sandbox_violations>");
  });

  it("cleans runtime command state even when wrapping fails", async () => {
    mocks.wrapWithSandbox.mockRejectedValue(new Error("wrap failed"));
    await expect(createSandboxedBashOperations().exec("bad", "/tmp", { onData: vi.fn() })).rejects.toThrow("wrap failed");
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
