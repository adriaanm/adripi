import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildHardeningPaths, type HardeningPaths } from "./hardening.ts";

export interface ExtensionConfigFields {
  enabled: boolean;
  failIfUnavailable: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  environment: { deny: string[] };
}

export type ConfigScope = "session" | "global" | "project";
export type JsonObject = Record<string, unknown>;

export interface ConfigLayers {
  defaults: JsonObject;
  global: JsonObject;
  project: JsonObject;
  session: JsonObject;
}

export interface EffectiveSandboxConfig extends ExtensionConfigFields {
  runtime: SandboxRuntimeConfig;
  hardening: HardeningPaths;
  layers: ConfigLayers;
  globalConfigPath: string;
  projectConfigPath: string;
  projectApplied: boolean;
  warnings: string[];
}

export interface LoadConfigOptions {
  cwd: string;
  agentDir: string;
  configDirName: string;
  allowProjectConfig: boolean;
  sessionConfig?: JsonObject;
  globalConfig?: JsonObject;
  projectConfig?: JsonObject;
}

const DEFAULT_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
];

const DEFAULT_CONFIG: JsonObject = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  environment: { deny: [] },
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowRead: [],
    allowWrite: [".", tmpdir()],
    denyWrite: [],
  },
};

const KNOWN_TOP_LEVEL = new Set([
  "enabled",
  "failIfUnavailable",
  "allowUnsandboxedCommands",
  "excludedCommands",
  "environment",
  "agentDirWriteProjects",
  "network",
  "filesystem",
  "credentials",
  "ignoreViolations",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "allowAppleEvents",
  "ripgrep",
  "mandatoryDenySearchDepth",
  "allowPty",
  "seccomp",
  "bwrapPath",
  "socatPath",
  "javaAgentJarPath",
  "git",
]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Arrays that layers above the user's own file extend instead of replacing.
 * They are allow lists: a project or session layer may add a grant, and must
 * not drop one it inherits. Replacement would silently revoke the global
 * package-host allowlist (or the workspace itself) as soon as a project or
 * session layer names a single entry, so a grant like "write /tmp/sgo-501"
 * would break workspace writes instead of widening them.
 *
 * The defaults → global step keeps replace semantics: the user's file owns its
 * policy and must be able to drop a default (the host temp root is writable by
 * pi-sbx's defaults and deliberately not by this stack). Every other array,
 * deny lists included, also keeps replace semantics, which is what the
 * settings UI's remove action expects.
 */
const UNIONED_ARRAYS: ReadonlyArray<readonly [string, string]> = [
  ["network", "allowedDomains"],
  ["network", "allowUnixSockets"],
  ["filesystem", "allowRead"],
  ["filesystem", "allowWrite"],
];

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function unionKey(section: string, key: string): boolean {
  return UNIONED_ARRAYS.some(([candidateSection, candidateKey]) => candidateSection === section && candidateKey === key);
}

function merge(base: JsonObject, override: JsonObject, section = "", unionGrants = false): JsonObject {
  const output: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = base[key];
    if (isObject(value) && isObject(existing)) {
      output[key] = merge(existing, value, key, unionGrants);
      continue;
    }
    if (unionGrants && Array.isArray(value) && unionKey(section, key)) {
      output[key] = dedupe([...stringEntries(existing), ...stringEntries(value)]);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(value)) throw new Error("top-level value must be an object");
    return value;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Human-owned escape hatch: a project root listed in the *global* profile may
 * write the agent directory, so the repo that installs this stack can maintain
 * the profile it installs. It is read from the global layer only — a project or
 * session layer must not widen the boundary — and only for a cwd inside a listed
 * root. Credentials and Guardian's session transcripts stay denied either way.
 */
function agentDirWriteAllowed(cwd: string, value: unknown, warnings: string[]): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !isAbsolute(entry))) {
    warnings.push("Ignored agentDirWriteProjects: expected an array of absolute project roots");
    return false;
  }
  return value.some((root) => {
    const rel = relative(resolve(root), resolve(cwd));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Drop the agent-dir write lock for an allowed project, keeping the secrets. */
function openAgentDir(hardening: HardeningPaths, agentDir: string, globalConfigPath: string): HardeningPaths {
  const stillDenied = [join(agentDir, "auth.json"), join(agentDir, "guardian-sessions")];
  const keep = (entry: string) => entry !== agentDir && entry !== globalConfigPath;
  return {
    ...hardening,
    denyRead: [...hardening.denyRead.filter(keep), ...stillDenied],
    denyWrite: [...hardening.denyWrite.filter(keep), ...stillDenied],
    mandatoryDenyWrite: [...hardening.mandatoryDenyWrite.filter(keep), ...stillDenied],
  };
}

function applyHardening(raw: JsonObject, hardening: HardeningPaths, agentDirWrite?: string): JsonObject {
  const filesystem = isObject(raw.filesystem) ? { ...raw.filesystem } : {};
  filesystem.denyRead = dedupe([...(Array.isArray(filesystem.denyRead) ? filesystem.denyRead as string[] : []), ...hardening.denyRead]);
  filesystem.denyWrite = dedupe([...(Array.isArray(filesystem.denyWrite) ? filesystem.denyWrite as string[] : []), ...hardening.denyWrite]);
  filesystem.allowWrite = dedupe([
    ...(Array.isArray(filesystem.allowWrite) ? filesystem.allowWrite as string[] : []),
    ...(hardening.worktreeGitDir ? [hardening.worktreeGitDir] : []),
    // A granted project needs an allow root, not just a lifted deny: writes are
    // allowlist-based, and denyWrite entries for credentials/transcripts are
    // emitted after this allow so they still win.
    ...(agentDirWrite ? [agentDirWrite] : []),
  ]);

  const environment = isObject(raw.environment) ? raw.environment : {};
  const environmentDeny = stringArray(environment.deny ?? [], "environment.deny");
  const credentials = isObject(raw.credentials) ? { ...raw.credentials } : {};
  const existingEnvVars = Array.isArray(credentials.envVars) ? credentials.envVars : [];
  const existingNames = new Set(existingEnvVars.flatMap((entry) => isObject(entry) && typeof entry.name === "string" ? [entry.name] : []));
  credentials.envVars = [
    ...existingEnvVars,
    ...dedupe([...DEFAULT_SECRET_ENV, ...environmentDeny])
      .filter((name) => !existingNames.has(name))
      .map((name) => ({ name, mode: "deny" })),
  ];

  return { ...raw, filesystem, credentials };
}

export function getConfigPaths(cwd: string, agentDir: string, configDirName: string): { global: string; project: string } {
  return {
    global: join(agentDir, "extensions", "sandbox.json"),
    project: join(cwd, configDirName, "sandbox.json"),
  };
}

export function hasProjectConfig(cwd: string, agentDir: string, configDirName: string): boolean {
  return existsSync(getConfigPaths(cwd, agentDir, configDirName).project);
}

export function loadConfig(options: LoadConfigOptions): EffectiveSandboxConfig {
  const warnings: string[] = [];
  const paths = getConfigPaths(options.cwd, options.agentDir, options.configDirName);
  const globalRaw = options.globalConfig ?? readJson(paths.global);
  if (options.allowProjectConfig && existsSync(paths.project)) assertSafeProjectPath(paths.project, options.cwd);
  const projectRaw = options.allowProjectConfig ? options.projectConfig ?? readJson(paths.project) : {};
  const sessionRaw = options.sessionConfig ?? {};
  if (existsSync(paths.project) && !options.allowProjectConfig) warnings.push(`Ignored untrusted project config: ${paths.project}`);

  const raw = merge(merge(merge(DEFAULT_CONFIG, globalRaw), projectRaw, "", true), sessionRaw, "", true);
  for (const key of Object.keys(raw)) if (!KNOWN_TOP_LEVEL.has(key)) warnings.push(`Unknown sandbox config key: ${key}`);

  if (projectRaw.agentDirWriteProjects !== undefined || sessionRaw.agentDirWriteProjects !== undefined) {
    warnings.push("Ignored agentDirWriteProjects outside the global profile");
  }
  let hardening = buildHardeningPaths(options.cwd, options.agentDir, paths.global, paths.project);
  const agentDirWrite = agentDirWriteAllowed(options.cwd, globalRaw.agentDirWriteProjects, warnings)
    ? options.agentDir
    : undefined;
  if (agentDirWrite) hardening = openAgentDir(hardening, agentDirWrite, paths.global);
  const hardened = applyHardening(raw, hardening, agentDirWrite);

  const enabled = bool(hardened.enabled, "enabled");
  const failIfUnavailable = bool(hardened.failIfUnavailable, "failIfUnavailable");
  const allowUnsandboxedCommands = bool(hardened.allowUnsandboxedCommands, "allowUnsandboxedCommands");
  const excludedCommands = stringArray(hardened.excludedCommands, "excludedCommands");
  const environment = isObject(hardened.environment)
    ? { deny: stringArray(hardened.environment.deny ?? [], "environment.deny") }
    : { deny: [] };

  const runtimeInput = Object.fromEntries(Object.entries(hardened).filter(([key]) => !["enabled", "failIfUnavailable", "allowUnsandboxedCommands", "excludedCommands", "environment", "agentDirWriteProjects"].includes(key)));
  const parsed = SandboxRuntimeConfigSchema.safeParse(runtimeInput);
  if (!parsed.success) throw new Error(`Invalid sandbox runtime config: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);

  return {
    enabled,
    failIfUnavailable,
    allowUnsandboxedCommands,
    excludedCommands,
    environment,
    runtime: parsed.data,
    hardening,
    layers: { defaults: DEFAULT_CONFIG, global: globalRaw, project: projectRaw, session: sessionRaw },
    globalConfigPath: paths.global,
    projectConfigPath: paths.project,
    projectApplied: options.allowProjectConfig && existsSync(paths.project),
    warnings,
  };
}

let writeQueue: Promise<void> = Promise.resolve();

function assertSafeProjectPath(path: string, cwd: string): void {
  const absoluteCwd = realpathSync.native(cwd);
  const configDir = resolve(path, "..");
  if (existsSync(configDir)) {
    if (lstatSync(configDir).isSymbolicLink()) throw new Error("Project config directory must not be a symlink");
    const realDir = realpathSync.native(configDir);
    const rel = relative(absoluteCwd, realDir);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("Project config directory escapes the project root");
  }
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Project config file must not be a symlink");
}

async function updateConfigFile(
  path: string,
  mutator: (raw: JsonObject) => JsonObject,
  validatePath: () => void,
): Promise<void> {
  const operation = async () => {
    validatePath();
    const dir = resolve(path, "..");
    mkdirSync(dir, { recursive: true });
    validatePath();
    let raw: JsonObject;
    try {
      raw = existsSync(path) ? readJson(path) : {};
    } catch {
      throw new Error(`Refusing to overwrite invalid JSON: ${path}`);
    }
    const next = mutator(raw);
    const temp = join(dir, `.sandbox.json.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temp, path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => undefined);
  return result;
}

export function updateProjectConfig(
  path: string,
  cwd: string,
  mutator: (raw: JsonObject) => JsonObject,
): Promise<void> {
  return updateConfigFile(path, mutator, () => assertSafeProjectPath(path, cwd));
}

export function updateGlobalConfig(
  path: string,
  mutator: (raw: JsonObject) => JsonObject,
): Promise<void> {
  const validatePath = () => {
    const dir = resolve(path, "..");
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("Global config directory must not be a symlink");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Global config file must not be a symlink");
  };
  return updateConfigFile(path, mutator, validatePath);
}

export function setConfigArray(
  raw: JsonObject,
  section: string | undefined,
  key: string,
  values: string[],
): JsonObject {
  if (!section) return { ...raw, [key]: dedupe(values) };
  const current = isObject(raw[section]) ? { ...raw[section] as JsonObject } : {};
  current[key] = dedupe(values);
  return { ...raw, [section]: current };
}

export function setConfigBoolean(raw: JsonObject, key: string, value: boolean): JsonObject {
  return { ...raw, [key]: value };
}

export function mutateConfigArrayValue(
  raw: JsonObject,
  section: string | undefined,
  key: string,
  inherited: string[],
  value: string,
  add: boolean,
  mandatory: string[] = [],
): JsonObject {
  const protectedValues = new Set(mandatory);
  const current = (getRawConfigArray(raw, section, key) ?? inherited)
    .filter((entry) => !protectedValues.has(entry));
  const next = add
    ? [...new Set([...current, value])]
    : current.filter((entry) => entry !== value);
  return setConfigArray(raw, section, key, next);
}

export function toggleConfigBoolean(raw: JsonObject, key: string, inherited: boolean): JsonObject {
  return setConfigBoolean(raw, key, !(getRawConfigBoolean(raw, key) ?? inherited));
}

function layerValue(raw: JsonObject, section: string | undefined, key: string): unknown {
  if (!section) return raw[key];
  const nested = raw[section];
  return isObject(nested) ? nested[key] : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function layersThrough(config: EffectiveSandboxConfig, scope: ConfigScope): Array<["default" | ConfigScope, JsonObject]> {
  const layers: Array<["default" | ConfigScope, JsonObject]> = [
    ["default", config.layers.defaults],
    ["global", config.layers.global],
  ];
  if (scope === "project" || scope === "session") layers.push(["project", config.layers.project]);
  if (scope === "session") layers.push(["session", config.layers.session]);
  return layers;
}

export function getRawConfigArray(
  raw: JsonObject,
  section: string | undefined,
  key: string,
): string[] | undefined {
  return optionalStringArray(layerValue(raw, section, key));
}

export function getRawConfigBoolean(raw: JsonObject, key: string): boolean | undefined {
  const value = layerValue(raw, undefined, key);
  return typeof value === "boolean" ? value : undefined;
}

export function getConfigArray(
  config: EffectiveSandboxConfig,
  section: string | undefined,
  key: string,
  scope: ConfigScope = "session",
): string[] {
  let result: string[] = [];
  for (const [, raw] of layersThrough(config, scope)) {
    const value = optionalStringArray(layerValue(raw, section, key));
    if (value) result = value;
  }
  return [...new Set(result)];
}

export function getInheritedConfigArray(
  config: EffectiveSandboxConfig,
  section: string | undefined,
  key: string,
  scope: ConfigScope,
): string[] {
  if (scope === "global") {
    return getRawConfigArray(config.layers.defaults, section, key) ?? [];
  }
  return getConfigArray(config, section, key, scope === "project" ? "global" : "project");
}

export function getConfigBoolean(
  config: EffectiveSandboxConfig,
  key: string,
  scope: ConfigScope = "session",
): boolean {
  let result = false;
  for (const [, raw] of layersThrough(config, scope)) {
    const value = layerValue(raw, undefined, key);
    if (typeof value === "boolean") result = value;
  }
  return result;
}

export function getInheritedConfigBoolean(
  config: EffectiveSandboxConfig,
  key: string,
  scope: ConfigScope,
): boolean {
  if (scope === "global") return getRawConfigBoolean(config.layers.defaults, key) ?? false;
  return getConfigBoolean(config, key, scope === "project" ? "global" : "project");
}

export function getArrayLayer(
  config: EffectiveSandboxConfig,
  section: string | undefined,
  key: string,
  scope: ConfigScope = "session",
): "default" | ConfigScope {
  let source: "default" | ConfigScope = "default";
  for (const [name, raw] of layersThrough(config, scope)) {
    if (Array.isArray(layerValue(raw, section, key))) source = name;
  }
  return source;
}

export function addAllowedDomain(raw: JsonObject, host: string): JsonObject {
  const network = isObject(raw.network) ? { ...raw.network } : {};
  const allowed = Array.isArray(network.allowedDomains) ? network.allowedDomains.filter((value): value is string => typeof value === "string") : [];
  network.allowedDomains = dedupe([...allowed, host]);
  return { ...raw, network };
}

export function setExcludedCommand(raw: JsonObject, pattern: string, add: boolean): JsonObject {
  const current = Array.isArray(raw.excludedCommands) ? raw.excludedCommands.filter((value): value is string => typeof value === "string") : [];
  return { ...raw, excludedCommands: add ? dedupe([...current, pattern]) : current.filter((value) => value !== pattern) };
}
