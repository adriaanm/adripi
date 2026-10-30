import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxExceptionPrompt, sandboxOutcomeFromAssessment } from "../src/sandbox/review.ts";
import type { SandboxExceptionRequest } from "../src/sandbox/types.ts";
import type { GuardianAssessment } from "../src/types.ts";
import { envelopeText } from "../src/reviewer-context.ts";

const request: SandboxExceptionRequest = {
	id: "req-1",
	origin: "tool",
	surface: "write",
	target: "~/.gradle",
	scope: "session",
	reason: "Gradle cache is needed for the offline build.",
	cwd: "/Users/example/project",
};

function assessment(overrides: Partial<GuardianAssessment> = {}): GuardianAssessment {
	return {
		risk_level: "low",
		user_authorization: "high",
		outcome: "allow",
		rationale: "The user asked for the build to run.",
		...overrides,
	} as GuardianAssessment;
}

test("the prompt frames one structured request and a separately sourced directive set", () => {
	const prompt = buildSandboxExceptionPrompt({ mode: "full", text: "untrusted duplicate text", omittedEntries: 1, truncatedEntries: 2 });
	assert.match(prompt, /SANDBOX EXCEPTION/);
	assert.match(prompt, /Only the host review envelope's ordered directives records authorize an exception/);
	const envelope = JSON.parse(envelopeText("parent", "policy", prompt, { directives: [{ id: "u", text: "build it offline" }], evidence: [], action: request }));
	assert.deepEqual(envelope.action, request);
	assert.equal(envelope.directives[0].text, "build it offline");
	assert.doesNotMatch(prompt, /~\/.gradle|build it offline|untrusted duplicate text/);
	assert.match(prompt, /omitted_entries=1, truncated_entries=2/);
});

test("scope is granted only with high user authorization and low/medium risk", () => {
	assert.equal(sandboxOutcomeFromAssessment(assessment(), request).outcome, "allow");
	assert.equal(
		sandboxOutcomeFromAssessment(assessment(), request).outcome === "allow"
			? (sandboxOutcomeFromAssessment(assessment(), request) as { scope: string }).scope
			: undefined,
		"session",
	);
	const unknownUser = sandboxOutcomeFromAssessment(assessment({ user_authorization: "unknown" }), request);
	assert.equal(unknownUser.outcome === "allow" ? unknownUser.scope : undefined, "once");
	const risky = sandboxOutcomeFromAssessment(assessment({ risk_level: "critical" }), request);
	assert.equal(risky.outcome === "allow" ? risky.scope : undefined, "once");
	// A once-scope request never widens, even for a fully authorized, low-risk ask.
	const once = sandboxOutcomeFromAssessment(assessment(), { ...request, scope: "once" });
	assert.equal(once.outcome === "allow" ? once.scope : undefined, "once");
});

test("a reviewer denial is a denial with its rationale", () => {
	const denied = sandboxOutcomeFromAssessment(
		assessment({ outcome: "deny", rationale: "Not authorized by the transcript." }),
		request,
	);
	assert.equal(denied.outcome, "deny");
	assert.equal(denied.rationale, "Not authorized by the transcript.");
});
