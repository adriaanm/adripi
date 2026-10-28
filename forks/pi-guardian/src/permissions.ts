import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardianPermissions } from "./types.ts";

export type PermissionDecision = { outcome: "allow" | "deny"; rule: string } | { outcome: "review" };

interface Rule {
	text: string;
	tool: string;
	specifier?: string;
}

interface ParsedCommand {
	commands: string[];
	parseable: boolean;
}

interface ToolCall {
	tool: string;
	serializedInput: string;
	command?: ParsedCommand;
	paths: string[];
	cwd: string;
	agentDir: string;
}

export const DEFAULT_ALLOW_RULES = ["Read", "Grep", "Find", "Ls", "tool_search"];

// Claude Code tool names that differ from Pi's.
const TOOL_ALIASES: Record<string, string> = { multiedit: "edit", glob: "find" };
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const DIRECTORY_TOOLS = new Set(["grep", "find", "ls"]);
const READ_ONLY_PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const RULE_PATTERN = /^([\w-]+(?:__\*)?)(?:\(([\s\S]+)\))?$/;
const MCP_TOOL_PATTERN = /^mcp__\w+(?:__\w+|__\*)?$/;
const SHELL_KEYWORD = /^(?:if|then|else|fi|for|while|until|do|done|case|function)\b/;

export function normalizeTool(tool: string): string {
	let name = tool.toLowerCase();
	// Pi replaces "-" with "_" in MCP server and tool names.
	if (name.startsWith("mcp__")) name = name.replaceAll("-", "_");
	return TOOL_ALIASES[name] ?? name;
}

function parseRule(text: string): Rule {
	const match = RULE_PATTERN.exec(text);
	if (!match) throw new Error(`Malformed permission rule: ${text}`);
	const tool = normalizeTool(match[1]);
	const specifier = match[2];
	if ((tool.includes("*") || tool.startsWith("mcp__")) && !MCP_TOOL_PATTERN.test(tool)) {
		throw new Error(`Malformed MCP permission rule: ${text}`);
	}
	if (specifier !== undefined) validateSpecifier(text, tool, specifier);
	return { text, tool, specifier };
}

function validateSpecifier(text: string, tool: string, specifier: string): void {
	if (!PATH_TOOLS.has(tool) && !SHELL_TOOLS.has(tool)) {
		throw new Error(`Unsupported specifier in permission rule: ${text}`);
	}
	if (!specifier.trim() || specifier.includes("\0")) throw new Error(`Malformed permission rule: ${text}`);
	if (PATH_TOOLS.has(tool)) {
		if (specifier.startsWith("!") || specifier.includes("\\")) {
			throw new Error(`Unsupported path pattern in permission rule: ${text}`);
		}
		// Compile now so a bad bracket expression is a config error, which fails closed.
		globRegex(specifier);
	} else if (specifier.includes(":*") && !specifier.endsWith(":*")) {
		throw new Error(`Command prefix :* must end permission rule: ${text}`);
	}
}

export function validateRules(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string")) {
		throw new Error(`${name} must be an array of permission rule strings`);
	}
	for (const rule of value) parseRule(rule);
	return value;
}

/**
 * Self-protection rules that config cannot remove, in a stable order. The agent
 * may not change anything Pi or Guardian loads: the agent dir (`~/.pi/agent`
 * unless PI_CODING_AGENT_DIR moves it), the Guardian session dir, and Guardian's
 * own package. Reads stay open — skills, transcripts, configuration, Guardian's
 * own audit trail — except for provider credentials.
 */
export function builtInDenyRules(agentDir: string, sessionDir: string): string[] {
	const packageDir = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
	const absolute = (path: string) => `/${resolve(path)}`;
	const directories = [...new Set([agentDir, sessionDir, packageDir].map(absolute))];
	return [
		...directories.map((directory) => `Edit(${directory}/**)`),
		`Read(${absolute(join(agentDir, "auth.json"))})`,
	];
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// Resolve symlinks in the deepest existing ancestor too, so a new file inside a
// symlinked directory still matches rules written for the link's target.
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

function pathSpellings(path: string): string[] {
	return [...new Set([path, canonical(path)])];
}

function escapeRegex(char: string): string {
	return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Gitignore-style glob: `*` and `?` stay within a segment, `**` crosses them. */
function globRegex(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			i++;
			if (pattern[i + 1] === "/") {
				source += "(?:.*/)?";
				i++;
			} else {
				source += ".*";
			}
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "[") {
			const end = pattern.indexOf("]", i + 1);
			if (end < 0 || end === i + 1) throw new Error(`Malformed path glob: ${pattern}`);
			const contents = pattern.slice(i + 1, end);
			source += `[${contents.startsWith("!") ? `^${contents.slice(1)}` : contents}]`;
			i = end;
		} else {
			source += escapeRegex(char);
		}
	}
	try {
		return new RegExp(`^${source}$`);
	} catch {
		throw new Error(`Malformed path glob: ${pattern}`);
	}
}

