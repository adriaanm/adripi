import { readFileSync } from "node:fs";
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
if (guardian.reviewer?.model !== "neuralwatt/nw-flash") {
  throw new Error("config/guardian.json: reviewer.model must be neuralwatt/nw-flash");
}
if (!Array.isArray(guardian.reviewer?.extensions) || guardian.reviewer.extensions.length === 0) {
  throw new Error("config/guardian.json: reviewer.extensions must list the Neuralwatt provider");
}
if (guardian.policyPath !== "~/.pi/agent/guardian-policy.md") {
  throw new Error("config/guardian.json: policyPath must point at the portable guardian policy");
}

const permission = read("pi-perm.config.json");
if (permission.version !== 1 || permission.activePermissionProfile !== "workspace") {
  throw new Error("config/pi-perm.config.json: expected version 1 with the workspace profile");
}
const workspace = permission.permissions?.workspace;
if (!workspace?.filesystem?.[":workspace_roots"]) {
  throw new Error("config/pi-perm.config.json: missing :workspace_roots");
}
if (workspace.filesystem[":workspace_roots"]["."] !== "write") {
  throw new Error("config/pi-perm.config.json: workspace root must be writable");
}

const review = read("pi-review.json");
if (review.schemaVersion !== 1 || !review.gate || !review.reviewers) {
  throw new Error("config/pi-review.json: expected schemaVersion 1, gate, and reviewers");
}

readFileSync(join(configDir, "guardian-policy.md"), "utf8");
console.log("config: ok");
