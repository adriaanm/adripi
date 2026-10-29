import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * One network destination: a host plus, when the spelling names one, a port.
 * A bare host and an explicit `:*` both mean every port; a numeric port means
 * that port only.
 */
export interface NetworkEndpoint {
	host: string;
	/** Written as `[...]`, so it is a literal IPv6 address, not a glob class. */
	literalHost: boolean;
	port?: number;
}

interface HostAndPort {
	host: string;
	literalHost: boolean;
	port?: number | "*";
}

/** Characters that make a network spelling non-exact: a glob, URL, path or userinfo. */
const NON_EXACT_HOST = /[\s/\\@?#*\[\],;'"|<>`]/;

/** Bracketed host content that is an IPv6 address rather than a glob class. */
const IPV6_ADDRESS = /^[0-9a-fA-F:.]+$/;

/** A shell operator, substitution or redirection that turns one command into more. */
const SHELL_METACHARACTERS = /[;&|<>`$\n\r]/;

/**
 * Commands that run code named later on the line, so approving one approves
 * arbitrary execution. Mirrors pi-sbx's host-command eligibility; the sandbox
 * enforces that first, this is the reviewer-side backstop.
 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
	"sh", "bash", "zsh", "dash", "ksh", "fish",
	"eval", "exec", "source", ".", "command", "builtin",
	"env", "sudo", "doas", "xargs", "nohup", "find",
	"timeout", "gtimeout", "nice", "stdbuf", "setsid", "chroot", "watch",
	"python", "python2", "python3", "node", "nodejs", "deno", "bun",
	"perl", "ruby", "awk", "php", "lua", "rscript", "osascript",
]);

const GLOB_CHARACTERS = /[*?[]/;

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
	// `command:git pull:` is the natural way to write "this command with any
	// arguments", but a bare trailing colon is a literal that matches nothing —
	// exactly the silent no-op users hit. Demand the `:*` spelling.
	if (surface === "command" && pattern.endsWith(":")) {
		throw new Error(
			`Malformed sandbox exception rule: ${text} (a command prefix rule ends with ":*", not ":", so it matches the command plus its arguments)`,
		);
	}
	// A network rule whose port cannot be read would match nothing at all, so say
	// so instead of shipping a rule that silently never fires. Globs stay legal in
	// the host; only the port says how wide the rule is.
	if (surface === "network" && !splitHostAndPort(pattern)) {
		throw new Error(
			`Malformed sandbox exception rule: ${text} (a network rule is "<host>", "<host>:*" or "<host>:<1-65535>"; bracket IPv6 and globs are allowed in the host)`,
		);
	}
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
		// A repo config can point core.fsmonitor/core.editor at an arbitrary
		// command, which is RCE-equivalent to a hook.
		"write:**/.git/config",
		"write:**/.git/HEAD",
		// A host-command exception must never be a way to run a second command or
		// an interpreter. The sandbox refuses these shapes too; this is the
		// reviewer-side backstop, and none of them can ever be granted.
		"command:*;*",
		"command:*&&*",
		"command:*||*",
		"command:*|*",
		"command:*>*",
		"command:*<*",
		"command:*$(*",
		"command:*`*",
		"command:sh *",
		"command:bash *",
		"command:zsh *",
		"command:dash *",
		"command:ksh *",
		"command:fish *",
		"command:eval *",
		"command:exec *",
		"command:source *",
		"command:env *",
		"command:sudo *",
		"command:doas *",
		"command:xargs *",
		"command:nohup *",
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
	const target = normalizeRequestTarget(request);
	if (!target) return { outcome: "review" };

	// Order is the decision order: hard denies, then defer, then allow. A project
	// can therefore never erase a built-in deny by adding its own rule.
	const ordered: { text: string; outcome: "deny" | "defer" | "allow" }[] = [
		...[...builtinSandboxDenyRules(agentDir), ...rules.deny].map((text) => ({ text, outcome: "deny" as const })),
		...rules.defer.map((text) => ({ text, outcome: "defer" as const })),
		...rules.allow.map((text) => ({ text, outcome: "allow" as const })),
	];

	for (const candidate of ordered) {
		const rule = parseSandboxRule(candidate.text);
		// `restrict` is false for allow rules: permission must cover the whole
		// request, while a restriction may be narrower than an all-port request.
		if (!ruleMatches(rule, target, candidate.outcome !== "allow", request.cwd)) continue;
		return { outcome: candidate.outcome, rule: rule.text };
	}

	return { outcome: "review" };
}

/**
 * Layered decision for a request that may also have standing project rules
 * (`<workspace>/.pi/guardian.json`).
 *
 * Precedence, tightest restriction first: the global hard denies and global
 * `defer`s always win, so a project can never erase a global restriction; then
 * the project's own deny/defer; then the project's `allow` (the point of the
 * feature: pre-authorize this project's workflow); then the global `allow`; and
 * only then the reviewer.
 */
export function evaluateLayeredSandboxRules(
	project: SandboxExceptionRules | undefined,
	global: SandboxExceptionRules,
	request: SandboxExceptionRequest,
	agentDir: string,
): SandboxRuleOutcome {
	const globalFirst = evaluateSandboxRules(global, request, agentDir);
	if (globalFirst.outcome === "deny" || globalFirst.outcome === "defer") return globalFirst;
	if (!project) return globalFirst;

	const local = evaluateSandboxRules(project, request, agentDir);
	if (local.outcome !== "review") {
		return local.outcome === "deny" || local.outcome === "defer"
			? local
			: { outcome: "allow", rule: local.rule };
	}
	return globalFirst;
}

/**
 * Admit one request target before any rule or the reviewer sees it. A request
 * promises one exact capability; a wildcard, URL, relative path, multi-line
 * command or wrapper command would promise more than the grant can name, so it
 * is refused here rather than narrowed afterwards.
 */
export function sandboxTargetProblem(request: SandboxExceptionRequest): string | undefined {
	const target = request.target.trim();
	if (target === "") return "the target is empty";
	if (/[\u0000-\u001f\u007f]/.test(target)) {
		return "the target contains a newline or control character";
	}
	if (request.surface === "network") {
		if (parseNetworkTarget(target)) return undefined;
		return 'a network target is one exact host with an optional port ("host", "host:*" or "host:443", bracketed for IPv6); wildcards, URLs and paths are not grantable per destination';
	}
	if (request.surface === "command") return commandTargetProblem(target);
	return pathTargetProblem(target);
}

/**
 * Read one exact network request target. Undefined when the spelling is not a
 * single destination: a glob, URL, path, userinfo or out-of-range port. An
 * unbracketed IPv6 spelling is also refused: it is indistinguishable from
 * `host:port`, and the runtime's allowlist only accepts bracketed literals, so
 * a grant for it could not be enforced as named.
 */
export function parseNetworkTarget(target: string): NetworkEndpoint | undefined {
	const split = splitHostAndPort(target);
	if (!split) return undefined;
	if (split.host.includes(":") && !split.literalHost) return undefined;
	if (NON_EXACT_HOST.test(split.host)) return undefined;
	return {
		host: split.host.toLowerCase(),
		literalHost: split.literalHost,
		...(split.port === undefined || split.port === "*" ? {} : { port: split.port }),
	};
}

/**
 * Split `host[:port]` without guessing a suffix off an address. A bracketed IPv6
 * literal keeps its address intact, and an unbracketed value with two or more
 * colons is a bare IPv6 address whose colons all belong to the address. The port
 * must be `*` (every port) or 1-65535; anything else is malformed, not "no port".
 */
function splitHostAndPort(value: string): HostAndPort | undefined {
	const text = value.trim();
	if (text === "") return undefined;
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		if (end > 0) {
			const host = text.slice(1, end);
			if (IPV6_ADDRESS.test(host) && host.includes(":")) {
				const rest = text.slice(end + 1);
				if (rest === "") return { host, literalHost: true };
				if (rest.startsWith(":")) {
					const port = portSuffix(rest.slice(1));
					if (port !== undefined) return { host, literalHost: true, port };
				}
				return undefined;
			}
		}
		// Not an address literal: fall through so `[ab].example` stays a host glob.
	}
	const colons = text.split(":").length - 1;
	if (colons === 0) return { host: text, literalHost: false };
	if (colons === 1) {
		const index = text.indexOf(":");
		const host = text.slice(0, index);
		const port = portSuffix(text.slice(index + 1));
		if (host === "" || port === undefined) return undefined;
		return { host, literalHost: false, port };
	}
	// Two or more colons without brackets: an IPv6 address, so no port suffix.
	if (!IPV6_ADDRESS.test(text)) return undefined;
	return { host: text, literalHost: false };
}

