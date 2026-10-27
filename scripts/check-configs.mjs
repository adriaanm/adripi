import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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
if (guardian.policyPath !== "~/.pi/agent/guardian-policy.md") {
  throw new Error("config/guardian.json: policyPath must point at the portable guardian policy");
}

const sandbox = read("sandbox.json");
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
if (!Array.isArray(sandbox.network?.allowedDomains) || sandbox.network.allowedDomains.length === 0) {
  throw new Error("config/sandbox.json: network.allowedDomains must name the package hosts");
}
if (existsSync(join(configDir, "pi-perm.config.json"))) {
  throw new Error("config/pi-perm.config.json is obsolete; the stack uses config/sandbox.json");
}
const pkg = readFileSync(join(configDir, "..", "packages.txt"), "utf8");
if (pkg.includes("pi-perm")) throw new Error("packages.txt still installs pi-perm");
if (!pkg.includes("pi-sbx@")) throw new Error("packages.txt must install pi-sbx");

const review = read("pi-review.json");
if (review.schemaVersion !== 1 || !review.gate || !review.reviewers) {
  throw new Error("config/pi-review.json: expected schemaVersion 1, gate, and reviewers");
}

readFileSync(join(configDir, "guardian-policy.md"), "utf8");
console.log("config: ok");
