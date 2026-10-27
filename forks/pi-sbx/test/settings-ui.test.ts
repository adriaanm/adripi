import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type ConfigScope } from "../src/config.ts";
import {
  formatEffectiveConfig,
  SandboxSettingsComponent,
  type SandboxSettingsActions,
} from "../src/settings-ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-sbx-settings-ui-"));
  const agent = join(root, "agent");
  mkdirSync(join(root, ".pi"));
  mkdirSync(join(agent, "extensions"), { recursive: true });
  writeFileSync(join(agent, "extensions", "sandbox.json"), JSON.stringify({
    network: { allowedDomains: ["global.test"] },
  }));
  writeFileSync(join(root, ".pi", "sandbox.json"), JSON.stringify({
    network: { allowedDomains: ["project.test"] },
  }));
  return loadConfig({
    cwd: root,
    agentDir: agent,
    configDirName: ".pi",
    allowProjectConfig: true,
    sessionConfig: {
      network: { allowedDomains: ["session.test"] },
      enableWeakerNestedSandbox: true,
    },
  });
}

describe("sandbox settings UI", () => {
  it("renders rules through the selected scope instead of flattening effective config", () => {
    const config = fixture();
    let scope: ConfigScope = "global";
    const actions: SandboxSettingsActions = {
      getConfig: () => config,
      getSessionEnabled: () => true,
      getScope: () => scope,
      getSummary: () => "ok",
      cycleScope: () => {
        scope = scope === "global" ? "project" : "session";
      },
      toggle: vi.fn(async () => undefined),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      editRaw: vi.fn(async () => undefined),
      close: vi.fn(),
      requestRender: vi.fn(),
      reportError: vi.fn(),
    };
    const component = new SandboxSettingsComponent(theme, actions);

    component.handleInput("\x1b[C");
    let rendered = component.render(200).join("\n");
    expect(rendered).toContain("global.test");
    expect(rendered).not.toContain("project.test");

    component.handleInput("s");
    rendered = component.render(200).join("\n");
    expect(rendered).toContain("project.test");
    expect(rendered).not.toContain("session.test");

    component.handleInput("s");
    rendered = component.render(200).join("\n");
    expect(rendered).toContain("session.test");
  });

  it("cancels embedded rule input without closing or wedging the settings UI", () => {
    const config = fixture();
    const add = vi.fn(async () => undefined);
    const close = vi.fn();
    const actions: SandboxSettingsActions = {
      getConfig: () => config,
      getSessionEnabled: () => true,
      getScope: () => "session",
      getSummary: () => "ok",
      cycleScope: vi.fn(),
      toggle: vi.fn(async () => undefined),
      add,
      remove: vi.fn(async () => undefined),
      editRaw: vi.fn(async () => undefined),
      close,
      requestRender: vi.fn(),
      reportError: vi.fn(),
    };
    const component = new SandboxSettingsComponent(theme, actions);

    component.handleInput("\x1b[C");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(component.render(200).join("\n")).toContain("Add allowed domain");

    component.handleInput("\x1b");
    expect(add).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(component.render(200).join("\n")).toContain("Add allowed domain…");

    component.handleInput("\x1b");
    expect(close).toHaveBeenCalledOnce();
  });

  it("formats every runtime field in the effective config", () => {
    const formatted = formatEffectiveConfig(fixture(), true);
    expect(formatted).toContain('"enableWeakerNestedSandbox": true');
    expect(formatted).toContain('"network"');
    expect(formatted).toContain('"filesystem"');
  });
});