function portSuffix(value: string): number | "*" | undefined {
	if (value === "*") return "*";
	if (!/^\d{1,5}$/.test(value)) return undefined;
	const port = Number(value);
	return port >= 1 && port <= 65535 ? port : undefined;
}

/** A filesystem request target is one exact absolute or home-relative path. */
function pathTargetProblem(target: string): string | undefined {
	if (target !== "~" && !target.startsWith("/") && !target.startsWith("~/")) {
		return 'a filesystem target is one exact absolute path (or "~/…"), not a relative path or glob';
	}
	if (GLOB_CHARACTERS.test(target)) {
		return "a filesystem target is one exact path; wildcards belong in rules, not requests";
	}
	return undefined;
}

/**
 * A command request target is one plain invocation. A second command, a
 * substitution, a redirection, an environment assignment or an interpreter
 * prefix would all turn the approved string into arbitrary execution.
 */
function commandTargetProblem(command: string): string | undefined {
	if (SHELL_METACHARACTERS.test(command)) {
		return "a command target is one command line with no shell operators, substitutions or redirections";
	}
	const head = command.split(/\s+/)[0] ?? "";
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
		return "a command target cannot start with an environment assignment";
	}
	// A path-qualified wrapper (`/bin/sh`) is the same wrapper as the bare name.
	const name = head.slice(head.lastIndexOf("/") + 1).toLowerCase();
	if (WRAPPER_COMMANDS.has(name)) {
		return `\`${name}\` is an interpreter or wrapper, so it can run code the exception never named; ask for the concrete command instead`;
	}
	return undefined;
}

