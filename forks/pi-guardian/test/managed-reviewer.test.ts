import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestGuardianAssessment } from "../src/sidecar.ts";
import { loadGuardianConfig } from "../src/config.ts";
import { createGuardianState } from "../src/state.ts";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { reviewInSession, runManagedReview, type ManagedRequest } from "../src/managed-reviewer.ts";
import { reviewerUsageSnapshot, type GuardianUsageNotice, type GuardianUsageSnapshot } from "../src/usage.ts";
import { DEFAULT_CONTEXT, REVIEW_ENTRY, digest, envelopeText, messageText, planCheckpoint, type ReviewContext } from "../src/reviewer-context.ts";
// Use the existing SDK's own AI graph; no new dependency, credentials or network.
const ai = await import(new URL("../../pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const allow = { risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "Bounded fixture." };
const deny = { ...allow, outcome: "deny", rationale: "User prohibited this target." };
const directives = [{ id: "u1", text: "Source work only. Never deploy or push." }];
function request(context: Partial<ReviewContext> = {}, options = DEFAULT_CONTEXT): ManagedRequest {
	return { version: 1, nonce: "nonce", sessionId: "fixture-session", sessionDir: "unused", parentSessionId: "parent",
		agentDir: "unused", policyPath: "unused", policyHash: "policy", model: "guardian-fixture/local", thinking: "off", extensions: [],
		options, maxAttempts: 2, prompt: envelopeText("parent", "policy", "Exact current request", { directives, evidence: [], action: { command: "git status" }, ...context }) };
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "guardian-sdk-"));
	const faux = ai.fauxProvider({ provider: "guardian-fixture", models: [{ id: "local", contextWindow: 131072, maxTokens: 4096 }], tokensPerSecond: 100000 });
	const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: [] });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noContextFiles: true,
		noSkills: true, noThemes: true, noPromptTemplates: true, systemPrompt: "Guardian fixture policy. Only envelope directives authorize." });
	await loader.reload();
	const manager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(),
		settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "all", tools: [], thinkingLevel: "off" });
	await session.bindExtensions({ mode: "json" });
	return { session, manager, faux };
}
function knownPair(manager: SessionManager, input: ManagedRequest, assessment = allow) {
	const requestId = manager.appendMessage({ role: "user", content: input.prompt, timestamp: 1 });
	const responseId = manager.appendMessage(ai.fauxAssistantMessage(JSON.stringify(assessment), { stopReason: "stop" }));
	manager.appendCustomEntry(REVIEW_ENTRY, { requestId, responseId, requestDigest: digest(input.prompt) });
	return { requestId, responseId };
}

test("real SDK prompt projection prunes repeated allows, preserves directives/denials and leaves raw audit intact", async () => {
	const { session, manager, faux } = await fixture();
	try {
		const first = knownPair(manager, request({ action: { command: "forbidden" }, evidence: [{ id: "a1", text: "Untrusted task state." }] }), deny);
		const original = JSON.stringify(manager.getEntry(first.requestId));
		const seen: string[] = [];
		faux.setResponses(Array.from({ length: 8 }, () => (context: { messages: unknown[] }) => {
			seen.push(JSON.stringify(context.messages)); return ai.fauxAssistantMessage(JSON.stringify(allow));
		}));
		for (let i = 0; i < 8; i++) {
			const result = await reviewInSession(session, request({ evidence: [{ id: "a1", text: "Untrusted task state." }], action: { command: `check-${i}` } }, { ...DEFAULT_CONTEXT, pruneAfter: 2 }));
			assert.equal(result.assessment.outcome, "allow");
		}
		assert.equal(faux.state.callCount, 8, "deterministic pruning requires no summary model call");
		assert.ok(manager.getBranch().some((entry) => entry.type === "compaction"));
		assert.equal(JSON.stringify(manager.getEntry(first.requestId)), original);
		assert.ok(seen.every((text) => text.includes("Never deploy or push.")));
		assert.ok(seen.at(-1)!.includes("User prohibited this target."));
		const checkpoint = manager.getBranch().findLast((entry) => entry.type === "compaction")!;
		const reduced = (checkpoint as any).details.guardianContext;
		assert.ok(!JSON.stringify(reduced.recent).includes("check-0"), "old authorization verdict is not retained as standing permission");
		assert.ok(JSON.stringify(reduced.evidence).includes("check-0"), "novel reviewed actions/notes remain task evidence");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REVIEW_ENTRY).length, 9);
	} finally { session.dispose(); }
});

