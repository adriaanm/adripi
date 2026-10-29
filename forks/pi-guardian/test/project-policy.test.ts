import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashText } from "../src/state.ts";
import {
	isProjectPolicyTrusted,
	persistProjectRule,
	projectPolicyPath,
	projectPolicySnapshot,
	readProjectPolicy,
	readProjectTrust,
	recordProjectTrust,
	type PersistProjectRuleResult,
	type ProjectPolicySnapshot,
} from "../src/project-policy.ts";

async function tempDir(prefix: string) {
	return await mkdtemp(join(tmpdir(), prefix));
}

async function project(files: Record<string, unknown>) {
	const root = await tempDir("guardian-project-");
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(projectPolicyPath(root), JSON.stringify(files));
	return root;
}

/** The snapshot a UI approval of the current content — or of its absence — yields. */
function snapshot(root: string): ProjectPolicySnapshot {
	const read = readProjectPolicy(root);
	const approved = projectPolicySnapshot(root, read);
	assert.ok(approved, `expected an approvable snapshot, got ${JSON.stringify(read)}`);
	return approved;
}

/** What `resolveProjectPolicy` does after the human says yes to the current content. */
function approve(root: string, agentDir: string): ProjectPolicySnapshot {
	const approved = snapshot(root);
	if (approved.hash !== null) recordProjectTrust(agentDir, approved.path, approved.hash);
	return approved;
}

/**
 * The body of the `pi-guardian:project-policy` service's `persistRule`, i.e. what
 * `src/index.ts` must do: approve against the content this project's approval
 * covers, record only the hash that was actually written, and adopt only the
 * rules that came back with it.
 */
function persistRule(root: string, agentDir: string, rule: string): PersistProjectRuleResult {
	const path = projectPolicyPath(root);
	const approved: ProjectPolicySnapshot = { path, hash: readProjectTrust(agentDir)[path] ?? null };
	const result = persistProjectRule(root, rule, { agentDir, approved });
	if (result.ok && result.added) recordProjectTrust(agentDir, result.path, result.hash);
	return result;
}

async function allowList(root: string): Promise<string[]> {
	const read = readProjectPolicy(root);
	assert.equal(read.kind, "ok");
	return read.kind === "ok" ? read.policy.sandboxExceptions.allow : [];
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
	const root = await tempDir("guardian-nopolicy-");
	assert.equal(readProjectPolicy(root).kind, "none");
	assert.deepEqual(projectPolicySnapshot(root, readProjectPolicy(root)), {
		path: projectPolicyPath(root),
		hash: null,
	});
});

test("trust is pinned to the exact content hash", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
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

test("an approval pins the bytes, not the parsed value", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);
	// Same policy, different spelling: the hash — and therefore the approval — is
	// bound to the exact bytes the human reviewed.
	await writeFile(projectPolicyPath(root), JSON.stringify({ sandboxExceptions: { allow: ["command:git push:*"] } }, null, 4));
	const reformatted = readProjectPolicy(root);
	assert.equal(reformatted.kind, "ok");
	if (reformatted.kind !== "ok") return;
	assert.notEqual(reformatted.policy.hash, approved.hash);
	assert.equal(isProjectPolicyTrusted(agentDir, reformatted.policy.path, reformatted.policy.hash), false);
});

