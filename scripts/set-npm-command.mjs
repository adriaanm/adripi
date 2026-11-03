import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pi's TS loader can resolve dependencies from the public package path without
// following pnpm's package-root symlink first. Use real package directories so
// imports see their dependencies from both the public and canonical paths.
export const NPM_COMMAND = ["pnpm", "--config.node-linker=hoisted"];

export function configureNpmCommand(agentDir, { run = spawnSync, log = console.log } = {}) {
  const settingsPath = join(agentDir, "settings.json");
  const npmDir = join(agentDir, "npm");
  const modulesPath = join(npmDir, "node_modules", ".modules.yaml");
  // pnpm has emitted both YAML and JSON here. Do not guess from unrelated
  // symlinks or force-reinstall an already hoisted/npm layout on every deploy.
  const isolated = existsSync(modulesPath) &&
    /^\s*["']?nodeLinker["']?\s*:\s*["']?isolated["']?\s*,?\s*$/m.test(readFileSync(modulesPath, "utf8"));
  if (isolated && !existsSync(join(npmDir, "pnpm-lock.yaml"))) {
    throw new Error(`Cannot migrate ${npmDir}: isolated pnpm layout has no pnpm-lock.yaml; restore its lockfile before installing`);
  }

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(`${settingsPath} must contain an object`);
    }
  }

  settings.npmCommand = [...NPM_COMMAND];
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`set npmCommand to pnpm (hoisted layout) in ${settingsPath}`);

  if (isolated) {
    log(`migrating ${npmDir} from isolated to hoisted pnpm layout; forks must be redeployed afterwards`);
    // Re-materialize the EXISTING locked graph, not an update. No lifecycle code
    // runs during migration. The normal package install and fork deploy follow.
    const result = run(NPM_COMMAND[0], [
      ...NPM_COMMAND.slice(1), "install", "--force", "--frozen-lockfile", "--ignore-scripts",
      "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false",
      "--config.strict-dep-builds=false",
    ], { cwd: npmDir, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error(`pnpm layout migration failed; stop before deploying forks: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureNpmCommand(process.argv[2] ?? join(process.env.HOME ?? homedir(), ".pi/agent"));
}
