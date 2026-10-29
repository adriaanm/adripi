import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";
import { evaluatePermissions } from "../src/permissions.ts";
import { createSandboxBroker } from "../src/sandbox/broker.ts";

const scratch = process.env.PI_SANDBOX_SCRATCH ?? tmpdir();

test("an explicit user deny identical to the built-in edit lock is never lifted", () => {
  const root = mkdtempSync(join(scratch, "guardian-explicit-lock-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir); mkdirSync(cwd);
    const rule = `Edit(/${agentDir}/**)`;
    writeFileSync(join(agentDir, "guardian.json"), JSON.stringify({ permissions: {
      allow: ["Write"], deny: [rule], agentDirWriteProjects: [cwd],
    } }));
    const config = loadGuardianConfig(agentDir, "/policy");
    assert.deepEqual(evaluatePermissions(config.permissions, "write", { path: join(agentDir, "settings.json") }, cwd, agentDir),
      { outcome: "deny", rule });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit protection survives equality and canonical equality with the agent root", async () => {
  const root = mkdtempSync(join(scratch, "guardian-audit-equality-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const alias = join(root, "audit-alias");
    mkdirSync(agentDir); mkdirSync(cwd); symlinkSync(agentDir, alias);
    for (const auditDir of [agentDir, alias]) {
      writeFileSync(join(agentDir, "guardian.json"), JSON.stringify({ guardianSessionDir: auditDir,
        permissions: { allow: ["Write"], agentDirWriteProjects: [cwd] } }));
      const config = loadGuardianConfig(agentDir, "/policy");
      const target = join(agentDir, "review.jsonl");
      assert.equal(evaluatePermissions(config.permissions, "write", { path: target }, cwd, agentDir).outcome, "deny");
      let reviews = 0;
      const broker = createSandboxBroker({ rules: { allow: [], deny: [], defer: [] }, agentDir,
        sessionDir: auditDir, maintenanceRoots: [cwd], sessionCwd: cwd,
        review: async () => { reviews++; return { outcome: "allow", rationale: "must not run" }; },
      });
      const result = await broker.review({ id: "audit", origin: "tool", surface: "write", target,
        cwd, scope: "once", reason: "not permitted" });
      assert.equal(result.kind, "deny");
      assert.equal(reviews, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