/** The request side of a rule match, normalized once per request. */
type NormalizedTarget =
	| { surface: "network"; endpoint: NetworkEndpoint }
	| { surface: "command"; command: string }
	| { surface: "read" | "write"; paths: string[] };

function normalizeRequestTarget(request: SandboxExceptionRequest): NormalizedTarget | undefined {
	const target = request.target.trim();
	if (target === "") return undefined;
	if (request.surface === "network") {
		const endpoint = parseNetworkTarget(target);
		return endpoint ? { surface: "network", endpoint } : undefined;
	}
	if (request.surface === "command") return { surface: "command", command: target };
	return { surface: request.surface, paths: pathSpellings(target, request.cwd) };
}

/**
 * Whether one rule covers (`restrict: false`) or overlaps (`restrict: true`) the
 * request target.
 */
function ruleMatches(
	rule: ParsedSandboxRule,
	target: NormalizedTarget,
	restrict: boolean,
	cwd: string,
): boolean {
	if (target.surface === "network") {
		return rule.surface === "network" && networkPatternMatches(rule.pattern, target.endpoint, restrict);
	}
	if (target.surface === "command") {
		return rule.surface === "command" && commandPatternMatches(rule.pattern, target.command);
	}
	if (rule.surface !== target.surface) return false;
	const expanded = expandHome(rule.pattern);
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const patterns = patternSpellings(absolute);
	// Built-in and user rules spell "anywhere" as `**/…`. Anchor that spelling at
	// the filesystem root as well as at the request cwd, so a class such as
	// `write:**/.env` does not depend on the project the agent happens to be in.
	if (!isAbsolute(expanded) && expanded.startsWith("**/")) {
		patterns.push(...patternSpellings(`/${expanded}`));
	}
	const candidates = [...new Set(patterns)];
	return candidates.some((pattern) => target.paths.some((path) => pathMatches(pattern, path)));
}

/**
 * Host globs are case-insensitive and may be written portless, `host:*` or
 * `host:<port>`. A portless target asks for every port: that satisfies an
 * all-port rule, includes a port-specific deny/defer, and never satisfies a
 * port-specific allow.
 */
function networkPatternMatches(pattern: string, target: NetworkEndpoint, restrict: boolean): boolean {
	const rule = splitHostAndPort(pattern);
	if (!rule) return false;
	const ruleHost = rule.host.toLowerCase();
	const hostMatches = rule.literalHost
		? ruleHost === target.host
		: globToRegExp(ruleHost, false).test(target.host);
	if (!hostMatches) return false;
	if (rule.port === undefined || rule.port === "*") return true;
	if (target.port !== undefined) return rule.port === target.port;
	return restrict;
}

/**
 * Command patterns are compared byte for byte after the prefix split: an
 * argument can be a tag, a branch or a path, so lowercasing the target would
 * make `-t MyApp` match `-t myapp`.
 */
function commandPatternMatches(pattern: string, command: string): boolean {
	// `prefix:*` means "this command with any arguments", the same spelling
	// pi-sbx uses for excluded commands. The space check keeps `git push:*` from
	// matching `git pusher`, which a bare glob would.
	if (pattern.endsWith(":*")) {
		const prefix = pattern.slice(0, -2).trim();
		return command === prefix || command.startsWith(`${prefix} `);
	}
	// Otherwise plain glob: `*` crosses separators.
	return globToRegExp(pattern, false).test(command);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Resolve symlinks in the deepest existing ancestor too, so a path reached
 * through a symlinked directory matches a rule written for the real one.
 */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return path;
		const name = path.slice(parent.length + (parent === "/" ? 0 : 1));
		return join(canonical(parent), name);
	}
}

function pathSpellings(path: string, cwd: string): string[] {
	// `resolve` also folds `.`, `..` and a trailing slash, so an alias spelling
	// of a protected path is decided on the path it actually names.
	const absolute = resolve(cwd, expandHome(path));
	return [...new Set([absolute, canonical(absolute)])];
}

/** The literal directory part of a glob pattern, used to resolve symlinks. */
function nonGlobPrefix(pattern: string): string {
	const index = pattern.search(GLOB_CHARACTERS);
	const prefix = index < 0 ? pattern : pattern.slice(0, index);
	return prefix.replace(/\/$/, "") || "/";
}

function patternSpellings(pattern: string): string[] {
	const prefix = nonGlobPrefix(pattern);
	const rest = pattern.slice(prefix.length);
	return [...new Set([prefix, canonical(prefix)])].map((spelling) => spelling + rest);
}

function pathMatches(pattern: string, path: string): boolean {
	if (globToRegExp(pattern, true).test(path)) return true;
	// `dir/**` also covers `dir` itself: a protected directory root must not be
	// reachable just because the rule was written for its descendants.
	return pattern.endsWith("/**") && path === pattern.slice(0, -3);
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
