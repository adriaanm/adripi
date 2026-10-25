export const GUARDIAN_STATE_ENTRY = "pi-guardian.state";
export const GUARDIAN_ASSESSMENT_ENTRY = "pi-guardian.assessment";
export const GUARDIAN_STATUS_ENTRY = "pi-guardian-status";
export const STATE_VERSION = 1;

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const AUTHORIZATION_LEVELS = ["unknown", "low", "medium", "high"] as const;
export const OUTCOMES = ["allow", "deny"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type AuthorizationLevel = (typeof AUTHORIZATION_LEVELS)[number];
export type GuardianOutcome = (typeof OUTCOMES)[number];

export interface GuardianAssessment {
	risk_level: RiskLevel;
	user_authorization: AuthorizationLevel;
	outcome: GuardianOutcome;
	rationale: string;
}

export interface GuardianStateV1 {
	version: 1;
	parentSessionId: string;
	guardianSessionId: string;
	guardianSessionDir: string;
	reviewerModel: string;
	thinkingLevel: string;
	policyHash: string;
	generation: number;
	createdAt: string;
	lastReviewedParentEntryId?: string;
	reviewCount: number;
	denialTurnKey?: string;
	consecutiveDenials: number;
}

export interface GuardianAssessmentRecordV1 {
	version: 1;
	guardianSessionId: string;
	toolName: string;
	toolCallId: string;
	actionHash: string;
	parentCursorEntryId?: string;
	parentToolCallId?: string;
	turnKey: string;
	assessment: GuardianAssessment;
	reviewedAt: string;
	failure?: string;
	failureHelp?: string;
}

export interface GuardianParentAction {
	tool_name: string;
	tool_call_id: string;
	input: Record<string, unknown>;
}

export interface GuardianAction extends GuardianParentAction {
	cwd: string;
	parent_actions?: GuardianParentAction[];
}

export interface TranscriptBounds {
	maxMessageChars: number;
	maxToolChars: number;
	maxMessageEntryChars: number;
	maxToolEntryChars: number;
	maxRecentNonUserEntries: number;
}

export interface GuardianConfig {
	enabled: boolean;
	reviewerModel: string;
	reviewerExtensions: readonly string[];
	thinkingLevel: string;
	timeoutMs: number;
	maxAttempts: number;
	maxParallelReviews: number;
	maxConsecutiveDenials: number;
	maxActionChars: number;
	guardianSessionDir: string;
	policyPath: string;
	piCommand?: string;
	exemptTools: ReadonlySet<string>;
	transcript: TranscriptBounds;
}

export interface RenderedTranscript {
	mode: "full" | "delta";
	text: string;
	cursorEntryId?: string;
	omittedEntries: number;
}
