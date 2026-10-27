import { minimatch } from "minimatch";

const WRAPPERS = new Set(["env", "timeout", "gtimeout", "nice", "nohup"]);
const UNSAFE_SHELL = /\$\(|`|<\(|>\(|<<|\n|\r/;

export interface CommandParseResult {
  leaves: string[];
  safe: boolean;
}

export function splitCommandLeaves(command: string): CommandParseResult {
  if (UNSAFE_SHELL.test(command)) return { leaves: [], safe: false };
  const leaves: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = () => {
    const leaf = current.trim();
    if (leaf) leaves.push(leaf);
    current = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "|") {
      push();
      if ((char === "|" && command[i + 1] === "|") || (char === "|" && command[i - 1] === "|")) {
        if (command[i + 1] === "|") i += 1;
      }
      continue;
    }
    if (char === "&") {
      if (command[i + 1] !== "&") return { leaves: [], safe: false };
      push();
      i += 1;
      continue;
    }
    // Unquoted redirection can write or read arbitrary host paths when a
    // broad exclusion sends the command outside the sandbox. Fail closed;
    // exact full-command exclusions are matched before parsing and still work.
    if (char === ">" || char === "<") return { leaves: [], safe: false };
    current += char;
  }

  if (quote || escaped) return { leaves: [], safe: false };
  push();
  return { leaves, safe: leaves.length > 0 };
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) words.push(current), (current = "");
    } else {
      current += char;
    }
  }
  if (quote || escaped) return undefined;
  if (current) words.push(current);
  return words;
}

function stripLeaf(command: string): string[] {
  const words = shellWords(command);
  if (!words?.length) return [command.trim()];
  let index = 0;
  let changed = true;
  while (changed && index < words.length) {
    changed = false;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
      index += 1;
      changed = true;
    }
    const wrapper = words[index];
    if (wrapper && WRAPPERS.has(wrapper)) {
      index += 1;
      if (wrapper === "timeout" || wrapper === "gtimeout" || wrapper === "nice") {
        while (index < words.length && (words[index]!.startsWith("-") || /^\d/.test(words[index]!))) index += 1;
      } else if (wrapper === "env") {
        while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index += 1;
      }
      changed = true;
    }
  }
  const stripped = words.slice(index).join(" ");
  return [...new Set([command.trim(), stripped].filter(Boolean))];
}

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function matchesPattern(pattern: string, candidate: string): boolean {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2).trim();
    return candidate === prefix || candidate.startsWith(`${prefix} `);
  }
  if (hasGlob(pattern)) {
    return minimatch(candidate, pattern, { dot: true, nocase: false, nonegate: true, nocomment: true });
  }
  return candidate === pattern.trim();
}

export function isCommandExcluded(command: string, patterns: readonly string[]): boolean {
  const normalized = command.trim();
  if (patterns.some((pattern) => !hasGlob(pattern) && !pattern.endsWith(":*") && pattern.trim() === normalized)) return true;
  const parsed = splitCommandLeaves(command);
  if (!parsed.safe) return false;
  return parsed.leaves.every((leaf) => {
    const candidates = stripLeaf(leaf);
    return patterns.some((pattern) => candidates.some((candidate) => matchesPattern(pattern, candidate)));
  });
}
