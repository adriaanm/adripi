import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse } from "node:path";

export type RuntimeProcess = {
  execPath: string;
  argv: readonly string[];
  versions: Readonly<Record<string, string | undefined>>;
  features?: { sea?: boolean; inspector?: boolean };
};

/** The extension's own import.meta.url is on disk even inside compiled Pi. */
export function isStandaloneExecutable(host: RuntimeProcess = process): boolean {
  return host.features?.sea === true || (
    !!host.versions.bun &&
    /(?:\$bunfs|~BUN|%7EBUN)/i.test(host.argv[1] ?? "")
  );
}

/** fork() must execute a JS runtime, never a compiled Pi application image. */
export function resolveBrokerExecPath(
  env: NodeJS.ProcessEnv = process.env,
  host: RuntimeProcess = process,
): string {
  if (!isStandaloneExecutable(host)) return host.execPath;

  for (const directory of (env.PATH ?? "").split(delimiter)) {
    // Do not discover executable code in the command's working directory.
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = realpathSync(join(directory, "node"));
      accessSync(candidate, constants.X_OK);
      const candidateStat = statSync(candidate);
      const hostStat = statSync(host.execPath);
      if (!candidateStat.isFile()) continue;
      // Also reject symlinks/hard links from `node` back to the Pi binary.
      if (candidateStat.dev === hostStat.dev && candidateStat.ino === hostStat.ino) continue;
      return candidate;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new Error(
    "pi-sandbox: standalone Pi requires Node.js >=22.19.0 on PATH to run the Sandbox Runtime broker; no usable node executable was found",
  );
}

function runtimeReadPath(execPath: string): string {
  const bin = dirname(execPath);
  const root = dirname(bin);
  // Node installations under nvm/Nix need their libraries as well as bin/node.
  // Arbitrarily placed executables must not grant a whole home directory or /.
  return basename(bin) === "bin" && root !== parse(root).root && root !== homedir()
    ? root
    : execPath;
}

function runtimeWritePath(execPath: string): string {
  const directory = dirname(execPath);
  return basename(directory) === "bin" ? directory : execPath;
}

/** Only the current user's private darwin dirs may be granted automatically. */
const DARWIN_USER_DIR_PREFIXES = [
  "/var/folders/",
  "/private/var/folders/",
] as const;

function normalizeUserDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) return undefined;
  if (trimmed === "/var/folders" || trimmed === "/private/var/folders") {
    return undefined;
  }
  return DARWIN_USER_DIR_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    ? trimmed
    : undefined;
}

/**
 * `getconf` is the authoritative source for confstr paths; `$TMPDIR` can be
 * overridden (including by this extension's own per-command temp dir), so it
 * is only a fallback. Returns undefined when the value is unavailable or does
 * not name a per-user darwin directory (e.g. a custom TMPDIR below $HOME,
 * which the sandbox deliberately keeps denied).
 */
function confstrDirectory(name: string): string | undefined {
  try {
    const value = execFileSync("/usr/bin/getconf", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return normalizeUserDir(value);
  } catch {
    return undefined;
  }
}

const macUserTempDirCache = new Map<string, string[]>();

/**
 * The current user's private macOS temp and cache directories: the confstr
 * `DARWIN_USER_TEMP_DIR` / `DARWIN_USER_CACHE_DIR` paths (what `$TMPDIR` and
 * most of `~/Library/Caches` resolve to).
 *
 * Build tools such as `xcodebuild` and the Swift/Clang toolchain ask confstr
 * directly instead of honouring the command's `TMPDIR`, so a sandbox that only
 * grants its own per-command temp directory fails them with `Operation not
 * permitted` under `/var/folders/...`. Granting these two per-user directories
 * (never the shared `/tmp` root) makes ordinary Apple-toolchain builds work.
 *
 * Empty on non-darwin platforms: there the shared temp root is world-writable
 * and is not granted automatically. The per-command temp directory still is.
 */
export function macUserTempDirs(
  platform: NodeJS.Platform = process.platform,
): string[] {
  const cached = macUserTempDirCache.get(platform);
  if (cached !== undefined) return cached;

  const paths = new Set<string>();
  if (platform === "darwin") {
    const temp = confstrDirectory("DARWIN_USER_TEMP_DIR");
    const cache = confstrDirectory("DARWIN_USER_CACHE_DIR");
    if (temp !== undefined) paths.add(temp);
    if (cache !== undefined) paths.add(cache);
    if (temp === undefined && cache === undefined) {
      // launchd sets $TMPDIR to <user temp dir>/T. Derive the sibling cache
      // dir only when the shape matches; never widen a custom TMPDIR.
      const fallback = normalizeUserDir(tmpdir());
      if (fallback !== undefined) {
        paths.add(fallback);
        if (basename(fallback) === "T") {
          paths.add(join(dirname(fallback), "C"));
        }
      }
    }
  }

  // `/var` is a symlink to `/private/var` on macOS. Sandbox Runtime resolves
  // spellings, but granting both keeps the policy readable and robust.
  const bothSpellings = new Set<string>();
  for (const path of paths) {
    if (path.startsWith("/private/var/folders/")) {
      bothSpellings.add(path.slice("/private".length));
      bothSpellings.add(path);
    } else if (path.startsWith("/var/folders/")) {
      bothSpellings.add(path);
      bothSpellings.add(`/private${path}`);
    }
  }

  const result = [...bothSpellings];
  macUserTempDirCache.set(platform, result);
  return result;
}

export function runtimeFilesystemPaths(
  env: NodeJS.ProcessEnv = process.env,
  host: RuntimeProcess = process,
): { allowRead: string[]; denyWrite: string[] } {
  const brokerExecPath = resolveBrokerExecPath(env, host);
  const standalone = isStandaloneExecutable(host);
  return {
    allowRead: [...new Set([
      standalone ? host.execPath : runtimeReadPath(host.execPath),
      runtimeReadPath(brokerExecPath),
    ])],
    denyWrite: [...new Set([
      standalone ? host.execPath : runtimeWritePath(host.execPath),
      runtimeWritePath(brokerExecPath),
    ])],
  };
}
