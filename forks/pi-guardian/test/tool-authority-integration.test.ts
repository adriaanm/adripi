import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGuardianConfig } from "../src/config.ts";
import guardianExtension from "../src/index.ts";
import { evaluatePermissions } from "../src/permissions.ts";
import { getSandboxBroker } from "../src/sandbox/broker.ts";
import { loadConfig } from "../../pi-sbx/src/config.ts";
import { registerFileGate } from "../../pi-sbx/src/file-gate.ts";
import { canWrite, createFilePolicy } from "../../pi-sbx/src/path-policy.ts";

const scratch = process.env.PI_SANDBOX_SCRATCH ?? tmpdir();

test("OS policy projection and Guardian agree on canonical maintenance roots", () => {
  const root = mkdtempSync(join(scratch, "tool-authority-matrix-"));
  try {
    const project = join(root, "project");
    const sibling = join(root, "sibling");
    const agentDir = join(root, "agent");
    for (const path of [project, sibling, join(project, "nested"), join(project, "..valid"), join(agentDir, "extensions")]) {
      mkdirSync(path, { recursive: true });
    }
    symlinkSync(sibling, join(project, "escape"));
    symlinkSync(project, join(root, "alias"));
    writeFileSync(join(agentDir, "guardian.json"), JSON.stringify({ permissions: { agentDirWriteProjects: [project] } }));
    const guardian = loadGuardianConfig(agentDir, "/policy");
    for (const [cwd, permitted] of [
      [project, true], [join(project, "nested"), true], [join(project, "..valid"), true],
      [sibling, false], [join(project, "escape"), false], [join(root, "alias"), false],
    ] as const) {
      const config = loadConfig({ cwd, agentDir, configDirName: ".pi", allowProjectConfig: false,
        globalConfig: { agentDirWriteProjects: [project], filesystem: { allowWrite: ["."] } } });
      const policy = createFilePolicy({ filesystem: config.runtime.filesystem,
        mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
      const target = join(agentDir, "settings.json");
      assert.equal(canWrite(target, cwd, policy), permitted, `OS projection: ${cwd}`);
      assert.equal(evaluatePermissions(guardian.permissions, "write", { path: target }, cwd, agentDir).outcome,
        permitted ? "allow" : "deny", `Guardian: ${cwd}`);
      for (const locked of [join(agentDir, "auth.json"), join(agentDir, "guardian-sessions", "audit.jsonl"), join(cwd, ".pi", "guardian.json")]) {
        assert.equal(canWrite(locked, cwd, policy), false, `OS exclusion: ${locked}`);
        assert.equal(evaluatePermissions(guardian.permissions, "write", { path: locked }, cwd, agentDir).outcome, "deny", `Guardian exclusion: ${locked}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registered native gate consumes the actual published Guardian broker without retaining authority", async () => {
  const root = mkdtempSync(join(scratch, "tool-authority-publisher-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  const agentDir = join(root, "agent");
  for (const path of [project, outside, agentDir]) mkdirSync(path, { recursive: true });
  const target = join(outside, "cache.txt");
  writeFileSync(join(agentDir, "guardian.json"), JSON.stringify({
    sandboxExceptions: { allow: [`write:${target}`] }, permissions: { agentDirWriteProjects: [project] },
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, (...args: any[]) => any>();
  const audits: any[] = [];
  const pi = { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand() {}, registerEntryRenderer() {},
    appendEntry: (kind: string, value: unknown) => { if (kind === "guardian-sandbox-exception") audits.push(value); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: project, hasUI: false, mode: "print", signal: undefined,
    sessionManager: { getBranch: () => [], getSessionId: () => "cross-tool-parent" },
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;
  try {
    guardianExtension(pi);
    await handlers.get("session_start")!({}, ctx);
    const config = loadConfig({ cwd: project, agentDir, configDirName: ".pi", allowProjectConfig: false,
      globalConfig: { filesystem: { allowWrite: ["."] } } });
    const policy = createFilePolicy({ filesystem: config.runtime.filesystem,
      mandatoryDenyRead: config.hardening.denyRead, mandatoryDenyWrite: config.hardening.mandatoryDenyWrite });
    let gate: ((event: any, context: ExtensionContext) => Promise<unknown>) | undefined;
    registerFileGate({ on: (_name: string, handler: typeof gate) => { gate = handler; } } as unknown as Parameters<typeof registerFileGate>[0], {
      getPolicy: () => ({ policy, enabled: true }),
      getHuman: () => ({ ask: async () => { throw new Error("Standing rules need no UI"); } }),
    });
    assert.ok(gate);
    assert.ok(getSandboxBroker());
    for (const toolName of ["write", "edit"]) {
      assert.equal(await gate({ toolName, input: { path: target, content: "x" } }, ctx), undefined);
    }
    assert.equal(audits.length, 2);
    assert.ok(audits.every(record => record.rule === `write:${target}` && record.decision === "allow"));
    assert.equal(canWrite(target, project, policy), false, "native approval did not alter baseline");
    const before = audits.length;
    for (const path of [join(agentDir, "auth.json"), join(project, ".pi", "guardian.json")]) {
      assert.equal((await gate({ toolName: "write", input: { path } }, ctx) as { block: boolean }).block, true);
    }
    assert.equal(audits.length, before, "mandatory exclusions never reach the broker");
    await handlers.get("session_shutdown")!({});
    assert.equal(getSandboxBroker(), undefined);
    const refused = await gate({ toolName: "write", input: { path: target } }, ctx) as { block: boolean; reason: string };
    assert.equal(refused.block, true);
    assert.match(refused.reason, /No guardian sandbox broker/);
  } finally {
    await handlers.get("session_shutdown")?.({});
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
