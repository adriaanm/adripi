import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSidecarArgs, getPiInvocation, requestGuardianAssessment } from "../src/sidecar.ts";
import type { GuardianConfig, GuardianStateV1 } from "../src/types.ts";
import { emptyKinds, measureUsage, type GuardianUsageNotice } from "../src/usage.ts";

const config = { reviewerModel: "fixture/model", reviewerExtensions: [], thinkingLevel: "low", policyPath: "/trusted/policy.md",
	piCommand: "/usr/local/bin/pi", timeoutMs: 10000, maxAttempts: 2 } as unknown as GuardianConfig;
const state = { guardianSessionId: "guardian-123", guardianSessionDir: "/safe/sessions", parentSessionId: "parent-456", policyHash: "fixture", reviewCount: 0 } as GuardianStateV1;
const assessment = { risk_level: "low", user_authorization: "medium", outcome: "allow", rationale: "Bounded fixture action." };
async function executable(body: string) {
	const directory = await mkdtemp(join(tmpdir(), "guardian-sidecar-"));
	const path = join(directory, "fake-pi.mjs");
	await writeFile(path, `#!/usr/bin/env node\nlet raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw.slice(raw.indexOf(" ") + 1));
const assessment = ${JSON.stringify(assessment)};
${body}\n`, { mode: 0o700 });
	await chmod(path, 0o700);
	return { path, directory };
}