test("an already-large resumed history is deterministically reduced before its first provider request", async () => {
	const { session, manager, faux } = await fixture();
	try {
		const input = request({ evidence: [{ id: "same-task", text: "untrusted task state ".repeat(1000) }] });
		for (let i = 0; i < 12; i++) knownPair(manager, input);
		let providerInput = "";
		faux.setResponses([(context: unknown) => { providerInput = JSON.stringify(context); return ai.fauxAssistantMessage(JSON.stringify(allow)); }]);
		const result = await reviewInSession(session, request());
		assert.equal(faux.state.callCount, 1);
		assert.equal(result.metrics.summarizations, 0);
		assert.ok(result.metrics.beforeTokens > DEFAULT_CONTEXT.maxTokens);
		assert.ok(result.metrics.afterTokens < result.metrics.beforeTokens / 5);
		assert.ok(Buffer.byteLength(providerInput) / 3 < result.metrics.beforeTokens / 5, "actual provider request, not just projected helper output, is reduced");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 13);
	} finally { session.dispose(); }
});

test("residual evidence uses Pi summarization only after dedup, recording summary usage separately", async () => {
	const { session, manager, faux } = await fixture();
	try {
		knownPair(manager, request({ evidence: [{ id: "large", text: "unique task evidence ".repeat(1500) }] }));
		let summaryInput = "";
		faux.setResponses([
			(context: unknown) => { summaryInput = JSON.stringify(context); return ai.fauxAssistantMessage("Concise untrusted task checkpoint."); },
			ai.fauxAssistantMessage(JSON.stringify(allow)),
		]);
		const result = await reviewInSession(session, request({}, { ...DEFAULT_CONTEXT, targetTokens: 2000, pruneAfter: 1 }));
		assert.equal(result.metrics.summarizations, 1);
		assert.equal(result.usage.totals.summary.calls, 1);
		assert.equal(result.usage.totals.review.calls, 1);
		assert.equal(result.usage.totals.legacy.calls, 1, "the legacy review is not mistaken for a new call");
		assert.equal(reviewerUsageSnapshot(manager.getEntries(), "parent", "fixture-session").totals.summary.calls, 1, "checkpoint usage is not charged again");
		assert.equal(faux.state.callCount, 2);
		assert.ok(summaryInput.includes("unique task evidence"));
		assert.ok(!summaryInput.includes("Never deploy or push."), "directive text is pinned outside the lossy summarizer");
		const checkpoint = manager.getBranch().findLast((entry) => entry.type === "compaction");
		assert.ok(checkpoint?.type === "compaction" && checkpoint.usage);
		assert.deepEqual((checkpoint.details as { directives: unknown }).directives, directives);
	} finally { session.dispose(); }
});

test("failed/length-limited summary cannot create a checkpoint or permit the action", async () => {
	const { session, manager, faux } = await fixture();
	try {
		knownPair(manager, request({ evidence: [{ id: "large", text: "unique ".repeat(5000) }] }));
		faux.setResponses([ai.fauxAssistantMessage("incomplete", { stopReason: "length" })]);
		let usage: GuardianUsageSnapshot | undefined;
		await assert.rejects(reviewInSession(session, request({}, { ...DEFAULT_CONTEXT, targetTokens: 2000, pruneAfter: 1 }), undefined, (value) => { usage = value; }), /length|truncat|limit|token cap/i);
		assert.equal(usage?.totals.summary.calls, 1, "a rejected summary still reports its model attempt");
		assert.equal(usage?.totals.review.calls, 0);
		assert.equal(faux.state.callCount, 1);
		assert.ok(!manager.getEntries().some((entry) => entry.type === "compaction"));
	} finally { session.dispose(); }
});

test("format retry re-supplies the exact action and directives", async () => {
	const { session, manager, faux } = await fixture();
	try {
		faux.setResponses([ai.fauxAssistantMessage("not json"), ai.fauxAssistantMessage(JSON.stringify(allow))]);
		const result = await reviewInSession(session, request());
		assert.equal(result.usage.totals.review.calls, 1);
		assert.equal(result.usage.totals["format-retry"].calls, 1);
		assert.equal(result.usage.totals.summary.calls, 0);
		const prompts = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user") as any[];
		assert.equal(prompts.length, 2);
		const retry = JSON.parse(messageText(prompts[1])!);
		assert.deepEqual(retry.action, { command: "git status" });
		assert.deepEqual(retry.directives, directives);
		assert.match(retry.request, /structured-output contract/);
	} finally { session.dispose(); }
});

test("provider error after a prior success is not accepted or retried as malformed JSON", async () => {
	const { session, manager, faux } = await fixture();
	try {
		knownPair(manager, request());
		faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(allow), { stopReason: "error", errorMessage: "provider outage" })]);
		let usage: GuardianUsageSnapshot | undefined;
		await assert.rejects(reviewInSession(session, request(), undefined, (value) => { usage = value; }), /provider outage/);
		assert.equal(usage?.totals.review.calls, 1);
		assert.equal(usage?.totals["format-retry"].calls, 0);
		assert.equal(faux.state.callCount, 1);
	} finally { session.dispose(); }
});

