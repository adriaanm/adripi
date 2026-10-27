import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import guardianExtension, { guardianFailureHelp } from "../src/index.ts";
import { findGuardianState } from "../src/state.ts";
import { formatGuardianAssessment, formatGuardianStatus } from "../src/tui.ts";
import {
	GUARDIAN_ASSESSMENT_ENTRY,
	GUARDIAN_STATE_ENTRY,
	type GuardianAssessmentRecordV1,
	type GuardianStateV1,
} from "../src/types.ts";

interface FakeToolEvent {
	parentToolCallId?: string;
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

interface FakeContext {
	hasUI: boolean;
	mode?: string;
	cwd: string;
	signal: undefined;
	sessionManager: {
		getBranch(): SessionEntry[];
		getSessionId(): string;
	};
	ui: {
		setStatus(key: string, value: string): void;
		setWorkingMessage(message?: string): void;
		setWidget(key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		notify(message: string, kind: "info" | "warning" | "error"): void;
	};
}

type ToolHandler = (
	event: FakeToolEvent,
	context: FakeContext,
) => Promise<{ block: true; reason: string; terminate?: boolean } | undefined>;

type SessionStartHandler = (event: unknown, context: FakeContext) => void;

interface GuardianCommand {
	handler(args: string, context: FakeContext): Promise<void>;
}

function message(id: string, parentId: string | null, role: string, content: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: 0 } as never,
	};
}