test("tool-free CLI bootstrap is ephemeral; only the managed runner owns persistent history", () => {
	const args = buildSidecarArgs(config, state);
	assert.deepEqual(args.slice(0, 4), ["--mode", "json", "--print", "--no-session"]);
	for (const flag of ["--no-tools", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates"]) assert.ok(args.includes(flag));
	assert.equal(args.includes("--session-id"), false);
	assert.ok(args.some((item) => item.endsWith("/managed-reviewer.ts")));
});
test("explicit Pi executable is invoked without a shell", () => {
	assert.deepEqual(getPiInvocation(["--version"], "/custom/pi"), { command: "/custom/pi", args: ["--version"] });
});
test("managed response is request-bound and carries the complete envelope over stdin", async () => {
	const fake = await executable(`import {writeFileSync} from "node:fs";
writeFileSync(new URL("./input.json", import.meta.url), JSON.stringify(input));
process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment}) + "\\n");`);
	// No providers or credentials are involved in this transport fixture.
	assert.deepEqual(await requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "exact action", undefined,
		{ directives: [{ id: "user-1", text: "Do not push." }], evidence: [], action: { command: "git status" } }), assessment);
	const input = JSON.parse(await readFile(join(fake.directory, "input.json"), "utf8"));
	const envelope = JSON.parse(input.prompt);
	assert.equal(input.sessionId, state.guardianSessionId);
	assert.deepEqual(envelope.directives, [{ id: "user-1", text: "Do not push." }]);
	assert.deepEqual(envelope.action, { command: "git status" });
});
for (const scenario of ["wrong nonce", "duplicate result", "later provider error"]) {
	test(`fails closed on ${scenario}`, async () => {
		const fake = await executable(`
const event = {type:"guardian_review_result",nonce:${scenario === "wrong nonce" ? '"forged"' : "input.nonce"},assessment};
process.stdout.write(JSON.stringify(event) + "\\n");
${scenario === "duplicate result" ? 'process.stdout.write(JSON.stringify(event) + "\\n");' : ""}
${scenario === "later provider error" ? 'process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"provider failed"}}) + "\\n");' : ""}`);
		await assert.rejects(requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review"), /no verified|duplicate|provider failed/);
	});
}
test("spawn failure has no writer and does not strand the reviewer queue", async () => {
	const fake = await executable('process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment}) + "\\n");');
	await assert.rejects(requestGuardianAssessment({ ...config, piCommand: join(fake.directory, "missing") }, state, "review"), /process error|ENOENT/);
	assert.deepEqual(await requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review"), assessment);
});

test("oversized output is bounded and cannot establish approval", async () => {
	const fake = await executable('process.stdout.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);');
	await assert.rejects(requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review"), /capture limit/);
});

test("non-object JSON output cannot crash the parent or establish approval", async () => {
	const fake = await executable('process.stdout.write("null\\n[]\\n42\\ntrue\\n");');
	await assert.rejects(requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review"), /no verified/);
});

test("provider bootstrap error is not converted into a missing response or accepted earlier text", async () => {
	const fake = await executable(`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"401 Incorrect API key"}}) + "\\n");`);
	await assert.rejects(requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review"), /401 Incorrect API key/);
});
test("timeout keeps reviewer ownership until the process actually closes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "guardian-sidecar-queue-"));
	const log = join(directory, "events");
	const fake = await executable(`import {appendFileSync} from "node:fs";
const event = (kind) => appendFileSync(${JSON.stringify(log)}, kind + "\\n");
event("start:" + JSON.parse(input.prompt).request);
if (JSON.parse(input.prompt).request === "first") {
  process.on("SIGTERM", () => setTimeout(() => { event("closed:first"); process.exit(0); }, 100));
  setInterval(() => {}, 1000);
} else {
  event("closed:second");
  process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment}) + "\\n");
}`);
	const notices: GuardianUsageNotice[] = [];
	const first = requestGuardianAssessment({ ...config, piCommand: fake.path, timeoutMs: 5000 }, state, "first", undefined, undefined, undefined, (notice) => notices.push(notice));
	const refused = assert.rejects(first, /timed out/);
	const second = requestGuardianAssessment({ ...config, piCommand: fake.path, timeoutMs: 15000 }, state, "second");
	await refused;
	assert.deepEqual(notices.map((notice) => notice.kind), ["pending", "gap"], "timeout is not zero-cost certification");
	assert.deepEqual(await second, assessment);
	assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["start:first", "closed:first", "start:second", "closed:second"]);
});
test("Pi invocation follows a CLI symlink using the current Node runtime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "guardian-invocation-"));
	const executable = join(directory, "pi");
	const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	await symlink(cli, executable);
	const previous = process.argv[1];
	try { process.argv[1] = executable; assert.deepEqual(getPiInvocation(["--version"]), { command: process.execPath, args: [executable, "--version"] }); }
	finally { process.argv[1] = previous; }
});

const usageTotals = emptyKinds();
usageTotals.review = measureUsage({ input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.001 } });
const usageEvent = `const usage = {version:1,parentSessionId:input.parentSessionId,reviewerSessionId:input.sessionId,revision:7,totals:${JSON.stringify(usageTotals)}};
const telemetry = {type:"guardian_usage",nonce:input.nonce,usage};`;
for (const phase of ["success", "review failure", "stale evidence"] as const) {
	test(`usage is independently retained on ${phase}, not turned into an authorization result`, async () => {
		const fake = await executable(`${usageEvent}
process.stdout.write(JSON.stringify({type:"entry_appended",entry:{customType:"pi-guardian.managed-usage",data:telemetry}}) + "\\n");
process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,${phase === "review failure" ? 'error:"provider failed"' : "assessment"}}) + "\\n");`);
		const notices: GuardianUsageNotice[] = [];
		let validations = 0;
		const result = requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review", undefined, undefined,
			() => { if (++validations === 2 && phase === "stale evidence") throw new Error("stale evidence"); }, (notice) => notices.push(notice));
		if (phase === "success") assert.deepEqual(await result, assessment);
		else await assert.rejects(result, /provider failed|stale evidence/);
		assert.equal(notices.length, 2);
		assert.equal(notices[0].kind, "pending");
		assert.equal(notices[1].kind, "snapshot");
		if (notices[1].kind === "snapshot") assert.equal(notices[1].snapshot.totals.review.usd, 0.001);
	});
}
for (const scenario of ["wrong nonce", "wrong session", "duplicate", "missing"] as const) {
	test(`usage ${scenario} cannot inflate or certify accounting`, async () => {
		const fake = await executable(`${usageEvent}
${scenario === "wrong nonce" ? 'telemetry.nonce = "forged";' : ""}
${scenario === "wrong session" ? 'usage.reviewerSessionId = "forged";' : ""}
${scenario === "missing" ? "" : 'process.stdout.write(JSON.stringify(telemetry) + "\\n");'}
${scenario === "duplicate" ? 'process.stdout.write(JSON.stringify(telemetry) + "\\n");' : ""}
process.stdout.write(JSON.stringify({type:"guardian_review_result",nonce:input.nonce,assessment}) + "\\n");`);
		const notices: GuardianUsageNotice[] = [];
		const result = requestGuardianAssessment({ ...config, piCommand: fake.path }, state, "review", undefined, undefined, undefined, (notice) => notices.push(notice));
		if (scenario === "duplicate" || scenario === "wrong session") await assert.rejects(result, /duplicate usage|identity mismatch/);
		else assert.deepEqual(await result, assessment);
		if (scenario === "wrong nonce" || scenario === "missing" || scenario === "wrong session") assert.equal(notices.at(-1)?.kind, "gap");
		assert.equal(notices.filter((n) => n.kind === "snapshot").length, scenario === "duplicate" ? 1 : 0);
	});
}
