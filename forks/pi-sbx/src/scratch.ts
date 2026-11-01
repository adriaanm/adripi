import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A per-session scratchpad the sandbox always allows writes to.
 *
 * It is the one place the agent can create temporary files without asking for
 * an exception: by default it lives under host temp; a delegated caller supplies
 * its already-held workspace and validates before exclusive creation. Ownership
 * is pinned for shutdown cleanup. Only root sessions sweep stale temp entries;
 * a child must never sweep parent/other-session scratch.
 */
export const SCRATCH_PREFIX = "pi-sbx-scratch-";

/** Environment variable that tells sandboxed commands where to write. */
export const SCRATCH_ENV = "PI_SANDBOX_SCRATCH";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Scratchpad {
	dir: string;
	dispose(): Promise<void>;
}

export async function createScratchpad(prefix: string = SCRATCH_PREFIX, options: {
	/** A child supplies its already-held workspace, never parent temp/scratch. */
	baseDir?: string;
	/** Synchronous policy/pin check BEFORE exclusive creation, not a grant. */
	validateBeforeCreate?: (candidate: string) => void;
} = {}): Promise<Scratchpad> {
	if (!prefix || /[\\/\\\\]/.test(prefix) || prefix === "." || prefix === "..") throw new Error("Scratch prefix must be one directory-name prefix");
	const dir = join(options.baseDir ?? tmpdir(), `${prefix}${randomUUID()}`);
	options.validateBeforeCreate?.(dir);
	await mkdir(dir, { mode: 0o700 });
	const owner = await lstat(dir, { bigint: true });
	if (!owner.isDirectory() || owner.isSymbolicLink()) throw new Error("Scratch root changed during creation; refusing ownership");
	const canonical = await realpath(dir);
	let disposed = false;
	return {
		dir,
		dispose: async () => {
			if (disposed) return;
			let current: BigIntStats;
			try { current = await lstat(dir, { bigint: true }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { disposed = true; return; } throw error; }
			// Never delete a symlink, replacement directory or a different alias
			// just because it reused our path. No hostile same-user atomicity claim.
			if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino ||
				current.birthtimeNs !== owner.birthtimeNs || await realpath(dir) !== canonical) {
				throw new Error(`Scratch ownership changed; refusing cleanup of ${dir}`);
			}
			await rm(dir, { recursive: true, force: true });
			disposed = true;
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
