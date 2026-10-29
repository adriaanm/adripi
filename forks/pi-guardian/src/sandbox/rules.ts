import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	canonicalPath,
	isWithinDirectory,
	maintenanceRuleText,
	pathSpellings,
	type MaintenanceAuthority,
} from "../maintenance.ts";
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
 *
 * Exactly one agent-directory file is hidden from reads: the provider
 * credentials. Skills, installed packages, session transcripts, settings and the
 * reviewer configuration are readable, so an ordinary read needs no exception.
 * Writes are different: `liftableSandboxDenyRules` names the broad
 * agent-directory write lock, which a trusted maintenance project may set aside.
 */
export function builtinSandboxDenyRules(
	agentDir: string,
	sessionDir: string = join(agentDir, "guardian-sessions"),
	includeAgentDirLock = true,
): string[] {
	const secrets = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**"];
	const agent = resolve(agentDir);
	const audit = resolve(sessionDir);
	const rules = [
		...secrets.flatMap((pattern) => [`read:${pattern}`, `write:${pattern}`]),
		`read:${join(agent, "auth.json")}`,
		// Credentials and Guardian's own audit trail stay write-denied even for a
		// project that may otherwise maintain the agent directory.
		`write:${join(agent, "auth.json")}`,
		`write:${join(audit, "**")}`,
		...(includeAgentDirLock ? liftableSandboxDenyRules(agentDir) : []),
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

/**
 * The single built-in rule a trusted maintenance project may set aside: the
 * broad agent-directory write lock. Only the built-in spelling is liftable — a
 * user or project deny that repeats this text stays in force — and credentials,
 * the audit trail and the workspace policy directory are separate rules that are
 * never lifted.
 */
export function liftableSandboxDenyRules(agentDir: string): string[] {
	return [`write:${join(resolve(agentDir), "**")}`];
}

/**
 * Per-request built-in: the requesting workspace's own policy directory is
 * mandatory deny-write, so an agent cannot pre-authorize itself. Like pi-sbx's
 * OS-level rule this is never liftable, including through a symlinked `.pi` or a
 * canonical spelling of it.
 */
export function workspaceSandboxDenyRules(cwd: string): string[] {
	return [`write:${join(resolve(cwd), ".pi", "**")}`];
}

export interface SandboxRuleOptions {
	/** Guardian's audit directory, when it is configured away from the default. */
	sessionDir?: string;
	/**
	 * Trusted maintenance authority for `request.cwd`, resolved by the caller from
	 * the *global* `permissions.agentDirWriteProjects` list and the session cwd.
	 * Production brokers bind that cwd to the publishing session; project policy
	 * and model-supplied authority fields never add roots.
	 */
	maintenance?: MaintenanceAuthority;
}

export function evaluateSandboxRules(
	rules: SandboxExceptionRules,
	request: SandboxExceptionRequest,
	agentDir: string,
	options: SandboxRuleOptions = {},
): SandboxRuleOutcome {
	const target = normalizeRequestTarget(request);
	if (!target) return { outcome: "review" };

	// Order is the decision order: hard denies, then defer, then the maintenance
	// grant, then allow, so a project can never erase a built-in deny by adding its
	// own rule. Only the built-in broad agent-directory lock is dropped when a
	// trusted maintenance project holds the authority for this request.
	const builtin = [
		// Omit the broad lock by provenance, not text equality: the audit or
		// workspace rule may legitimately have exactly the same spelling.
		...builtinSandboxDenyRules(agentDir, options.sessionDir, !options.maintenance),
		...workspaceSandboxDenyRules(request.cwd),
	];
	// `restrict` is false for allow rules: permission must cover the whole request,
	// while a restriction may be narrower than an all-port request.
	const restricted = (texts: readonly string[], outcome: "deny" | "defer"): SandboxRuleOutcome | undefined => {
		for (const text of texts) {
			const rule = parseSandboxRule(text);
			if (ruleMatches(rule, target, true, request.cwd)) return { outcome, rule: rule.text };
		}
		return undefined;
	};

	// User and project denies are never lifted, even when they repeat the built-in
	// broad lock's spelling.
	const denied = restricted([...builtin, ...rules.deny], "deny");
	if (denied) return denied;
	const deferred = restricted(rules.defer, "defer");
	if (deferred) return deferred;

	// The grant decides agent-directory reads and writes here, in the rule engine,
	// because the reviewer cannot see which project holds it. Every hard deny and
	// every user/global `defer` above still wins, and the authority never speaks
	// for an unrelated command or network target.
	if (options.maintenance && requestReachesDirectory(request, agentDir)) {
		return { outcome: "allow", rule: maintenanceRuleText(options.maintenance, request.target) };
	}

	for (const text of rules.allow) {
		const rule = parseSandboxRule(text);
		if (ruleMatches(rule, target, false, request.cwd)) return { outcome: "allow", rule: rule.text };
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
 *
 * Only the trusted global project list grants maintenance. A project cannot
 * grant it to itself, but its restrictions still win over that authority.
 */
export function evaluateLayeredSandboxRules(
	project: SandboxExceptionRules | undefined,
	global: SandboxExceptionRules,
	request: SandboxExceptionRequest,
	agentDir: string,
	options: SandboxRuleOptions = {},
): SandboxRuleOutcome {
	const globalFirst = evaluateSandboxRules(global, request, agentDir, options);
	if (globalFirst.outcome === "deny" || globalFirst.outcome === "defer") return globalFirst;
	if (!project) return globalFirst;

	const local = evaluateSandboxRules(project, request, agentDir, options);
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
	return { surface: request.surface, paths: requestPaths(target, request.cwd) };
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
 * A request target as spelled and with symlinks (and the deepest existing
 * ancestor) resolved, so a rule written for either spelling decides it.
 */
function requestPaths(path: string, cwd: string): string[] {
	// `resolve` also folds `.`, `..` and a trailing slash, so an alias spelling
	// of a protected path is decided on the path it actually names.
	return pathSpellings(resolve(cwd, expandHome(path)));
}

/** Whether a read/write request names the directory, under any spelling of it. */
function requestReachesDirectory(request: SandboxExceptionRequest, directory: string): boolean {
	const target = normalizeRequestTarget(request);
	if (!target || (target.surface !== "read" && target.surface !== "write")) return false;
	const directories = pathSpellings(resolve(directory));
	return target.paths.some((path) => directories.some((entry) => isWithinDirectory(entry, path)));
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
	return [...new Set([prefix, canonicalPath(prefix)])].map((spelling) => spelling + rest);
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
