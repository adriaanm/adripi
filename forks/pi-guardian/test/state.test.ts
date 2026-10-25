import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createGuardianState, findGuardianState, stateMatchesConfig, updateDenialState } from "../src/state.ts";
import { GUARDIAN_STATE_ENTRY, type GuardianConfig } from "../src/types.ts";

const config: GuardianConfig = {
	enabled: true,
	reviewerModel: "openai-codex/gpt-5.6-luna",
	reviewerExtensions: [],
	thinkingLevel: "low",
	timeoutMs: 90_000,
	maxAttempts: 3,
	maxParallelReviews: 4,
	maxConsecutiveDenials: 3,
	maxActionChars: 64_000,
	guardianSessionDir: "/tmp/guardian-sessions",
	policyPath: "/tmp/policy.md",
	exemptTools: new Set(["read"]),
	transcript: {
		maxMessageChars: 1,
		maxToolChars: 1,
		maxMessageEntryChars: 1,
		maxToolEntryChars: 1,
		maxRecentNonUserEntries: 1,
	},
};

test("creates, restores, and validates Guardian state", () => {
	const state = createGuardianState("parent-1", config, "policy-hash", 2);
	assert.equal(state.generation, 3);
	assert.equal(state.parentSessionId, "parent-1");
	assert.ok(state.guardianSessionId);
	assert.equal(stateMatchesConfig(state, "parent-1", config, "policy-hash"), true);
	assert.equal(stateMatchesConfig(state, "parent-2", config, "policy-hash"), false);

	const entry: SessionEntry = {
		type: "custom",
		id: "state-1",
		parentId: null,
		timestamp: state.createdAt,
		customType: GUARDIAN_STATE_ENTRY,
		data: state,
	};
	assert.deepEqual(findGuardianState([entry]), state);
});

test("tracks consecutive denials within one user turn", () => {
	let state = createGuardianState("parent-1", config, "policy-hash");
	state = updateDenialState(state, "turn-1", true);
	state = updateDenialState(state, "turn-1", true);
	assert.equal(state.consecutiveDenials, 2);
	state = updateDenialState(state, "turn-2", true);
	assert.equal(state.consecutiveDenials, 1);
	state = updateDenialState(state, "turn-2", false);
	assert.equal(state.consecutiveDenials, 0);
});
