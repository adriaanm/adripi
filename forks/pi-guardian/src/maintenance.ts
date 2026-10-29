import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The one trusted source of agent-directory maintenance authority. A project
 * holds it only because guardian's *global* configuration names it; a project
 * policy, a working-directory spelling or a request field never adds or widens
 * it. File-tool rules and sandbox exception admission share this resolver.
 * The OS adapter separately enforces the same spelled/canonical containment;
 * cross-fork tests guard that policy boundary.
 */
export const MAINTENANCE_AUTHORITY_SOURCE = "permissions.agentDirWriteProjects";

export interface MaintenanceAuthority {
	/** The trusted project root that matched, as the global config spells it. */
	root: string;
	/** The canonical directory inside that root that the grant was decided for. */
	cwd: string;
	/** Where the grant came from. There is no other source. */
	source: typeof MAINTENANCE_AUTHORITY_SOURCE;
}

/**
 * Resolve symlinks in the deepest existing ancestor too, so a path that does not
 * exist yet is decided against the directory it would really be created in.
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		if (parent === path) return path;
		const name = path.slice(parent.length + (parent === "/" ? 0 : 1));
		return join(canonicalPath(parent), name);
	}
}

/** One path as spelled and as resolved: both spellings name the same thing. */
export function pathSpellings(path: string): string[] {
	return [...new Set([path, canonicalPath(path)])];
}

/** `path` is `directory` itself or one of its descendants. */
export function isWithinDirectory(directory: string, path: string): boolean {
	const rel = relative(directory, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Which trusted project root, if any, holds agent-directory maintenance
 * authority for `cwd`. A grant holds only while both the spelled and the
 * canonical directory stay inside the same root: a cwd spelled under a listed
 * project but symlinked outside it keeps no authority, and neither does a
 * lexical escape such as a `../` spelling or a parent of the root.
 */
export function resolveMaintenanceAuthority(
	roots: readonly string[] | undefined,
	cwd: string,
): MaintenanceAuthority | undefined {
	if (!roots || roots.length === 0) return undefined;
	const spelled = resolve(cwd);
	const canonicalCwd = canonicalPath(spelled);
	for (const configured of roots) {
		const root = resolve(configured);
		if (!isWithinDirectory(root, spelled)) continue;
		if (!isWithinDirectory(canonicalPath(root), canonicalCwd)) continue;
		return { root, cwd: canonicalCwd, source: MAINTENANCE_AUTHORITY_SOURCE };
	}
	return undefined;
}

/**
 * Concise provenance for a rule text, audit row or status line. Paths only: it
 * never carries file content, credentials or reviewer text.
 */
export function maintenanceRuleText(authority: MaintenanceAuthority, target: string): string {
	return `${MAINTENANCE_AUTHORITY_SOURCE}(${target}) root=${authority.root}`;
}
