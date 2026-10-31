import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { canonicalizeTarget, isWithin, type FilePolicy } from "./path-policy.ts";

/** Policy data, not a child SRT config. Socket ceilings MUST be intersected with
 * the assigned workspace/host-created private scratch before use. No values,
 * injection rules, parent proxy URLs, or parent-private socket grants travel.
 * Local-binding/PTY bits are ALSO parent ceilings, not instructions to copy
 * unbounded localhost/TTY namespaces into the child's actual runtime. */
export type ChildNetworkPolicy = {
  readonly policy: "parent-decision";
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly strictAllowlist: boolean;
  readonly unixSocketCeiling: { readonly all: boolean; readonly roots: readonly string[] };
  readonly allowLocalBinding: boolean;
};
export type ChildEnvironmentPolicy = { readonly deny: readonly string[] };
export type ChildIsolationPolicy = {
  readonly allowPty: boolean;
  readonly mandatoryDenySearchDepth: number | null;
};

export interface RuntimeBaseline {
  readonly runtime: SandboxRuntimeConfig;
  readonly environmentDeny: readonly string[];
}

/** Child credentials always tighten to file locks, including masked sources.
 * Reuse for preparation AND current-parent decisions; do not trust a native
 * adapter accidentally omitting a declaration from the actual runtime. */
export function childParentFilePolicy(baseline: RuntimeBaseline & { policy: FilePolicy }): FilePolicy {
  const paths = (baseline.runtime.credentials?.files ?? []).map(entry => entry.path);
  if (paths.some(path => typeof path !== "string" || !path || path.includes("\0"))) throw new Error("child credential locks require source paths, never credential values");
  return { ...baseline.policy,
    denyRead: [...new Set([...baseline.policy.denyRead, ...paths])],
    mandatoryDenyRead: [...new Set([...baseline.policy.mandatoryDenyRead, ...paths])],
    mandatoryDenyWrite: [...new Set([...baseline.policy.mandatoryDenyWrite, ...paths])],
  };
}

/** Reject features whose restrictions cannot be carried by a connection-only
 * parent route. In contrast, weaker isolation, Mach/AppleEvents and credential
 * injection are narrowed away, NEVER inherited by the child. */
export function projectChildRuntime(baseline: RuntimeBaseline, cwd: string): {
  network: ChildNetworkPolicy;
  environment: ChildEnvironmentPolicy;
  isolation: ChildIsolationPolicy;
} {
  if (!baseline.runtime?.network || !baseline.runtime.filesystem || !Array.isArray(baseline.environmentDeny)) {
    throw new Error("child runtime authority requires the actual parent baseline network/filesystem/environment policy");
  }
  const { runtime } = baseline;
  const network = runtime.network;
  const knownNetwork = new Set(["allowedDomains", "deniedDomains", "deniedDomainReasons", "strictAllowlist", "allowUnixSockets", "allowAllUnixSockets", "allowLocalBinding", "allowMachLookup", "filterRequest", "httpProxyPort", "socksProxyPort", "mitmProxy", "tlsTerminate", "parentProxy"]);
  if (Object.keys(network).some(key => !knownNetwork.has(key))) throw new Error("child runtime projection encountered an unsupported parent network field");
  const knownRuntime = new Set(["network", "filesystem", "credentials", "ignoreViolations", "enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "allowAppleEvents", "ripgrep", "mandatoryDenySearchDepth", "allowPty", "seccomp", "bwrapPath", "socatPath", "javaAgentJarPath", "git"]);
  if (Object.keys(runtime).some(key => !knownRuntime.has(key))) throw new Error("child runtime projection encountered an unsupported parent runtime field");
  if (Object.keys(runtime.filesystem).some(key => !["disabled", "denyRead", "allowRead", "allowWrite", "denyWrite", "allowGitConfig"].includes(key)) ||
      Object.keys(runtime.credentials ?? {}).some(key => !["files", "envVars", "allowPlaintextInject", "awsPairs", "sigv4"].includes(key)) ||
      Object.keys(runtime.git ?? {}).some(key => key !== "safeDirectories")) {
    throw new Error("child runtime projection encountered an unsupported parent filesystem/credential/Git field");
  }
  for (const value of [network.strictAllowlist, network.allowAllUnixSockets, network.allowLocalBinding, runtime.allowPty]) {
    if (value !== undefined && typeof value !== "boolean") throw new Error("child runtime feature ceilings must be booleans");
  }
  if (runtime.mandatoryDenySearchDepth !== undefined && (!Number.isInteger(runtime.mandatoryDenySearchDepth) || runtime.mandatoryDenySearchDepth < 1 || runtime.mandatoryDenySearchDepth > 10)) {
    throw new Error("child runtime search depth must satisfy the installed SRT contract (1-10)");
  }
  for (const name of ["filterRequest", "httpProxyPort", "socksProxyPort", "mitmProxy", "tlsTerminate", "parentProxy"] as const) {
    // Do not stringify a potentially secret-bearing value in diagnostics.
    if (network[name] !== undefined) throw new Error(`child runtime projection does not support parent network.${name}; refusing rather than dropping its restrictions`);
  }
  if ((["bwrapPath", "socatPath", "javaAgentJarPath", "seccomp", "ripgrep"] as const).some(name => runtime[name] !== undefined)) {
    throw new Error("child runtime projection does not support custom parent execution helpers; refusing rather than substituting a different enforcement backend");
  }
  const envNames = [
    ...baseline.environmentDeny,
    ...(runtime.credentials?.envVars ?? []).map(entry => entry.name),
    // Capability-bearing agent sockets are not child credential authority.
    "SSH_AUTH_SOCK", "GPG_AGENT_INFO",
  ];
  if (envNames.some(name => typeof name !== "string" || !name || name.includes("\0") || name.includes("="))) {
    throw new Error("child environment policy requires valid variable names, not values");
  }
  const strings = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || item.includes("\0"))) {
      throw new Error(`child runtime projection requires a valid ${name} array`);
    }
    return [...new Set(value as string[])];
  };
  const socketRoots = strings(network.allowUnixSockets ?? [], "network.allowUnixSockets").map(root => {
    if (/[*?[]/.test(root)) throw new Error("child Unix socket ceilings require exact directories, not globs");
    return canonicalizeTarget(root, cwd);
  });
  return {
    network: {
      policy: "parent-decision",
      allowedDomains: strings(network.allowedDomains, "network.allowedDomains"),
      deniedDomains: strings(network.deniedDomains, "network.deniedDomains"),
      strictAllowlist: network.strictAllowlist === true,
      unixSocketCeiling: { all: network.allowAllUnixSockets === true, roots: [...new Set(socketRoots)] },
      allowLocalBinding: network.allowLocalBinding === true,
    },
    environment: { deny: [...new Set(envNames)] },
    isolation: { allowPty: runtime.allowPty === true, mandatoryDenySearchDepth: runtime.mandatoryDenySearchDepth ?? null },
  };
}

