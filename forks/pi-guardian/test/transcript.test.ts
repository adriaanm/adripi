import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { latestUserTurnKey, renderGuardianTranscript } from "../src/transcript.ts";
import { GUARDIAN_STATE_ENTRY, type TranscriptBounds } from "../src/types.ts";

const bounds: TranscriptBounds = {
	maxMessageChars: 20_000,
	maxToolChars: 20_000,
	maxMessageEntryChars: 5_000,
	maxToolEntryChars: 5_000,
	maxRecentNonUserEntries: 40,
};

function message(id: string, parentId: string | null, role: string, content: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: 0 } as never,
	};
}

test("renders a full transcript with trust labels", () => {
	const branch: SessionEntry[] = [
		message("u1", null, "user", "Delete only build/output.txt"),
		message("a1", "u1", "assistant", [
			{ type: "text", text: "I will remove it." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rm build/output.txt" } },
		]),
	];
	const transcript = renderGuardianTranscript(branch, undefined, bounds);
	assert.equal(transcript.mode, "full");
	assert.equal(transcript.cursorEntryId, "a1");
	assert.match(transcript.text, /trusted user: Delete only build\/output\.txt/);
	assert.match(transcript.text, /untrusted assistant/);
	assert.match(transcript.text, /rm build\/output\.txt/);
	assert.equal(latestUserTurnKey(branch), "u1");
});

test("renders only entries after the saved cursor and filters Guardian metadata", () => {
	const branch: SessionEntry[] = [
		message("u1", null, "user", "Inspect the repository"),
		message("a1", "u1", "assistant", "First response"),
		{
			type: "custom",
			id: "g1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01.000Z",
			customType: GUARDIAN_STATE_ENTRY,
			data: { secret: "must not be rendered" },
		},
		message("u2", "g1", "user", "Now publish it"),
		message("a2", "u2", "assistant", "I will push it"),
	];
	const transcript = renderGuardianTranscript(branch, "a1", bounds);
	assert.equal(transcript.mode, "delta");
	assert.equal(transcript.cursorEntryId, "a2");
	assert.doesNotMatch(transcript.text, /Inspect the repository/);
	assert.doesNotMatch(transcript.text, /must not be rendered/);
	assert.match(transcript.text, /trusted user: Now publish it/);
	assert.match(transcript.text, /I will push it/);
	assert.equal(latestUserTurnKey(branch), "u2");
});

test("falls back to a full transcript when the cursor is not on the active branch", () => {
	const branch = [message("u1", null, "user", "Current branch")];
	const transcript = renderGuardianTranscript(branch, "abandoned-entry", bounds);
	assert.equal(transcript.mode, "full");
	assert.match(transcript.text, /Current branch/);
});
