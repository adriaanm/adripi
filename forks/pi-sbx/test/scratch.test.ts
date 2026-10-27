import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
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
