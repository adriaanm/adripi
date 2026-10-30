import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import guardianExtension from "../src/index.ts";
import { findGuardianState } from "../src/state.ts";
import { GUARDIAN_ASSESSMENT_ENTRY, GUARDIAN_STATE_ENTRY } from "../src/types.ts";

for (const mutation of ["restriction", "denial", "tool warning", "generation", "queued sibling"] as const) {
	test(`registered review rejects stale ${mutation} without advancing its cursor or overwriting a generation`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "guardian-evidence-lifecycle-"));
		const executable = join(dir, "fake-pi.mjs"), started = join(dir, "started");
		await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
const input = JSON.parse(prompt.slice(prompt.indexOf(" ") + 1));
appendFileSync(${JSON.stringify(started)}, "started\\n");
await new Promise(resolve => setTimeout(resolve, 300));
process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment:{risk_level:"low",user_authorization:"high",outcome:"allow",rationale:"fixture"}})+"\\n");
`, { mode: 0o700 });
		await writeFile(join(dir, "guardian.json"), JSON.stringify({ piCommand: executable, reviewer: { model: "fixture/local", timeoutMs: 5000 } }));
		const old = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		const branch: SessionEntry[] = [];
		let sequence = 0;
		const append = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data, id: `meta-${++sequence}`, parentId: branch.at(-1)?.id ?? null, timestamp: "fixture" });
		branch.push({ type: "message", id: "user", parentId: null, timestamp: "fixture", message: { role: "user", content: "Source work only", timestamp: 0 } });
		branch.push({ type: "message", id: "assistant", parentId: "user", timestamp: "fixture", message: { role: "assistant", content: [
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo one" } },
			{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "echo two" } },
		], stopReason: "toolUse", timestamp: 0 } as never });
		const handlers: Record<string, (...args: any[]) => any> = {};
		const pi = { on: (name: string, handler: any) => { handlers[name] = handler; }, appendEntry: append, registerEntryRenderer() {}, registerCommand() {} } as unknown as ExtensionAPI;
		const ctx = { cwd: dir, hasUI: false, mode: "json", signal: undefined, ui: {}, sessionManager: {
			getSessionId: () => "parent", getBranch: () => structuredClone(branch),
		} };
		try {
			guardianExtension(pi); handlers.session_start({}, ctx);
			const pending = handlers.tool_call({ toolName: "bash", toolCallId: "call-1", input: { command: "echo one" } }, ctx);
			const deadline = Date.now() + 4000;
			while (!existsSync(started) && Date.now() < deadline) await delay(10);
			assert.ok(existsSync(started), "the reviewer actually entered before mutation");
			const sibling = mutation === "queued sibling" ? handlers.tool_call({ toolName: "bash", toolCallId: "call-2", input: { command: "echo two" } }, ctx) : undefined;
			const original = findGuardianState(branch)!;
			if (mutation === "generation") append(GUARDIAN_STATE_ENTRY, { ...original, guardianSessionId: "next-generation", generation: original.generation + 1 });
			else if (mutation === "denial") append(GUARDIAN_ASSESSMENT_ENTRY, { assessment: { outcome: "deny" }, rationale: "Unresolved denial" });
			else branch.push({ type: "message", id: "new-evidence", parentId: branch.at(-1)!.id, timestamp: "fixture",
				message: { role: mutation === "tool warning" ? "toolResult" : "user", content: mutation === "tool warning" ? "Security warning: this target changed" : "Stop; do not run this action.", timestamp: 1 } as never });
			const result = await pending;
			assert.equal(result?.block, true); assert.match(result.reason, /changed|stale/);
			if (sibling) { assert.equal((await sibling)?.block, true); assert.equal((await readFile(started, "utf8")).trim().split("\n").length, 1, "queued stale review never spawns"); }
			const state = findGuardianState(branch)!;
			assert.equal(state.lastReviewedParentEntryId, undefined);
			assert.equal(state.reviewCount, 0);
			assert.equal(state.guardianSessionId, mutation === "generation" ? "next-generation" : original.guardianSessionId);
		} finally {
			handlers.session_shutdown?.({}, ctx);
			if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
		}
	});
}
