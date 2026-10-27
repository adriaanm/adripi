import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
	SandboxExceptionRequest,
	SandboxExceptionRules,
	SandboxSurface,
} from "./types.ts";

/** `surface:pattern` — the surface is explicit so a typo cannot widen a rule to
 * every surface. Patterns are matched against the request target only. */
const RULE_PATTERN = /^(command|network|read|write):(.+)$/;

const SURFACES: ReadonlySet<string> = new Set(["command", "network", "read", "write"]);

export interface ParsedSandboxRule {
	surface: SandboxSurface;
	pattern: string;
	text: string;
}

export type SandboxRuleOutcome =
	| { outcome: "deny"; rule: string }
	| { outcome: "defer"; rule: string }
	| { outcome: "allow"; rule: string }
	| { outcome: "review" };

export function parseSandboxRule(text: string): ParsedSandboxRule {
	const match = RULE_PATTERN.exec(text.trim());
	if (!match) {
		throw new Error(
			`Malformed sandbox exception rule: ${text} (expected "<command|network|read|write>:<pattern>")`,
		);
	}
	const surface = match[1] as SandboxSurface;
	if (!SURFACES.has(surface)) throw new Error(`Unknown sandbox surface in rule: ${text}`);
	const pattern = match[2].trim();
	if (pattern === "") throw new Error(`Empty sandbox rule pattern: ${text}`);
	return { surface, pattern, text: `${surface}:${pattern}` };
}

export function validateSandboxRules(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string" || rule.trim() === "")) {
		throw new Error(`${name} must be an array of non-empty rule strings`);
	}
	// Throws on the first malformed rule; validation is fail-closed.
	for (const rule of value) parseSandboxRule(rule);
	return value.map((rule) => rule.trim());
}

/**
 * Always-deny classes for sandbox exceptions. These never reach the reviewer and
 * cannot be granted, whatever the model or the transcript says.
 */
export function builtinSandboxDenyRules(agentDir: string): string[] {
	const secrets = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**"];
	const rules = [
		...secrets.flatMap((pattern) => [`read:${pattern}`, `write:${pattern}`]),
		`read:${agentDir}/**`,
		`write:${agentDir}/**`,
		"write:**/.env",
		"write:**/.env.*",
		"write:**/.git/hooks/**",
		"write:**/*.pem",
		"write:**/*.key",
		"write:**/*.p12",
		"write:**/*.pfx",
	];
	return rules;
}

export function evaluateSandboxRules(
	rules: SandboxExceptionRules,
	request: SandboxExceptionRequest,
	agentDir: string,
): SandboxRuleOutcome {
	const targets = targetSpellings(request);
	if (targets.length === 0) return { outcome: "review" };

	for (const text of [...builtinSandboxDenyRules(agentDir), ...rules.deny]) {
		const rule = parseSandboxRule(text);
		if (rule.surface !== request.surface) continue;
		if (targets.some((target) => matches(rule, target, request))) return { outcome: "deny", rule: rule.text };
	}

	for (const text of rules.defer) {
		const rule = parseSandboxRule(text);
		if (rule.surface !== request.surface) continue;
		if (targets.some((target) => matches(rule, target, request))) return { outcome: "defer", rule: rule.text };
	}

	for (const text of rules.allow) {
		const rule = parseSandboxRule(text);
		if (rule.surface !== request.surface) continue;
		if (targets.some((target) => matches(rule, target, request))) return { outcome: "allow", rule: rule.text };
	}

	return { outcome: "review" };
}

function targetSpellings(request: SandboxExceptionRequest): string[] {
	const target = request.target.trim();
	if (target === "") return [];
	if (request.surface === "network") return [target.toLowerCase()];
	if (request.surface === "command") return [target];
	const expanded = expandHome(target);
	const absolute = isAbsolute(expanded) ? expanded : resolve(request.cwd, expanded);
	// A path may be spelled relative to the cwd; match the absolute form, which
	// is what a rule like `write:~/.gradle/**` is written against.
	return [...new Set([target, absolute])];
}

function matches(rule: ParsedSandboxRule, target: string, request: SandboxExceptionRequest): boolean {
	if (rule.surface === "network" || rule.surface === "command") {
		// Network and command patterns are plain strings: `*` crosses separators.
		return globToRegExp(rule.pattern.toLowerCase(), false).test(target.toLowerCase());
	}
	const pattern = expandHome(rule.pattern);
	const absolutePattern = isAbsolute(pattern) ? pattern : resolve(request.cwd, pattern);
	return globToRegExp(absolutePattern, true).test(target) || globToRegExp(rule.pattern, true).test(target);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function escapeRegex(char: string): string {
	return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Gitignore-style glob when `segmentAware`: `*` and `?` stay within a segment,
 * `**` crosses them. Otherwise `*` crosses everything (hosts, commands). */
export function globToRegExp(pattern: string, segmentAware: boolean): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*" && pattern[index + 1] === "*") {
			index++;
			if (segmentAware && pattern[index + 1] === "/") {
				source += "(?:.*/)?";
				index++;
			} else {
				source += ".*";
			}
		} else if (char === "*") {
			source += segmentAware ? "[^/]*" : ".*";
		} else if (char === "?") {
			source += segmentAware ? "[^/]" : ".";
		} else if (char === "[") {
			const end = pattern.indexOf("]", index + 1);
			if (end < 0 || end === index + 1) throw new Error(`Malformed sandbox rule glob: ${pattern}`);
			const contents = pattern.slice(index + 1, end);
			source += `[${contents.startsWith("!") ? `^${contents.slice(1)}` : contents}]`;
			index = end;
		} else {
			source += escapeRegex(char);
		}
	}
	try {
		return new RegExp(`^${source}$`);
	} catch {
		throw new Error(`Malformed sandbox rule glob: ${pattern}`);
	}
}
