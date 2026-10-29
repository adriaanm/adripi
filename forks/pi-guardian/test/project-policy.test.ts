import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	isProjectPolicyTrusted,
	projectPolicyPath,
	readProjectPolicy,
	readProjectTrust,
	recordProjectTrust,
} from "../src/project-policy.ts";

async function project(files: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "guardian-project-"));
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(projectPolicyPath(root), JSON.stringify(files));
	return root;
}

test("reads standing sandbox exceptions from the project policy", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"], deny: [], defer: [] } });
	const read = readProjectPolicy(root);
	assert.equal(read.kind, "ok");
	if (read.kind !== "ok") return;
	assert.deepEqual(read.policy.sandboxExceptions.allow, ["command:git push:*"]);
	assert.equal(read.policy.hash.length > 0, true);
});

test("rejects anything but sandboxExceptions", async () => {
	for (const [files, message] of [
		[{ permissions: { allow: ["Bash"] } }, /unsupported keys: permissions/],
		[{ sandboxExceptions: { allow: ["command:git push:*"], mode: "allow" } }, /unsupported sandboxExceptions keys: mode/],
		[{ sandboxExceptions: { allow: "command:git push:*" } }, /must be an array/],
		[{ sandboxExceptions: { allow: ["git push"] } }, /expected "<command\|network\|read\|write>:<pattern>"/],
	] as Array<[Record<string, unknown>, RegExp]>) {
		const root = await project(files);
		const read = readProjectPolicy(root);
		assert.equal(read.kind, "invalid");
		if (read.kind === "invalid") assert.match(read.error, message);
	}
});

test("no policy file means no project rules", async () => {
	const root = await mkdtemp(join(tmpdir(), "guardian-nopolicy-"));
	assert.equal(readProjectPolicy(root).kind, "none");
});

test("trust is pinned to the exact content hash", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await mkdtemp(join(tmpdir(), "guardian-agenty-"));
	const read = readProjectPolicy(root);
	assert.equal(read.kind, "ok");
	if (read.kind !== "ok") return;

	assert.equal(isProjectPolicyTrusted(agentDir, read.policy.path, read.policy.hash), false);
	recordProjectTrust(agentDir, read.policy.path, read.policy.hash);
	assert.equal(isProjectPolicyTrusted(agentDir, read.policy.path, read.policy.hash), true);
	assert.deepEqual(readProjectTrust(agentDir), { [read.policy.path]: read.policy.hash });

	// Editing the file invalidates the approval.
	await writeFile(projectPolicyPath(root), JSON.stringify({ sandboxExceptions: { allow: ["command:git push:*", "command:gh:*"] } }));
	const edited = readProjectPolicy(root);
	assert.equal(edited.kind, "ok");
	if (edited.kind !== "ok") return;
	assert.equal(isProjectPolicyTrusted(agentDir, edited.policy.path, edited.policy.hash), false);
	// The trust file is a plain JSON map in the agent dir.
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "guardian-project-trust.json"), "utf8")), {
		[read.policy.path]: read.policy.hash,
	});
});

test("persisting an approved rule creates, appends and dedupes", async () => {
	const { persistProjectRule } = await import("../src/project-policy.ts");
	const root = await mkdtemp(join(tmpdir(), "guardian-persist-"));

	// Creates the file when the project has no policy yet.
	const created = persistProjectRule(root, "command:git push:*");
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.equal(created.added, true);
	let read = readProjectPolicy(root);
	assert.equal(read.kind, "ok");
	if (read.kind !== "ok") return;
	assert.deepEqual(read.policy.sandboxExceptions.allow, ["command:git push:*"]);

	// Appends without disturbing existing rules or keys.
	const appended = persistProjectRule(root, "command:gh pr create:*");
	assert.equal(appended.ok, true);
	read = readProjectPolicy(root);
	if (read.kind !== "ok") return;
	assert.deepEqual(read.policy.sandboxExceptions.allow, ["command:git push:*", "command:gh pr create:*"]);

	// Idempotent, and reports that nothing was added.
	const again = persistProjectRule(root, "command:git push:*");
	assert.equal(again.ok, true);
	if (!again.ok) return;
	assert.equal(again.added, false);

	// Unusable rules are refused rather than written.
	const bad = persistProjectRule(root, "git push");
	assert.equal(bad.ok, false);
	const typo = persistProjectRule(root, "command:git push:");
	assert.equal(typo.ok, false);
	read = readProjectPolicy(root);
	if (read.kind !== "ok") return;
	assert.equal(read.policy.sandboxExceptions.allow.length, 2);
});
