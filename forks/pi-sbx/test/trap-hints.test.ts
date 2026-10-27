import { describe, expect, it } from "vitest";
import { buildTrapHint, findDeniedPaths, withTrapHint } from "../src/trap-hints.ts";

describe("findDeniedPaths", () => {
	it("finds paths from common denial messages", () => {
		expect(findDeniedPaths("touch: /Users/a/.gradle/x: Operation not permitted")).toEqual(["/Users/a/.gradle/x"]);
		expect(findDeniedPaths("mkdir: /opt/tool/logs: Permission denied")).toEqual(["/opt/tool/logs"]);
		expect(findDeniedPaths("open: '/Users/a/Library/x': Read-only file system")).toEqual([
			"/Users/a/Library/x",
		]);
	});

	it("ignores output without a denial, relative paths, and duplicates", () => {
		expect(findDeniedPaths("hello\nworld")).toEqual([]);
		expect(findDeniedPaths("touch: relative/x: Operation not permitted")).toEqual([]);
		expect(
			findDeniedPaths(
				"touch: /a: Operation not permitted\ntouch: /a: Operation not permitted\ntouch: /b: Operation not permitted",
			),
		).toEqual(["/a", "/b"]);
	});

	it("caps the number of paths", () => {
		const output = ["/a", "/b", "/c", "/d", "/e"].map((p) => `touch: ${p}: Operation not permitted`).join("\n");
		expect(findDeniedPaths(output, 2)).toEqual(["/a", "/b"]);
	});
});

describe("buildTrapHint", () => {
	it("returns undefined when nothing was denied", () => {
		expect(buildTrapHint("ok", { cwd: "/work" })).toBeUndefined();
	});

	it("skips scratch paths and already-granted targets", () => {
		const output = [
			"touch: /tmp/pi-sbx-scratch-x/p: Operation not permitted",
			"touch: /Users/a/.gradle/caches: Operation not permitted",
		].join("\n");
		const onlyGradle = buildTrapHint(output, { cwd: "/work", scratchDir: "/tmp/pi-sbx-scratch-x" });
		expect(onlyGradle).toContain("/Users/a/.gradle/caches");
		expect(onlyGradle).not.toContain("pi-sbx-scratch-x");
		expect(
			buildTrapHint(output, {
				cwd: "/work",
				scratchDir: "/tmp/pi-sbx-scratch-x",
				granted: ["/Users/a/.gradle"],
			}),
		).toBeUndefined();
	});

	it("names the tool and the exact target", () => {
		const hint = buildTrapHint("touch: /Users/a/.gradle/x: Operation not permitted", { cwd: "/work" });
		expect(hint).toContain("/Users/a/.gradle/x");
		expect(hint).toContain("request_sandbox_exception");
		expect(hint).toContain('"write"');
	});

	it("appends to a tool result without touching non-text results", () => {
		const result = { content: [{ type: "text", text: "touch: /a: Operation not permitted" }], details: { x: 1 } };
		const next = withTrapHint(result, "touch: /a: Operation not permitted", { cwd: "/work" });
		expect(next.content).toHaveLength(2);
		expect(String(next.content[1].text)).toContain("request_sandbox_exception");
		expect(next.details).toEqual({ x: 1 });
		expect(withTrapHint(result, "all good", { cwd: "/work" })).toBe(result);
	});
});
