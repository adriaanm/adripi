import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseDelegatedToolRequest, type DelegatedToolRequest } from "../src/delegated-tool.ts";
import { evaluatePermissions } from "../src/permissions.ts";
import { findGuardianState } from "../src/state.ts";
import { GUARDIAN_ASSESSMENT_ENTRY, GUARDIAN_STATE_ENTRY } from "../src/types.ts";
import { guardianUsageView } from "../src/usage.ts";
import { publishChildAuthority } from "../../pi-sbx/src/child-authority.ts";
import { createFilePolicy, canWrite } from "../../pi-sbx/src/path-policy.ts";
import { createChildAuthorityController } from "../../pi-subagents/src/api/child-authority.ts";
import { registerRequiredChildExtensions } from "../../pi-subagents/src/api/required-child-extensions.ts";

import { action, fixture, subject } from "./support/delegated-parent.ts";
const request = (): DelegatedToolRequest => ({ identity: { ...subject }, action: JSON.stringify(action) });

test("exact delegated action parsing preserves full write/edit/unknown/nested inputs without filtering", () => {
	const nested = { ...action, tool_name: "mcp__server__write", input: { payload: "文🌍".repeat(2000), extra: { computed: [1, true, null] } },
		parent_actions: [{ tool_name: "codemode", tool_call_id: "outer", input: { code: "await tools.write(actualRuntimeArgs)" } }] };
	assert.deepEqual(parseDelegatedToolRequest({ ...request(), action: JSON.stringify(nested) }).action, nested);
	assert.ok(JSON.stringify(nested).length > 2048);
});

test("delegated parser rejects identity/cwd substitution, unknown envelope fields, malformed/oversized JSON and cyclic parent ids", () => {
	for (const invalid of [
		{ ...request(), grant: true },
		{ ...request(), identity: { ...subject, permissions: "all" } },
		{ ...request(), identity: { ...subject, parentSessionId: "" } },
		{ ...request(), identity: { ...subject, index: -1 } },
		{ ...request(), signal: "ALLOW" },
		{ ...request(), action: "ALLOW" },
		{ ...request(), action: JSON.stringify({ ...action, cwd: "/foreign" }) },
		{ ...request(), action: JSON.stringify({ ...action, granted: true }) },
		{ ...request(), action: JSON.stringify({ ...action, input: [] }) },
		{ ...request(), action: JSON.stringify({ ...action, input: { content: "x".repeat(64000) } }) },
		{ ...request(), action: JSON.stringify({ ...action, parent_actions: [{ tool_name: "script", tool_call_id: "call", input: {} }] }) },
		{ ...request(), action: JSON.stringify({ ...action, parent_actions: [{ tool_name: "script", tool_call_id: "outer", input: {}, cwd: "/foreign" }] }) },
		{ ...request(), action: JSON.stringify({ ...action, parent_actions: Array.from({ length: 33 }, (_, index) => ({ tool_name: "script", tool_call_id: `id-${index}`, input: {} })) }) },
		{ ...request(), action: '{"tool_name":"write","tool_call_id":"call","cwd":"/workspace/child","input":{"number":1e400}}' },
	]) assert.throws(() => parseDelegatedToolRequest(invalid));
	const deep = `${'['.repeat(70)}0${']'.repeat(70)}`;
	assert.throws(() => parseDelegatedToolRequest({ ...request(), action: `{"tool_name":"write","tool_call_id":"call","cwd":"/workspace/child","input":{"deep":${deep}}}` }), /nesting/);
});

test("child argument paths resolve in child cwd but parent fixed rules retain their original anchor", () => {
	const permissions = { allow: ["Read(./safe/**)"], deny: ["Edit(./pinned/protected/**)"], agentDirWriteProjects: [] };
	assert.equal(evaluatePermissions(permissions, "read", { path: "../safe/file" }, "/project", "/agent", "/project/child").outcome, "allow");
	assert.equal(evaluatePermissions(permissions, "read", { path: "safe/file" }, "/project", "/agent", "/project/child").outcome, "review");
	assert.equal(evaluatePermissions(permissions, "write", { path: "../pinned/protected/file" }, "/project", "/agent", "/project/child").outcome, "deny");
	assert.equal(evaluatePermissions(permissions, "write", { path: "pinned/protected/file" }, "/project", "/agent", "/project/child").outcome, "review");
	for (const path of [".pi/guardian.json", "../.pi/guardian.json"]) {
		assert.equal(evaluatePermissions(permissions, "write", { path }, "/project", "/agent", "/project/child").outcome, "deny");
	}
});