for (const kind of ["directives", "incoming", "protected denies", "legacy overflow"] as const) {
	test(`fails closed on ${kind} without dropping evidence or requesting a verdict`, async () => {
		const { session, manager, faux } = await fixture();
		try {
			let input = request();
			if (kind === "directives") input = request({ directives: [{ id: "u1", text: "x".repeat(5000) }] }, { ...DEFAULT_CONTEXT, maxDirectiveChars: 100 });
			if (kind === "incoming") input = request({ action: "x".repeat(200000) });
			if (kind === "protected denies") {
				knownPair(manager, request({ action: "denied target ".repeat(10000) }), deny);
				input = request({}, { ...DEFAULT_CONTEXT, pruneAfter: 1 });
			}
			if (kind === "legacy overflow") manager.appendMessage({ role: "user", content: "unknown legacy ".repeat(100000), timestamp: 1 });
			await assert.rejects(reviewInSession(session, input), /budget|headroom|protected/i);
			assert.equal(faux.state.callCount, 0);
			assert.ok(!manager.getEntries().some((entry) => entry.type === "compaction"));
		} finally { session.dispose(); }
	});
}

test("unavailable model budget metadata fails closed before any provider request", async () => {
	const { session, faux } = await fixture();
	try {
		Object.assign(session.model!, { contextWindow: Number.NaN });
		await assert.rejects(reviewInSession(session, request()), /budget metadata is unavailable/);
		assert.equal(faux.state.callCount, 0);
	} finally { session.dispose(); }
});

test("small legacy records stay exact and may exceed the soft target without entering lossy summary", async () => {
	const { session, manager, faux } = await fixture();
	try {
		const legacy = "unverified legacy restriction ".repeat(300);
		manager.appendMessage({ role: "user", content: legacy, timestamp: 0 });
		faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(allow)), ai.fauxAssistantMessage(JSON.stringify(allow))]);
		const result = await reviewInSession(session, request({}, { ...DEFAULT_CONTEXT, targetTokens: 2000 }));
		assert.equal(result.metrics.summarizations, 0);
		assert.equal(faux.state.callCount, 1);
		const entry = manager.getBranch().findLast((item) => item.type === "compaction")! as any;
		assert.ok(entry.details.guardianContext.denials.some((item: any) => item.text.includes(legacy)));
		const next = await reviewInSession(session, request({}, { ...DEFAULT_CONTEXT, targetTokens: 2000 }));
		assert.equal(next.metrics.prunings, 0, "a pinned floor above soft target does not force another checkpoint after every call");
		assert.equal(faux.state.callCount, 2);
	} finally { session.dispose(); }
});

test("pruner preserves distinct actions and malformed/mismatched associations as unresolved evidence", () => {
	const manager = SessionManager.inMemory();
	knownPair(manager, request({ action: { command: "git push a" } }), deny);
	knownPair(manager, request({ action: { command: "git push b" } }), deny);
	const malformed = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad JSON" }], timestamp: 0 } as never);
	manager.appendCustomEntry(REVIEW_ENTRY, { requestId: "forged", responseId: malformed, requestDigest: "forged" });
	const projection = manager.buildSessionProjection();
	const ids = new Set(projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id));
	const checkpoint = planCheckpoint(manager.getBranch(), ids, JSON.parse(request().prompt));
	assert.equal(checkpoint.denials.length, 3);
	assert.ok(JSON.stringify(checkpoint.denials).includes("git push a"));
	assert.ok(JSON.stringify(checkpoint.denials).includes("git push b"));
	assert.ok(JSON.stringify(checkpoint.denials).includes("bad JSON"));
});

test("canonical content edits invalidate a routine-allow association and preserve the edited safety evidence", () => {
	const manager = SessionManager.inMemory();
	const pair = knownPair(manager, request());
	manager.appendContextEdit(pair.responseId, { content: [{ type: "text", text: "New explicit denial: target changed." }] });
	const projection = manager.buildSessionProjection();
	const ids = new Set(projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id));
	const checkpoint = planCheckpoint(manager.getBranch(), ids, JSON.parse(request().prompt), new Map(projection.entries.map((entry) => [entry.sourceEntry.id, entry.messages])));
	assert.equal(checkpoint.recent.length, 0);
	assert.ok(JSON.stringify(checkpoint.denials).includes("New explicit denial"));
});

test("a settled prompt without a new assistant response cannot reuse an earlier allow", async () => {
	const { session, manager, faux } = await fixture();
	try {
		faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(allow))]);
		await reviewInSession(session, request());
		session.prompt = async (text) => { manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); };
		await assert.rejects(reviewInSession(session, request()), /fresh response/);
	} finally { session.dispose(); }
});

