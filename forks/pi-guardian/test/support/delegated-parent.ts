import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import guardianExtension from "../../src/index.ts";
import { getSandboxBroker } from "../../src/sandbox/broker.ts";

export const subject = { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: "/workspace/child" };
export const action = { tool_name: "write", tool_call_id: "call", input: { path: "file", content: "actual edit" }, cwd: subject.cwd };

/** Registered production parent, synthetic transcript and credential-free sidecar verdict/usage.
 * This is not a paid reviewer, real human approval or deployed identity fixture. */
export function fixture(slow = false) {
	const root = mkdtempSync(join(process.env.PI_SANDBOX_SCRATCH ?? tmpdir(), "guardian-delegated-"));
	const parent = join(root, "project"), child = join(parent, "child"), agentDir = join(root, "agent");
	for (const dir of [parent, child, agentDir]) mkdirSync(dir, { recursive: true });
	const log = join(root, "prompts.jsonl"), started = join(root, "started"), executable = join(root, "fake-pi.mjs");
	writeFileSync(executable, `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from "node:fs";
let raw=""; for await (const chunk of process.stdin) raw+=chunk;
const input=JSON.parse(raw.slice(raw.indexOf(" ")+1));
const envelope=JSON.parse(input.prompt);
appendFileSync(${JSON.stringify(log)},JSON.stringify(envelope)+"\\n");
writeFileSync(${JSON.stringify(started)},"started");
${slow ? 'await new Promise(resolve=>setTimeout(resolve,250));' : ''}
const calls=readFileSync(${JSON.stringify(log)},"utf8").trim().split("\\n").length;
const zero={calls:0,input:0,output:0,cacheRead:0,cacheWrite:0,usd:0,unpriced:0,unreported:0};
const totals=Object.fromEntries(["review","format-retry","summary","legacy"].map(kind=>[kind,{...zero}]));
totals.review={...zero,calls,input:calls*100,output:calls*20,usd:calls*0.01};
process.stdout.write(JSON.stringify({type:"guardian_usage",nonce:input.nonce,usage:{version:1,parentSessionId:input.parentSessionId,reviewerSessionId:input.sessionId,revision:calls,totals}})+"\\n");
const denied=JSON.stringify(envelope.action.input ?? envelope.action).includes("FORBIDDEN");
process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment:{risk_level:denied?"high":"low",user_authorization:"high",outcome:denied?"deny":"allow",rationale:denied?"Forbidden exact content":"Bounded fixture action"}})+"\\n");
`, { mode: 0o700 });
	writeFileSync(join(agentDir, "guardian.json"), JSON.stringify({ piCommand: executable, maxConsecutiveDenials: 1,
		permissions: { allow: ["Read"], deny: ["Edit(./protected/**)"], agentDirWriteProjects: [parent] },
		reviewer: { model: "fixture/local", timeoutMs: 5000, maxAttempts: 1 } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const branch: SessionEntry[] = [{ type: "message", id: "user", parentId: null, timestamp: "fixture",
		message: { role: "user", content: "Update the assigned child only. Never deploy.", timestamp: 0 } }];
	const handlers: Record<string, (...args: any[]) => any> = {};
	let sequence = 0, sessionId = "parent";
	const append = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data, id: `meta-${++sequence}`, parentId: branch.at(-1)?.id ?? null, timestamp: "fixture" });
	const pi = { on: (name: string, handler: any) => { handlers[name] = handler; }, appendEntry: append, registerEntryRenderer() {}, registerCommand() {} } as unknown as ExtensionAPI;
	const ctx = { cwd: parent, hasUI: false, mode: "print", signal: undefined, ui: {}, sessionManager: {
		getSessionId: () => sessionId, getBranch: () => structuredClone(branch), getEntries: () => structuredClone(branch),
	} } as unknown as ExtensionContext;
	guardianExtension(pi); handlers.session_start({}, ctx);
	const broker = getSandboxBroker()!;
	assert.equal(typeof broker.reviewTool, "function");
	return { root, parent, child, agentDir, log, started, branch, handlers, ctx, append, broker,
		readPrompts: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
		ask: (input: Record<string, unknown>, extra: Record<string, unknown> = {}, signal?: AbortSignal) => broker.reviewTool!({
			identity: { ...subject, cwd: child }, action: JSON.stringify({ ...action, cwd: child, input, ...extra }), signal,
		}),
		switchSession: () => { sessionId = "new-parent"; },
		close: () => { handlers.session_shutdown?.({}, ctx); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); },
	};
}
