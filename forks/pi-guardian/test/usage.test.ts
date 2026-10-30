import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { GUARDIAN_USAGE_ENTRY, REVIEWER_USAGE_ENTRY, emptyKinds, formatGuardianCosts, guardianUsageView, measureUsage, parseUsageSnapshot, reviewerUsageSnapshot } from "../src/usage.ts";

const tokens = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: { total: 0.02 } };
const priced = { cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } };
function custom(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-01-01", customType, data };
}
const call = (id: string, kind: string, sourceId?: string) => custom(`record-${id}`, REVIEWER_USAGE_ENTRY, { version: 1, id, kind, sourceId, totals: measureUsage(tokens) });
function snapshot(id: string, usd: number, revision = 1) {
	const totals = emptyKinds(); totals.review = { ...measureUsage(tokens), usd };
	return { version: 1, parentSessionId: "parent", reviewerSessionId: id, revision, totals };
}

test("usage distinguishes reported/estimated, zero-only unpriced, and unreported costs", () => {
	assert.equal(measureUsage(tokens).usd, 0.02);
	const zero = { ...tokens, cost: { total: 0 } };
	assert.ok(Math.abs(measureUsage(zero, priced).usd - 0.000391) < 1e-12);
	assert.equal(measureUsage(zero).unpriced, 1);
	assert.equal(measureUsage(zero, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }).unpriced, 1);
	assert.equal(measureUsage(undefined).unreported, 1);
	const pricedWithoutTokens = measureUsage({ cost: { total: 0.02 } });
	assert.equal(pricedWithoutTokens.unreported, 1);
	assert.equal(pricedWithoutTokens.unpriced, 0);
	assert.equal(pricedWithoutTokens.usd, 0.02, "missing tokens do not erase a known monetary charge");
	const amounts = emptyKinds(); amounts.review = pricedWithoutTokens;
	assert.match(formatGuardianCosts({ totals: amounts, gaps: 0 }), /\$0\.0200 estimate.*unreported usage/);
	amounts.review = measureUsage({ ...tokens, cost: { total: 0.000001 } });
	assert.match(formatGuardianCosts({ totals: amounts, gaps: 0 }), /<\$0\.0001 estimate/, "tiny positive costs must not round to free");
	assert.equal(measureUsage({ ...tokens, input: NaN }).unreported, 1);
	assert.equal(measureUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, priced).unreported, 1);
	assert.equal(measureUsage(tokens).usd, 0.02, "failed responses retain reported partial spending");
});

test("individual review, retry, failed summary and successful checkpoint usage count once", () => {
	const assistant = { type: "message", id: "response", parentId: null, timestamp: "now", message: { role: "assistant", usage: tokens } } as SessionEntry;
	const checkpoint = { type: "compaction", id: "checkpoint", parentId: null, timestamp: "now", summary: "checkpoint", firstKeptEntryId: null, tokensBefore: 10, usage: tokens, details: { guardianUsageId: "summary" } } as unknown as SessionEntry;
	const entries = [assistant, call("review", "review", "response"), call("retry", "format-retry"), call("failed-summary", "summary"), call("summary", "summary"), checkpoint];
	const result = reviewerUsageSnapshot(entries, "parent", "reviewer");
	assert.equal(result.totals.review.calls, 1);
	assert.equal(result.totals["format-retry"].calls, 1);
	assert.equal(result.totals.summary.calls, 2);
	assert.equal(result.totals.summary.usd, 0.04);
	assert.equal(result.totals.legacy.calls, 0);
	assert.deepEqual(reviewerUsageSnapshot([...entries, entries[1]], "parent", "reviewer").totals, result.totals, "repeated record does not charge again");
	const legacy = reviewerUsageSnapshot([assistant, { ...checkpoint, details: {} } as SessionEntry], "parent", "reviewer");
	assert.equal(legacy.totals.legacy.calls, 2);
	assert.equal(legacy.totals.legacy.usd, 0.04);
});