test("persisting an approved rule creates, appends and dedupes", async () => {
	const root = await tempDir("guardian-persist-");
	const agentDir = await tempDir("guardian-agenty-");

	// Creating the file is allowed when the approval covered its absence.
	const created = persistProjectRule(root, "command:git push:*", { agentDir, approved: snapshot(root) });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.equal(created.added, true);
	// The hash the caller may trust is the hash of the bytes on disk, and the
	// rules it may apply come back with it: no second read of a file that another
	// writer could already have replaced.
	assert.equal(created.hash, hashText(await readFile(created.path, "utf8")));
	assert.deepEqual(created.sandboxExceptions, { allow: ["command:git push:*"], defer: [], deny: [] });
	recordProjectTrust(agentDir, created.path, created.hash);
	assert.deepEqual(await allowList(root), ["command:git push:*"]);

	// Appends without disturbing existing rules.
	const appended = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved: snapshot(root) });
	assert.equal(appended.ok, true);
	if (!appended.ok) return;
	assert.equal(appended.added, true);
	assert.deepEqual(appended.sandboxExceptions, {
		allow: ["command:git push:*", "command:gh pr create:*"],
		defer: [],
		deny: [],
	});
	recordProjectTrust(agentDir, appended.path, appended.hash);
	assert.deepEqual(await allowList(root), ["command:git push:*", "command:gh pr create:*"]);

	// Idempotent: an already-approved rule writes nothing and reports the approved hash.
	const before = await readFile(projectPolicyPath(root), "utf8");
	const again = persistProjectRule(root, "command:git push:*", { agentDir, approved: snapshot(root) });
	assert.equal(again.ok, true);
	if (!again.ok) return;
	assert.equal(again.added, false);
	assert.equal(again.hash, hashText(before));
	assert.deepEqual(again.sandboxExceptions.allow, ["command:git push:*", "command:gh pr create:*"]);
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), before);

	// Unusable rules are refused rather than written.
	for (const bad of ["git push", "command:git push:"]) {
		const refused = persistProjectRule(root, bad, { agentDir, approved: snapshot(root) });
		assert.equal(refused.ok, false);
	}
	assert.deepEqual(await allowList(root), ["command:git push:*", "command:gh pr create:*"]);

	// Atomic replacement leaves no temp files next to the policy.
	assert.deepEqual(await readdir(join(root, ".pi")), ["guardian.json"]);
});

test("appending preserves defer and deny and cannot duplicate a rule", async () => {
	const root = await project({
		sandboxExceptions: {
			allow: [" command:git push:* "],
			defer: ["network:example.test:443"],
			deny: ["command:rm:*"],
		},
	});
	const agentDir = await tempDir("guardian-agenty-");
	approve(root, agentDir);

	// The existing entry is trimmed on read, so re-saving it is a no-op.
	const noop = persistProjectRule(root, "command:git push:*", { agentDir, approved: snapshot(root) });
	assert.equal(noop.ok, true);
	if (!noop.ok) return;
	assert.equal(noop.added, false);

	const saved = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved: snapshot(root) });
	assert.equal(saved.ok, true);
	if (!saved.ok) return;
	recordProjectTrust(agentDir, saved.path, saved.hash);

	const read = readProjectPolicy(root);
	assert.equal(read.kind, "ok");
	if (read.kind !== "ok") return;
	assert.deepEqual(read.policy.sandboxExceptions, {
		allow: ["command:git push:*", "command:gh pr create:*"],
		defer: ["network:example.test:443"],
		deny: ["command:rm:*"],
	});

	// Saving twice more never duplicates the new entry.
	persistProjectRule(root, "command:gh pr create:*", { agentDir, approved: snapshot(root) });
	assert.deepEqual(await allowList(root), ["command:git push:*", "command:gh pr create:*"]);
});

test("saving one rule cannot trust pre-existing unapproved entries", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:echo:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = snapshot(root);
	const before = await readFile(projectPolicyPath(root), "utf8");

	const saved = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	// Actionable: says which file, why, and that it needs review.
	assert.match(saved.reason, new RegExp(`${projectPolicyPath(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not an approved project policy`));
	assert.match(saved.reason, /review that file and approve it/);

	// Nothing was written and nothing was blessed.
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), before);
	assert.deepEqual(readProjectTrust(agentDir), {});
	assert.equal(isProjectPolicyTrusted(agentDir, projectPolicyPath(root), hashText(before)), false);
});

test("the service saves one rule without activating unapproved entries", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:echo:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const unapproved = await readFile(projectPolicyPath(root), "utf8");

	// No approval covers the file's content, so the service refuses to extend it
	// and reports why: saving "git push" must not switch on "command:echo:*".
	const refused = persistRule(root, agentDir, "command:git push:*");
	assert.equal(refused.ok, false);
	if (refused.ok) return;
	assert.match(refused.reason, /is not an approved project policy/);
	assert.deepEqual(readProjectTrust(agentDir), {});
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), unapproved);

	// The sanctioned path is the human approving that file, after which one save
	// both appends the new rule and records trust for exactly the new bytes.
	approve(root, agentDir);
	const saved = persistRule(root, agentDir, "command:git push:*");
	assert.equal(saved.ok, true);
	if (!saved.ok) return;
	assert.equal(saved.added, true);
	assert.deepEqual(saved.sandboxExceptions.allow, ["command:echo:*", "command:git push:*"]);
	assert.deepEqual(readProjectTrust(agentDir), { [saved.path]: saved.hash });
	assert.equal(isProjectPolicyTrusted(agentDir, saved.path, saved.hash), true);

	// The approval the service recorded advances with the save, so the next save in
	// the same session needs no re-read and loses nothing.
	const second = persistRule(root, agentDir, "command:gh pr create:*");
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(second.added, true);
	assert.deepEqual(readProjectTrust(agentDir), { [second.path]: second.hash });
	assert.deepEqual(await allowList(root), ["command:echo:*", "command:git push:*", "command:gh pr create:*"]);
});

