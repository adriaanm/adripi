import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { builtInDenyRules, DEFAULT_ALLOW_RULES, normalizeTool, validateRules } from "./permissions.ts";
import { builtinSandboxDenyRules, validateSandboxRules } from "./sandbox/rules.ts";
import type { GuardianConfig, GuardianPermissions, TranscriptBounds } from "./types.ts";
import type { SandboxExceptionRules } from "./sandbox/types.ts";

const BARE_TOOL = /^[\w-]+$/;

const DEFAULT_TRANSCRIPT: TranscriptBounds = {
	maxMessageChars: 40_000,
	maxToolChars: 40_000,
	maxMessageEntryChars: 8_000,
	maxToolEntryChars: 4_000,
	maxRecentNonUserEntries: 40,
};

interface GuardianConfigFile {
	enabled?: boolean;
	reviewer?: {
		model?: string;
		thinking?: string;
		timeoutMs?: number;
		maxAttempts?: number;
		extensions?: string[];
	};
	maxConsecutiveDenials?: number;
	maxParallelReviews?: number;
	maxActionChars?: number;
	guardianSessionDir?: string;
	policyPath?: string;
	piCommand?: string;
	exemptTools?: string[];
	permissions?: { allow?: string[]; deny?: string[] };
	sandboxExceptions?: { allow?: string[]; defer?: string[]; deny?: string[] };
	transcript?: Partial<TranscriptBounds>;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function nonEmptyString(value: unknown, fallback: string, name: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value.trim();
}

function resolveConfiguredPath(value: string, baseDir: string): string {
	const expanded = expandHome(value);
	return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** Any `scheme:` specifier (npm:, git:, https:, builtin:, file:, …) is not a
 * filesystem path and keeps Pi's own meaning. Only path-shaped entries resolve
 * against the agent directory. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_PATTERN = /^[a-z]:[\\/]/i;

/** Keep package sources and URLs intact; only normalize filesystem paths. */
function resolveReviewerExtension(value: string, baseDir: string): string {
	if (SCHEME_PATTERN.test(value) && !WINDOWS_DRIVE_PATTERN.test(value)) return value;
	return resolveConfiguredPath(value, baseDir);
}

export function loadGuardianConfig(agentDir: string, bundledPolicyPath: string): GuardianConfig {
	const configPath = join(agentDir, "guardian.json");
	let file: GuardianConfigFile = {};
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (error) {
			throw new Error(`Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${configPath} must contain a JSON object`);
		}
		file = parsed as GuardianConfigFile;
	}

	if (file.enabled !== undefined && typeof file.enabled !== "boolean") {
		throw new Error("enabled must be a boolean");
	}

	const transcriptFile = file.transcript ?? {};
	const transcript: TranscriptBounds = {
		maxMessageChars: positiveInteger(
			transcriptFile.maxMessageChars,
			DEFAULT_TRANSCRIPT.maxMessageChars,
			"transcript.maxMessageChars",
		),
		maxToolChars: positiveInteger(
			transcriptFile.maxToolChars,
			DEFAULT_TRANSCRIPT.maxToolChars,
			"transcript.maxToolChars",
		),
		maxMessageEntryChars: positiveInteger(
			transcriptFile.maxMessageEntryChars,
			DEFAULT_TRANSCRIPT.maxMessageEntryChars,
			"transcript.maxMessageEntryChars",
		),
		maxToolEntryChars: positiveInteger(
			transcriptFile.maxToolEntryChars,
			DEFAULT_TRANSCRIPT.maxToolEntryChars,
			"transcript.maxToolEntryChars",
		),
		maxRecentNonUserEntries: positiveInteger(
			transcriptFile.maxRecentNonUserEntries,
			DEFAULT_TRANSCRIPT.maxRecentNonUserEntries,
			"transcript.maxRecentNonUserEntries",
		),
	};

	const sessionDirValue = nonEmptyString(
		file.guardianSessionDir,
		join(agentDir, "guardian-sessions"),
		"guardianSessionDir",
	);
	const policyPathValue = nonEmptyString(file.policyPath, bundledPolicyPath, "policyPath");
	const guardianSessionDir = resolveConfiguredPath(sessionDirValue, agentDir);
	const permissions = loadPermissions(file, agentDir, guardianSessionDir);
	// Bare allow rules are reported as exempt tools for status consumers.
	const exemptTools = permissions.allow.filter((rule) => BARE_TOOL.test(rule)).map(normalizeTool);

	const reviewerExtensions = file.reviewer?.extensions ?? [];
	if (
		!Array.isArray(reviewerExtensions) ||
		reviewerExtensions.some((extension) => typeof extension !== "string" || extension.trim() === "")
	) {
		throw new Error("reviewer.extensions must be an array of non-empty paths or npm: sources");
	}

	return {
		enabled: file.enabled ?? true,
		reviewerModel: nonEmptyString(file.reviewer?.model, "openai-codex/gpt-5.6-luna", "reviewer.model"),
		reviewerExtensions: reviewerExtensions.map((extension) => resolveReviewerExtension(extension.trim(), agentDir)),
		thinkingLevel: nonEmptyString(file.reviewer?.thinking, "low", "reviewer.thinking"),
		timeoutMs: positiveInteger(file.reviewer?.timeoutMs, 90_000, "reviewer.timeoutMs"),
		maxAttempts: positiveInteger(file.reviewer?.maxAttempts, 3, "reviewer.maxAttempts"),
		maxParallelReviews: positiveInteger(file.maxParallelReviews, 4, "maxParallelReviews"),
		maxConsecutiveDenials: positiveInteger(file.maxConsecutiveDenials, 3, "maxConsecutiveDenials"),
		maxActionChars: positiveInteger(file.maxActionChars, 64_000, "maxActionChars"),
		guardianSessionDir,
		policyPath: resolveConfiguredPath(policyPathValue, agentDir),
		piCommand: file.piCommand === undefined ? undefined : nonEmptyString(file.piCommand, "", "piCommand"),
		exemptTools: new Set(exemptTools),
		permissions,
		sandboxExceptions: loadSandboxExceptions(file, agentDir),
		agentDir,
		transcript,
	};
}

/**
 * Built-in denies always apply and user denies add to them. An explicit
 * `permissions.allow` replaces the default allow list; legacy `exemptTools`
 * names become extra bare allow rules.
 */
function loadPermissions(file: GuardianConfigFile, agentDir: string, sessionDir: string): GuardianPermissions {
	const configured = file.permissions;
	if (configured !== undefined) {
		if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
			throw new Error("permissions must be an object with optional allow and deny arrays");
		}
		if (Object.keys(configured).some((key) => key !== "allow" && key !== "deny")) {
			throw new Error("permissions supports only allow and deny (no ask)");
		}
	}
	const legacy = file.exemptTools === undefined ? [] : validateRules(file.exemptTools, "exemptTools");
	if (legacy.some((tool) => !BARE_TOOL.test(tool))) throw new Error("exemptTools must contain bare tool names");