/** Narrow an explicit parent socket feature to the named, independently held
 * child directories. Never copy a broad parent temp/maintenance namespace. */
export function childUnixSocketDirectories(network: ChildNetworkPolicy, directories: readonly string[], cwd: string): string[] {
  const scopes = directories.map(root => canonicalizeTarget(root, cwd));
  return [...new Set(scopes.flatMap(scope => network.unixSocketCeiling.all ? [scope] :
    network.unixSocketCeiling.roots.flatMap(root => isWithin(scope, root) ? [scope] : isWithin(root, scope) ? [root] : [])))];
}

export interface DomainMatcher {
  splitDomainPatternPort(pattern: string): { hostPattern: string; port?: number };
  matchesDomainPatternWithPort(host: string, port: number | undefined, pattern: string): boolean;
  canonicalizeHost(host: string): string | undefined;
  isValidHost(host: string): boolean;
}

let matcherPromise: Promise<DomainMatcher> | undefined;
/** Lazy so a missing/incompatible SRT helper fails a guarded preparation, not
 * module loading before root guard intent could be published. */
export function loadChildDomainMatcher(): Promise<DomainMatcher> {
  return matcherPromise ??= (async () => {
    const [patterns, hosts] = await Promise.all([
      import("@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js"),
      import("@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js"),
    ]);
    const matcher: DomainMatcher = {
      splitDomainPatternPort: patterns.splitDomainPatternPort,
      matchesDomainPatternWithPort: patterns.matchesDomainPatternWithPort,
      canonicalizeHost: hosts.canonicalizeHost,
      isValidHost: hosts.isValidHost,
    };
    if (Object.values(matcher).some(fn => typeof fn !== "function") ||
        matcher.canonicalizeHost("127.1") !== "127.0.0.1" || matcher.isValidHost("a@b") ||
        matcher.matchesDomainPatternWithPort("example.com", 80, "example.com:443") ||
        !matcher.matchesDomainPatternWithPort("::1", 443, "[::1]:443")) {
      throw new Error("the installed SRT domain helpers are incompatible; child network authority is unavailable");
    }
    return Object.freeze(matcher);
  })();
}

export type ChildNetworkDisposition = "held" | "ask" | "deny";
/** Same host/port semantics as SRT; no second domain matcher. A connection must
 * have an actual numeric port, otherwise a port-specific deny could be skipped. */
export function childNetworkDisposition(target: string, prepared: ChildNetworkPolicy, current: ChildNetworkPolicy, matcher: DomainMatcher): ChildNetworkDisposition {
  const endpoint = matcher.splitDomainPatternPort(target);
  // The shipped splitter canonicalizes bracket contents. Validate the ORIGINAL
  // host first, as SRT does at its proxy boundary: otherwise [user@allowed.com]
  // would be coerced into allowed.com before validation.
  const rawHost = target.startsWith("[") ? target.slice(1, target.indexOf("]")) : target.slice(0, target.lastIndexOf(":"));
  if (endpoint.port === undefined || !matcher.isValidHost(rawHost) ||
      (target.startsWith("[") && !rawHost.includes(":")) || !matcher.isValidHost(endpoint.hostPattern)) return "deny";
  const host = matcher.canonicalizeHost(endpoint.hostPattern);
  if (!host) return "deny";
  let held = true;
  for (const policy of [prepared, current]) {
    if (policy.deniedDomains.some(pattern => matcher.matchesDomainPatternWithPort(host, endpoint.port, pattern))) return "deny";
    const allowed = policy.allowedDomains.some(pattern => matcher.matchesDomainPatternWithPort(host, endpoint.port, pattern));
    if (!allowed && policy.strictAllowlist) return "deny";
    held &&= allowed;
  }
  return held ? "held" : "ask";
}
