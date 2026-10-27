import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  getArrayLayer,
  getConfigArray,
  getConfigBoolean,
  type ConfigScope,
  type EffectiveSandboxConfig,
} from "./config.ts";

export type SandboxSettingId =
  | "mode"
  | "fallback"
  | "failIfUnavailable"
  | "weakerNested"
  | "weakerNetwork"
  | "appleEvents"
  | "allowPty";
export type RuleKind =
  | "networkAllow"
  | "networkDeny"
  | "readAllow"
  | "readDeny"
  | "writeAllow"
  | "writeDeny"
  | "command"
  | "environment";

export interface SandboxSettingsActions {
  getConfig(): EffectiveSandboxConfig | undefined;
  getSessionEnabled(): boolean;
  getScope(): ConfigScope;
  getSummary(): string;
  cycleScope(): void;
  toggle(id: SandboxSettingId): Promise<void>;
  add(kind: RuleKind, value: string): Promise<void>;
  remove(kind: RuleKind, value: string): Promise<void>;
  editRaw(): Promise<void>;
  close(): void;
  requestRender(): void;
  reportError(error: unknown): void;
}

type TabId = "sandbox" | "network" | "read" | "write" | "commands" | "environment" | "advanced" | "config";
type Row =
  | { type: "setting"; id: SandboxSettingId; label: string; value: string; description: string }
  | { type: "rule"; kind: RuleKind; label: string; value: string; source: string; mandatory: boolean }
  | { type: "add"; kind: RuleKind; label: string }
  | { type: "action"; id: "editRaw"; label: string; description: string }
  | { type: "text"; label: string };

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "sandbox", label: "Sandbox" },
  { id: "network", label: "Network" },
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
  { id: "commands", label: "Commands" },
  { id: "environment", label: "Environment" },
  { id: "advanced", label: "Advanced" },
  { id: "config", label: "Config" },
];

function scopedRuleRows(
  config: EffectiveSandboxConfig,
  scope: ConfigScope,
  kind: RuleKind,
  label: string,
  section: string | undefined,
  key: string,
  mandatoryValues: string[] = [],
): Row[] {
  const mandatory = new Set(mandatoryValues);
  const source = getArrayLayer(config, section, key, scope);
  const values = [...new Set([...getConfigArray(config, section, key, scope), ...mandatoryValues])];
  return [
    ...values.map((value): Row => ({
      type: "rule",
      kind,
      label,
      value,
      source: mandatory.has(value) ? "mandatory" : source,
      mandatory: mandatory.has(value),
    })),
    { type: "add", kind, label: `Add ${label.toLowerCase()}…` },
  ];
}

function booleanSettingRow(
  config: EffectiveSandboxConfig,
  scope: ConfigScope,
  id: Exclude<SandboxSettingId, "mode">,
  key: string,
  label: string,
  enabledValue = "enabled",
  disabledValue = "disabled",
): Row {
  return {
    type: "setting",
    id,
    label,
    value: getConfigBoolean(config, key, scope) ? enabledValue : disabledValue,
    description: `Value through ${scope} scope`,
  };
}

export function formatEffectiveConfig(config: EffectiveSandboxConfig, sessionEnabled: boolean): string {
  return JSON.stringify({
    enabled: sessionEnabled,
    failIfUnavailable: config.failIfUnavailable,
    allowUnsandboxedCommands: config.allowUnsandboxedCommands,
    excludedCommands: config.excludedCommands,
    environment: config.environment,
    ...config.runtime,
  }, null, 2);
}