test("extension reuses one sidecar, sends a delta, audits, allows, and denies", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-index-test-"));
	const agentDir = join(directory, "agent");
	const executable = join(directory, "fake-pi.mjs");
	const promptsPath = join(directory, "prompts.jsonl");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(process.env.FAKE_GUARDIAN_PROMPTS, JSON.stringify(prompt) + "\\n");
const denied = prompt.includes('"command": "rm -rf /"');
const assessment = denied
  ? {risk_level:"critical",user_authorization:"unknown",outcome:"deny",rationale:"The command would destroy the laptop filesystem."}
  : {risk_level:"low",user_authorization:"medium",outcome:"allow",rationale:"The command is a bounded local operation."};
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(assessment)}]}}) + "\\n");
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	await writeFile(
		join(directory, "guardian.json"),
		JSON.stringify({
			piCommand: executable,
			guardianSessionDir: join(directory, "sidecars"),
			maxConsecutiveDenials: 1,
			reviewer: { model: "fake/luna", thinking: "low", timeoutMs: 5_000, maxAttempts: 1 },
		}),
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPrompts = process.env.FAKE_GUARDIAN_PROMPTS;
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.FAKE_GUARDIAN_PROMPTS = promptsPath;
	try {
		const branch: SessionEntry[] = [
			message("u1", null, "user", "Run a harmless command, but do not delete anything."),
			message("a1", "u1", "assistant", [
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo okay" } },
			]),
		];
		let toolHandler: ToolHandler | undefined;
		let sessionStartHandler: SessionStartHandler | undefined;
		let entrySequence = 0;
		const notifications: string[] = [];
		const workingMessages: Array<string | undefined> = [];
		const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
		let assessmentRendererRegistered = false;
		let guardianCommand: GuardianCommand | undefined;
		const fakePi = {
			on(event: string, handler: unknown) {
				if (event === "tool_call") toolHandler = handler as ToolHandler;
				if (event === "session_start") sessionStartHandler = handler as SessionStartHandler;
			},
			appendEntry(customType: string, data: unknown) {
				const parentId = branch.at(-1)?.id ?? null;
				branch.push({
					type: "custom",
					id: `ext-${++entrySequence}`,
					parentId,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			},
			registerEntryRenderer(customType: string) {
				if (customType === GUARDIAN_ASSESSMENT_ENTRY) assessmentRendererRegistered = true;
			},
			registerCommand(name: string, command: GuardianCommand) {
				if (name === "guardian") guardianCommand = command;
			},
		} as unknown as ExtensionAPI;
		guardianExtension(fakePi);
		assert.ok(toolHandler);
		assert.ok(guardianCommand);
		assert.equal(assessmentRendererRegistered, true);
		const context: FakeContext = {
			hasUI: true,
			mode: "tui",
			cwd: directory,
			signal: undefined,
			sessionManager: {
				getBranch: () => structuredClone(branch),
				getSessionId: () => "parent-session",
			},
			ui: {
				setStatus: () => {},
				setWorkingMessage: (messageText) => workingMessages.push(messageText),
				setWidget: (key, content, options) => widgets.push({ key, content, placement: options?.placement }),
				notify: (messageText) => notifications.push(messageText),
			},
		};
		assert.ok(sessionStartHandler);
		sessionStartHandler({}, context);
		assert.deepEqual(
			widgets.map(({ key, placement, content }) => ({ key, placement, contentType: typeof content })),
			[{ key: "pi-guardian-status", placement: "aboveEditor", contentType: "function" }],
		);

		const allowed = await toolHandler({ toolName: "bash", toolCallId: "call-1", input: { command: "echo okay" } }, context);
		assert.equal(allowed, undefined);
		const firstStateEntry = branch.find(
			(entry) => entry.type === "custom" && entry.customType === GUARDIAN_STATE_ENTRY,
		);
		assert.ok(firstStateEntry?.type === "custom");
		const firstState = firstStateEntry.data as GuardianStateV1;

		branch.push(
			message("a2", branch.at(-1)?.id ?? null, "assistant", [
				{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "rm -rf /" } },
			]),
		);
		const denied = await toolHandler({ toolName: "bash", toolCallId: "call-2", input: { command: "rm -rf /" } }, context);
		assert.equal(denied?.block, true);
		assert.equal(denied?.terminate, true);
		assert.match(denied?.reason ?? "", /destroy the laptop filesystem/);
		assert.equal(notifications.length, 1);

		const states = branch
			.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_STATE_ENTRY)
			.map((entry) => (entry.type === "custom" ? (entry.data as GuardianStateV1) : undefined));
		assert.ok(states.length >= 3);
		assert.ok(states.every((state) => state?.guardianSessionId === firstState.guardianSessionId));
		assert.equal(
			branch.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY).length,
			2,
		);
		const assessments = branch
			.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY)
			.map((entry) => (entry.type === "custom" ? (entry.data as GuardianAssessmentRecordV1) : undefined));
		assert.deepEqual(
			assessments.map((assessment) => assessment?.toolName),
			["bash", "bash"],
		);
		assert.deepEqual(workingMessages, ["Guardian reviewing 1 tool…", undefined, "Guardian reviewing 1 tool…", undefined]);

		const prompts = (await readFile(promptsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string);
		assert.equal(prompts.length, 2);
		assert.match(prompts[0], />>> TRANSCRIPT START/);
		assert.match(prompts[1], />>> TRANSCRIPT DELTA START/);
		assert.doesNotMatch(prompts[1], /Run a harmless command/);
		assert.match(prompts[1], /rm -rf/);

		await guardianCommand.handler("off", context);
		const disabledConfig = JSON.parse(await readFile(join(directory, "guardian.json"), "utf8")) as {
			enabled?: boolean;
			reviewer?: { model?: string };
		};
		assert.equal(disabledConfig.enabled, false);
		assert.equal(disabledConfig.reviewer?.model, "fake/luna");
		const bypassed = await toolHandler(
			{ toolName: "bash", toolCallId: "call-disabled", input: { command: "rm -rf /" } },
			context,
		);
		assert.equal(bypassed, undefined);
		await guardianCommand.handler("on", context);
		const enabledConfig = JSON.parse(await readFile(join(directory, "guardian.json"), "utf8")) as {
			enabled?: boolean;
		};
		assert.equal(enabledConfig.enabled, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPrompts === undefined) delete process.env.FAKE_GUARDIAN_PROMPTS;
		else process.env.FAKE_GUARDIAN_PROMPTS = previousPrompts;
	}
});

test("sibling tool reviews are pre-launched and overlap after the first sidecar turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-parallel-test-"));
	const executable = join(directory, "slow-fake-pi.mjs");
	const eventsPath = join(directory, "events.jsonl");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const commandMatches = [...prompt.matchAll(/"command"\\s*:\\s*"([^"]+)/g)];
