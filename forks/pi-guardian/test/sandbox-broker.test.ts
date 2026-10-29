import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSandboxBroker,
	getSandboxBroker,
	publishSandboxBroker,
} from "../src/sandbox/broker.ts";
import {
	builtinSandboxDenyRules,
	evaluateLayeredSandboxRules,
	evaluateSandboxRules,
	parseNetworkTarget,
	parseSandboxRule,
} from "../src/sandbox/rules.ts";
import type {
	SandboxAuditRecord,
	SandboxExceptionRequest,
	SandboxExceptionRules,
} from "../src/sandbox/types.ts";

const agentDir = join(homedir(), ".pi", "agent");
const cwd = join(homedir(), "project");

const emptyRules: SandboxExceptionRules = { allow: [], defer: [], deny: [] };

function request(overrides: Partial<SandboxExceptionRequest> = {}): SandboxExceptionRequest {
	return {
		id: "req-1",
		origin: "tool",
		surface: "write",
		target: "~/.gradle/caches",
		scope: "session",
		reason: "Gradle needs its cache to build offline.",
		cwd,
		...overrides,
	};
}

test("sandbox rules require an explicit surface and a pattern", () => {
	assert.deepEqual(parseSandboxRule("write: ~/.gradle/**"), {
		surface: "write",
		pattern: "~/.gradle/**",
		text: "write:~/.gradle/**",
	});
	assert.throws(() => parseSandboxRule("~/.gradle/**"), /Malformed sandbox exception rule/);
	assert.throws(() => parseSandboxRule("everything:~/.gradle/**"), /Malformed sandbox exception rule/);
	assert.throws(() => parseSandboxRule("write:"), /Malformed sandbox exception rule/);
});

test("credentials and the agent directory are always denied", () => {
	const rules = { allow: [] as string[], defer: [] as string[], deny: builtinSandboxDenyRules(agentDir) };
	const ssh = evaluateSandboxRules(rules, request({ target: "~/.ssh/id_ed25519" }), agentDir);
	assert.equal(ssh.outcome, "deny");
	const config = evaluateSandboxRules(
		rules,
		request({ target: join(agentDir, "guardian.json") }),
		agentDir,
	);
	assert.equal(config.outcome, "deny");
	// A deny cannot be overridden by an allow rule for the same target.
	const overridden = evaluateSandboxRules(
		{ allow: ["write:~/.ssh/**"], defer: [], deny: builtinSandboxDenyRules(agentDir) },
		request({ target: "~/.ssh/id_ed25519" }),
		agentDir,
	);
	assert.equal(overridden.outcome, "deny");
});

test("an allow rule short-circuits review but a deny still wins", () => {
	const rules = { allow: ["write:~/.gradle/**"], defer: [], deny: ["write:~/project/secrets/**"] };
	assert.equal(evaluateSandboxRules(rules, request({ target: "~/.gradle/caches" }), agentDir).outcome, "allow");
	assert.equal(
		evaluateSandboxRules(rules, request({ target: join(cwd, "secrets", "x") }), agentDir).outcome,
		"deny",
	);
	// Network and command targets match their own surface only.
	assert.equal(
		evaluateSandboxRules(rules, request({ surface: "network", target: "registry.npmjs.org" }), agentDir).outcome,
		"review",
	);
	// A write grant never answers a read request, or the reverse.
	assert.equal(
		evaluateSandboxRules(
			{ allow: ["write:~/.gradle/**"], defer: [], deny: [] },
			request({ surface: "read", target: "~/.gradle/caches" }),
			agentDir,
		).outcome,
		"review",
	);
	assert.equal(
		evaluateSandboxRules(
			{ allow: ["read:~/.gradle/**"], defer: [], deny: [] },
			request({ surface: "write", target: "~/.gradle/caches" }),
			agentDir,
		).outcome,
		"review",
	);
});

test("a hard deny never calls the reviewer", async () => {
	const audits: SandboxAuditRecord[] = [];
	let reviews = 0;
	const broker = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		audit: (record) => audits.push(record),
		review: async () => {
			reviews++;
			return { outcome: "allow", rationale: "should not happen" };
		},
	});
	const decision = await broker.review(request({ target: "~/.ssh/id_ed25519" }));
	assert.equal(decision.kind, "deny");
	assert.equal(reviews, 0);
	assert.equal(audits.length, 1);
	assert.equal(audits[0].source, "rule");
});

