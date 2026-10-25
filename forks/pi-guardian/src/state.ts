import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	GUARDIAN_STATE_ENTRY,
	STATE_VERSION,
	type GuardianConfig,
	type GuardianStateV1,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function hashAction(value: unknown): string {
	return hashText(JSON.stringify(value));
}

export function isGuardianState(value: unknown): value is GuardianStateV1 {
	if (!isRecord(value)) return false;
	return (
		value.version === STATE_VERSION &&
		typeof value.parentSessionId === "string" &&
		typeof value.guardianSessionId === "string" &&
		typeof value.guardianSessionDir === "string" &&
		typeof value.reviewerModel === "string" &&
		typeof value.thinkingLevel === "string" &&
		typeof value.policyHash === "string" &&
		typeof value.generation === "number" &&
		typeof value.createdAt === "string" &&
		(value.lastReviewedParentEntryId === undefined || typeof value.lastReviewedParentEntryId === "string") &&
		typeof value.reviewCount === "number" &&
		(value.denialTurnKey === undefined || typeof value.denialTurnKey === "string") &&
		typeof value.consecutiveDenials === "number"
	);
}

export function findGuardianState(branch: readonly SessionEntry[]): GuardianStateV1 | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === GUARDIAN_STATE_ENTRY && isGuardianState(entry.data)) {
			return structuredClone(entry.data);
		}
	}
	return undefined;
}

export function stateMatchesConfig(
	state: GuardianStateV1,
	parentSessionId: string,
	config: GuardianConfig,
	policyHash: string,
): boolean {
	return (
		state.parentSessionId === parentSessionId &&
		state.guardianSessionDir === config.guardianSessionDir &&
		state.reviewerModel === config.reviewerModel &&
		state.thinkingLevel === config.thinkingLevel &&
		state.policyHash === policyHash
	);
}

export function createGuardianState(
	parentSessionId: string,
	config: GuardianConfig,
	policyHash: string,
	previousGeneration = 0,
): GuardianStateV1 {
	return {
		version: STATE_VERSION,
		parentSessionId,
		guardianSessionId: randomUUID(),
		guardianSessionDir: config.guardianSessionDir,
		reviewerModel: config.reviewerModel,
		thinkingLevel: config.thinkingLevel,
		policyHash,
		generation: previousGeneration + 1,
		createdAt: new Date().toISOString(),
		reviewCount: 0,
		consecutiveDenials: 0,
	};
}

export function updateDenialState(state: GuardianStateV1, turnKey: string, denied: boolean): GuardianStateV1 {
	const sameTurn = state.denialTurnKey === turnKey;
	return {
		...state,
		denialTurnKey: turnKey,
		consecutiveDenials: denied ? (sameTurn ? state.consecutiveDenials + 1 : 1) : 0,
	};
}
