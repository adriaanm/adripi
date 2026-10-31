import { isAbsolute, resolve } from "node:path";
import type { GuardianAction, GuardianParentAction } from "./types.ts";

/** Host-bound audience mirrored from the one child-authority API, never model fields. */
export interface DelegatedToolIdentity {
	readonly parentSessionId: string;
	readonly runId: string;
	readonly agent: string;
	readonly index: number;
	readonly cwd: string;
}

export interface DelegatedToolRequest {
	readonly identity: DelegatedToolIdentity;
	/** Exact GuardianAction JSON, not a summary/hash/path-only substitute. */
	readonly action: string;
	readonly signal?: AbortSignal;
}

export interface DelegatedToolDecision {
	readonly outcome: "allow" | "deny" | "unavailable" | "cancelled";
	readonly rationale?: string;
	readonly terminate?: boolean;
}

export const MAX_DELEGATED_TOOL_CHARS = 64_000;
export const MAX_DELEGATED_TOOL_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

function text(value: unknown, max: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0") || value.length > max) {
		throw new Error(`${label} must be a nonempty bounded string without NUL or surrounding whitespace`);
	}
	return value;
}

function cwd(value: unknown): string {
	const path = text(value, 4096, "Delegated cwd");
	if (!isAbsolute(path) || Buffer.byteLength(path, "utf8") > 4096) throw new Error("Delegated cwd must be an absolute path of at most 4096 bytes");
	return path;
}

/** Exact JSON trees only: stringify must not silently drop fields, invoke a
 * getter/toJSON, change a number or erase reference identity. The optional lock
 * binds delegated SDK execution to the data actually sent for parent review. */
export function validateExactToolJson(root: unknown, { lock = false, bounded = true }: { lock?: boolean; bounded?: boolean } = {}): void {
	const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	const seen = new Set<object>();
	let count = 0, minimumChars = 0;
	while (pending.length) {
		const { value, depth } = pending.pop()!;
		if (bounded && depth > 64) throw new Error("Delegated tool input exceeds 64 levels of nesting");
		count++;
		if (typeof value === "string") minimumChars += value.length;
		if (bounded && (count > MAX_DELEGATED_TOOL_CHARS || minimumChars > MAX_DELEGATED_TOOL_CHARS)) throw new Error("Delegated tool input exceeds the exact JSON tree bound");
		if (value === null || typeof value === "string" || typeof value === "boolean") continue;
		if (typeof value === "number") {
			if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Delegated tool input contains a nonexact JSON number");
			continue;
		}
		if (typeof value !== "object") throw new Error("Delegated tool input contains non-JSON data");
		if (seen.has(value)) throw new Error("Delegated tool input contains a cycle or shared reference");
		seen.add(value);
		if (lock) Object.freeze(value);
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Delegated tool input must contain only plain JSON data");
		const names = Reflect.ownKeys(value);
		if (bounded && names.length + pending.length + count > MAX_DELEGATED_TOOL_CHARS) throw new Error("Delegated tool input exceeds the exact JSON tree bound");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (array && names.length !== value.length + 1) throw new Error("Delegated tool input contains a sparse or decorated array");
		for (const name of names) {
			if (array && name === "length") continue;
			if (typeof name !== "string") throw new Error("Delegated tool input contains a symbol field");
			if (!array) minimumChars += name.length;
			if (bounded && minimumChars > MAX_DELEGATED_TOOL_CHARS) throw new Error("Delegated tool input exceeds the exact JSON tree bound");
			const descriptor = descriptors[name];
			if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Delegated tool input contains a hidden field or accessor");
			if (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length)) throw new Error("Delegated tool input contains a decorated array");
			pending.push({ value: descriptor.value, depth: depth + 1 });
		}
	}
}

function parentAction(value: unknown): GuardianParentAction {
	const action = record(value, "Delegated tool action");
	keys(action, ["tool_name", "tool_call_id", "input"], "Delegated parent action");
	return {
		tool_name: text(action.tool_name, 512, "Delegated tool name"),
		tool_call_id: text(action.tool_call_id, 1024, "Delegated tool call id"),
		input: record(action.input, "Delegated tool input"),
	};
}

/**
 * Parse only at the Guardian authority boundary; the launcher keeps this target opaque.
 * No truncation, cwd/parent substitution, unknown-field filtering or lossy JSON clone.
 */
export function parseDelegatedToolRequest(value: unknown): { identity: DelegatedToolIdentity; action: GuardianAction; signal?: AbortSignal } {
	const request = record(value, "Delegated tool request");
	keys(request, ["identity", "action", "signal"], "Delegated tool request");
	if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new Error("Delegated tool signal must be an AbortSignal");
	const subject = record(request.identity, "Delegated tool identity");
	keys(subject, ["parentSessionId", "runId", "agent", "index", "cwd"], "Delegated tool identity");
	for (const key of ["parentSessionId", "runId", "agent"]) {
		if (typeof subject[key] !== "string" || !ID.test(subject[key])) throw new Error(`Invalid delegated ${key}`);
	}
	if (typeof subject.index !== "number" || !Number.isInteger(subject.index) || subject.index < 0 || subject.index > 4096) throw new Error("Invalid delegated child index");
	const identity: DelegatedToolIdentity = {
		parentSessionId: subject.parentSessionId as string,
		runId: subject.runId as string,
		agent: subject.agent as string,
		index: subject.index,
		cwd: cwd(subject.cwd),
	};
	if (typeof request.action !== "string" || request.action.length > MAX_DELEGATED_TOOL_CHARS || Buffer.byteLength(request.action, "utf8") > MAX_DELEGATED_TOOL_BYTES) {
		throw new Error("Exact delegated tool action exceeds the bounded review budget; nothing was truncated");
	}
	const raw = record(JSON.parse(request.action), "Delegated tool action");
	keys(raw, ["tool_name", "tool_call_id", "input", "cwd", "parent_actions"], "Delegated tool action");
	const action: GuardianAction = { ...parentAction({ tool_name: raw.tool_name, tool_call_id: raw.tool_call_id, input: raw.input }), cwd: cwd(raw.cwd) };
	if (resolve(action.cwd) !== resolve(identity.cwd)) throw new Error("Delegated tool cwd does not match the host-bound child");
	if (raw.parent_actions !== undefined) {
		if (!Array.isArray(raw.parent_actions) || raw.parent_actions.length > 32) throw new Error("Delegated parent actions must be an array of at most 32 actions");
		action.parent_actions = raw.parent_actions.map(parentAction);
		const ids = [action.tool_call_id, ...action.parent_actions.map(item => item.tool_call_id)];
		if (new Set(ids).size !== ids.length) throw new Error("Delegated parent chain contains a cycle or duplicate id");
	}
	validateExactToolJson(action);
	return { identity, action, signal: request.signal as AbortSignal | undefined };
}
