import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuardianAction, GuardianParentAction } from "./types.ts";
import { validateExactToolJson } from "./delegated-tool.ts";

export function cloneToolInput(input: Record<string, unknown>): Record<string, unknown> {
	// Ordinary root reviews keep their configured action budget; only the
	// delegated wire/consumer applies its fixed protocol depth/size ceilings.
	validateExactToolJson(input, { bounded: false });
	const serialized = JSON.stringify(input);
	if (serialized === undefined) throw new Error("Tool input could not be serialized");
	return JSON.parse(serialized) as Record<string, unknown>;
}

export function createAction(toolName: string, toolCallId: string, input: Record<string, unknown>, cwd: string): GuardianAction {
	return { tool_name: toolName, tool_call_id: toolCallId, input: cloneToolInput(input), cwd };
}

export function assistantToolCalls(message: unknown): Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }> {
	if (!message || typeof message !== "object") return [];
	const value = message as Record<string, unknown>;
	if (value.role !== "assistant" || value.stopReason === "length" || value.stopReason === "error" || value.stopReason === "aborted" || !Array.isArray(value.content)) return [];
	const calls: Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }> = [];
	for (const item of value.content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (block.type === "toolCall" && typeof block.name === "string" && typeof block.id === "string" &&
			block.arguments !== null && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
			calls.push({ toolName: block.name, toolCallId: block.id, input: block.arguments as Record<string, unknown> });
		}
	}
	return calls;
}

export function findAssistantCursor(branch: readonly SessionEntry[], toolCallId: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (message.content.some(item => Boolean(item) && typeof item === "object" &&
			(item as Record<string, unknown>).type === "toolCall" && (item as Record<string, unknown>).id === toolCallId)) return entry.id;
	}
	return undefined;
}

export interface ActiveToolAction {
	action: GuardianParentAction;
	parentToolCallId?: string;
	sessionId: string;
}

/** The SAME exact nested evidence for root and delegated reviews. No truncation,
 * inferred parents, foreign sessions, cycles or unbounded active chains. */
export function createActionWithParents(options: {
	toolName: string; toolCallId: string; input: Record<string, unknown>; cwd: string;
	parentToolCallId?: string; branch: readonly SessionEntry[];
	activeCalls: ReadonlyMap<string, ActiveToolAction>; sessionId: string;
}): { action: GuardianAction; cursorEntryId: string | undefined } {
	const action = createAction(options.toolName, options.toolCallId, options.input, options.cwd);
	let cursorEntryId = findAssistantCursor(options.branch, options.toolCallId);
	const parents: GuardianParentAction[] = [];
	let parentId = options.parentToolCallId;
	const seen = new Set([options.toolCallId]);
	while (parentId) {
		if (seen.has(parentId)) throw new Error("Nested tool parent chain contains a cycle");
		if (parents.length >= 32) throw new Error("Nested tool parent chain exceeds the exact-action bound");
		seen.add(parentId);
		const parentCursor = findAssistantCursor(options.branch, parentId);
		if (parentCursor) {
			const entry = options.branch.find(entry => entry.id === parentCursor)!;
			const call = assistantToolCalls(entry.type === "message" ? entry.message : undefined).find(call => call.toolCallId === parentId);
			if (!call) throw new Error(`Could not locate parent tool call ${parentId}`);
			parents.unshift({ tool_name: call.toolName, tool_call_id: call.toolCallId, input: cloneToolInput(call.input) });
			cursorEntryId = parentCursor;
			break;
		}
		const parent = options.activeCalls.get(parentId);
		if (!parent || parent.sessionId !== options.sessionId || !parent.parentToolCallId) {
			throw new Error(`Could not locate parent tool call ${parentId} in the active transcript`);
		}
		// The active record can be a full GuardianAction; parent wire records
		// accept only these three fields, never inherited cwd/parent_actions.
		parents.unshift({ tool_name: parent.action.tool_name, tool_call_id: parent.action.tool_call_id, input: cloneToolInput(parent.action.input) });
		parentId = parent.parentToolCallId;
	}
	if (options.parentToolCallId) action.parent_actions = parents;
	return { action, cursorEntryId };
}
