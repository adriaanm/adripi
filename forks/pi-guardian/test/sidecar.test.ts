import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSidecarArgs, getPiInvocation, requestGuardianAssessment } from "../src/sidecar.ts";
import type { GuardianConfig, GuardianStateV1 } from "../src/types.ts";

const config = {
	reviewerModel: "openai-codex/gpt-5.6-luna",
	reviewerExtensions: [],
	thinkingLevel: "low",
	policyPath: "/trusted/guardian-policy.md",
	piCommand: "/usr/local/bin/pi",
} as unknown as GuardianConfig;

const state = {
	guardianSessionId: "guardian-123",
	guardianSessionDir: "/safe/guardian-sessions",
	parentSessionId: "parent-456",
	reviewCount: 0,
} as GuardianStateV1;

test("sidecar arguments preserve the session while disabling recursive capabilities", () => {
	const args = buildSidecarArgs(config, state);
	assert.deepEqual(args.slice(0, 8), [
		"--mode",
		"json",
		"--print",
		"--session-dir",
		"/safe/guardian-sessions",
		"--session-id",
		"guardian-123",
		"--model",
	]);
	assert.ok(args.includes("openai-codex/gpt-5.6-luna"));
	assert.ok(args.includes("--no-tools"));
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-context-files"));
	assert.ok(args.includes("--name"));
});

test("resumed sidecars are not renamed on every review", () => {
	const args = buildSidecarArgs(config, { ...state, reviewCount: 1 });
	assert.equal(args.includes("--name"), false);
});

test("loads only explicitly configured reviewer extensions", () => {
	const extensions = ["npm:@aliou/pi-neuralwatt@0.18.0", "/opt/provider.ts"];
	const args = buildSidecarArgs({ ...config, reviewerExtensions: extensions }, state);
	const configured = args.flatMap((arg, index) => (arg === "--extension" ? [args[index + 1]] : []));
	assert.deepEqual(configured, extensions);
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-tools"));
});

test("an explicit Pi executable is invoked without a shell", () => {
	assert.deepEqual(getPiInvocation(["--version"], "/custom/pi"), {
		command: "/custom/pi",
		args: ["--version"],
	});
});

test("runs a sidecar over stdin and retries malformed structured output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-sidecar-test-"));
	const executable = join(directory, "fake-pi.mjs");
	const countPath = join(directory, "count");
	const promptPath = join(directory, "prompt");
	await writeFile(
		executable,
		`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.FAKE_GUARDIAN_PROMPT, prompt);
let count = 0;
try { count = Number(readFileSync(process.env.FAKE_GUARDIAN_COUNT, "utf8")); } catch {}
count += 1;
writeFileSync(process.env.FAKE_GUARDIAN_COUNT, String(count));
const text = count === 1
  ? "not json"
  : '{"risk_level":"low","user_authorization":"medium","outcome":"allow","rationale":"The action is bounded and authorized."}';
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}]}}) + "\\n");
`,
		{ mode: 0o700 },
	);
	await chmod(executable, 0o700);
	const previousPrompt = process.env.FAKE_GUARDIAN_PROMPT;
	const previousCount = process.env.FAKE_GUARDIAN_COUNT;
	process.env.FAKE_GUARDIAN_PROMPT = promptPath;
	process.env.FAKE_GUARDIAN_COUNT = countPath;
	try {
		const assessment = await requestGuardianAssessment(
			{ ...config, piCommand: executable, timeoutMs: 2_000, maxAttempts: 2 },
			state,
			"review this exact action",
		);
		assert.equal(assessment.outcome, "allow");
		assert.equal(await readFile(countPath, "utf8"), "2");
		assert.match(await readFile(promptPath, "utf8"), /previous response could not be used/);
	} finally {
		if (previousPrompt === undefined) delete process.env.FAKE_GUARDIAN_PROMPT;
		else process.env.FAKE_GUARDIAN_PROMPT = previousPrompt;
		if (previousCount === undefined) delete process.env.FAKE_GUARDIAN_COUNT;
		else process.env.FAKE_GUARDIAN_COUNT = previousCount;
	}
});


test("Pi invocation follows a global-style CLI symlink using the current Node runtime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-invocation-"));
	const executable = join(directory, "pi");
	const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	await symlink(cli, executable);
	const previousScript = process.argv[1];
	try {
		process.argv[1] = executable;
		assert.deepEqual(getPiInvocation(["--version"]), {
			command: process.execPath, args: [executable, "--version"],
		});
	} finally {
		process.argv[1] = previousScript;
	}
});