test("registered parent broker uses ordinary fixed/semantic engines, exact inputs, full directives, same durable reviewer/costs and no parent-cursor consumption", async () => {
	const f = fixture();
	try {
		assert.equal((await f.ask({ path: "../protected/file", content: "x" })).outcome, "deny");
		assert.equal(f.readPrompts().length, 0, "parent relative fixed deny runs before the reviewer");
		assert.equal((await f.ask({ path: "settings.json" }, { tool_name: "read" })).outcome, "allow");
		assert.equal(f.readPrompts().length, 0);
		// Parent maintenance semantics do not grant the child's file/OS gate a path exception.
		assert.equal((await f.ask({ path: join(f.agentDir, "settings.json"), content: "x" })).outcome, "allow");
		assert.equal(f.readPrompts().length, 0);
		for (const path of [".pi/guardian.json", "../.pi/guardian.json", join(f.agentDir, "auth.json")]) {
			assert.equal((await f.ask({ path, content: "x" })).outcome, "deny");
		}
		const original = findGuardianState(f.branch)!;
		f.append(GUARDIAN_STATE_ENTRY, { ...original, lastReviewedParentEntryId: "parent-cursor" });
		const input = { path: "file", content: "文🌍".repeat(2000), arbitrary: { runtime: [1, 2, 3] } };
		const parents = [{ tool_name: "codemode", tool_call_id: "script", input: { code: "await tools.write(computedArgs)" } }];
		assert.equal((await f.ask(input, { parent_actions: parents })).outcome, "allow");
		const envelope = f.readPrompts()[0];
		assert.deepEqual(envelope.action.input, input);
		assert.deepEqual(envelope.action.parent_actions, parents);
		assert.ok(envelope.directives.some((item: any) => item.text.includes("Never deploy")));
		assert.ok(envelope.evidence.some((item: any) => item.text.includes('"runId":"run"')));
		const state = findGuardianState(f.branch)!;
		assert.equal(state.guardianSessionId, original.guardianSessionId);
		assert.equal(state.lastReviewedParentEntryId, "parent-cursor");
		assert.equal(state.reviewCount, 1);
		const audit = f.branch.filter(entry => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY).at(-1)!;
		assert.equal(audit.type, "custom");
		assert.deepEqual((audit as any).data.delegated.action.input, input);
		assert.equal((audit as any).data.delegated.identity.cwd, f.child);
		const denied = await f.ask({ path: "file", content: "FORBIDDEN content" }, { tool_call_id: "deny-call" });
		assert.equal(denied.outcome, "deny"); assert.equal(denied.terminate, true);
		assert.match(denied.rationale ?? "", /Forbidden exact content/);
		const usage = guardianUsageView(f.branch, "parent");
		assert.equal(usage.totals.review.calls, 2);
		assert.equal(usage.totals.review.usd, 0.02);
		assert.equal(f.branch.some(entry => entry.type === "message" && entry.message.role === "assistant"), false, "no synthetic parent assistant usage");
		assert.equal((await f.broker.reviewTool!({ ...request(), identity: { ...subject, parentSessionId: "other", cwd: f.child }, action: JSON.stringify({ ...action, cwd: f.child }) })).outcome, "deny");
	} finally { f.close(); }
});