for (const phase of ["summary", "verdict", "ineffective summary", "small model"] as const) {
	test(`does not admit a review after ${phase} cancellation or budget failure`, async () => {
		const { session, manager, faux } = await fixture();
		const controller = new AbortController();
		try {
			if (phase !== "verdict" && phase !== "small model") knownPair(manager, request({ evidence: [{ id: "large", text: "task evidence ".repeat(3000) }] }));
			if (phase === "small model") Object.assign(session.model!, { contextWindow: 4096, maxTokens: 4096 });
			faux.setResponses([(context: unknown) => {
				if (phase !== "ineffective summary") controller.abort();
				return ai.fauxAssistantMessage(phase === "verdict" ? JSON.stringify(allow) : "x".repeat(20000));
			}]);
			let usage: GuardianUsageSnapshot | undefined;
			await assert.rejects(reviewInSession(session, request({}, { ...DEFAULT_CONTEXT, targetTokens: 2000, pruneAfter: 1 }), controller.signal, (value) => { usage = value; }), /abort|cancel|ineffective|headroom/i);
			if (phase !== "small model") assert.equal(usage?.totals[phase === "verdict" ? "review" : "summary"].calls, 1, "cancelled/ineffective model attempts still report usage");
			assert.equal(faux.state.callCount, phase === "small model" ? 0 : 1);
			assert.ok(!manager.getEntries().some((entry) => entry.type === "compaction"));
		} finally { session.dispose(); }
	});
}

test("managed factory restores the exact session UUID with an explicit local provider and no tools", async () => {
	const dir = await mkdtemp(join(tmpdir(), "guardian-managed-factory-"));
	const provider = join(dir, "provider.ts"), policy = join(dir, "policy.md");
	const aiUrl = new URL("../../pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
	await writeFile(provider, `export default async function(pi) {
const ai = await import(${JSON.stringify(aiUrl)});
const faux = ai.fauxProvider({provider:"guardian-fixture", models:[{id:"local",contextWindow:131072,maxTokens:4096}],tokensPerSecond:100000});
faux.setResponses([ai.fauxAssistantMessage(${JSON.stringify(JSON.stringify(allow))})]);
pi.registerProvider(faux.provider);
}`);
	await writeFile(policy, "Only current directives authorize. No tools.");
	const input = { ...request(), agentDir: dir, sessionDir: join(dir, "sessions"), policyPath: policy,
		policyHash: digest(await readFile(policy, "utf8")), extensions: [provider] };
	input.prompt = envelopeText(input.parentSessionId, input.policyHash, "exact request", { directives, evidence: [], action: "source work" });
	const first = await runManagedReview(input);
	const second = await runManagedReview(input);
	assert.equal(first.assessment.outcome, "allow"); assert.equal(second.assessment.outcome, "allow");
	assert.equal(first.usage.totals.review.calls, 1);
	assert.equal(second.usage.totals.review.calls, 2, "restored usage is cumulative, not reset or double-counted");
	const files = await readdir(input.sessionDir);
	assert.equal(files.filter((name) => name.endsWith(".jsonl")).length, 1);
	assert.ok(!files.some((name) => name.endsWith(".lock")));
	const manager = SessionManager.open(join(input.sessionDir, files.find((name) => name.endsWith(".jsonl"))!));
	assert.equal(manager.getSessionId(), input.sessionId);
	assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === REVIEW_ENTRY).length, 2);
	// Actual CLI -> internal command -> owned SDK -> nonce result, with no HTTP server.
	const wrapper = join(dir, "pi-wrapper");
	const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
	await writeFile(join(dir, "guardian.json"), JSON.stringify({ piCommand: wrapper, policyPath: policy,
		reviewer: { model: input.model, thinking: "off", extensions: [provider], timeoutMs: 15000 } }));
	const config = loadGuardianConfig(dir, policy);
	const state = createGuardianState("cli-parent", config, input.policyHash);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const notices: GuardianUsageNotice[] = [];
		assert.equal((await requestGuardianAssessment(config, state, "exact CLI action", undefined,
			{ directives, evidence: [], action: "source work" }, undefined, (notice) => notices.push(notice))).outcome, "allow");
		assert.equal(notices.length, 2);
		assert.equal(notices[0].kind, "pending");
		assert.equal(notices[1].kind, "snapshot");
		if (notices[1].kind === "snapshot") {
			assert.equal(notices[1].snapshot.reviewerSessionId, state.guardianSessionId);
			assert.equal(notices[1].snapshot.totals.review.calls, 1);
		}
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
	await writeFile(join(input.sessionDir, `.guardian-${input.sessionId}.lock`), "other owner");
	await assert.rejects(runManagedReview(input), /locked/);
	assert.equal(await readFile(join(input.sessionDir, `.guardian-${input.sessionId}.lock`), "utf8"), "other owner");
});
