import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSandboxBroker,
	getSandboxBroker,
	publishSandboxBroker,
} from "../src/sandbox/broker.ts";
import { builtinSandboxDenyRules, evaluateSandboxRules, parseSandboxRule } from "../src/sandbox/rules.ts";
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
	const { evaluateLayeredSandboxRules } = await import("../src/sandbox/rules.ts");
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
