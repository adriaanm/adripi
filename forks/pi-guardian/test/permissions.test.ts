import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtInDenyRules, evaluatePermissions, validateRules } from "../src/permissions.ts";
import { loadGuardianConfig } from "../src/config.ts";

const cwd = "/work/project";
const agentDir = "/agent";
const decide = (tool: string, input: Record<string, unknown>, deny: string[] = [], allow: string[] = []) =>
	evaluatePermissions({ allow, deny }, tool, input, cwd, agentDir);

test("case-insensitive aliases, bare tools, and deny precedence", () => {
	const aliases = [
		["rEaD", "read"],
		["MultiEdit", "edit"],
		["Edit", "write"],
		["Glob", "find"],
		["LS", "ls"],
		["PowerShell", "powershell"],
		["extension_tool", "extension_tool"],
	];
	for (const [rule, tool] of aliases) {
		assert.equal(decide(tool, { path: "file", command: "echo hi" }, [], [rule]).outcome, "allow");
	}
	assert.deepEqual(decide("read", { path: "file" }, ["READ"], ["Read"]), { outcome: "deny", rule: "READ" });
});

test("MCP exact names and server rules normalize hyphens", () => {
	for (const rule of ["mcp__my-server__tool-name", "mcp__my-server__*", "mcp__my-server"]) {
		assert.equal(decide("mcp__my_server__tool_name", {}, [rule]).outcome, "deny");
		assert.equal(decide("mcp__other__tool_name", {}, [rule]).outcome, "review");
	}
	assert.equal(decide("mcp__my_server__other", {}, ["mcp__my_server__tool_name"]).outcome, "review");
});

test("path anchors, globstar, filename depth, and dot normalization", () => {
	for (const [rule, path] of [
		["Read(~/secrets/**)", join(homedir(), "secrets/deep/file")],
		["Read(//opt/secrets/**)", "/opt/secrets/file"],
		["Read(/secrets/**)", "/agent/secrets/file"],
		["Read(secrets/**)", "vendor/secrets/deep/file"],
		["Read(src/**/key?.[jt]s)", "src/deep/key1.ts"],
		["Read(.env)", "a/b/.env"],
		["Read(./private/../secrets/**)", "secrets/dir/../file"],
	] as const) assert.equal(decide("read", { path }, [rule]).outcome, "deny", rule);
	assert.equal(decide("read", { path: "/opt/secrets/file" }, ["Read(/opt/secrets/**)"]).outcome, "review");
	assert.equal(decide("read", { path: "vendor/src/file" }, [], ["Read(src/**)"]).outcome, "review");
	assert.equal(decide("read", { path: "src/file" }, [], ["Read(src/**)"]).outcome, "allow");
});

test("deny containment covers directory roots, defaults, and wildcard ancestors", () => {
	for (const tool of ["grep", "find", "ls"]) {
		for (const path of ["/", homedir(), "~", join(homedir(), ".codex"), join(homedir(), ".codex/subdir")]) {
			assert.equal(decide(tool, { path }, ["Read(~/.codex/**)"], [tool]).outcome, "deny", `${tool} ${path}`);
		}
		assert.equal(decide(tool, {}, ["Read(private/*.key)"], [tool]).outcome, "deny");
		assert.equal(decide(tool, { path: "secret-two" }, ["Read(secret-*/deep/file)"]).outcome, "deny");
		assert.equal(decide(tool, { path: "public" }, ["Read(private/deep/**)"], [tool]).outcome, "allow");
		assert.equal(decide(tool, { path: "/" }, [], ["Read(~/.codex/**)"]).outcome, "review");
	}
});

test("symlink targets and non-existing files under symlinked ancestors are protected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "guardian-permissions-"));
	await mkdir(join(directory, "secret"));
	await mkdir(join(directory, "public"));
	await writeFile(join(directory, "secret/key"), "not a real key");
	await symlink(join(directory, "secret"), join(directory, "public/link"));
	const permissions = { deny: [`Read(/${directory}/secret/**)`], allow: [`Read(/${directory}/public/**)`] };
	for (const path of [join(directory, "public/link/key"), join(directory, "public/link/new")]) {
		assert.equal(evaluatePermissions(permissions, "read", { path }, directory, agentDir).outcome, "deny");
		assert.equal(evaluatePermissions({ ...permissions, deny: [] }, "read", { path }, directory, agentDir).outcome, "review");
	}
	const linkEditDeny = { allow: [], deny: [`Edit(/${directory}/public/link/**)`] };
	const newSecret = { path: join(directory, "secret/new") };
	assert.equal(evaluatePermissions(linkEditDeny, "write", newSecret, directory, agentDir).outcome, "deny");
});