test("the reviewer decides, and the grant scope never widens", async () => {
	const broker = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async () => ({ outcome: "allow", rationale: "User asked for offline builds.", scope: "session" }),
	});
	const once = await broker.review(request({ scope: "once" }));
	assert.equal(once.kind, "allow");
	assert.equal(once.kind === "allow" ? once.scope : undefined, "once");
	const session = await broker.review(request({ scope: "session" }));
	assert.equal(session.kind === "allow" ? session.scope : undefined, "session");
	assert.ok(session.kind === "allow" && session.grantId);
});

test("reviewer denials, defers and failures are reported faithfully", async () => {
	const denying = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async () => ({ outcome: "deny", rationale: "Not authorized by the transcript." }),
	});
	const denied = await denying.review(request());
	assert.equal(denied.kind, "deny");
	assert.match(denied.kind === "deny" ? denied.reason : "", /Do not retry or rephrase/);

	const deferring = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async () => ({ outcome: "defer", rationale: "Ambiguous scope." }),
	});
	assert.equal((await deferring.review(request())).kind, "defer");

	const failing = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async () => {
			throw new Error("sidecar timeout");
		},
	});
	const failed = await failing.review(request());
	assert.equal(failed.kind, "deny");
	assert.match(failed.kind === "deny" ? failed.reason : "", /review failed/i);
});

test("a model-asked exception without a reason is denied without review", async () => {
	let reviews = 0;
	const broker = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async () => {
			reviews++;
			return { outcome: "allow", rationale: "ok" };
		},
	});
	const decision = await broker.review(request({ reason: "   " }));
	assert.equal(decision.kind, "deny");
	assert.equal(reviews, 0);
	// Trap-origin requests do not need a model justification.
	reviews = 0;
	const trap = await broker.review(request({ origin: "trap", reason: undefined, violation: "write denied" }));
	assert.equal(trap.kind, "allow");
	assert.equal(reviews, 1);
});

test("publishing the broker is single-owner and disposable", () => {
	const first = { review: async () => ({ kind: "deny" as const, reason: "no", review: { rationale: "no", source: "rule" as const } }) };
	const dispose = publishSandboxBroker(first);
	assert.equal(getSandboxBroker(), first);
	assert.throws(() => publishSandboxBroker(first), /already published/);
	dispose();
	assert.equal(getSandboxBroker(), undefined);
});

test("a defer rule routes the request to the human without review", async () => {
	let reviews = 0;
	const broker = createSandboxBroker({
		rules: { allow: [], defer: ["network:*.internal:*"], deny: [] },
		agentDir,
		review: async () => {
			reviews++;
			return { outcome: "allow", rationale: "should not be consulted" };
		},
	});
	const decision = await broker.review(
		request({ surface: "network", target: "build.internal:8443", scope: "once" }),
	);
	assert.equal(decision.kind, "defer");
	assert.equal(reviews, 0);

	// A deny rule for the same class still wins over defer.
	const overridden = createSandboxBroker({
		rules: { allow: [], defer: ["network:*.internal:*"], deny: ["network:build.internal:*"] },
		agentDir,
		review: async () => ({ outcome: "allow", rationale: "should not be consulted" }),
	});
	assert.equal(
		(await overridden.review(request({ surface: "network", target: "build.internal:8443", scope: "once" }))).kind,
		"deny",
	);
});

test("repeated denials trip the breaker without consulting the reviewer", async () => {
	let reviews = 0;
	const broker = createSandboxBroker({
		rules: { allow: [], defer: [], deny: [] },
		agentDir,
		maxConsecutiveDenials: 2,
		review: async () => {
			reviews++;
			return { outcome: "deny", rationale: "Not authorized." };
		},
	});
	assert.equal((await broker.review(request({ id: "a" }))).kind, "deny");
	assert.equal((await broker.review(request({ id: "b" }))).kind, "deny");
	const tripped = await broker.review(request({ id: "c" }));
	assert.equal(tripped.kind, "deny");
	assert.match(tripped.kind === "deny" ? tripped.reason : "", /consecutive denials/);
	assert.equal(reviews, 2);
});

test("a portless network rule matches host:port and the reverse", () => {
	const portless = { allow: [], defer: [], deny: ["network:evil.example"] };
	const trap = request({ surface: "network", target: "evil.example:443", scope: "once" });
	assert.equal(evaluateSandboxRules(portless, trap, agentDir).outcome, "deny");

	const ported = { allow: [], defer: [], deny: ["network:evil.example:443"] };
	const codeless = request({ surface: "network", target: "evil.example", scope: "once" });
	assert.equal(evaluateSandboxRules(ported, codeless, agentDir).outcome, "deny");
});