const command = commandMatches.at(-1)?.[1] ?? "unknown";
appendFileSync(process.env.FAKE_GUARDIAN_EVENTS, JSON.stringify({kind:"start",command,at:Date.now()}) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 200));
appendFileSync(process.env.FAKE_GUARDIAN_EVENTS, JSON.stringify({kind:"end",command,at:Date.now()}) + "\\n");
const assessment = {risk_level:"low",user_authorization:"medium",outcome:"allow",rationale:"Bounded test action."};
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(assessment)}]}}) + "\\n");
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	await writeFile(
		join(directory, "guardian.json"),
		JSON.stringify({
			piCommand: executable,
			guardianSessionDir: join(directory, "sidecars"),
			maxParallelReviews: 2,
			reviewer: { model: "fake/luna", thinking: "low", timeoutMs: 5_000, maxAttempts: 1 },
		}),
	);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousEvents = process.env.FAKE_GUARDIAN_EVENTS;
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.FAKE_GUARDIAN_EVENTS = eventsPath;
	try {
		const branch: SessionEntry[] = [message("u1", null, "user", "Run the three bounded checks.")];
		let toolHandler: ToolHandler | undefined;
		let messageEndHandler: ((event: { message: unknown }, context: FakeContext) => void) | undefined;
		let entrySequence = 0;
		const fakePi = {
			on(event: string, handler: unknown) {
				if (event === "tool_call") toolHandler = handler as ToolHandler;
				if (event === "message_end") {
					messageEndHandler = handler as (event: { message: unknown }, context: FakeContext) => void;
				}
			},
			appendEntry(customType: string, data: unknown) {
				branch.push({
					type: "custom",
					id: `ext-${++entrySequence}`,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			},
			registerEntryRenderer() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		guardianExtension(fakePi);
		assert.ok(toolHandler);
		assert.ok(messageEndHandler);
		const context: FakeContext = {
			hasUI: true,
			mode: "tui",
			cwd: directory,
			signal: undefined,
			sessionManager: {
				getBranch: () => structuredClone(branch),
				getSessionId: () => "parallel-parent",
			},
			ui: {
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				notify: () => {},
			},
		};
		const toolBlocks = ["one", "two", "three", "four", "five"].map((command, index) => ({
			type: "toolCall",
			id: `call-${index + 1}`,
			name: "bash",
			arguments: { command },
		}));
		const assistant = { role: "assistant", content: toolBlocks, stopReason: "toolUse", timestamp: 0 };
		messageEndHandler({ message: assistant }, context);
		branch.push(message("a1", branch.at(-1)?.id ?? null, "assistant", toolBlocks));

		for (let index = 0; index < toolBlocks.length; index++) {
			const toolResult: { block: true; reason: string; terminate?: boolean } | undefined = await toolHandler(
				{
					toolName: "bash",
					toolCallId: `call-${index + 1}`,
					input: { command: ["one", "two", "three", "four", "five"][index] },
				},
				context,
			);
			assert.equal(toolResult, undefined);
		}

		const events = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: "start" | "end"; command: string; at: number });
		assert.equal(events.length, 10);
		const startTwo = events.findIndex((event) => event.kind === "start" && event.command === "two");
		const startThree = events.findIndex((event) => event.kind === "start" && event.command === "three");
		const firstSiblingEnd = events.findIndex(
			(event) => event.kind === "end" && (event.command === "two" || event.command === "three"),
		);
		assert.ok(startTwo >= 0 && startThree >= 0 && firstSiblingEnd >= 0);
		assert.ok(startTwo < firstSiblingEnd && startThree < firstSiblingEnd, JSON.stringify(events));
		let running = 0;
		for (const event of events) {
			running += event.kind === "start" ? 1 : -1;
			assert.ok(running >= 0 && running <= 2, JSON.stringify(events));
		}
		assert.equal(running, 0);
		const assessmentCount = branch.filter(
			(entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY,
		).length;
		assert.equal(assessmentCount, 5);
		const finalState = findGuardianState(branch);
		assert.equal(finalState?.reviewCount, 5);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousEvents === undefined) delete process.env.FAKE_GUARDIAN_EVENTS;
		else process.env.FAKE_GUARDIAN_EVENTS = previousEvents;
	}
});