test("a policy changed after approval is refused instead of trusted", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);

	const changed = JSON.stringify({ sandboxExceptions: { allow: ["command:git push:*", "command:sudo:*"] } });
	await writeFile(projectPolicyPath(root), changed);

	const saved = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved });
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /changed after it was approved/);
	assert.match(saved.reason, /review the new content/);

	assert.equal(await readFile(projectPolicyPath(root), "utf8"), changed);
	assert.equal(isProjectPolicyTrusted(agentDir, projectPolicyPath(root), hashText(changed)), false);
	// The approval still covers exactly the bytes it covered before.
	assert.equal(isProjectPolicyTrusted(agentDir, projectPolicyPath(root), approved.hash ?? ""), true);
});

test("an approval is bound to one policy path", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);

	const saved = persistProjectRule(root, "command:gh pr create:*", {
		agentDir,
		approved: { ...approved, path: join(root, "other", "guardian.json") },
	});
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /approved for .*other.*guardian\.json/);
	assert.deepEqual(await allowList(root), ["command:git push:*"]);
});

test("a policy that appeared after its absence was approved is refused", async () => {
	const root = await tempDir("guardian-absent-");
	const agentDir = await tempDir("guardian-agenty-");
	const approved = snapshot(root);
	assert.equal(approved.hash, null);

	const appeared = JSON.stringify({ sandboxExceptions: { allow: ["command:echo:*"] } });
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(projectPolicyPath(root), appeared);

	// Nobody approved the content that appeared, so it cannot be extended at all.
	const saved = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /is not an approved project policy/);
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), appeared);
	assert.deepEqual(readProjectTrust(agentDir), {});

	// Even when another session approved that content, an approval for the file's
	// absence does not cover it.
	recordProjectTrust(agentDir, projectPolicyPath(root), hashText(appeared));
	const stale = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(stale.ok, false);
	if (stale.ok) return;
	assert.match(stale.reason, /approval covers creating .* but it now holds approved content/);
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), appeared);
});

test("an approval for older content cannot extend newer approved bytes", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const stale = approve(root, agentDir);

	// Another session appends a rule and records its approval.
	const other = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved: snapshot(root) });
	assert.equal(other.ok, true);
	if (!other.ok) return;
	recordProjectTrust(agentDir, other.path, other.hash);

	const saved = persistProjectRule(root, "command:git status:*", { agentDir, approved: stale });
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /approval supplied is for/);
	assert.deepEqual(await allowList(root), ["command:git push:*", "command:gh pr create:*"]);
});

test("a policy removed after approval is refused", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);
	await rm(projectPolicyPath(root));

	const saved = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /no longer exists/);
});

test("a no-op save cannot move trust to changed bytes", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:git push:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);

	const noop = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(noop.ok, true);
	if (!noop.ok) return;
	assert.equal(noop.added, false);
	assert.equal(noop.hash, approved.hash);

	// The file gains an entry nobody approved; the already-present rule is still
	// there, so a naive no-op would look successful and the new bytes "approved".
	const edited = JSON.stringify({ sandboxExceptions: { allow: ["command:git push:*", "command:sudo:*"] } });
	await writeFile(projectPolicyPath(root), edited);
	const afterEdit = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	assert.equal(afterEdit.ok, false);
	if (afterEdit.ok) return;
	assert.match(afterEdit.reason, /changed after it was approved/);
	assert.equal(isProjectPolicyTrusted(agentDir, projectPolicyPath(root), hashText(edited)), false);
	assert.equal(await readFile(projectPolicyPath(root), "utf8"), edited);
});