test("repository config and HEAD are never grantable", () => {
	const rules = { allow: [] as string[], defer: [] as string[], deny: builtinSandboxDenyRules(agentDir) };
	for (const target of ["/repo/.git/config", "/repo/.git/HEAD"]) {
		assert.equal(evaluateSandboxRules(rules, request({ target }), agentDir).outcome, "deny");
	}
});

test("project rules pre-authorize without overriding global restrictions", async () => {
	const request = (target: string) => ({
		id: "r1",
		origin: "tool" as const,
		surface: "command" as const,
		target,
		scope: "session" as const,
		cwd: "/work/project",
	});
	const global = { allow: ["command:make:*"], defer: ["command:docker:*"], deny: ["command:rm -rf:*"] };
	const project = { allow: ["command:git push:*", "command:make:*", "command:docker:*", "command:rm -rf:*"], defer: [], deny: [] };
	const decide = (target: string) => evaluateLayeredSandboxRules(project, global, request(target), "/agent");

	// The project's standing permission grants without a review...
	assert.equal(decide("git push -u origin main").outcome, "allow");
	assert.equal(decide("git push").outcome, "allow");
	// A prefix rule must not match a longer word.
	assert.equal(
		evaluateLayeredSandboxRules({ allow: ["command:git push:*"], defer: [], deny: [] }, { allow: [], defer: [], deny: [] }, request("git pusher"), "/agent").outcome,
		"review",
	);
	// ...but a global deny still wins, even when the project allows the same target.
	assert.equal(decide("rm -rf build").outcome, "deny");
	// A global defer ("always ask me") also wins over a project allow.
	assert.equal(decide("docker build .").outcome, "defer");
	// A project deny can tighten a global allow.
	assert.equal(
		evaluateLayeredSandboxRules({ allow: [], defer: [], deny: ["command:make deploy:*"] }, global, request("make deploy"), "/agent").outcome,
		"deny",
	);
	// Unrelated targets still go to the reviewer.
	assert.equal(decide("npm install").outcome, "review");
	// Without a project policy the global rules are the whole story.
	assert.equal(evaluateLayeredSandboxRules(undefined, global, request("git push"), "/agent").outcome, "review");
});

test("a project cannot write its own policy file", async () => {
	const { evaluatePermissions } = await import("../src/permissions.ts");
	const permissions = { allow: ["Write", "Edit"], deny: [] };
	const outcome = (path: string) =>
		evaluatePermissions(permissions, "write", { path, content: "{}" }, "/work/project", "/agent").outcome;
	assert.equal(outcome("/work/project/.pi/guardian.json"), "deny");
	assert.equal(outcome("/work/project/.pi/sandbox.json"), "deny");
	assert.equal(outcome("/work/project/src/main.ts"), "allow");
});

test("a command prefix rule must be spelled prefix:*", async () => {
	const { validateSandboxRules } = await import("../src/sandbox/rules.ts");
	assert.throws(() => validateSandboxRules(["command:git pull:"], "sandboxExceptions.allow"), /ends with ":\*"/);
	assert.doesNotThrow(() => validateSandboxRules(["command:git pull:*"], "sandboxExceptions.allow"));
});

test("a network request target is one exact destination", () => {
	assert.deepEqual(parseNetworkTarget("Example.TEST:443"), {
		host: "example.test",
		literalHost: false,
		port: 443,
	});
	assert.deepEqual(parseNetworkTarget("example.test:*"), { host: "example.test", literalHost: false });
	assert.deepEqual(parseNetworkTarget("[::1]:443"), { host: "::1", literalHost: true, port: 443 });
	assert.deepEqual(parseNetworkTarget("[::1]"), { host: "::1", literalHost: true });
	// Unbracketed IPv6 is ambiguous with host:port and cannot be granted exactly.
	assert.equal(parseNetworkTarget("::1"), undefined);
	assert.equal(parseNetworkTarget("2001:db8::1:443"), undefined);
	assert.equal(parseNetworkTarget("*.example.test"), undefined);
	assert.equal(parseNetworkTarget("https://example.test"), undefined);
	assert.equal(parseNetworkTarget("example.test:0"), undefined);
	assert.equal(parseNetworkTarget("example.test:65536"), undefined);
	assert.equal(parseNetworkTarget("example.test:"), undefined);
	assert.equal(parseNetworkTarget("example.test/path"), undefined);
});

