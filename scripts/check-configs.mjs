import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

const configDir = fileURLToPath(new URL("../config/", import.meta.url));

function read(name) {
  const path = join(configDir, name);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const guardian = read("guardian.json");
if (typeof guardian.reviewer?.model !== "string" || !guardian.reviewer.model.includes("/")) {
  throw new Error("config/guardian.json: reviewer.model must be a provider/model string");
}
if (!Array.isArray(guardian.reviewer?.extensions)) {
  throw new Error("config/guardian.json: reviewer.extensions must be an array");
}
const context = guardian.reviewer.context;
if (!context || !["maxTokens", "targetTokens", "pruneAfter", "maxDirectiveChars"].every((key) => Number.isSafeInteger(context[key]) && context[key] > 0) || context.targetTokens >= context.maxTokens) {
  throw new Error("config/guardian.json: expected valid reviewer context budgets");
}
if (guardian.policyPath !== "~/.pi/agent/guardian-policy.md") {
  throw new Error("config/guardian.json: policyPath must point at the portable guardian policy");
}

if (guardian.exemptTools?.includes("request_sandbox_exception")) {
  throw new Error("config/guardian.json: the separate exception tool is retired");
}

const sandbox = read("sandbox.json");
if ("excludedCommands" in sandbox) {
  throw new Error("config/sandbox.json: use Guardian standing rules, not retired command exclusions");
}
if (sandbox.enabled !== true || sandbox.failIfUnavailable !== true) {
  throw new Error("config/sandbox.json: expected enabled and failIfUnavailable");
}
const fsPolicy = sandbox.filesystem ?? {};
if (!Array.isArray(fsPolicy.allowWrite) || !fsPolicy.allowWrite.includes(".")) {
  throw new Error("config/sandbox.json: workspace must be writable");
}
// The host temp root stays read-only; the session scratchpad is added at runtime.
const SHARED_TEMP = new Set(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]);
if (
  fsPolicy.allowWrite.some((entry) => {
    if (typeof entry !== "string" || entry.startsWith(".")) return false;
    return SHARED_TEMP.has(entry.replace(/\/+$/, ""));
  })
) {
  throw new Error("config/sandbox.json: do not allowWrite the shared temp root");
}
for (const secret of ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]) {
  if (!Array.isArray(fsPolicy.denyRead) || !fsPolicy.denyRead.includes(secret)) {
    throw new Error(`config/sandbox.json: denyRead must include ${secret}`);
  }
}
for (const pattern of ["**/.env", "**/*.pem", "**/*.key"]) {
  if (!Array.isArray(fsPolicy.denyWrite) || !fsPolicy.denyWrite.includes(pattern)) {
    throw new Error(`config/sandbox.json: denyWrite must include ${pattern}`);
  }
}
if (
  !Array.isArray(sandbox.agentDirWriteProjects) ||
  sandbox.agentDirWriteProjects.some((entry) => typeof entry !== "string" || !isAbsolute(entry))
) {
  throw new Error("config/sandbox.json: agentDirWriteProjects must be an array of absolute project roots");
}
if (!Array.isArray(sandbox.network?.allowedDomains) || sandbox.network.allowedDomains.length === 0) {
  throw new Error("config/sandbox.json: network.allowedDomains must name the package hosts");
}
if (existsSync(join(configDir, "pi-perm.config.json"))) {
  throw new Error("config/pi-perm.config.json is obsolete; the stack uses config/sandbox.json");
}
const pkg = readFileSync(join(configDir, "..", "packages.txt"), "utf8");
if (pkg.includes("pi-perm")) throw new Error("packages.txt still installs pi-perm");
if (!pkg.includes("pi-sbx@")) throw new Error("packages.txt must install pi-sbx");

if (
  !Array.isArray(guardian.permissions?.agentDirWriteProjects) ||
  guardian.permissions.agentDirWriteProjects.some((entry) => typeof entry !== "string" || !isAbsolute(entry))
) {
  throw new Error("config/guardian.json: permissions.agentDirWriteProjects must be an array of absolute project roots");
}

// This opt-in profile adds only named maintenance roots. Deny arrays replace,
// so retain the template's denies and project them across home-relative roots.
const project = read("adripi-project-sandbox.json");
const roots = ["~/.pi/agent", "~/g/bq268/wata", "~/g/sgola"];
if (
  project.enabled !== true || project.failIfUnavailable !== true ||
  Object.keys(project).some((key) => !["enabled", "failIfUnavailable", "filesystem"].includes(key)) ||
  Object.keys(project.filesystem ?? {}).sort().join(",") !== "allowRead,allowWrite,denyWrite" ||
  JSON.stringify(project.filesystem.allowRead) !== JSON.stringify(roots) ||
  JSON.stringify(project.filesystem.allowWrite) !== JSON.stringify([".", ...roots]) ||
  JSON.stringify(project.filesystem.denyWrite) !== JSON.stringify([
    ...fsPolicy.denyWrite, ...fsPolicy.denyWrite.map((pattern) => `~/${pattern}`),
  ])
) {
  throw new Error("config/adripi-project-sandbox.json: expected additive maintenance roots only");
}

const review = read("pi-review.json");
if (review.schemaVersion !== 1 || !review.gate || !review.reviewers) {
  throw new Error("config/pi-review.json: expected schemaVersion 1, gate, and reviewers");
}

readFileSync(join(configDir, "guardian-policy.md"), "utf8");
console.log("config: ok");