test("parent restores highest cumulative revision across branches and generations, not deltas", () => {
	const entries = [
		custom("a", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("one", 0.1) }),
		custom("b", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("one", 0.4, 9) }),
		custom("c", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("one", 0.1) }),
		custom("d", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("two", 0.2) }),
		custom("e", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("one", 0.4, 9) }),
		custom("foreign", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: { ...snapshot("three", 9), parentSessionId: "other" } }),
		custom("gap", GUARDIAN_USAGE_ENTRY, { kind: "gap", parentSessionId: "parent", requestId: "request" }),
		custom("gap-copy", GUARDIAN_USAGE_ENTRY, { kind: "gap", parentSessionId: "parent", requestId: "request" }),
	];
	const restored = guardianUsageView(JSON.parse(JSON.stringify(entries)), "parent");
	assert.ok(Math.abs(restored.totals.review.usd - 0.6) < 1e-12);
	assert.equal(restored.totals.review.calls, 2);
	assert.equal(restored.gaps, 1);
	assert.match(formatGuardianCosts(restored, true), /Guardian only:.*\$0\.6000 estimate/);
	assert.match(formatGuardianCosts(restored, true), /format-retry:/);
	assert.match(formatGuardianCosts(restored, true), /incomplete review transports/);
});

test("custom accounting never contributes a parent assistant message, native usage or model context", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: snapshot("one", 2) });
	assert.equal(manager.getEntries().some((entry) => entry.type === "message" || entry.type === "usage" || entry.type === "compaction"), false);
	assert.equal(manager.buildSessionProjection().messages.length, 0);
	assert.equal(guardianUsageView(manager.getEntries(), "parent").totals.review.usd, 2);
});

test("source accounting includes a real SDK sibling branch without rebilling its assistant/checkpoint", () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	manager.appendCustomEntry(REVIEWER_USAGE_ENTRY, { version: 1, id: "first", kind: "review", totals: measureUsage(tokens) });
	manager.branch(root);
	manager.appendCustomEntry(REVIEWER_USAGE_ENTRY, { version: 1, id: "second", kind: "review", totals: measureUsage(tokens) });
	assert.equal(reviewerUsageSnapshot(manager.getBranch(), "parent", "reviewer").totals.review.calls, 1);
	assert.equal(reviewerUsageSnapshot(manager.getEntries(), "parent", "reviewer").totals.review.calls, 2);
});

test("pending accounting survives a lost parent context and only the correlated final report resolves it", () => {
	const pending = custom("pending", GUARDIAN_USAGE_ENTRY, { kind: "pending", parentSessionId: "parent", requestId: "request" });
	assert.equal(guardianUsageView([pending], "parent").pending, 1);
	const done = custom("done", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", requestId: "request", snapshot: snapshot("one", 0.1) });
	assert.equal(guardianUsageView([pending, done, pending], "parent").pending, 0);
	const malformed = custom("bad", GUARDIAN_USAGE_ENTRY, { kind: "snapshot", snapshot: {} });
	assert.equal(guardianUsageView([malformed], "parent").gaps, 1);
	assert.match(formatGuardianCosts(guardianUsageView([pending], "parent")), /pending\/unreconciled/);
	const oldState = custom("old-state", "pi-guardian.state", { parentSessionId: "parent", guardianSessionId: "old-reviewer", reviewCount: 9 });
	assert.equal(guardianUsageView([oldState], "parent").uncovered, 1, "pre-feature generations are not reported as zero cost");
	assert.equal(guardianUsageView([oldState], "foreign-parent").uncovered, 0);
	assert.match(formatGuardianCosts(guardianUsageView([oldState], "parent")), /lack historical telemetry/);
});

test("telemetry rejects malformed counters/NaN and never presents missing pricing as free", () => {
	assert.throws(() => parseUsageSnapshot({ ...snapshot("one", 1), revision: -1 }), /invalid usage/);
	const bad = snapshot("one", NaN);
	assert.throws(() => parseUsageSnapshot(bad), /invalid usage/);
	bad.totals.review.usd = 1; bad.totals.review.unpriced = 2;
	assert.throws(() => parseUsageSnapshot(bad), /invalid usage/);
	const totals = emptyKinds(); totals.summary = measureUsage({ ...tokens, cost: { total: 0 } });
	assert.match(formatGuardianCosts({ totals, gaps: 0 }), /cost unavailable/);
	assert.doesNotMatch(formatGuardianCosts({ totals, gaps: 0 }), /\$0\.0000/);
});