test("bash exact and prefix matching require command boundaries", () => {
	assert.equal(decide("bash", { command: "git status" }, [], ["Bash(git status)"]).outcome, "allow");
	assert.equal(decide("bash", { command: "git status --short" }, [], ["Bash(git status)"]).outcome, "review");
	for (const command of ["ls", "ls -la", "ls\t-la"]) assert.equal(decide("bash", { command }, [], ["Bash(ls:*)"]).outcome, "allow");
	assert.equal(decide("bash", { command: "lsof" }, [], ["Bash(ls:*)"]).outcome, "review");
});

test("compound shell allows require every subcommand; denies require any", () => {
	for (const separator of [" && ", " || ", "; ", " | ", " & ", "\n", " |& "]) {
		assert.equal(decide("bash", { command: `git status${separator}curl x` }, [], ["Bash(git status)"]).outcome, "review");
		assert.equal(decide("bash", { command: `git status${separator}ls -la` }, [], ["Bash(git status)", "Bash(ls:*)"]).outcome, "allow");
		assert.equal(decide("bash", { command: `git status${separator}git push origin main` }, ["Bash(git push:*)"], ["Bash"]).outcome, "deny");
	}
	for (const command of ['echo "$(git push origin)"', '(git push origin)', 'echo `git push origin`']) {
		assert.equal(decide("bash", { command }, ["Bash(git push:*)"]).outcome, "deny", command);
		assert.equal(decide("bash", { command }, [], ["Bash(echo:*)", "Bash(git push:*)"]).outcome, "review");
	}
	for (const command of ['git status &&', 'ls "unterminated', 'ls > file', 'for x in a; do ls; done']) {
		assert.equal(decide("bash", { command }, [], ["Bash(ls:*)", "Bash(git status)"]).outcome, "review");
	}
	assert.equal(decide("bash", { command: "echo 'git push && ls'" }, ["Bash(git push:*)"], ["Bash(echo:*)"]).outcome, "allow");
	assert.equal(decide("powershell", { command: "Get-Item a; Remove-Item b" }, ["PowerShell(Remove-Item:*)"]).outcome, "deny");
});

test("denied path literals cover bash, powershell, codemode, MCP, and extension inputs", () => {
	for (const literal of [join(homedir(), ".codex"), "~/.codex", "$HOME/.codex", "${HOME}/.codex"]) {
		for (const tool of ["bash", "powershell", "codemode", "mcp__server__tool", "extension"]) {
			const input = { command: `cat ${literal}/auth.json`, nested: { code: literal } };
			assert.equal(decide(tool, input, ["Read(~/.codex/**)"], [tool]).outcome, "deny");
		}
	}
	assert.equal(decide("bash", { command: "cat /opt/private/key" }, ["Read(//opt/private/**)"]).outcome, "deny");
	assert.equal(decide("codemode", { code: "/agent/private/key" }, ["Edit(/private/**)"]).outcome, "deny");
});

test("denied path literals end at a path boundary", () => {
	assert.equal(decide("bash", { command: "cat /root/.pip/pip.conf" }, ["Edit(//root/.pi/**)"]).outcome, "review");
	assert.equal(decide("bash", { command: "echo x > /root/.pi/agent/mcp.json" }, ["Edit(//root/.pi/**)"]).outcome, "deny");
	assert.equal(decide("bash", { command: "ls /root/.pi" }, ["Edit(//root/.pi/**)"]).outcome, "deny");
});

test("absolute rules under home also match ~ and $HOME spellings in shell commands", () => {
	const agentDirRule = [`Edit(/${join(homedir(), ".pi/agent")}/**)`];
	for (const prefix of [join(homedir(), ".pi/agent"), "~/.pi/agent", "$HOME/.pi/agent", "${HOME}/.pi/agent"]) {
		const command = `sed -i s/true/false/ ${prefix}/guardian.json`;
		assert.equal(decide("bash", { command }, agentDirRule).outcome, "deny", command);
	}
	assert.equal(decide("bash", { command: "cat ~/.pip/pip.conf" }, [`Edit(/${join(homedir(), ".pi")}/**)`]).outcome, "review");
});

