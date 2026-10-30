import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";
import { DEFAULT_CONTEXT } from "../src/reviewer-context.ts";

test("context defaults apply to existing configs without changing their files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "guardian-context-config-"));
	assert.deepEqual(loadGuardianConfig(dir, "/fixture/policy").reviewerContext, DEFAULT_CONTEXT);
});
for (const context of [null, [], { maxTokens: 0 }, { maxTokens: 2.5 }, { maxTokens: 1e30 }, { maxTokens: 100, targetTokens: 100 }, { unknown: 1 }, { toString: 1 }]) {
	test(`rejects invalid context settings ${JSON.stringify(context)}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "guardian-context-config-"));
		await writeFile(join(dir, "guardian.json"), JSON.stringify({ reviewer: { context } }));
		assert.throws(() => loadGuardianConfig(dir, "/fixture/policy"), /reviewer.context/);
	});
}