test("assessment display distinguishes allow, deny, and review failure", () => {
	const base: GuardianAssessmentRecordV1 = {
		version: 1,
		guardianSessionId: "guardian-session",
		source: "reviewer",
		toolName: "bash",
		toolCallId: "call-1",
		actionHash: "hash",
		turnKey: "turn",
		assessment: {
			risk_level: "low",
			user_authorization: "medium",
			outcome: "allow",
			rationale: "Bounded and authorized.",
		},
		reviewedAt: "2026-01-01T00:00:00.000Z",
	};

	assert.deepEqual(formatGuardianAssessment(base), {
		tone: "success",
		headline: "Guardian allowed bash",
		details: ["low risk · medium user authorization", "Bounded and authorized."],
	});
	assert.equal(
		formatGuardianAssessment({
			...base,
			assessment: { ...base.assessment, outcome: "deny", rationale: "Destructive action." },
		}).headline,
		"Guardian denied bash",
	);
	assert.deepEqual(
		formatGuardianAssessment({
			...base,
			failure: "Guardian review timed out after 90000ms",
			failureHelp: "Increase reviewer.timeoutMs in /tmp/guardian.json.",
		}),
		{
			tone: "error",
			headline: "Guardian blocked bash because review failed",
			details: [
				"Guardian review timed out after 90000ms",
				"Fix: Increase reviewer.timeoutMs in /tmp/guardian.json.",
			],
		},
	);
});

test("status widget copy and colors make enabled and disabled states unambiguous", () => {
	assert.deepEqual(formatGuardianStatus("enabled"), { tone: "warning", text: "⬭ guardian enabled" });
	assert.deepEqual(formatGuardianStatus("disabled"), { tone: "error", text: "Ψ guardian disabled" });
	assert.deepEqual(formatGuardianStatus("error"), { tone: "error", text: "Ψ guardian configuration error" });
	assert.deepEqual(formatGuardianStatus("enabled", "openai-codex/gpt-5.6-luna"), {
		tone: "warning",
		text: "⬭ guardian enabled",
		model: "openai-codex/gpt-5.6-luna",
	});
});

test("review failures point to the relevant configuration fix", () => {
	const configPath = "/Users/test/.pi/agent/guardian.json";
	assert.match(guardianFailureHelp("Guardian review timed out after 90000ms", configPath), /reviewer\.timeoutMs/);
	assert.match(guardianFailureHelp("Could not start Guardian sidecar: spawn ENOENT", configPath), /piCommand/);
	assert.match(guardianFailureHelp("provider authentication failed with 401", configPath), /Authenticate/);
	assert.match(guardianFailureHelp("Guardian returned malformed output", configPath), /structured response/);
	assert.match(guardianFailureHelp("unexpected failure", configPath), /reviewer\.model/);
	assert.ok(guardianFailureHelp("unexpected failure", configPath).includes(configPath));
});

test("nested calls retain full parent evidence, review MCP, exempt reads, and fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-nested-test-"));
	const executable = join(directory, "fake-pi.mjs");
	const promptsPath = join(directory, "prompts.jsonl");
	await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(promptsPath)}, JSON.stringify(prompt) + "\\n");
