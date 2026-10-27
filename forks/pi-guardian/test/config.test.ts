import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig, persistGuardianEnabled } from "../src/config.ts";

test("loads safe defaults from an empty user agent directory", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-config-test-"));
	const config = loadGuardianConfig(agentDir, "/bundle/policy.md");
	assert.equal(config.enabled, true);
	assert.equal(config.reviewerModel, "openai-codex/gpt-5.6-luna");
	assert.equal(config.maxParallelReviews, 4);
	assert.equal(config.guardianSessionDir, join(agentDir, "guardian-sessions"));
	assert.deepEqual([...config.exemptTools], ["read", "grep", "find", "ls", "tool_search"]);
});

test("rejects unsafe or malformed bounds instead of silently accepting them", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-config-test-"));
	await writeFile(join(agentDir, "guardian.json"), '{"reviewer":{"timeoutMs":0}}');
	assert.throws(() => loadGuardianConfig(agentDir, "/bundle/policy.md"), /reviewer\.timeoutMs must be a positive integer/);
});

test("rejects a non-positive parallel review limit", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-config-test-"));
	await writeFile(join(agentDir, "guardian.json"), '{"maxParallelReviews":0}');
	assert.throws(() => loadGuardianConfig(agentDir, "/bundle/policy.md"), /maxParallelReviews must be a positive integer/);
});

test("persists the enabled flag without discarding other configuration", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-config-test-"));
	const configPath = join(agentDir, "guardian.json");
	await writeFile(configPath, '{"reviewer":{"model":"safe/model"},"maxParallelReviews":2}\n');
	persistGuardianEnabled(agentDir, false);
	const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	assert.equal(saved.enabled, false);
	assert.deepEqual(saved.reviewer, { model: "safe/model" });
	assert.equal(saved.maxParallelReviews, 2);
});


test("rejects a non-boolean enabled switch", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-config-test-"));
	await writeFile(join(agentDir, "guardian.json"), '{"enabled":"false"}');
	assert.throws(() => loadGuardianConfig(agentDir, "/bundle/policy.md"), /enabled must be a boolean/);
});
