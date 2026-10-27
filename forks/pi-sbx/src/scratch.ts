import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A per-session scratchpad the sandbox always allows writes to.
 *
 * It is the one place the agent can create temporary files without asking for
 * an exception: it lives under the host temp tree, is unique per session, is
 * removed at shutdown, and stale directories from crashed sessions are swept
 * by age. Nothing else under the temp root becomes writable.
 */
export const SCRATCH_PREFIX = "pi-sbx-scratch-";

/** Environment variable that tells sandboxed commands where to write. */
export const SCRATCH_ENV = "PI_SANDBOX_SCRATCH";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Scratchpad {
	dir: string;
	dispose(): Promise<void>;
}

export async function createScratchpad(prefix: string = SCRATCH_PREFIX): Promise<Scratchpad> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return {
		dir,
		dispose: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** Remove scratch directories left behind by sessions that never shut down. */
export async function sweepScratchpads(
	options: { maxAgeMs?: number; now?: number; prefix?: string; baseDir?: string } = {},
): Promise<string[]> {
	const prefix = options.prefix ?? SCRATCH_PREFIX;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = options.now ?? Date.now();
	const baseDir = options.baseDir ?? tmpdir();
	let entries: string[];
	try {
		entries = await readdir(baseDir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of entries) {
		if (!name.startsWith(prefix)) continue;
		const dir = join(baseDir, name);
		try {
			const info = await stat(dir);
			if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
			await rm(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			// A concurrent session may own it; leave it alone.
		}
	}
	return removed;
}

export interface ScratchpadCarrier {
	runtime: { filesystem: { allowWrite: string[]; allowRead?: string[] } };
}

/**
 * Add the scratchpad to the effective runtime policy. Returns a copy; the input
 * config (and the user's persisted layer) is never mutated.
 */
export function withScratchpad<T extends ScratchpadCarrier>(config: T, dir: string): T {
	const filesystem = config.runtime.filesystem;
	const allowWrite = [...new Set([...filesystem.allowWrite, dir])];
	const allowRead =
		filesystem.allowRead === undefined ? undefined : [...new Set([...filesystem.allowRead, dir])];
	return {
		...config,
		runtime: {
			...config.runtime,
			filesystem: { ...filesystem, allowWrite, ...(allowRead ? { allowRead } : {}) },
		},
	};
}
