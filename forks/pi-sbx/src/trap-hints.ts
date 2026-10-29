/**
 * Turn sandbox denials in command output into an actionable hint.
 *
 * Why a hint and not an automatic retry: Solaris-style guessing aside, the
 * reliable signal on macOS is the command's own error text (`Operation not
 * permitted`), while SRT's violation log is asynchronous and often reports
 * unrelated probes (`sysctl-read`). Inferring the *surface* from the message is
 * guesswork, and guessing wrong would either widen the sandbox in the wrong
 * dimension or spend a guardian review on a mislabelled request. So the sandbox
 * names the exact path and tells the model which tool to call; the request then
 * goes through the normal guardian/human decision with a reviewed target.
 */
const DENIAL = /(Operation not permitted|Permission denied|Read-only file system)/i;

/**
 * Credential stores that are permanently denied: a review cannot grant them, so
 * suggesting a `read`/`write` request for one of these sends the model into a
 * loop (ask → hard deny → retry). A command that needs them must run on the host.
 */
const PERMANENT_DENY = /(?:^|\/)\.ssh(?:\/|$)|\.aws(?:\/|$)|\.gnupg(?:\/|$)|\.config\/gh(?:\/|$)|\/auth\.json$/;

/** Failures that mean "this needs the host's credentials", not a wider sandbox. */
const CREDENTIAL_FAILURE =
	/(could not read Username for|could not read Password for|Device not configured|failed to create root command|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled)/i;

const PATH_BEFORE_DENIAL =
	/(?:^|[\s:`"'(])((?:'[^']+'|"[^"]+"|\/[^\s:'"()]+))(?=:\s*(?:Operation not permitted|Permission denied|Read-only file system))/gi;

/** Absolute paths the command appears to have been denied, in output order. */
export function findDeniedPaths(output: string, limit = 3): string[] {
	if (!DENIAL.test(output)) return [];
	const found: string[] = [];
	for (const match of output.matchAll(PATH_BEFORE_DENIAL)) {
		const raw = match[1];
		if (!raw) continue;
		const path = raw.replace(/^['"]|['"]$/g, "");
		if (!path.startsWith("/")) continue;
		if (found.includes(path)) continue;
		found.push(path);
		if (found.length >= limit) break;
	}
	return found;
}

export interface HintContext {
	cwd: string;
	scratchDir?: string;
	/** Absolute paths that already have a grant; no point suggesting them. */
	granted?: readonly string[];
}

/**
 * A hint appended to the tool result, or undefined when the output shows no
 * denials, or when every denied path is already known to be writable/readable.
 */
/** A hint for "git/gh needs host credentials", or undefined when it does not apply. */
export function buildCredentialHint(output: string): string | undefined {
	if (!CREDENTIAL_FAILURE.test(output)) return undefined;
	return [
		"This command needs the host's credential helper, which is not available inside the sandbox.",
		"Only network git (clone, fetch, pull, push, ls-remote, submodule --remote) and gh need this; every other git command works sandboxed.",
		'Call request_sandbox_exception with `surface` "command", the exact command line as `target`',
		'(for example `git pull --ff-only origin main`), and a reason: an approved command runs on the host with your real credentials.',
		"Do not retry it in the sandbox, and do not request read access to ~/.config/gh, ~/.ssh or other credential files —",
		"those are permanently denied and are not needed when the command runs on the host.",
	].join(" ");
}

export function buildTrapHint(output: string, context: HintContext): string | undefined {
	const paths = findDeniedPaths(output).filter((path) => {
		if (context.scratchDir && path.startsWith(context.scratchDir)) return false;
		if (context.granted?.some((granted) => path === granted || path.startsWith(`${granted}/`))) return false;
		return true;
	});
	if (paths.length === 0) return undefined;
	const permanent = paths.filter((path) => PERMANENT_DENY.test(path));
	const grantable = paths.filter((path) => !PERMANENT_DENY.test(path));
	const parts: string[] = [];
	if (grantable.length > 0) {
		const listed = grantable.map((path) => `"${path}"`).join(", ");
		parts.push(
			[
				`The sandbox denied access to ${listed}.`,
				"If the task genuinely needs it, call request_sandbox_exception with one of those exact paths as `target`,",
				"`surface` \"write\" for a write denial (or \"read\" for a read denial), and a `reason` explaining why the task needs it.",
				"Guardian reviews the request; the user is asked when guardian defers.",
			].join(" "),
		);
	}
	if (permanent.length > 0) {
		const listed = permanent.map((path) => `"${path}"`).join(", ");
		parts.push(
			[
				`The sandbox denied ${listed}, which is a permanently denied credential store — a request for it is refused by rule.`,
				"If the tool needs those credentials (git or gh authenticating against a remote), request a `command` exception",
				"for the exact command line instead; it runs on the host, where the credentials already live.",
			].join(" "),
		);
	}
	return parts.join("\n\n");
}

/** Append the hint to a Pi tool result's text content, if it has one. */
export function withTrapHint<T extends { content?: unknown }>(result: T, output: string, context: HintContext): T {
	if (!Array.isArray(result.content)) return result;
	const hint = [buildTrapHint(output, context), buildCredentialHint(output)].filter(Boolean).join("\n\n");
	if (!hint) return result;
	return {
		...result,
		content: [...result.content, { type: "text", text: `\n${hint}` }],
	} as T;
}

/** Concatenated text content of a Pi tool result, for scanning. */
export function resultText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const value = block as Record<string, unknown>;
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.join("\n");
}