test("numeric network rules match only their port; bare host and :* mean any port", () => {
	const decide = (rules: string[], target: string) =>
		evaluateSandboxRules(
			{ allow: rules, defer: [], deny: [] },
			request({ surface: "network", target, scope: "once" }),
			agentDir,
		).outcome;

	assert.equal(decide(["network:example.test:443"], "example.test:443"), "allow");
	assert.equal(decide(["network:example.test:443"], "example.test:8443"), "review");
	assert.equal(decide(["network:example.test:443"], "example.test"), "review");
	assert.equal(decide(["network:example.test:443"], "example.test:*"), "review");
	assert.equal(decide(["network:example.test"], "example.test:8443"), "allow");
	assert.equal(decide(["network:example.test:*"], "example.test:8443"), "allow");
	// Host names are case-insensitive, but the port is an exact number.
	assert.equal(decide(["network:Example.Test:443"], "example.TEST:443"), "allow");
	assert.equal(decide(["network:example.test:44"], "example.test:443"), "review");
	assert.equal(decide(["network:127.0.0.1:8080"], "127.0.0.1:8080"), "allow");
	assert.equal(decide(["network:127.0.0.1:8080"], "127.0.0.1:8081"), "review");
	assert.equal(decide(["network:[::1]:443"], "[::1]:443"), "allow");
	assert.equal(decide(["network:[::1]:443"], "[::1]:8443"), "review");
	assert.equal(decide(["network:[::1]"], "[::1]:8443"), "allow");
	assert.equal(decide(["network:[::1]:*"], "[::1]"), "allow");
	// Intentional host globs stay legal in rules.
	assert.equal(decide(["network:*.internal:*"], "build.internal:8443"), "allow");
});

test("numeric deny and defer rules are as precise as allow rules", () => {
	const decide = (rules: SandboxExceptionRules, target: string) =>
		evaluateSandboxRules(rules, request({ surface: "network", target, scope: "once" }), agentDir).outcome;

	assert.equal(decide({ allow: [], defer: [], deny: ["network:evil.test:443"] }, "evil.test:443"), "deny");
	assert.equal(decide({ allow: [], defer: [], deny: ["network:evil.test:443"] }, "evil.test:8443"), "review");
	// An all-port request includes the denied port, so a narrower deny covers it.
	assert.equal(decide({ allow: [], defer: [], deny: ["network:evil.test:443"] }, "evil.test"), "deny");
	assert.equal(decide({ allow: [], defer: [], deny: ["network:evil.test"] }, "evil.test:8443"), "deny");
	assert.equal(decide({ allow: [], defer: ["network:build.internal:8443"], deny: [] }, "build.internal:8443"), "defer");
	assert.equal(decide({ allow: [], defer: ["network:build.internal:8443"], deny: [] }, "build.internal:443"), "review");
	// An all-port deny still outranks a port-specific allow.
	assert.equal(
		decide({ allow: ["network:evil.test:8443"], defer: [], deny: ["network:evil.test"] }, "evil.test:8443"),
		"deny",
	);
});

test("command rules compare arguments case-sensitively", () => {
	const decide = (allow: string[], target: string) =>
		evaluateLayeredSandboxRules(
			{ allow, defer: [], deny: [] },
			{ allow: [], defer: [], deny: [] },
			request({ surface: "command", target, scope: "once" }),
			agentDir,
		).outcome;

	assert.equal(decide(["command:deploy -t MyApp:*"], "deploy -t MyApp --verbose"), "allow");
	assert.equal(decide(["command:deploy -t MyApp:*"], "deploy -t myapp --verbose"), "review");
	assert.equal(decide(["command:Git push:*"], "git push"), "review");
	assert.equal(decide(["command:git push:*"], "git push -u origin Main"), "allow");
	assert.equal(decide(["command:npm run Build"], "npm run Build"), "allow");
	assert.equal(decide(["command:npm run Build"], "npm run build"), "review");
});

