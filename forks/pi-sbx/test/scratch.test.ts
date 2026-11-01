import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createScratchpad,
	SCRATCH_ENV,
	SCRATCH_PREFIX,
	sweepScratchpads,
	withScratchpad,
} from "../src/scratch.ts";

function config(overrides: { allowWrite?: string[]; allowRead?: string[] } = {}) {
	return {
		runtime: {
			filesystem: {
				allowWrite: overrides.allowWrite ?? ["."],
				...(overrides.allowRead ? { allowRead: overrides.allowRead } : {}),
			},
		},
		other: true,
	};
}

describe("withScratchpad", () => {
	it("adds the scratchpad to allowWrite and allowRead without mutating the input", () => {
		const original = config({ allowWrite: ["."], allowRead: ["."] });
		const next = withScratchpad(original, "/tmp/pi-sbx-scratch-x");
		expect(next.runtime.filesystem.allowWrite).toEqual([".", "/tmp/pi-sbx-scratch-x"]);
		expect(next.runtime.filesystem.allowRead).toEqual([".", "/tmp/pi-sbx-scratch-x"]);
		expect(original.runtime.filesystem.allowWrite).toEqual(["."]);
		expect(original.runtime.filesystem.allowRead).toEqual(["."]);
		expect(next.other).toBe(true);
	});

	it("dedupes and leaves allowRead unset when the profile does not use it", () => {
		const dir = "/tmp/pi-sbx-scratch-x";
		const next = withScratchpad(config({ allowWrite: [dir] }), dir);
		expect(next.runtime.filesystem.allowWrite).toEqual([dir]);
		expect("allowRead" in next.runtime.filesystem).toBe(false);
	});
});

describe("scratchpad lifecycle", () => {
	it("creates a uniquely named directory and removes it on dispose", async () => {
		const a = await createScratchpad();
		const b = await createScratchpad();
		expect(a.dir.startsWith(join(tmpdir(), SCRATCH_PREFIX))).toBe(true);
		expect(a.dir).not.toBe(b.dir);
		await writeFile(join(a.dir, "probe.txt"), "ok");
		expect(existsSync(join(a.dir, "probe.txt"))).toBe(true);
		await a.dispose();
		await b.dispose();
		expect(existsSync(a.dir)).toBe(false);
		expect(SCRATCH_ENV).toBe("PI_SANDBOX_SCRATCH");
	});

	it("can allocate within already-held scope and validates the exact candidate before creation", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-owned-base-"));
		let checked: string | undefined;
		try {
			const scratch = await createScratchpad(SCRATCH_PREFIX, { baseDir: base, validateBeforeCreate(candidate) {
				checked = candidate; expect(candidate.startsWith(join(base, SCRATCH_PREFIX))).toBe(true);
				expect(existsSync(candidate)).toBe(false);
			} });
			expect(scratch.dir).toBe(checked);
			expect((await lstat(scratch.dir)).mode & 0o777).toBe(0o700);
			await scratch.dispose();
			expect(await readdir(base)).toEqual([]);
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("refuses an unheld candidate without making any directory or granting another root", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-refused-base-"));
		try {
			await expect(createScratchpad(SCRATCH_PREFIX, { baseDir: base, validateBeforeCreate() { throw new Error("not held"); } })).rejects.toThrow("not held");
			expect(await readdir(base)).toEqual([]);
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("does not delete a replacement directory or its dirty files", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-replaced-base-"));
		try {
			const scratch = await createScratchpad(SCRATCH_PREFIX, { baseDir: base });
			const moved = join(base, "moved-owned-root");
			await rename(scratch.dir, moved); await mkdir(scratch.dir);
			await writeFile(join(scratch.dir, "user-file"), "preserve");
			await expect(scratch.dispose()).rejects.toThrow(/ownership changed/);
			expect(await readFile(join(scratch.dir, "user-file"), "utf8")).toBe("preserve");
			expect(existsSync(moved)).toBe(true);
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("refuses symlink replacement without traversing or deleting its target", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-linked-base-"));
		try {
			const scratch = await createScratchpad(SCRATCH_PREFIX, { baseDir: base });
			const foreign = join(base, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "keep"), "preserve");
			await rm(scratch.dir, { recursive: true }); await symlink(foreign, scratch.dir);
			await expect(scratch.dispose()).rejects.toThrow(/ownership changed/);
			expect(await readFile(join(foreign, "keep"), "utf8")).toBe("preserve");
			expect((await lstat(scratch.dir)).isSymbolicLink()).toBe(true);
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("is idempotent and never adopts a later directory at the disposed path", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-disposed-base-"));
		try {
			const scratch = await createScratchpad(SCRATCH_PREFIX, { baseDir: base });
			await scratch.dispose(); await mkdir(scratch.dir); await writeFile(join(scratch.dir, "keep"), "preserve");
			await scratch.dispose();
			expect(await readFile(join(scratch.dir, "keep"), "utf8")).toBe("preserve");
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("rejects path-like prefixes before creating anything", async () => {
		const base = await mkdtemp(join(tmpdir(), "sbx-prefix-base-"));
		try {
			for (const prefix of ["", ".", "..", "../escape", "a/b", "a\\b"]) {
				await expect(createScratchpad(prefix, { baseDir: base })).rejects.toThrow(/directory-name prefix/);
			}
			expect(await readdir(base)).toEqual([]);
		} finally { await rm(base, { recursive: true, force: true }); }
	});

	it("sweeps only stale directories with the scratch prefix", async () => {
		const base = await mkdtemp(join(tmpdir(), "pi-sbx-sweep-test-"));
		const stale = join(base, `${SCRATCH_PREFIX}stale`);
		const fresh = join(base, `${SCRATCH_PREFIX}fresh`);
		const unrelated = join(base, "unrelated");
		for (const dir of [stale, fresh, unrelated]) await mkdir(dir);
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
		await utimes(stale, old, old);
		await utimes(unrelated, old, old);

		const removed = await sweepScratchpads({ baseDir: base, maxAgeMs: 60 * 60 * 1000 });

		expect(removed).toEqual([stale]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});
});