test("a symlinked policy directory is rejected for reads and writes", async () => {	const root = await tempDir("guardian-symlink-");
	const outside = await tempDir("guardian-outside-");
	const agentDir = await tempDir("guardian-agenty-");
	const outsidePolicy = JSON.stringify({ sandboxExceptions: { allow: ["command:echo:*"] } });
	await writeFile(join(outside, "guardian.json"), outsidePolicy);
	await symlink(outside, join(root, ".pi"), "dir");

	const read = readProjectPolicy(root);
	assert.equal(read.kind, "invalid");
	if (read.kind === "invalid") assert.match(read.error, /\.pi must not be a symlink/);

	const saved = persistProjectRule(root, "command:git push:*", {
		agentDir,
		approved: { path: projectPolicyPath(root), hash: null },
	});
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /must not be a symlink/);
	assert.equal(await readFile(join(outside, "guardian.json"), "utf8"), outsidePolicy);
});

test("a symlinked .pi is rejected before it holds any policy file", async () => {
	const root = await tempDir("guardian-symlink-");
	const outside = await tempDir("guardian-outside-");
	const agentDir = await tempDir("guardian-agenty-");
	await symlink(outside, join(root, ".pi"), "dir");

	const read = readProjectPolicy(root);
	assert.equal(read.kind, "invalid");
	if (read.kind === "invalid") assert.match(read.error, /\.pi must not be a symlink/);

	// Approving "create the policy" does not make a symlinked directory writable.
	const saved = persistProjectRule(root, "command:git push:*", {
		agentDir,
		approved: { path: projectPolicyPath(root), hash: null },
	});
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /\.pi must not be a symlink/);
	assert.deepEqual(await readdir(outside), []);
});

test("a .pi path that is not a directory is rejected", async () => {
	const root = await tempDir("guardian-notadir-");
	const agentDir = await tempDir("guardian-agenty-");
	await writeFile(join(root, ".pi"), "not a directory\n");

	const read = readProjectPolicy(root);
	assert.equal(read.kind, "invalid");
	if (read.kind === "invalid") assert.match(read.error, /\.pi must be a directory/);

	const saved = persistProjectRule(root, "command:git push:*", {
		agentDir,
		approved: { path: projectPolicyPath(root), hash: null },
	});
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /\.pi must be a directory/);
});

test("a symlinked policy file is rejected even when its content is trusted", async () => {
	const root = await tempDir("guardian-symlink-");
	const agentDir = await tempDir("guardian-agenty-");
	const target = join(await tempDir("guardian-outside-"), "policy.json");
	const targetPolicy = JSON.stringify({ sandboxExceptions: { allow: ["command:echo:*"] } });
	await writeFile(target, targetPolicy);
	await mkdir(join(root, ".pi"), { recursive: true });
	await symlink(target, projectPolicyPath(root), "file");
	const hash = hashText(targetPolicy);
	recordProjectTrust(agentDir, projectPolicyPath(root), hash);

	const read = readProjectPolicy(root);
	assert.equal(read.kind, "invalid");
	if (read.kind === "invalid") assert.match(read.error, /guardian\.json must not be a symlink/);

	// Trust of the target's bytes does not make the symlink writable.
	const saved = persistProjectRule(root, "command:git push:*", {
		agentDir,
		approved: { path: projectPolicyPath(root), hash },
	});
	assert.equal(saved.ok, false);
	if (saved.ok) return;
	assert.match(saved.reason, /must not be a symlink/);
	assert.equal(await readFile(target, "utf8"), targetPolicy);
});

test("concurrent saves keep both rules by rejecting the stale approval", async () => {
	const root = await project({ sandboxExceptions: { allow: ["command:echo:*"] } });
	const agentDir = await tempDir("guardian-agenty-");
	const approved = approve(root, agentDir);

	// Both saves were approved against the same content before either ran.
	const first = persistProjectRule(root, "command:git push:*", { agentDir, approved });
	const second = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.equal(second.ok, false);
	if (second.ok) return;
	assert.match(second.reason, /changed after it was approved/);

	recordProjectTrust(agentDir, first.path, first.hash);
	assert.deepEqual(await allowList(root), ["command:echo:*", "command:git push:*"]);
	// Only the bytes that were written are trusted; the stale approval was not
	// silently re-pointed at them and the rejected rule was not blessed.
	assert.deepEqual(readProjectTrust(agentDir), { [first.path]: first.hash });

	// A fresh approval saves the second rule and keeps the first.
	const retry = persistProjectRule(root, "command:gh pr create:*", { agentDir, approved: snapshot(root) });
	assert.equal(retry.ok, true);
	assert.deepEqual(await allowList(root), ["command:echo:*", "command:git push:*", "command:gh pr create:*"]);
});