const denied = prompt.includes('"command": "rm -rf /"');
const assessment = {risk_level:denied?"critical":"low",user_authorization:"medium",outcome:denied?"deny":"allow",rationale:denied?"Destructive action.":"Bounded action."};
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(assessment)}]}}) + "\\n");
`, { mode: 0o700 });
	await writeFile(join(directory, "guardian.json"), JSON.stringify({
		piCommand: executable,
		guardianSessionDir: join(directory, "sidecars"),
		maxConsecutiveDenials: 2,
		reviewer: { model: "fake/luna", timeoutMs: 5_000, maxAttempts: 1 },
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const script = `/*${"parent evidence ".repeat(800)}*/ await tools.bash({command: computeCommand()});`;
		const branch = [
			message("u1", null, "user", "Run bounded checks."),
			message("a1", "u1", "assistant", [{ type: "toolCall", id: "root", name: "codemode", arguments: { code: script } }]),
		];
		const handlers = new Map<string, Function>();
		const fakePi = {
			on: (event: string, handler: Function) => handlers.set(event, handler),
			appendEntry(customType: string, data: unknown) {
				branch.push({ type: "custom", id: `ext-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(), customType, data });
			},
			registerEntryRenderer() {},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		guardianExtension(fakePi);
		const context: FakeContext = {
			hasUI: false, mode: "json", cwd: directory, signal: undefined,
			sessionManager: { getBranch: () => structuredClone(branch), getSessionId: () => "nested-parent" },
			ui: new Proxy({}, { get() { throw new Error("Headless UI must not be accessed"); } }) as FakeContext["ui"],
		};
		handlers.get("session_start")!({}, context);
		handlers.get("input")!({}, context);
		const call = handlers.get("tool_call")! as ToolHandler;
		assert.equal(await call({ toolName: "codemode", toolCallId: "root", input: { code: script } }, context), undefined);
		assert.equal(await call({ toolName: "bash", toolCallId: "root/1", parentToolCallId: "root", input: { command: "echo okay" } }, context), undefined);
		assert.equal(await call({ toolName: "read", toolCallId: "root/2", parentToolCallId: "root", input: { path: "README.md" } }, context), undefined);
		assert.equal(await call({ toolName: "mcp__server__tool", toolCallId: "root/3", parentToolCallId: "root", input: { value: 1 } }, context), undefined);
		// A custom orchestration tool can nest more deeply even though codemode cannot call itself.
		assert.equal(await call({ toolName: "bash", toolCallId: "root/3/1", parentToolCallId: "root/3", input: { command: "echo deep" } }, context), undefined);
		const denied = await call({ toolName: "bash", toolCallId: "root/4", parentToolCallId: "root", input: { command: "rm -rf /" } }, context);
		assert.equal(denied?.block, true);
		assert.equal(denied?.terminate, false);
		const missing = await call({ toolName: "bash", toolCallId: "missing/1", parentToolCallId: "missing", input: { command: "echo okay" } }, context);
		assert.equal(missing?.block, true);
		assert.equal(missing?.terminate, true);
		assert.match(missing?.reason ?? "", /Could not locate parent tool call missing/);
		branch.push(message("a2", branch.at(-1)?.id ?? null, "assistant", [
			{ type: "toolCall", id: "mcp-direct", name: "mcp__server__tool", arguments: { value: 2 } },
		]));
		assert.equal(await call({ toolName: "mcp__server__tool", toolCallId: "mcp-direct", input: { value: 2 } }, context), undefined);
		const prompts = (await readFile(promptsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
		assert.equal(prompts.length, 6);
		assert.match(prompts[1], /Exact nested action requested/);
		assert.ok(prompts[1].includes(JSON.stringify(script)));
		assert.match(prompts[2], /mcp__server__tool/);
		assert.match(prompts[3], /root\/3/);
		assert.match(prompts[5], /mcp-direct/);
		const assessments = branch.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY);
		assert.equal(assessments.length, 7);
		assert.equal(findGuardianState(branch)?.consecutiveDenials, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("fixed denies audit nested calls, bypass speculative review, and count the denial streak", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-rule-index-"));
	await writeFile(join(directory, "guardian.json"), JSON.stringify({
		piCommand: "/does-not-exist-reviewer", maxConsecutiveDenials: 2,
		permissions: { allow: ["Read", "codemode", "Bash(git status)"], deny: ["Read(~/.codex/**)", "Bash(git push:*)"] },
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const branch: SessionEntry[] = [message("user", null, "user", "Run checks.")];
		const handlers = new Map<string, Function>();
		const fakePi = {
			on: (name: string, handler: Function) => handlers.set(name, handler),
			appendEntry(customType: string, data: unknown) {
				branch.push({
					type: "custom",
					id: `entry-${branch.length}`,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			}, registerEntryRenderer() {}, registerCommand() {},
		} as unknown as ExtensionAPI;
		guardianExtension(fakePi);
		const context: FakeContext = {
			hasUI: false, mode: "json", cwd: directory, signal: undefined,
			sessionManager: { getBranch: () => structuredClone(branch), getSessionId: () => "rule-parent" },
			ui: new Proxy({}, { get() { throw new Error("Headless UI must not be accessed"); } }) as FakeContext["ui"],
		};
		handlers.get("session_start")!({}, context);
		const call = handlers.get("tool_call")! as ToolHandler;
		const blocks = [
			{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "await tools.read({path: computePath()})" } },
			{ type: "toolCall", id: "push", name: "bash", arguments: { command: "git push origin" } },
		];
		handlers.get("message_end")!({ message: { role: "assistant", content: blocks } }, context);
		branch.push(message("assistant", branch.at(-1)?.id ?? null, "assistant", blocks));
		assert.equal(await call({ toolName: "codemode", toolCallId: "outer", input: blocks[0].arguments }, context), undefined);
		const denied = await call(
			{ toolName: "read", toolCallId: "outer/1", parentToolCallId: "outer", input: { path: "~/.codex/auth.json" } },
			context,
		);
		assert.equal(denied?.block, true);
		assert.equal(denied?.terminate, false);
		assert.match(denied?.reason ?? "", /fixed permission rule[\s\S]*Do not retry by other means/);
		const second = await call({ toolName: "bash", toolCallId: "push", input: { command: "git push origin" } }, context);
		assert.equal(second?.terminate, true);
		const records = branch.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY)
			.map((entry) => (entry as Extract<SessionEntry, { type: "custom" }>).data as GuardianAssessmentRecordV1);
		assert.equal(records.length, 2);
		assert.equal(records[0].parentToolCallId, "outer");
		assert.equal(records[0].parentCursorEntryId, "assistant");
		assert.equal(records[0].source, "rule");
		assert.equal(records[0].rule, "Read(~/.codex/**)");
		assert.deepEqual(records[0].assessment, {
			risk_level: "high",
			user_authorization: "unknown",
			outcome: "deny",
			rationale: "Denied by rule Read(~/.codex/**)",
		});
		assert.equal(records[0].failure, undefined);
		assert.equal(findGuardianState(branch)?.reviewCount, 0);
		assert.equal(findGuardianState(branch)?.consecutiveDenials, 2);
		assert.equal(await call({ toolName: "read", toolCallId: "allowed", input: { path: "public.txt" } }, context), undefined);
		assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === GUARDIAN_ASSESSMENT_ENTRY).length, 2);
		// Rule and reviewer denials share the same state counter; a reviewer failure is the third denial.
		const third = await call({ toolName: "bash", toolCallId: "review", input: { command: "unknown" } }, context);
		assert.equal(third?.terminate, true);
		assert.equal(findGuardianState(branch)?.consecutiveDenials, 3);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("malformed permission config blocks even default-exempt reads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-rule-invalid-"));
	await writeFile(join(directory, "guardian.json"), JSON.stringify({ permissions: { deny: ["Read("] } }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const handlers = new Map<string, Function>();
		const entries: Array<{ customType: string; data: Record<string, unknown> }> = [];
		guardianExtension({ on: (name: string, handler: Function) => handlers.set(name, handler),
			appendEntry: (customType: string, data: Record<string, unknown>) => entries.push({ customType, data }),
			registerEntryRenderer() {},
			registerCommand() {},
		} as unknown as ExtensionAPI);
		const ctx = { hasUI: false, mode: "json", cwd: directory } as FakeContext;
		handlers.get("session_start")!({}, ctx);
		assert.equal(entries[0].data.permissions, null);
		assert.equal(entries[0].data.permissionsSha256, null);
		assert.match(String(entries[0].data.configError), /Malformed permission rule/);
		const toolCall = handlers.get("tool_call")! as ToolHandler;
		const result = await toolCall({ toolName: "read", toolCallId: "read", input: { path: "public.txt" } }, ctx);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /Malformed permission rule/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
