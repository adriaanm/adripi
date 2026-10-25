import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RenderedTranscript, TranscriptBounds } from "./types.ts";

type EntryKind = "user" | "protected" | "message" | "tool";

interface TranscriptItem {
	index: number;
	kind: EntryKind;
	text: string;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "<unserializable value>";
	}
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n<guardian_truncated omitted_chars="${text.length - maxChars}" />`;
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return stringify(content);
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") {
			parts.push(stringify(item));
			continue;
		}
		const value = item as Record<string, unknown>;
		switch (value.type) {
			case "text":
				if (typeof value.text === "string") parts.push(value.text);
				break;
			case "thinking":
				parts.push("<assistant reasoning omitted>");
				break;
			case "toolCall":
				parts.push(`tool call ${String(value.name)} ${stringify(value.arguments)}`);
				break;
			case "image":
				parts.push("<image omitted>");
				break;
			default:
				parts.push(stringify(value));
		}
	}
	return parts.join("\n");
}

function renderMessage(entry: Extract<SessionEntry, { type: "message" }>, index: number): TranscriptItem | undefined {
	const message = entry.message as unknown as Record<string, unknown>;
	const role = message.role;
	if (role === "user") {
		return { index, kind: "user", text: `[${index + 1}] trusted user: ${renderContent(message.content)}` };
	}
	if (role === "assistant") {
		return { index, kind: "message", text: `[${index + 1}] untrusted assistant: ${renderContent(message.content)}` };
	}
	if (role === "toolResult") {
		return {
			index,
			kind: "tool",
			text: `[${index + 1}] untrusted tool result (${String(message.toolName ?? "unknown")}, error=${String(message.isError ?? false)}): ${renderContent(message.content)}`,
		};
	}
	if (role === "bashExecution") {
		return {
			index,
			kind: "tool",
			text: `[${index + 1}] untrusted user-shell record: command=${String(message.command ?? "")}\n${String(message.output ?? "")}`,
		};
	}
	if (role === "custom") {
		return {
			index,
			kind: "message",
			text: `[${index + 1}] untrusted custom message (${String(message.customType ?? "unknown")}): ${renderContent(message.content)}`,
		};
	}
	return undefined;
}

function renderEntry(entry: SessionEntry, index: number): TranscriptItem | undefined {
	switch (entry.type) {
		case "message":
			return renderMessage(entry, index);
		case "compaction":
			return {
				index,
				kind: "protected",
				text: `[${index + 1}] untrusted parent compaction summary: ${entry.summary}`,
			};
		case "branch_summary":
			return {
				index,
				kind: "protected",
				text: `[${index + 1}] untrusted parent branch summary: ${entry.summary}`,
			};
		case "custom_message":
			return {
				index,
				kind: "message",
				text: `[${index + 1}] untrusted extension message (${entry.customType}): ${renderContent(entry.content)}`,
			};
		case "custom":
			// Custom entries are durable extension state and never participate in Pi's model context.
			return undefined;
		case "model_change":
			return {
				index,
				kind: "message",
				text: `[${index + 1}] parent model changed to ${entry.provider}/${entry.modelId}`,
			};
		case "thinking_level_change":
		case "label":
		case "session_info":
			return undefined;
	}
}

function selectWithinBounds(items: TranscriptItem[], bounds: TranscriptBounds): { items: TranscriptItem[]; omitted: number } {
	let messageChars = 0;
	let toolChars = 0;
	let recentNonUser = 0;
	const selected: TranscriptItem[] = [];

	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		const isTool = item.kind === "tool";
		const entryLimit = isTool ? bounds.maxToolEntryChars : bounds.maxMessageEntryChars;
		const text = truncate(item.text, entryLimit);
		if (item.kind !== "user" && recentNonUser >= bounds.maxRecentNonUserEntries) continue;
		if (isTool) {
			if (toolChars + text.length > bounds.maxToolChars) continue;
			toolChars += text.length;
		} else {
			if (messageChars + text.length > bounds.maxMessageChars) continue;
			messageChars += text.length;
		}
		if (item.kind !== "user") recentNonUser++;
		selected.push({ ...item, text });
	}

	selected.sort((left, right) => left.index - right.index);
	return { items: selected, omitted: items.length - selected.length };
}

export function latestUserTurnKey(branch: readonly SessionEntry[]): string {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && (entry.message as { role?: string }).role === "user") return entry.id;
	}
	return branch.at(-1)?.id ?? "session-start";
}

export function renderGuardianTranscript(
	branch: readonly SessionEntry[],
	lastReviewedParentEntryId: string | undefined,
	bounds: TranscriptBounds,
): RenderedTranscript {
	const cursorIndex = lastReviewedParentEntryId
		? branch.findIndex((entry) => entry.id === lastReviewedParentEntryId)
		: -1;
	const mode = lastReviewedParentEntryId && cursorIndex >= 0 ? "delta" : "full";
	const startIndex = mode === "delta" ? cursorIndex + 1 : 0;
	const rendered: TranscriptItem[] = [];
	for (let index = startIndex; index < branch.length; index++) {
		const item = renderEntry(branch[index], index);
		if (item) rendered.push(item);
	}
	const selected = selectWithinBounds(rendered, bounds);
	const body = selected.items.length > 0 ? selected.items.map((item) => item.text).join("\n\n") : "<no new retained transcript entries>";
	const omission = selected.omitted > 0 ? `\n\n<guardian_transcript_entries_omitted count="${selected.omitted}" />` : "";
	return {
		mode,
		text: `${body}${omission}`,
		cursorEntryId: branch.at(-1)?.id,
		omittedEntries: selected.omitted,
	};
}