	let allow: string[];
	if (configured?.allow !== undefined) allow = validateRules(configured.allow, "permissions.allow");
	else allow = file.exemptTools === undefined ? DEFAULT_ALLOW_RULES : [];
	const deny = configured?.deny === undefined ? [] : validateRules(configured.deny, "permissions.deny");
	return {
		allow: [...new Set([...allow, ...legacy])],
		deny: [...new Set([...builtInDenyRules(agentDir, sessionDir), ...deny])],
	};
}

/**
 * Sandbox exception rules: user denies add to the always-applied built-in
 * denies (credentials, the agent directory, secret-file writes). Allow rules
 * short-circuit review but never override a deny.
 */
function loadSandboxExceptions(file: GuardianConfigFile, agentDir: string): SandboxExceptionRules {
	const configured = file.sandboxExceptions;
	const allow = validateSandboxRules(configured?.allow, "sandboxExceptions.allow");
	const defer = validateSandboxRules(configured?.defer, "sandboxExceptions.defer");
	const deny = validateSandboxRules(configured?.deny, "sandboxExceptions.deny");
	return { allow, defer, deny: [...new Set([...builtinSandboxDenyRules(agentDir), ...deny])] };
}

export function persistGuardianEnabled(agentDir: string, enabled: boolean): void {
	const configPath = join(agentDir, "guardian.json");
	let file: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (error) {
			throw new Error(`Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${configPath} must contain a JSON object`);
		}
		file = parsed as Record<string, unknown>;
	}
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(configPath, `${JSON.stringify({ ...file, enabled }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
