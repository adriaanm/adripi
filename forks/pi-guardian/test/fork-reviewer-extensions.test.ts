import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGuardianConfig } from "../src/config.ts";
import { denialReason } from "../src/index.ts";
import { buildSidecarArgs, getPiInvocation } from "../src/sidecar.ts";
import type { GuardianAssessment, GuardianConfig, GuardianStateV1 } from "../src/types.ts";

// Fork-only behavior: the reviewer sidecar may load an explicit allowlist of
// extensions (for provider extensions such as npm:@aliou/pi-neuralwatt), and a
// pi-subagents child runner must be relaunched as the Pi CLI rather than as its
// own Node bootstrap. See VENDOR.md.

const config = {
	reviewerModel: "neuralwatt/nw-flash",
	reviewerExtensions: [],
	thinkingLevel: "low",
	policyPath: "/trusted/guardian-policy.md",
} as unknown as GuardianConfig;

const state = {
	guardianSessionId: "guardian-123",
	guardianSessionDir: "/safe/guardian-sessions",
	parentSessionId: "parent-456",
	reviewCount: 0,
} as unknown as GuardianStateV1;

test("reviewer extensions default to none", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-fork-config-"));
	const loaded = loadGuardianConfig(agentDir, "/bundle/policy.md");
	assert.deepEqual(loaded.reviewerExtensions, []);
});

test("keeps npm sources while resolving local reviewer extensions", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-fork-config-"));
	await writeFile(
		join(agentDir, "guardian.json"),
		JSON.stringify({
			reviewer: { extensions: ["npm:@aliou/pi-neuralwatt@0.18.0", "./local.ts", "/opt/provider.ts"] },
		}),
	);
	const loaded = loadGuardianConfig(agentDir, "/bundle/policy.md");
	assert.deepEqual(loaded.reviewerExtensions, [
		"npm:@aliou/pi-neuralwatt@0.18.0",
		join(agentDir, "local.ts"),
		"/opt/provider.ts",
	]);
});

test("rejects malformed reviewer extension entries", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-fork-config-"));
	await writeFile(join(agentDir, "guardian.json"), '{"reviewer":{"extensions":[""]}}');
	assert.throws(
		() => loadGuardianConfig(agentDir, "/bundle/policy.md"),
		/reviewer\.extensions must be an array/,
	);
});

test("loads only explicitly configured reviewer extensions", () => {
	const extensions = ["npm:@aliou/pi-neuralwatt@0.18.0", "/opt/provider.ts"];
	const args = buildSidecarArgs({ ...config, reviewerExtensions: extensions }, state);
	const configured = args.flatMap((arg, index) => (arg === "--extension" ? [args[index + 1]] : []));
	assert.deepEqual(configured, extensions);
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-tools"));
});

test("keeps every non-path specifier intact and resolves only paths", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-guardian-fork-config-"));
	await writeFile(
		join(agentDir, "guardian.json"),
		JSON.stringify({
			reviewer: {
				extensions: ["builtin:x", "file:///opt/provider.ts", "https://example.com/p.git", "git:github.com/a/b", "~/local.ts"],
			},
		}),
	);
	const loaded = loadGuardianConfig(agentDir, "/bundle/policy.md");
	assert.deepEqual(loaded.reviewerExtensions, [
		"builtin:x",
		"file:///opt/provider.ts",
		"https://example.com/p.git",
		"git:github.com/a/b",
		join(homedir(), "local.ts"),
	]);
});

test("failed reviews are reported as review failures, not risk denials", () => {
	const assessment = {
		risk_level: "critical",
		user_authorization: "unknown",
		outcome: "deny",
		rationale: "Automatic safety review failed closed: sidecar exited 1",
	} as unknown as GuardianAssessment;
	assert.match(denialReason(assessment, false, true), /could not complete the safety review/);
	assert.match(denialReason(assessment, false, false), /unacceptable risk/);
	assert.doesNotMatch(denialReason(assessment, false, false), /could not complete the safety review/);
});

test("honors PI_SUBAGENT_RUNNER_CONFIG when detecting a nested runner", () => {
	const previous = process.env.PI_SUBAGENT_RUNNER_CONFIG;
	try {
		process.env.PI_SUBAGENT_RUNNER_CONFIG = "{}";
		assert.deepEqual(getPiInvocation(["--version"]), { command: "pi", args: ["--version"] });
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_RUNNER_CONFIG;
		else process.env.PI_SUBAGENT_RUNNER_CONFIG = previous;
	}
});

test("does not relaunch a pi-subagents child runner as Pi", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-guardian-fork-runner-"));
	const runner = join(directory, "subagent-runner-bootstrap.js");
	await writeFile(runner, "");
	const previousScript = process.argv[1];
	const previousAsync = process.env.PI_ASYNC_NATIVE_RUNNER;
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	try {
		process.argv[1] = runner;
		delete process.env.PI_ASYNC_NATIVE_RUNNER;
		delete process.env.PI_SUBAGENT_PI_BINARY;
		assert.deepEqual(getPiInvocation(["--version"]), { command: "pi", args: ["--version"] });

		process.env.PI_ASYNC_NATIVE_RUNNER = "1";
		assert.deepEqual(getPiInvocation(["--version"]), { command: "pi", args: ["--version"] });

		process.env.PI_SUBAGENT_PI_BINARY = "/opt/pi";
		assert.deepEqual(getPiInvocation(["--version"]), { command: "/opt/pi", args: ["--version"] });
	} finally {
		process.argv[1] = previousScript;
		if (previousAsync === undefined) delete process.env.PI_ASYNC_NATIVE_RUNNER;
		else process.env.PI_ASYNC_NATIVE_RUNNER = previousAsync;
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
	}
});