/**
 * Claude Code anchors: `//abs` is absolute, `~/` is home, `/x` is relative to the
 * agent dir (Claude uses the settings file's directory), anything else is relative
 * to the cwd and, like gitignore, a bare name matches at any depth.
 */
function resolvePattern(specifier: string, cwd: string, agentDir: string, deny: boolean): string {
	if (specifier.startsWith("//")) return resolve("/", specifier.slice(2));
	if (specifier === "~" || specifier.startsWith("~/")) return resolve(expandHome(specifier));
	if (specifier.startsWith("/")) return resolve(agentDir, specifier.slice(1));
	let relative = specifier.replace(/^\.\//, "");
	// A single-directory deny such as `secrets/**` also applies at any depth.
	if (!relative.includes("/") || (deny && /^[^/]+\/\*\*$/.test(relative))) relative = `**/${relative}`;
	return resolve(cwd, relative);
}

function nonGlobPrefix(pattern: string): string {
	const index = pattern.search(/[*?[]/);
	const prefix = index < 0 ? pattern : pattern.slice(0, index);
	return prefix.replace(/\/$/, "") || "/";
}

/** The pattern with its literal prefix spelled both as written and with symlinks resolved. */
function patternSpellings(pattern: string): string[] {
	const prefix = nonGlobPrefix(pattern);
	const rest = pattern.slice(prefix.length);
	return pathSpellings(prefix).map((spelling) => spelling + rest);
}

function patternMatches(pattern: string, path: string): boolean {
	if (globRegex(pattern).test(path)) return true;
	return pattern.endsWith("/**") && path === pattern.slice(0, -3);
}

/** Whether searching from `root` could reach some path the pattern matches. */
function couldMatchDescendant(pattern: string, root: string): boolean {
	const patternParts = pattern.split("/").filter(Boolean);
	const rootParts = root.split("/").filter(Boolean);
	const visit = (p: number, r: number): boolean => {
		if (r === rootParts.length) return true;
		if (p === patternParts.length) return false;
		if (patternParts[p] === "**") return visit(p + 1, r) || visit(p, r + 1);
		return globRegex(patternParts[p]).test(rootParts[r]) && visit(p + 1, r + 1);
	};
	return visit(0, 0);
}

function toolMatches(rule: Rule, tool: string): boolean {
	if (rule.tool.startsWith("mcp__")) {
		if (rule.tool.endsWith("__*")) return tool.startsWith(rule.tool.slice(0, -1));
		// `mcp__server` covers every tool of that server.
		if (!rule.tool.slice("mcp__".length).includes("__")) return tool.startsWith(`${rule.tool}__`);
	}
	// As in Claude Code, Edit rules cover every file-writing tool.
	return rule.tool === tool || (rule.tool === "edit" && tool === "write");
}

/**
 * Split a shell command into simple commands. This is a conservative scanner, not a
 * shell parser: anything it doesn't fully understand is marked unparseable, which
 * disables allow rules and leaves the call to the reviewer. Subshells and command
 * substitutions are split out so deny rules still see their contents.
 */
export function splitCommands(command: string): ParsedCommand {
	const commands: string[] = [];
	let buffer = "";
	let quote = "";
	let depth = 0;
	let parseable = true;
	const flush = () => {
		if (buffer.trim()) commands.push(buffer.trim());
		buffer = "";
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === "\\" && quote !== "'") {
			i++;
			if (i >= command.length) parseable = false;
			buffer += char + (command[i] ?? "");
			continue;
		}
		if (quote === "'") {
			buffer += char;
			if (char === "'") quote = "";
			continue;
		}
		if (char === "`") {
			parseable = false;
			flush();
			const end = command.indexOf("`", i + 1);
			if (end < 0) {
				buffer += command.slice(i + 1);
				break;
			}
			commands.push(...splitCommands(command.slice(i + 1, end)).commands);
			i = end;
			continue;
		}
		if ((char === "$" && command[i + 1] === "(") || (char === "(" && !quote)) {
			parseable = false;
			flush();
			if (char === "$") i++;
			depth++;
			quote = "";
			continue;
		}
		if (char === ")" && !quote) {
			flush();
			depth--;
			if (depth < 0) parseable = false;
			continue;
		}
		if (char === '"' || char === "'") {
			if (!quote) quote = char;
			else if (quote === char) quote = "";
			buffer += char;
			continue;
		}
		if (!quote && /[&|;\n]/.test(char)) {
			// An operator with nothing before it, such as a leading `;`.
			if (!buffer.trim() && !/[&|]/.test(command[i - 1] ?? "")) parseable = false;
			flush();
			const next = command[i + 1];
			if (next === char || (char === "|" && next === "&")) i++;
			continue;
		}
		// Redirections, comments, and brace groups aren't modeled.
		if (!quote && /[<>#{}]/.test(char)) parseable = false;
		buffer += char;
	}
	flush();

	if (quote || depth !== 0 || /(?:&&|\|\||\|)\s*$/.test(command) || commands.length === 0) parseable = false;
	if (commands.some((part) => SHELL_KEYWORD.test(part))) parseable = false;
	return { commands, parseable };
}

/** `Bash(cmd)` is exact; `Bash(cmd:*)` matches `cmd` and `cmd <args>`. */
function commandMatches(specifier: string | undefined, command: string): boolean {
	if (specifier === undefined || specifier === "*") return true;
	if (!specifier.endsWith(":*")) return command === specifier;
	const prefix = specifier.slice(0, -2);
	return command === prefix || command.startsWith(`${prefix} `) || command.startsWith(`${prefix}\t`);
}

function callPaths(tool: string, input: Record<string, unknown>, cwd: string): string[] {
	if (!PATH_TOOLS.has(tool)) return [];
	const path = typeof input.path === "string" ? input.path : undefined;
	// Directory tools search the cwd when no path is given.
	if (path === undefined && !DIRECTORY_TOOLS.has(tool)) return [];
	return pathSpellings(resolve(cwd, expandHome(path ?? cwd)));
}

/**
 * Guardian addition: deny any call whose input mentions the rule's literal path,
 * so `bash cat ~/.codex/auth.json` or a codemode script can't sidestep `Read(...)`.
 * Plain substring matching; obfuscation can evade it, and the reviewer remains the backstop.
 */
function inputMentionsRulePath(specifier: string, call: ToolCall): boolean {
	const raw = nonGlobPrefix(specifier);
	if (raw === "/") return false;
	let literal: string;
	if (specifier.startsWith("//")) literal = resolve("/", raw.slice(2));
	else if (specifier.startsWith("/")) literal = resolve(call.agentDir, raw.slice(1));
	else literal = resolve(call.cwd, expandHome(raw));
	if (literal === "/") return false;
	const literals = [literal, canonical(literal)];
	// A shell can name a path under home without spelling out the home directory.
	const home = homedir();
	if (literal.startsWith(`${home}/`)) {
		const rest = literal.slice(home.length + 1);
		literals.push(`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`);
	}
	// The literal must end at a path boundary, so `/root/.pi` doesn't match `/root/.pip`.
	return literals.some((value) => new RegExp(`${escapeRegex(value)}(?![\\w.-])`).test(call.serializedInput));
}

function pathRuleDenies(rule: Rule, specifier: string, call: ToolCall): boolean {
	const patterns = patternSpellings(resolvePattern(specifier, call.cwd, call.agentDir, true));
	const matchesPath = (path: string) => patterns.some((pattern) => patternMatches(pattern, path));
	if (toolMatches(rule, call.tool) && call.paths.some(matchesPath)) return true;
	// Read-only file tools may look at files that are only protected from edits.
	const editRule = rule.tool === "edit" || rule.tool === "write";
	if (editRule && READ_ONLY_PATH_TOOLS.has(call.tool) && call.paths.length > 0) return false;
	// Guardian addition: a recursive search from an ancestor could reach a read-denied file.
	const reachesPath = (root: string) => patterns.some((pattern) => couldMatchDescendant(pattern, root));
	if (DIRECTORY_TOOLS.has(call.tool) && call.paths.some(reachesPath)) return true;
	// write/edit access exactly their `path`; the payload is data, not an access.
	// Without this, a document that merely mentions a protected path (a README
	// explaining the sandbox, say) could never be edited.
	if (call.tool === "write" || call.tool === "edit") return false;
	return inputMentionsRulePath(specifier, call);
}

function denies(rule: Rule, call: ToolCall): boolean {
	if (rule.specifier !== undefined && PATH_TOOLS.has(rule.tool)) return pathRuleDenies(rule, rule.specifier, call);
	if (!toolMatches(rule, call.tool)) return false;
	if (rule.specifier === undefined) return true;
	// A shell deny matches if any simple command in the line matches.
	return call.command?.commands.some((part) => commandMatches(rule.specifier, part)) ?? false;
}

function allows(rule: Rule, call: ToolCall): boolean {
	if (!toolMatches(rule, call.tool)) return false;
	if (rule.specifier === undefined) return true;
	if (!PATH_TOOLS.has(rule.tool) || call.paths.length === 0) return false;
	const patterns = patternSpellings(resolvePattern(rule.specifier, call.cwd, call.agentDir, false));
	return call.paths.every((path) => patterns.some((pattern) => patternMatches(pattern, path)));
}

/** A shell allow needs every simple command covered, by the same rule or different ones. */
function shellAllowRule(allow: Rule[], call: ToolCall): Rule | undefined {
	const command = call.command;
	if (!command?.parseable) return undefined;
	const coveringRule = (part: string) =>
		allow.find((rule) => toolMatches(rule, call.tool) && commandMatches(rule.specifier, part));
	if (!command.commands.every((part) => coveringRule(part))) return undefined;
	return coveringRule(command.commands[0]);
}

/** Deny rules win, then allow rules; anything unmatched goes to the reviewer. */
export function evaluatePermissions(
	permissions: GuardianPermissions,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	agentDir: string,
): PermissionDecision {
	let serializedInput: string;
	try {
		serializedInput = JSON.stringify(input);
	} catch {
		return { outcome: "review" };
	}
	const tool = normalizeTool(toolName);
	const call: ToolCall = {
		tool,
		serializedInput,
		command: typeof input.command === "string" ? splitCommands(input.command) : undefined,
		paths: callPaths(tool, input, cwd),
		cwd,
		agentDir,
	};

	// A project root listed in permissions.agentDirWriteProjects may maintain the
	// agent directory (that is how the repo installing this stack keeps its own
	// profile). Only the directory-wide edit lock is lifted; credentials and
	// every user deny still apply.
	// The file tools on that directory are decided here, not by the reviewer.
	const writable = (permissions.agentDirWriteProjects ?? []).some((root) => {
		const rel = relative(resolve(root), resolve(cwd));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	});
	const baseAgentDir = `/${resolve(agentDir)}`;
	const lifted = new Set([`Edit(${baseAgentDir}/**)`]);
	if (writable) {
		// Maintaining the profile never includes touching provider credentials or
		// rewriting Guardian's own audit trail.
		for (const text of [`Edit(${baseAgentDir}/auth.json)`, `Edit(${baseAgentDir}/guardian-sessions/**)`]) {
			if (denies(parseRule(text), call)) return { outcome: "deny", rule: text };
		}
	}
	for (const text of permissions.deny) {
		if (writable && lifted.has(text)) continue;
		if (denies(parseRule(text), call)) return { outcome: "deny", rule: text };
	}
	// The workspace's own policy directory is never agent-writable: a project
	// could otherwise pre-authorize itself. pi-sbx enforces this at the OS level;
	// this is the reviewer-independent backstop.
	const projectPolicyDir = join(resolve(cwd), ".pi");
	if ((call.tool === "write" || call.tool === "edit") &&
		call.paths.some((path) => path === projectPolicyDir || path.startsWith(`${projectPolicyDir}/`))) {
		return { outcome: "deny", rule: `Edit(${projectPolicyDir}/**)` };
	}
	// A granted project maintains the profile with the file tools. Decide it here
	// rather than falling through to "review": the reviewer cannot see which
	// project holds the grant, so it would deny the maintenance path itself.
	const agentDirPath = resolve(agentDir);
	if (writable && (call.tool === "read" || call.tool === "write" || call.tool === "edit") &&
		call.paths.some((path) => path === agentDirPath || path.startsWith(`${agentDirPath}/`))) {
		return { outcome: "allow", rule: `agentDirWriteProjects(${call.paths[0]})` };
	}
	const allow = permissions.allow.map(parseRule);
	const rule = SHELL_TOOLS.has(tool) ? shellAllowRule(allow, call) : allow.find((candidate) => allows(candidate, call));
	return rule ? { outcome: "allow", rule: rule.text } : { outcome: "review" };
}
