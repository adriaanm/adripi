import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.argv[2] ?? join(process.env.HOME ?? homedir(), ".pi/agent");
const settingsPath = join(agentDir, "settings.json");

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

settings.npmCommand = ["pnpm"];
mkdirSync(agentDir, { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`set npmCommand to pnpm in ${settingsPath}`);
