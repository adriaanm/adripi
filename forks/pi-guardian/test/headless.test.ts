import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GUARDIAN_ASSESSMENT_ENTRY, GUARDIAN_STATUS_ENTRY } from "../src/types.ts";

test("real Pi 1.0 CLI emits status and nested assessments in JSON no-session mode", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-headless-"));
	let requests = 0;
	let reviews = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
		const reviewer = payload.messages.some((message) =>
			(message.role === "system" || message.role === "developer") && JSON.stringify(message.content).includes("You are Guardian"));
		if (reviewer) reviews++;
		const first = !reviewer && requests++ === 0;
		const delta = reviewer ? { role: "assistant", content: JSON.stringify({
			risk_level: "low", user_authorization: "medium", outcome: "allow", rationale: "Authorized smoke action.",
		}) } : first ? {
			role: "assistant",
			tool_calls: [{ index: 0, id: "smoke-root", type: "function", function: {
				name: "codemode", arguments: JSON.stringify({ code: 'text(await tools.bash({command: "echo guardian-smoke"}));' }),
			} }],
		} : { role: "assistant", content: "Smoke complete." };
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await writeFile(join(directory, "guardian.json"), JSON.stringify({
		guardianSessionDir: join(directory, "sidecars"),
		reviewer: { model: "guardian-smoke/test", timeoutMs: 10_000, maxAttempts: 1 },
	}));
	await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
		"guardian-smoke": {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-local-key", api: "openai-completions",
			models: [{ id: "test", name: "Local smoke", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
		},
	} }));
	try {
		const run = () => {
			requests = 0;
			return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
				const child = spawn(resolve("node_modules/.bin/pi"), [
					"--mode", "json", "--print", "--no-session", "--no-approve", "--no-context-files",
					"--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,bash,codemode",
					"-e", resolve("src/index.ts"), "--model", "guardian-smoke/test",
				], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				const timeout = setTimeout(() => { child.kill(); reject(new Error(`Smoke timed out: ${stderr}`)); }, 20_000);
				child.stdout.on("data", (chunk) => stdout += chunk);
				child.stderr.on("data", (chunk) => stderr += chunk);
				child.on("error", reject);
				child.on("close", (code) => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
				child.stdin.end("Run the authorized bounded smoke command.");
			});
		};
		const result = await run();
		assert.equal(result.code, 0, result.stderr);
		assert.equal(reviews, 2, result.stdout + result.stderr);
		const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const entries = events.filter((event) => event.type === "entry_appended").map((event) => event.entry);
		const status = entries.find((entry) => entry.customType === GUARDIAN_STATUS_ENTRY);
		assert.ok(status, result.stdout + result.stderr);
		assert.equal(status.data.enabled, true);
		assert.equal(status.data.configError, null);
		assert.match(status.data.policySha256, /^[a-f0-9]{64}$/);
		const assessments = entries.filter((entry) => entry.customType === GUARDIAN_ASSESSMENT_ENTRY);
		assert.deepEqual(assessments.map((entry) => entry.data.toolName), ["codemode", "bash"]);
		assert.equal(assessments[1].data.parentToolCallId, "smoke-root");
		assert.ok(assessments.every((entry) => entry.data.assessment.outcome === "allow"));
		assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash" && !event.isError));
		await writeFile(join(directory, "stdout.jsonl"), result.stdout);
		console.log(`Headless smoke JSONL: ${join(directory, "stdout.jsonl")}`);
		for (const entry of [status, ...assessments]) console.log(JSON.stringify({ type: "entry_appended", entry }));
		// Misconfigured and disabled runs must still advertise that Guardian loaded.
		for (const [contents, enabled, error] of [["{", true, true], ['{"enabled":false}', false, false]] as const) {
			await writeFile(join(directory, "guardian.json"), contents);
			const next = await run();
			assert.equal(next.code, 0, next.stderr);
			const record = next.stdout.trim().split("\n").map((line) => JSON.parse(line))
				.find((event) => event.type === "entry_appended" && event.entry.customType === GUARDIAN_STATUS_ENTRY);
			assert.ok(record, next.stdout + next.stderr);
			assert.equal(record.entry.data.enabled, enabled);
			assert.equal(typeof record.entry.data.configError === "string", error);
			const execution = next.stdout.trim().split("\n").map((line) => JSON.parse(line))
				.find((event) => event.type === "tool_execution_end" && event.toolName === "codemode");
			assert.equal(execution?.isError, error, next.stdout + next.stderr);
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
