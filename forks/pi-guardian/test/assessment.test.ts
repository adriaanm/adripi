import assert from "node:assert/strict";
import test from "node:test";
import { failedClosedAssessment, parseGuardianAssessment } from "../src/assessment.ts";

test("parses the exact Guardian assessment contract", () => {
	assert.deepEqual(
		parseGuardianAssessment(
			'{"risk_level":"high","user_authorization":"medium","outcome":"allow","rationale":"The user explicitly approved the narrow operation."}',
		),
		{
			risk_level: "high",
			user_authorization: "medium",
			outcome: "allow",
			rationale: "The user explicitly approved the narrow operation.",
		},
	);
});

test("rejects markdown, extra keys, and invalid enum values", () => {
	assert.throws(() => parseGuardianAssessment("```json\n{}\n```"), /invalid JSON/);
	assert.throws(
		() =>
			parseGuardianAssessment(
				'{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"Fine.","advice":"run it"}',
			),
		/exactly/,
	);
	assert.throws(
		() =>
			parseGuardianAssessment(
				'{"risk_level":"extreme","user_authorization":"high","outcome":"allow","rationale":"Fine."}',
			),
		/invalid risk_level/,
	);
});

test("failed-closed assessments are denials", () => {
	assert.deepEqual(failedClosedAssessment("reviewer unavailable"), {
		risk_level: "high",
		user_authorization: "unknown",
		outcome: "deny",
		rationale: "Automatic safety review failed closed: reviewer unavailable",
	});
});
