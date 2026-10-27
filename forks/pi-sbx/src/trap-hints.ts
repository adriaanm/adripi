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
export function buildTrapHint(output: string, context: HintContext): string | undefined {
	const paths = findDeniedPaths(output).filter((path) => {
		if (context.scratchDir && path.startsWith(context.scratchDir)) return false;
		if (context.granted?.some((granted) => path === granted || path.startsWith(`${granted}/`))) return false;
		return true;
	});
	if (paths.length === 0) return undefined;
	const listed = paths.map((path) => `"${path}"`).join(", ");
	return [
		`The sandbox denied access to ${listed}.`,
		"If the task genuinely needs it, call request_sandbox_exception with one of those exact paths as `target`,",
		"`surface` \"write\" for a write denial (or \"read\" for a read denial), and a `reason` explaining why the task needs it.",
		"Guardian reviews the request; the user is asked when guardian defers.",
	].join(" ");
}

/** Append the hint to a Pi tool result's text content, if it has one. */
export function withTrapHint<T extends { content?: unknown }>(result: T, output: string, context: HintContext): T {
	if (!Array.isArray(result.content)) return result;
	const hint = buildTrapHint(output, context);
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