test("a wildcard, URL or unsafe request shape is refused before rules or review", async () => {
	let reviews = 0;
	const broker = createSandboxBroker({
		// An intentional rule glob must not turn a wildcard *request* into a grant.
		rules: { allow: ["network:*.example.test:*"], defer: [], deny: [] },
		agentDir,
		maxConsecutiveDenials: 100,
		review: async () => {
			reviews++;
			return { outcome: "allow", rationale: "should not be reviewed" };
		},
	});
	const invalid: Array<Partial<SandboxExceptionRequest>> = [
		{ surface: "network", target: "*.example.test" },
		{ surface: "network", target: "https://example.test" },
		{ surface: "network", target: "example.test:0" },
		{ surface: "network", target: "example.test:https" },
		{ surface: "network", target: "user@example.test:443" },
		{ surface: "network", target: "::1" },
		{ surface: "write", target: "relative/file" },
		{ surface: "write", target: "/work/*.env" },
		{ surface: "write", target: "~/project/*.env" },
		{ surface: "command", target: "git push\nrm -rf /" },
		{ surface: "command", target: "git push && rm -rf /" },
		{ surface: "command", target: "git push | tee out" },
		{ surface: "command", target: "git push $(whoami)" },
		{ surface: "command", target: "git push > /tmp/out" },
		{ surface: "command", target: "/bin/sh -c 'git push'" },
		{ surface: "command", target: "BASH -c 'git push'" },
		{ surface: "command", target: "python3 -c 'print(1)'" },
		{ surface: "command", target: "FOO=1 git push" },
	];
	for (const [index, overrides] of invalid.entries()) {
		const decision = await broker.review(request({ id: `invalid-${index}`, ...overrides }));
		assert.equal(decision.kind, "deny", overrides.target);
	}
	assert.equal(reviews, 0);
});

test("valid request targets still reach the reviewer", async () => {
	let reviews = 0;
	const broker = createSandboxBroker({
		rules: emptyRules,
		agentDir,
		review: async (seen) => {
			reviews++;
			return { outcome: "allow", rationale: `Reviewed ${seen.surface}.`, scope: "once" };
		},
	});
	const valid: Array<Partial<SandboxExceptionRequest>> = [
		{ surface: "network", target: "Example.Test:443" },
		{ surface: "network", target: "[::1]:8443" },
		{ surface: "network", target: "build.internal:*" },
		{ surface: "network", target: "registry.npmjs.org:443", origin: "trap", reason: undefined },
		{ surface: "write", target: "~/project/.gradle/caches" },
		{ surface: "read", target: join(cwd, "src", "main.ts") },
		{ surface: "command", target: "git push -u origin main" },
		{ surface: "command", target: "make deploy-prod" },
	];
	for (const [index, overrides] of valid.entries()) {
		const decision = await broker.review(request({ id: `valid-${index}`, scope: "once", ...overrides }));
		assert.equal(decision.kind, "allow", overrides.target);
	}
	assert.equal(reviews, valid.length);
});

test("a protected directory root, descendants and aliases are denied before review", async () => {
	const root = mkdtempSync(join(process.env.PI_SANDBOX_SCRATCH ?? tmpdir(), "guardian-targets-"));
	try {
		const agent = join(root, "agent");
		mkdirSync(join(agent, "sessions"), { recursive: true });
		writeFileSync(join(agent, "settings.json"), "{}");
		const directoryAlias = join(root, "agent-link");
		const fileAlias = join(root, "settings-link.json");
		symlinkSync(agent, directoryAlias);
		symlinkSync(join(agent, "settings.json"), fileAlias);

		let reviews = 0;
		const broker = createSandboxBroker({
			rules: emptyRules,
			agentDir: agent,
			maxConsecutiveDenials: 100,
			review: async () => {
				reviews++;
				return { outcome: "allow", rationale: "should not be reviewed" };
			},
		});
		const targets: Array<{ surface: "read" | "write"; target: string }> = [
			{ surface: "write", target: agent },
			{ surface: "write", target: join(agent, "settings.json") },
			{ surface: "read", target: join(agent, "sessions") },
			{ surface: "write", target: directoryAlias },
			{ surface: "write", target: join(directoryAlias, "settings.json") },
			{ surface: "write", target: join(directoryAlias, "sessions", "missing.json") },
			{ surface: "write", target: join(agent, "sessions", "..", "settings.json") },
			{ surface: "write", target: fileAlias },
			// The same never-grantable class spelled through the home directory.
			{ surface: "read", target: join(homedir(), ".ssh") },
			{ surface: "write", target: join(homedir(), ".ssh", "id_ed25519") },
		];
		for (const [index, entry] of targets.entries()) {
			const decision = await broker.review(
				request({ id: `protected-${index}`, scope: "once", surface: entry.surface, target: entry.target }),
			);
			assert.equal(decision.kind, "deny", entry.target);
			assert.equal(decision.kind === "deny" ? decision.review.source : undefined, "rule", entry.target);
		}
		assert.equal(reviews, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
