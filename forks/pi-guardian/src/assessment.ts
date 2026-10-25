import {
	AUTHORIZATION_LEVELS,
	OUTCOMES,
	RISK_LEVELS,
	type GuardianAssessment,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGuardianAssessment(text: string): GuardianAssessment {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch (error) {
		throw new Error(`Guardian returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("Guardian assessment must be a JSON object");

	const expectedKeys = ["outcome", "rationale", "risk_level", "user_authorization"];
	const actualKeys = Object.keys(parsed).sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error(`Guardian assessment must contain exactly: ${expectedKeys.join(", ")}`);
	}

	if (!RISK_LEVELS.includes(parsed.risk_level as (typeof RISK_LEVELS)[number])) {
		throw new Error("Guardian assessment has an invalid risk_level");
	}
	if (!AUTHORIZATION_LEVELS.includes(parsed.user_authorization as (typeof AUTHORIZATION_LEVELS)[number])) {
		throw new Error("Guardian assessment has an invalid user_authorization");
	}
	if (!OUTCOMES.includes(parsed.outcome as (typeof OUTCOMES)[number])) {
		throw new Error("Guardian assessment has an invalid outcome");
	}
	if (typeof parsed.rationale !== "string" || parsed.rationale.trim() === "" || parsed.rationale.length > 2_000) {
		throw new Error("Guardian assessment rationale must contain 1-2000 characters");
	}

	return {
		risk_level: parsed.risk_level as GuardianAssessment["risk_level"],
		user_authorization: parsed.user_authorization as GuardianAssessment["user_authorization"],
		outcome: parsed.outcome as GuardianAssessment["outcome"],
		rationale: parsed.rationale.trim(),
	};
}

export function failedClosedAssessment(reason: string): GuardianAssessment {
	return {
		risk_level: "high",
		user_authorization: "unknown",
		outcome: "deny",
		rationale: `Automatic safety review failed closed: ${reason}`,
	};
}
