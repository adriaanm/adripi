import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { decodeChildPolicy } from "./child-policy.ts";
import { getConfigPaths, type EffectiveSandboxConfig } from "./config.ts";
import { canonicalizeTarget } from "./path-policy.ts";

/** SDK peers/lazy dependencies share the owning node_modules namespace, not
 * merely the SDK package directory. npm/pnpm layouts may contain nested stores. */
function dependencyNamespace(packageRoot: string): string {
  let current = packageRoot, root = packageRoot;
  while (true) {
    if (basename(current) === "node_modules") root = current;
    const parent = dirname(current);
    if (parent === current) return root;
    current = parent;
  }
}

/** Shell bootstrap variables must not load workspace-writable code before the
 * SDK's local backend enters SRT. This only narrows inherited environment; no
 * credential values, proxy-injection declarations or parent shell config travel. */
export const CHILD_BOOTSTRAP_ENV_DENY = ["BASH_ENV", "ENV", "ZDOTDIR"] as const;

/** Translate validated authority DATA to the existing controller/dispatcher
 * config, without invoking loadConfig, project trust, Git discovery, maintenance,
 * scratch allocation or SRT. This function alone cannot establish readiness.
 *
 * allowedDomains stays empty so EVERY connection reaches the current parent;
 * parent static/strict restrictions remain final in its existing decision path.
 * Broad Unix/local-binding/PTY ceilings are conservatively disabled, not lent.
 */
export function compileChildConfig(value: unknown, cwd: string, agentDir: string): EffectiveSandboxConfig {
  const policy = decodeChildPolicy(value, cwd);
  const unique = (paths: readonly string[]) => [...new Set(paths)];
  if (!isAbsolute(agentDir)) throw new Error("Child runtime requires an absolute actual agent directory");
  // The SDK's actual agent directory can differ from the prepared parent's.
  // Neither its auth file nor this loaded enforcement package may become a
  // writable/readable credential capability through that metadata difference.
  const mandatoryRead = unique([...policy.read.mandatoryDeny, join(agentDir, "auth.json")]);
  const packages = [getPackageDir(), fileURLToPath(new URL("../", import.meta.url))];
  const codeRoots = packages.flatMap(root => {
    const canonical = canonicalizeTarget(root, cwd);
    return [root, canonical, dependencyNamespace(canonical)];
  });
  const mandatoryWrite = unique([...policy.write.mandatoryDeny, agentDir, ...codeRoots, process.execPath, canonicalizeTarget(process.execPath, cwd)]);
  const denyEnvironment = unique([...policy.environment.deny, ...CHILD_BOOTSTRAP_ENV_DENY]);
  if (denyEnvironment.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Child runtime cannot safely express a denied environment variable name");
  }
  const runtime = SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: [],
      deniedDomains: [...policy.network.deniedDomains],
      strictAllowlist: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      disabled: false,
      denyRead: unique([...policy.read.deny, ...mandatoryRead]),
      allowRead: [...policy.read.allow],
      allowWrite: [...policy.write.allow],
      denyWrite: unique([...policy.write.deny, ...mandatoryWrite]),
      allowGitConfig: false,
    },
    credentials: {
      files: mandatoryRead.map(path => ({ path, mode: "deny" })),
      envVars: denyEnvironment.map(name => ({ name, mode: "deny" })),
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
    ...(policy.isolation.mandatoryDenySearchDepth === null ? {} : { mandatoryDenySearchDepth: policy.isolation.mandatoryDenySearchDepth }),
    git: { safeDirectories: [] },
  });
  const paths = getConfigPaths(cwd, agentDir, ".pi");
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: policy.command.allowHost,
    environment: { deny: denyEnvironment },
    runtime,
    hardening: {
      denyRead: mandatoryRead,
      denyWrite: mandatoryWrite,
      mandatoryDenyWrite: mandatoryWrite,
    },
    // Display/type-adapter metadata only. No settings contents were read; root settings,
    // persistence and publisher handlers must not be installed in a child.
    globalConfigPath: paths.global,
    projectConfigPath: paths.project,
    projectApplied: false,
    layers: { defaults: {}, global: {}, project: {}, session: {} },
    warnings: [],
  };
}

/** SDK spawnHook/operations adapter: deny before the OUTER local shell starts,
 * not just via SRT's unset inside the wrapped command. Preserve the SDK backend
 * and command string; this is not a replacement shell/execution engine. */
export function childExecutionEnvironment(env: NodeJS.ProcessEnv, deny: readonly string[]): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of new Set([...deny, ...CHILD_BOOTSTRAP_ENV_DENY, "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "CDPATH"])) delete result[name];
  // Exported functions can shadow the wrapper command in the outer shell.
  for (const name of Object.keys(result)) if (name.startsWith("BASH_FUNC_")) delete result[name];
  return result;
}
