import type { SandboxScope } from "./broker.ts";

export type SupervisorDecision =
  | { kind: "allow"; scope: SandboxScope }
  | { kind: "deny" };

/**
 * A subagent has no UI, so a deferred sandbox exception used to be dropped. The
 * parent session is reachable through pi-subagents' `contact_supervisor` tool; we
 * ask it for an explicit token so the answer cannot be read as consent by
 * accident. `contact_supervisor` wraps the reply in a heading, so the token may
 * appear on the first line after it.
 */
export function supervisorQuestion(input: {
  surface: string;
  target: string;
  reason?: string;
  cwd: string;
}): string {
  return [
    `A subagent needs a sandbox exception the reviewer deferred to a human.`,
    ``,
    `surface: ${input.surface}`,
    `target: ${input.target}`,
    `project: ${input.cwd}`,
    ...(input.reason ? [`why: ${input.reason}`] : []),
    ``,
    `Ask the user and reply with exactly one of:`,
    `  ALLOW session   — allow it for the rest of the child session`,
    `  ALLOW once      — allow it once`,
    `  DENY            — refuse (say why in the next line)`,
    `Do not answer on your own authority; this decision belongs to the user.`,
  ].join("\n");
}

/** Parse `ALLOW [once|session]` / `DENY` out of a supervisor reply. */
export function parseSupervisorDecision(text: string): SupervisorDecision | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*\*\*[^*]*\*\*:?\s*/, "").trim();
    const match = /^(ALLOW|DENY)\b(?:\s+(once|session))?/i.exec(line);
    if (!match) continue;
    if (match[1]!.toUpperCase() === "DENY") return { kind: "deny" };
    return { kind: "allow", scope: (match[2]?.toLowerCase() as SandboxScope | undefined) ?? "session" };
  }
  return undefined;
}
