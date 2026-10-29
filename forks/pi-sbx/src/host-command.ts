import { basename } from "node:path";

/**
 * Eligibility for running one exact command on the host.
 *
 * Host execution is the reviewed full-host tier: the host's credential helper
 * and host services become reachable, so one approval must not turn into
 * arbitrary execution. The gate is shared by the only remaining host route and
 * runs before the broker reviewer or the human is asked.
 *
 * Safety comes from shape, not from trusting the reviewer alone:
 *   1. one plain command line — no newlines, chaining, redirection, pipes,
 *      substitution or quoting tricks;
 *   2. a known executable, not an interpreter or wrapper that turns its
 *      arguments into another program (including absolute and quoted spellings,
 *      because `/bin/sh` and `'bash'` are the same executable);
 *   3. a proposed `prefix_rule` must be a true categorical prefix of the
 *      command being approved, so an unrelated rule cannot be saved.
 */

export interface HostCommand {
  /** The trimmed command line that was checked. */
  command: string;
  /** Shell words with quotes and escapes removed. */
  argv: string[];
  /** Canonical executable name: basename, lowercased, no `.exe`. */
  executable: string;
}

export type HostCommandCheck =
  | { ok: true; command: HostCommand }
  | { ok: false; reason: string };

export type PrefixRuleCheck =
  | { ok: true; pattern?: string }
  | { ok: false; reason: string };

/**
 * Executables that run another program or arbitrary code from their arguments.
 * A host exception is for host *capabilities* (credentials, devices, services),
 * never for "run this string". This is a shape gate, not a capability policy:
 * package managers and container CLIs can still run code, which is why the
 * broader host-capability question stays an explicit closing-interview topic.
 */
const BANNED_EXECUTABLES = new Set([
  // shells and shell builtins
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "csh", "tcsh", "fish",
  "busybox", "eval", "exec", "source", ".", "command", "builtin",
  // launchers, wrappers and schedulers
  "env", "sudo", "doas", "xargs", "find", "nohup", "time", "timeout",
  "gtimeout", "nice", "stdbuf", "script", "expect",
  // language runtimes
  "python", "pypy", "node", "nodejs", "bun", "deno", "tsx", "ts-node",
  "perl", "ruby", "php", "lua", "luajit", "rscript", "osascript", "pwsh",
  "powershell", "cmd", "awk", "gawk", "mawk", "nawk", "sed", "tclsh", "wish",
  "julia", "sqlite3",
  // destructive primitives that are never a host capability
  "rm", "dd", "mkfs", "kill", "shred", "truncate",
]);

/** Version suffixes do not make an interpreter safe: `python3.12`, `node20`. */
function canonicalExecutable(word: string): string {
  const unquoted = word.replace(/^['"]|['"]$/g, "");
  const name = basename(unquoted.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name;
}

export function isBannedExecutable(name: string): boolean {
  const canonical = canonicalExecutable(name);
  if (BANNED_EXECUTABLES.has(canonical)) return true;
  const versionless = canonical.replace(/[0-9]+(?:[._][0-9]+)*$/u, "");
  return versionless !== canonical && BANNED_EXECUTABLES.has(versionless);
}

/**
 * Split a command line into shell words, rejecting syntax that could run a
 * second command. A quote may contain spaces; everything outside single quotes
 * must not expand (`$`), substitute (backticks) or redirect/chains.
 */
function parseWords(command: string): { ok: true; words: string[] } | { ok: false; reason: string } {
  const words: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = () => {
    if (!hasCurrent) return;
    words.push(current);
    current = "";
    hasCurrent = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      hasCurrent = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        // Single quotes are literal; a double-quoted `$` or backtick still
        // expands or substitutes, which is another program.
        if (quote === '"' && (char === "$" || char === "`")) {
          return { ok: false, reason: "shell metacharacters are not allowed in a host-command exception" };
        }
        current += char;
      }
      hasCurrent = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasCurrent = true;
      continue;
    }
    // Outside quotes every one of these could chain, redirect, background,
    // substitute or expand into a different program.
    if (/[;&|<>$`*?{}[\]]/.test(char)) {
      return { ok: false, reason: "shell metacharacters are not allowed in a host-command exception" };
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (quote) return { ok: false, reason: "unbalanced quotes in the host-command exception" };
  if (escaped) return { ok: false, reason: "a trailing escape is not a plain command" };
  push();
  return { ok: true, words };
}

/** Why this command cannot be approved for host execution, or the parsed command. */
export function parseHostCommand(command: string): HostCommandCheck {
  const trimmed = command.trim();
  if (trimmed === "") return { ok: false, reason: "empty command" };
  if (/[\n\r]/.test(trimmed)) return { ok: false, reason: "multi-line command" };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: "control characters are not allowed in a host command" };
  const parsed = parseWords(trimmed);
  if (!parsed.ok) return parsed;
  if (parsed.words.length === 0) return { ok: false, reason: "empty command" };
  const head = parsed.words[0]!;
  if (!/^[A-Za-z0-9_./+-]+$/.test(head)) {
    return { ok: false, reason: "the executable must be a literal command name or path, not a shell keyword, assignment or expansion" };
  }
  const executable = canonicalExecutable(head);
  if (executable === "") return { ok: false, reason: "the command has no executable" };
  if (isBannedExecutable(executable)) {
    return {
      ok: false,
      reason: `"${parsed.words[0]}" is an interpreter or wrapper, which would make the host exception arbitrary execution`,
    };
  }
  return { ok: true, command: { command: trimmed, argv: parsed.words, executable } };
}

/** A rule word must be one literal shell word, not a pattern or a chain. */
function ruleWord(word: unknown): string | undefined {
  if (typeof word !== "string") return undefined;
  const trimmed = word.trim();
  if (trimmed === "" || trimmed !== word) return undefined;
  if (/[\s;&|<>`$*?\\'"[\]{}]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Check a proposed standing rule against the command it is attached to. A rule
 * is categorical: `["git", "push"]` becomes `git push:*` and covers any
 * arguments. Anything that is not a literal prefix of the current command is
 * refused before a review is spent on it.
 */
export function checkPrefixRule(
  command: HostCommand,
  proposed: readonly string[] | undefined,
): PrefixRuleCheck {
  if (proposed === undefined) return { ok: true };
  if (!Array.isArray(proposed) || proposed.length === 0) {
    return { ok: false, reason: 'prefix_rule must be a non-empty array of command words, for example ["git", "push"]' };
  }
  const words: string[] = [];
  for (const entry of proposed) {
    const word = ruleWord(entry);
    if (word === undefined) {
      return { ok: false, reason: "prefix_rule words must be literal command words without whitespace, metacharacters or wildcards" };
    }
    words.push(word);
  }
  if (words.length > command.argv.length) {
    return { ok: false, reason: `prefix_rule ${JSON.stringify(words)} is longer than the command it would cover` };
  }
  for (let index = 0; index < words.length; index += 1) {
    if (command.argv[index] !== words[index]) {
      return {
        ok: false,
        reason: `prefix_rule ${JSON.stringify(words)} is not a prefix of the current command "${command.command}"`,
      };
    }
  }
  if (isBannedExecutable(canonicalExecutable(words[0]!))) {
    return { ok: false, reason: `prefix_rule "${words[0]}" would allow arbitrary execution` };
  }
  return { ok: true, pattern: `${words.join(" ")}:*` };
}