test("built-in self-protection survives empty deny and broad allow", async () => {
	const directory = await mkdtemp(join(tmpdir(), "guardian-config-rules-"));
	await writeFile(join(directory, "guardian.json"), JSON.stringify({ permissions: { allow: ["Read", "Edit", "Write"], deny: [] } }));
	const config = loadGuardianConfig(directory, "/policy");
	assert.deepEqual(config.permissions.deny, builtInDenyRules(directory, config.guardianSessionDir));
	const outcome = (tool: string, path: string) =>
		evaluatePermissions(config.permissions, tool, { path }, cwd, directory).outcome;
	const protectedFiles = [
		"guardian.json",
		"auth.json",
		"settings.json",
		"models.json",
		"trust.json",
		"extensions/plugin.ts",
		"guardian-sessions/session.jsonl",
		"mcp.json",
		"APPEND_SYSTEM.md",
		"skills/example/SKILL.md",
	];
	for (const file of protectedFiles) {
		for (const tool of ["edit", "write"]) assert.equal(outcome(tool, join(directory, file)), "deny");
	}
	for (const file of ["guardian.json", "auth.json"]) assert.equal(outcome("read", join(directory, file)), "deny");
	assert.equal(outcome("read", join(directory, "guardian-sessions/session.jsonl")), "deny");
	assert.equal(outcome("read", join(directory, "settings.json")), "allow");
	// Skills are read from the agent dir, so edit-only protection must not block reads or listings.
	assert.equal(outcome("read", join(directory, "skills/example/SKILL.md")), "allow");
	assert.equal(
		evaluatePermissions(config.permissions, "ls", { path: join(directory, "skills") }, cwd, directory).outcome,
		"review",
	);
	const packagePath = new URL("../src/index.ts", import.meta.url).pathname;
	assert.equal(outcome("edit", packagePath), "deny");
	assert.equal(outcome("read", packagePath), "allow");
});

test("defaults, replacement, and legacy exemptTools merging are precise", async () => {
	const directory = await mkdtemp(join(tmpdir(), "guardian-config-merge-"));
	const load = async (contents: unknown) => {
		await writeFile(join(directory, "guardian.json"), JSON.stringify(contents));
		return loadGuardianConfig(directory, "/policy");
	};
	const defaults = ["Read", "Grep", "Find", "Ls", "tool_search"];
	assert.deepEqual((await load({})).permissions.allow, defaults);
	assert.deepEqual((await load({ permissions: { deny: ["Bash(git push:*)"] } })).permissions.allow, defaults);
	assert.deepEqual((await load({ permissions: { allow: [] } })).permissions.allow, []);
	assert.deepEqual((await load({ exemptTools: ["Glob"] })).permissions.allow, ["Glob"]);
	const config = await load({ permissions: { allow: ["Bash(ls:*)", "Read"] }, exemptTools: ["Glob", "LS"] });
	assert.deepEqual(config.permissions.allow, ["Bash(ls:*)", "Read", "Glob", "LS"]);
	assert.deepEqual([...config.exemptTools], ["read", "find", "ls"]);
});

test("malformed and unsupported rules are config errors", async () => {
	const malformed = [
		"",
		"Read(",
		"Read()",
		"Bash(ls:*oops)",
		"Read([bad)",
		"Read(!secret)",
		"mcp__server__tool(path)",
		"unknown(value)",
		"bad tool",
	];
	for (const rule of malformed) {
		assert.throws(() => validateRules([rule], "permissions.deny"), /rule|glob|pattern/);
	}
	assert.throws(() => validateRules("Read", "permissions.allow"), /array/);
	const directory = await mkdtemp(join(tmpdir(), "guardian-config-bad-rules-"));
	for (const permissions of [{ allow: ["Read("] }, { deny: [9] }, { ask: ["Bash"] }, []]) {
		await writeFile(join(directory, "guardian.json"), JSON.stringify({ permissions }));
		assert.throws(() => loadGuardianConfig(directory, "/policy"));
	}
});