export class SandboxSettingsComponent implements Component, Focusable {
  private tabIndex = 0;
  private selectedByTab = new Map<TabId, number>();
  private scrollByTab = new Map<TabId, number>();
  private busy = false;
  private addInput?: { label: string; input: Input };
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.addInput) this.addInput.input.focused = value;
  }

  constructor(
    private readonly theme: Theme,
    private readonly actions: SandboxSettingsActions,
  ) {}

  private currentTab(): TabId { return TABS[this.tabIndex]!.id; }

  private rows(): Row[] {
    const config = this.actions.getConfig();
    if (!config) return [{ type: "text", label: "No valid sandbox configuration" }];
    const scope = this.actions.getScope();
    switch (this.currentTab()) {
      case "sandbox":
        return [
          { type: "setting", id: "mode", label: "Sandbox mode", value: this.actions.getSessionEnabled() ? "enabled" : "disabled", description: "Current session only" },
          booleanSettingRow(config, scope, "fallback", "allowUnsandboxedCommands", "Unsandboxed fallback", "allowed", "strict"),
          booleanSettingRow(config, scope, "failIfUnavailable", "failIfUnavailable", "Fail if unavailable"),
        ];
      case "network":
        return [
          ...scopedRuleRows(config, scope, "networkAllow", "Allowed domain", "network", "allowedDomains"),
          ...scopedRuleRows(config, scope, "networkDeny", "Denied domain", "network", "deniedDomains"),
        ];
      case "read":
        return [
          ...scopedRuleRows(config, scope, "readAllow", "Allowed path", "filesystem", "allowRead"),
          ...scopedRuleRows(config, scope, "readDeny", "Denied path", "filesystem", "denyRead", config.hardening.denyRead),
        ];
      case "write": {
        const mandatoryAllow = config.hardening.worktreeGitDir ? [config.hardening.worktreeGitDir] : [];
        return [
          ...scopedRuleRows(config, scope, "writeAllow", "Allowed path", "filesystem", "allowWrite", mandatoryAllow),
          ...scopedRuleRows(config, scope, "writeDeny", "Denied path", "filesystem", "denyWrite", config.hardening.denyWrite),
        ];
      }
      case "commands":
        return scopedRuleRows(config, scope, "command", "Excluded command", undefined, "excludedCommands");
      case "environment":
        return scopedRuleRows(config, scope, "environment", "Denied variable", "environment", "deny");
      case "advanced":
        return [
          booleanSettingRow(config, scope, "weakerNested", "enableWeakerNestedSandbox", "Weaker nested sandbox"),
          booleanSettingRow(config, scope, "weakerNetwork", "enableWeakerNetworkIsolation", "Weaker network isolation"),
          booleanSettingRow(config, scope, "appleEvents", "allowAppleEvents", "Allow Apple Events"),
          booleanSettingRow(config, scope, "allowPty", "allowPty", "Allow PTY"),
          { type: "action", id: "editRaw", label: "Edit raw scope JSON…", description: "Edit all advanced sandbox-runtime fields" },
        ];
      case "config":
        return formatEffectiveConfig(config, this.actions.getSessionEnabled()).split("\n").map((label): Row => ({ type: "text", label }));
    }
  }

  private selected(): number {
    const count = this.rows().length;
    return Math.min(this.selectedByTab.get(this.currentTab()) ?? 0, Math.max(0, count - 1));
  }

  private move(delta: number): void {
    const next = Math.max(0, Math.min(this.rows().length - 1, this.selected() + delta));
    this.selectedByTab.set(this.currentTab(), next);
  }

  private run(operation: () => Promise<void>): void {
    if (this.busy) return;
    this.busy = true;
    this.actions.requestRender();
    void operation().catch((error) => this.actions.reportError(error)).finally(() => {
      this.busy = false;
      this.actions.requestRender();
    });
  }

  private startAdd(kind: RuleKind, label: string): void {
    const input = new Input();
    input.focused = this.focused;
    input.onEscape = () => {
      this.addInput = undefined;
    };
    input.onSubmit = (rawValue) => {
      this.addInput = undefined;
      const value = rawValue.trim();
      if (value) this.run(() => this.actions.add(kind, value));
    };
    this.addInput = { label, input };
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.addInput) {
      this.addInput.input.handleInput(data);
      this.actions.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.actions.close();
    } else if (matchesKey(data, "left")) {
      this.tabIndex = (this.tabIndex + TABS.length - 1) % TABS.length;
    } else if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.tabIndex = (this.tabIndex + 1) % TABS.length;
    } else if (matchesKey(data, "up")) {
      this.move(-1);
    } else if (matchesKey(data, "down")) {
      this.move(1);
    } else if (data === "s" || data === "S") {
      this.actions.cycleScope();
    } else if (matchesKey(data, "return") || matchesKey(data, "space")) {
      const row = this.rows()[this.selected()];
      if (row?.type === "setting") this.run(() => this.actions.toggle(row.id));
      else if (row?.type === "add") this.startAdd(row.kind, row.label.replace(/^Add /, "").replace(/…$/, ""));
      else if (row?.type === "action" && row.id === "editRaw") this.run(() => this.actions.editRaw());
    } else if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
      const row = this.rows()[this.selected()];
      if (row?.type === "rule" && !row.mandatory) this.run(() => this.actions.remove(row.kind, row.value));
    }
    this.actions.requestRender();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const tab = this.currentTab();
    const rows = this.rows();
    const selected = this.selected();
    const maxRows = 18;
    let start = this.scrollByTab.get(tab) ?? 0;
    if (selected < start) start = selected;
    if (selected >= start + maxRows) start = selected - maxRows + 1;
    start = Math.max(0, Math.min(start, Math.max(0, rows.length - maxRows)));
    this.scrollByTab.set(tab, start);

    const tabs = TABS.map((entry, index) => index === this.tabIndex
      ? theme.bg("selectedBg", theme.fg("text", theme.bold(` ${entry.label} `)))
      : theme.fg("muted", ` ${entry.label} `)).join(" ");
    const lines = [truncateToWidth(tabs, width), ""];
    lines.push(truncateToWidth(`${theme.fg("muted", "Save scope:")} ${theme.fg("accent", this.actions.getScope())}${this.busy ? theme.fg("warning", "  Applying…") : ""}`, width));
    lines.push(truncateToWidth(theme.fg("dim", this.actions.getSummary()), width));
    lines.push("");

    const addInput = this.addInput;
    if (addInput) {
      lines.push(truncateToWidth(theme.fg("accent", `Add ${addInput.label}`), width));
      lines.push(...addInput.input.render(width));
      lines.push("");
      lines.push(truncateToWidth(theme.fg("dim", "Enter save · Esc cancel"), width));
      return lines;
    }

    for (let index = start; index < Math.min(rows.length, start + maxRows); index += 1) {
      const row = rows[index]!;
      const active = index === selected;
      const prefix = active ? theme.fg("accent", "> ") : "  ";
      let content: string;
      if (row.type === "setting") {
        content = `${row.label}  ${theme.fg("accent", row.value)}  ${theme.fg("dim", row.description)}`;
      } else if (row.type === "rule") {
        const source = row.mandatory ? theme.fg("warning", "mandatory") : theme.fg("dim", row.source);
        content = `${theme.fg("muted", `${row.label}:`)} ${row.value}  ${source}`;
      } else if (row.type === "add") {
        content = theme.fg("accent", row.label);
      } else if (row.type === "action") {
        content = `${theme.fg("accent", row.label)}  ${theme.fg("dim", row.description)}`;
      } else {
        content = theme.fg("muted", row.label);
      }
      const line = truncateToWidth(`${prefix}${content}`, width);
      lines.push(active ? theme.bg("selectedBg", line) : line);
    }
    if (rows.length > maxRows) lines.push(theme.fg("dim", `  ${start + 1}-${Math.min(rows.length, start + maxRows)} of ${rows.length}`));
    lines.push("");
    lines.push(truncateToWidth(theme.fg("dim", "←/→ switch · ↑/↓ select · Enter add/toggle · Backspace delete · S scope · Esc close"), width));
    return lines;
  }

  invalidate(): void {
    this.addInput?.input.invalidate();
  }
}
