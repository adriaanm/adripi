import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as api from "../../src/api/child-authority.ts";
import { bindChildRuntimeCodePaths, createChildAuthorityLease, getChildRuntimeCodePaths, withChildAuthority } from "../../src/runs/shared/child-authority.ts";

const entry = (path = "/fixture/extension.ts") => ({ path, resolvedPath: path, sourceInfo: { origin: "top-level" } });
function fixture() {
	return createChildAuthorityLease({ leaseId: "code-paths", identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: process.cwd() },
		payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel() {}, requestTimeoutMs: 100 });
}

describe("SDK loaded code metadata on the existing live lease (not permission)", () => {
	it("exports only read-only inspection, not the internal producer", () => {
		assert.equal(api.getChildRuntimeCodePaths, getChildRuntimeCodePaths);
		assert.equal((api as any).bindChildRuntimeCodePaths, undefined);
	});
	it("captures independent bounded file/package paths before acknowledgment without changing SDK records", () => {
		const { lease } = fixture(); const original = entry(), pkg = { ...entry("/fixture/pkg/index.ts"), resolvedPath: "/canonical/pkg/index.ts", sourceInfo: { origin: "package", baseDir: "/fixture/pkg" } };
		try { withChildAuthority(lease, () => {
			bindChildRuntimeCodePaths(lease, [original, pkg, entry("<inline:actual-sdk-factory>"), entry("builtin:mcp")]);
			const paths = api.getChildRuntimeCodePaths(lease);
			assert.deepEqual(paths, ["/fixture/extension.ts", "/fixture/pkg/index.ts", "/canonical/pkg/index.ts", "/fixture/pkg"]);
			assert.equal(Object.isFrozen(paths), true); assert.equal(Object.isFrozen(original), false);
			original.path = "/producer/changed.ts"; assert.equal(paths[0], "/fixture/extension.ts");
			assert.throws(() => (paths as string[]).push("/forged"), TypeError);
			assert.throws(() => lease.assertReady(), /pi-sbx.*pi-guardian/);
			assert.throws(() => bindChildRuntimeCodePaths(lease, []), /already bound/);
		}); } finally { lease.dispose(); }
	});
	it("requires a factory receipt, same scoped lease, and live lifetime", () => {
		const a = fixture(), b = fixture();
		try {
			withChildAuthority(a.lease, () => {
				assert.throws(() => api.getChildRuntimeCodePaths(a.lease), /has not bound/);
				bindChildRuntimeCodePaths(a.lease, []); bindChildRuntimeCodePaths(b.lease, []);
				assert.throws(() => api.getChildRuntimeCodePaths(b.lease), /current live SDK child lease/);
			});
			assert.throws(() => api.getChildRuntimeCodePaths(a.lease), /own live.*identity/);
			a.lease.dispose(); withChildAuthority(a.lease, () => assert.throws(() => api.getChildRuntimeCodePaths(a.lease), /current live SDK child lease/));
		} finally { a.lease.dispose(); b.lease.dispose(); }
	});
	for (const shape of ["missing", "proxy array", "sparse", "array accessor", "proxy entry", "path accessor", "missing resolved", "relative", "control", "glob", "oversized path", "too many", "aggregate bytes", "missing origin", "proxy info", "info accessor", "package missing root", "package relative root"]) it(`refuses ${shape} without executing traps or exposing data`, () => {
		let traps = 0; let records: any = [entry()];
		if (shape === "missing") records = undefined;
		if (shape === "proxy array") records = new Proxy([], { get() { traps++; return 0; } });
		if (shape === "sparse") records = new Array(1);
		if (shape === "array accessor") records = Object.defineProperty([entry()], "0", { get() { traps++; return entry(); } });
		if (shape === "proxy entry") records = [new Proxy(entry(), { getOwnPropertyDescriptor() { traps++; throw new Error("private diagnostic"); } })];
		if (shape === "path accessor") records = [Object.defineProperty(entry(), "path", { get() { traps++; return "/private"; } })];
		if (shape === "missing resolved") delete records[0].resolvedPath;
		if (shape === "relative") records = [entry("relative.ts")];
		if (shape === "control") records = [entry("/private\npath.ts")];
		if (shape === "glob") records = [entry("/private/[path].ts")];
		if (shape === "oversized path") records = [entry("/" + "x".repeat(4096))];
		if (shape === "too many") records = new Array(257).fill(entry());
		if (shape === "aggregate bytes") records = Array.from({length: 30}, (_, index) => entry("/" + index + "x".repeat(3000)));
		if (shape === "missing origin") records[0].sourceInfo = {};
		if (shape === "proxy info") records[0].sourceInfo = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw new Error("private diagnostic"); } });
		if (shape === "info accessor") Object.defineProperty(records[0], "sourceInfo", { get() { traps++; return {}; } });
		if (shape.startsWith("package")) records[0].sourceInfo = { origin: "package", ...(shape === "package relative root" ? { baseDir: "relative" } : {}) };
		const { lease } = fixture();
		try {
			assert.throws(() => bindChildRuntimeCodePaths(lease, records), error => error instanceof Error && /missing, malformed, oversized or already bound/.test(error.message) && !/private diagnostic/.test(error.message));
			assert.equal(traps, 0);
			withChildAuthority(lease, () => assert.throws(() => api.getChildRuntimeCodePaths(lease), /has not bound/));
		} finally { lease.dispose(); }
	});
});
