import {
  SandboxManager as RuntimeSandboxManager,
  type SandboxAskCallback,
  type SandboxDependencyCheck,
} from "@anthropic-ai/sandbox-runtime";
import type { EffectiveSandboxConfig } from "./config.ts";

export type SandboxState = "disabled" | "initializing" | "active" | "unavailable";

export class SandboxController {
  private initialization?: Promise<void>;
  private state: SandboxState = "disabled";
  private error?: string;
  private config?: EffectiveSandboxConfig;
  private generation = 0;

  getState(): SandboxState { return this.state; }
  getError(): string | undefined { return this.error; }
  getConfig(): EffectiveSandboxConfig | undefined { return this.config; }

  checkDependencies(): SandboxDependencyCheck {
    return RuntimeSandboxManager.checkDependencies();
  }

  isSupported(): boolean {
    return process.platform !== "win32" && RuntimeSandboxManager.isSupportedPlatform();
  }

  async initialize(config: EffectiveSandboxConfig, askCallback: SandboxAskCallback): Promise<void> {
    this.config = config;
    this.error = undefined;
    if (!config.enabled) {
      this.state = "disabled";
      return;
    }
    if (this.initialization) return this.initialization;
    this.state = "initializing";
    const generation = this.generation;
    this.initialization = (async () => {
      if (!this.isSupported()) throw new Error(`Unsupported platform: ${process.platform}`);
      const dependencies = this.checkDependencies();
      if (dependencies.errors.length) throw new Error(`Missing sandbox dependencies: ${dependencies.errors.join(", ")}`);
      await RuntimeSandboxManager.initialize(config.runtime, askCallback);
      if (generation === this.generation) this.state = "active";
    })().catch((error) => {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : String(error);
        this.state = "unavailable";
        this.initialization = undefined;
      }
      throw error;
    });
    return this.initialization;
  }

  refresh(config: EffectiveSandboxConfig): void {
    this.config = config;
    if (this.state === "active") RuntimeSandboxManager.updateConfig(config.runtime);
  }

  setSessionEnabled(enabled: boolean): void {
    if (!enabled) this.state = "disabled";
    else if (this.config && RuntimeSandboxManager.isSandboxingEnabled()) this.state = "active";
  }

  canRunSandboxed(): boolean { return this.state === "active"; }

  shouldFailClosed(): boolean {
    return Boolean(this.config?.enabled && this.config.failIfUnavailable && this.state === "unavailable");
  }

  async reset(): Promise<void> {
    this.generation += 1;
    const pending = this.initialization;
    this.initialization = undefined;
    this.state = "disabled";
    this.error = undefined;
    await pending?.catch(() => undefined);
    await RuntimeSandboxManager.reset();
  }
}

export { RuntimeSandboxManager };