test("real Node IPC binds pi-sbx's prepared provider to the registered parent Guardian exact-tool service", async () => {
	const f = fixture();
	const policy = createFilePolicy({ filesystem: { denyRead: [], allowWrite: [f.parent], denyWrite: [] }, mandatoryDenyWrite: [f.agentDir] });
	const publication = publishChildAuthority({ sessionId: "parent", agentDir: f.agentDir, configDirName: ".pi",
		getBaseline: () => ({ cwd: f.parent, policy, allowUnsandboxedCommands: false,
			runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [f.parent], denyWrite: [] } },
			environmentDeny: [],
		}),
		getHuman: () => ({ ask: async () => { throw new Error("Semantic review must not ask for a path exception"); } }),
		requiredExtensions: [
			{ id: "pi-sbx", path: fileURLToPath(new URL("../../pi-sbx/src/index.ts", import.meta.url)) },
			{ id: "pi-guardian", path: fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
		], loadRegistration: async () => ({ registerRequiredChildExtensions }),
	});
	// This is a protocol fixture, NOT production consumer readiness or OS containment.
	const input = { path: "file", content: "文🌍".repeat(2000), computed: { preserve: [true, 123] } };
	const target = JSON.stringify({ ...action, input, cwd: f.child });
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../../pi-subagents/test/fixtures/child-authority/runner-client.ts", import.meta.url)),
		JSON.stringify({ consumers: ["pi-sbx", "pi-guardian"], acknowledge: ["pi-sbx", "pi-guardian"], requests: [{ surface: "tool", target, reason: "review the actual write" }] })],
		{ cwd: f.child, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let output = "", error = "";
	child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { error += chunk; });
	const closed = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
	const controller = createChildAuthorityController({ child, provider: publication.provider, sessionId: "parent", runId: "run" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
	try {
		await publication.ready;
		await controller.prepare({ agent: "worker", index: 0, cwd: f.child });
		assert.equal(await closed, 0, error);
		const line = output.split("\n").find(line => line.startsWith("AUTHORITY_RESULT "));
		assert.ok(line, output + error);
		const result = JSON.parse(line.slice("AUTHORITY_RESULT ".length));
		assert.equal(result.requests[0].decision.outcome, "allow");
		assert.deepEqual(f.readPrompts()[0].action.input, input);
		assert.equal(f.readPrompts()[0].action.cwd, f.child);
		assert.ok(f.readPrompts()[0].directives.some((item: any) => item.text.includes("Never deploy")));
		const record = (f.branch.filter(entry => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY).at(-1) as any).data;
		assert.deepEqual(record.delegated.identity, { ...subject, cwd: f.child });
		assert.equal(guardianUsageView(f.branch, "parent").totals.review.calls, 1);
		assert.equal(canWrite(join(f.root, "outside"), f.parent, policy), false, "semantic approval never widens the file policy");
	} finally {
		clearTimeout(timer); controller.dispose(); publication.dispose();
		if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
		f.close();
	}
});

for (const mutation of ["restriction", "denial", "tool warning", "queued sibling", "generation", "parent", "shutdown", "cancel"] as const) {
	test(`delegated parent review rejects late approval after ${mutation} and cannot advance a cursor`, async () => {
		const f = fixture(true), controller = new AbortController();
		try {
			const pending = f.ask({ path: "file", content: "x" }, {}, controller.signal);
			const deadline = Date.now() + 4000;
			while (!existsSync(f.started) && Date.now() < deadline) await delay(10);
			assert.ok(existsSync(f.started), "the real sidecar started before mutation");
			const original = findGuardianState(f.branch)!;
			const sibling = mutation === "queued sibling" ? f.ask({ path: "second", content: "x" }, { tool_call_id: "queued-child" }) : undefined;
			if (mutation === "generation") f.append(GUARDIAN_STATE_ENTRY, { ...original, guardianSessionId: "replacement", generation: original.generation + 1 });
			else if (mutation === "parent") f.switchSession();
			else if (mutation === "cancel") controller.abort();
			else if (mutation === "shutdown") f.handlers.session_shutdown({}, f.ctx);
			else if (mutation === "denial") f.append(GUARDIAN_ASSESSMENT_ENTRY, { assessment: { outcome: "deny" }, rationale: "Unresolved new denial" });
			else f.branch.push({ type: "message", id: "stop", parentId: f.branch.at(-1)!.id, timestamp: "fixture", message: { role: mutation === "tool warning" ? "toolResult" : "user", content: "Stop; do not write anything", timestamp: 1 } as never });
			assert.notEqual((await pending).outcome, "allow");
			if (sibling) { assert.notEqual((await sibling).outcome, "allow"); assert.equal(f.readPrompts().length, 1, "queued stale child never starts another reviewer process"); }
			const state = findGuardianState(f.branch)!;
			assert.equal(state.reviewCount, 0); assert.equal(state.lastReviewedParentEntryId, undefined);
			assert.equal(state.guardianSessionId, mutation === "generation" ? "replacement" : original.guardianSessionId);
		} finally { f.close(); }
	});
}
