import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import guardianExtension from "../src/index.ts";
import { projectPolicyPath, readProjectPolicy, readProjectTrust, recordProjectTrust } from "../src/project-policy.ts";
// Exercise Guardian's registered service through the actual sandbox consumer.
import { getProjectPolicyService } from "../../pi-sbx/src/broker.ts";
import { getSandboxBroker } from "../src/sandbox/broker.ts";

// No sidecar or host command is launched: standing rules resolve in the broker.
test("registered project-policy service binds approval to the pre-prompt snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardian-policy-service-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "guardian.json"), JSON.stringify({ enabled: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {}, registerEntryRenderer: () => {}, appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, hasUI: false, mode: "print",
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getBranch: () => [], getSessionId: () => "policy-test" },
  } as unknown as ExtensionContext;
  try {
    guardianExtension(pi);
    await handlers.get("session_start")!({}, ctx);
    const service = getProjectPolicyService();
    assert.ok(service);
    const creating = service.prepareRule("command:git push:*");
    assert.equal(creating.ok, true);
    if (!creating.ok) return;
    assert.equal(creating.alreadyPresent, false);
    const created = creating.commit();
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(readProjectTrust(agentDir), { [created.path]: created.hash });
    const allowed = await getSandboxBroker()!.review({
      id: "standing", origin: "tool", surface: "command", target: "git push origin main",
      scope: "once", reason: "push this branch", cwd: root,
    });
    assert.equal(allowed.kind, "allow");
    assert.equal(allowed.review.source, "rule");
    const existing = service.prepareRule("command:git push:*");
    assert.equal(existing.ok && existing.alreadyPresent, true);
    // A broader proposal must still be offered, even when a narrower rule
    // already allows the current invocation. Only exact saved rules skip UI.
    const broader = service.prepareRule("command:git:*");
    assert.equal(broader.ok && broader.alreadyPresent, false);
    // The same policy is recognized after a full session service replacement.
    await handlers.get("session_shutdown")!({});
    await handlers.get("session_start")!({}, ctx);
    const restarted = getProjectPolicyService()!;
    const restored = restarted.prepareRule("command:git push:*");
    assert.equal(restored.ok && restored.alreadyPresent, true);

    const pending = restarted.prepareRule("command:gh pr view:*");
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    // Another legitimate approval occurs while the save question is open.
    // Even those trusted newer bytes cannot be substituted for its snapshot.
    await writeFile(projectPolicyPath(root), JSON.stringify({ sandboxExceptions: { allow: ["network:example.test:443"] } }));
    const newer = readProjectPolicy(root);
    assert.equal(newer.kind, "ok");
    if (newer.kind !== "ok") return;
    recordProjectTrust(agentDir, newer.policy.path, newer.policy.hash);
    const before = await readFile(newer.policy.path, "utf8");
    const refused = pending.commit();
    assert.equal(refused.ok, false);
    assert.equal(await readFile(newer.policy.path, "utf8"), before);
    assert.deepEqual(readProjectTrust(agentDir), { [newer.policy.path]: newer.policy.hash });

    // Pre-existing unapproved content is never silently approved by saving one rule.
    await writeFile(newer.policy.path, JSON.stringify({ sandboxExceptions: { allow: ["command:echo:*"] } }));
    assert.equal(restarted.prepareRule("command:echo:*").ok, false);
    await writeFile(newer.policy.path, before);
    const staleSession = restarted.prepareRule("command:gh pr view:*");
    assert.equal(staleSession.ok, true);
    await handlers.get("session_shutdown")!({});
    assert.equal(getProjectPolicyService(), undefined);
    assert.equal(getSandboxBroker(), undefined);
    if (staleSession.ok) assert.equal(staleSession.commit().ok, false);
    assert.equal(await readFile(newer.policy.path, "utf8"), before);
  } finally {
    await handlers.get("session_shutdown")?.({});
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
