/**
 * Host-command exceptions.
 *
 * A `command` exception means "run this exact command outside the OS sandbox",
 * which is how remote git operations work: the credential helper stays on the
 * host and the token never enters the model's context or the sandbox.
 *
 * Safety comes from three properties, not from trusting the reviewer alone:
 *   1. exact match — the executed string must equal the approved string, so a
 *      granted `git push` cannot authorise `git push; curl …`;
 *   2. single invocation — `once` grants are consumed by one execution;
 *   3. shape eligibility — shell metacharacters and interpreter/wrapper
 *      prefixes are refused before a review is even requested, because those
 *      turn one approved command into arbitrary execution.
 */

/** Shell syntax that would let one approved command run something else. */
const SHELL_METACHARACTERS = /[;&|<>`$\n\r]/;

/** Prefixes that turn the "command" into an interpreter or environment wrapper. */
const WRAPPER_PREFIXES = [
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"eval",
	"exec",
	"source",
	"env",
	"sudo",
	"doas",
	"xargs",
	"find",
	"nohup",
	"command",
	"builtin",
];

export type HostCommandRefusal =
	| "empty command"
	| "multi-line command"
	| "shell metacharacters are not allowed in a host-command exception"
	| "interpreter or wrapper prefixes are not allowed in a host-command exception";

/** Why this command cannot be approved for host execution, or undefined if it can. */
export function hostCommandRefusal(command: string): HostCommandRefusal | undefined {
	const trimmed = command.trim();
	if (trimmed === "") return "empty command";
	if (/[\n\r]/.test(trimmed)) return "multi-line command";
	if (SHELL_METACHARACTERS.test(trimmed)) {
		return "shell metacharacters are not allowed in a host-command exception";
	}
	const first = trimmed.split(/\s+/)[0] ?? "";
	if (WRAPPER_PREFIXES.includes(first)) {
		return "interpreter or wrapper prefixes are not allowed in a host-command exception";
	}
	return undefined;
}

export function isHostCommandEligible(command: string): boolean {
	return hostCommandRefusal(command) === undefined;
}

/**
 * Exact-match store for approved host commands. `session` grants persist for the
 * session; `once` grants are consumed by the next matching execution.
 */
export class HostCommandGrants {
	private session = new Set<string>();
	private once = new Set<string>();

	grant(command: string, scope: "once" | "session"): void {
		const key = command.trim();
		if (key === "") return;
		if (scope === "session") this.session.add(key);
		else this.once.add(key);
	}

	/** True when this exact command may run on the host; consumes a `once` grant. */
	consume(command: string): boolean {
		const key = command.trim();
		if (this.session.has(key)) return true;
		if (this.once.delete(key)) return true;
		return false;
	}

	/** Non-consuming check, for tests and diagnostics. */
	has(command: string): boolean {
		const key = command.trim();
		return this.session.has(key) || this.once.has(key);
	}

	clear(): void {
		this.session.clear();
		this.once.clear();
	}

	list(): { session: string[]; once: string[] } {
		return { session: [...this.session], once: [...this.once] };
	}
}
