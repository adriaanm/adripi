import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  updateConfig: vi.fn(),
  reset: vi.fn(async () => undefined),
  isSupportedPlatform: vi.fn(() => true),
  isSandboxingEnabled: vi.fn(() => true),
  checkDependencies: vi.fn(() => ({ errors: [] as string[], warnings: [] as string[] })),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: runtime }));

import { SandboxController } from "../src/manager.ts";
import type { EffectiveSandboxConfig } from "../src/config.ts";

function config(overrides: Partial<EffectiveSandboxConfig> = {}): EffectiveSandboxConfig {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: true,
    excludedCommands: [],
    environment: { deny: [] },
    runtime: {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] },
    },
    hardening: { denyRead: [], denyWrite: [], mandatoryDenyWrite: [] },
    globalConfigPath: "/tmp/global.json",
    projectConfigPath: "/tmp/project.json",
    projectApplied: false,
    warnings: [],
    ...overrides,
  } as EffectiveSandboxConfig;
}

const ask = async () => false;

describe("sandbox controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.isSupportedPlatform.mockReturnValue(true);
    runtime.isSandboxingEnabled.mockReturnValue(true);
    runtime.checkDependencies.mockReturnValue({ errors: [], warnings: [] });
  });

  it("initializes the runtime once for concurrent calls", async () => {
    let release!: () => void;
    runtime.initialize.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const controller = new SandboxController();
    const cfg = config();
    const first = controller.initialize(cfg, ask);
    const second = controller.initialize(cfg, ask);
    expect(controller.getState()).toBe("initializing");
    release();
    await Promise.all([first, second]);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("active");
    expect(controller.canRunSandboxed()).toBe(true);
  });

  it("fails closed after an initialization error and supports retry", async () => {
    runtime.initialize.mockRejectedValueOnce(new Error("bwrap missing"));
    const controller = new SandboxController();
    await expect(controller.initialize(config(), ask)).rejects.toThrow("bwrap missing");
    expect(controller.getState()).toBe("unavailable");
    expect(controller.getError()).toContain("bwrap missing");
    expect(controller.shouldFailClosed()).toBe(true);

    runtime.initialize.mockResolvedValueOnce(undefined);
    await controller.initialize(config(), ask);
    expect(controller.getState()).toBe("active");
    expect(controller.shouldFailClosed()).toBe(false);
  });

  it("fails closed on missing dependencies without touching the runtime", async () => {
    runtime.checkDependencies.mockReturnValue({ errors: ["bubblewrap not found"], warnings: [] });
    const controller = new SandboxController();
    await expect(controller.initialize(config(), ask)).rejects.toThrow(/bubblewrap/);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("unavailable");
  });

  it("stays disabled when config disables the sandbox", async () => {
    const controller = new SandboxController();
    await controller.initialize(config({ enabled: false }), ask);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("disabled");
    expect(controller.shouldFailClosed()).toBe(false);
  });

  it("refreshes runtime config only while active", async () => {
    runtime.initialize.mockResolvedValue(undefined);
    const controller = new SandboxController();
    const cfg = config();

    controller.refresh(cfg);
    expect(runtime.updateConfig).not.toHaveBeenCalled();

    await controller.initialize(cfg, ask);
    controller.refresh(cfg);
    expect(runtime.updateConfig).toHaveBeenCalledTimes(1);
    expect(runtime.updateConfig).toHaveBeenCalledWith(cfg.runtime);
  });

  it("resets state and the runtime", async () => {
    runtime.initialize.mockResolvedValue(undefined);
    const controller = new SandboxController();
    await controller.initialize(config(), ask);
    await controller.reset();
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("disabled");
    expect(controller.getError()).toBeUndefined();
  });

  it("waits for and invalidates an initialization that overlaps reset", async () => {
    let release!: () => void;
    runtime.initialize.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const controller = new SandboxController();
    const initializing = controller.initialize(config(), ask);
    const resetting = controller.reset();
    expect(runtime.reset).not.toHaveBeenCalled();
    release();
    await Promise.all([initializing, resetting]);
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("disabled");
    expect(controller.canRunSandboxed()).toBe(false);
  });
});
