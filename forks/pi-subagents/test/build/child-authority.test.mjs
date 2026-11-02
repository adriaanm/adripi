// Deliberately separate from test:unit: this checks the actual graph after an explicit build.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const dist = new URL("../../dist-pkg/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("package.json", dist), "utf8"));
const bundled = await import(new URL(manifest.exports["./child-authority"].default, dist).href);
const compiled = await import(new URL("src/api/child-authority.js", dist).href);
const domain = await import(new URL("src/runs/shared/child-authority.js", dist).href);

for (const [producer, consumer] of [[bundled, compiled], [compiled, bundled]]) {
	test(`built authority shares a live lease across ${producer === bundled ? "bundle→compiled" : "compiled→bundle"} consumers`, async () => {
		const handle = domain.createChildAuthorityLease({
			leaseId: "built-lease",
			identity: { parentSessionId: "built-session", runId: "built-run", agent: "worker", index: 0, cwd: "/workspace/built" },
			payload: { version: 1 },
			requiredConsumers: ["pi-sbx"],
			send: (id) => { queueMicrotask(() => handle.deliverDecision(id, { outcome: "allow" })); return true; },
			cancel: () => {},
			requestTimeoutMs: 1000,
		});
		try {
			await producer.withChildAuthority(handle.lease, async () => {
				await Promise.resolve();
				assert.equal(producer.hasChildAuthorityContext(), true);
				assert.equal(consumer.hasChildAuthorityContext(), true);
				assert.equal(domain.captureChildAuthorityLease("/workspace/built"), handle.lease, "compiled SDK guard captures the same live scoped lease");
				assert.throws(() => handle.lease.assertReady(), /pi-sbx/, "SDK capture must not claim or acknowledge a consumer");
				domain.bindChildRuntimeCodePaths(handle.lease, [{ path: "/fixture/loaded.ts", resolvedPath: "/fixture/loaded.ts", sourceInfo: { origin: "top-level" } }]);
				assert.deepEqual(consumer.getChildRuntimeCodePaths(handle.lease), ["/fixture/loaded.ts"]);
				assert.equal(consumer.getChildRuntimeCodePaths(handle.lease), producer.getChildRuntimeCodePaths(handle.lease));
				assert.equal(producer.bindChildRuntimeCodePaths, undefined, "only the internal factory can produce the receipt");
				const claimed = consumer.claimChildAuthority("pi-sbx", "/workspace/built");
				assert.equal(claimed, handle.lease);
				consumer.acknowledgeChildAuthority("pi-sbx");
				handle.lease.assertReady();
				assert.deepEqual(await claimed.request({ surface: "write", target: "/workspace/built/file", reason: "build fixture" }), { outcome: "allow" });
			});
			assert.equal(producer.hasChildAuthorityContext(), false);
			assert.equal(consumer.hasChildAuthorityContext(), false);
			assert.throws(() => consumer.claimChildAuthority("pi-sbx", "/workspace/built"), /active withChildAuthority/);
			assert.throws(() => domain.captureChildAuthorityLease("/workspace/built"), /own live.*identity/);
		} finally {
			handle.lease.dispose();
		}
	});
}

test("bundle and compiled APIs retain child intent for an explicitly undefined runner latch", () => {
	const key = Symbol.for("pi-subagents.child-authority-runner.v1");
	assert.equal(key in globalThis, false, "fixture must not replace a latched runner");
	globalThis[key] = undefined;
	try {
		assert.equal(bundled.hasChildAuthorityContext(), true);
		assert.equal(compiled.hasChildAuthorityContext(), true);
	} finally {
		delete globalThis[key];
	}
});

test("bundle and compiled APIs read the very same live provider slot", () => {
	const key = Symbol.for("pi-sbx.session-authority.v1");
	assert.equal(globalThis[key], undefined, "fixture must not replace an active publisher");
	const provider = { version: 2, sessionId: "built-session", requiredExtensions: [], prepare: async () => { throw new Error("unused"); } };
	globalThis[key] = provider;
	try {
		assert.equal(bundled.readChildAuthorityProvider().sessionId, compiled.readChildAuthorityProvider().sessionId);
		provider.sessionId = "replaced-session";
		assert.equal(bundled.readChildAuthorityProvider().sessionId, "replaced-session");
		assert.equal(compiled.readChildAuthorityProvider().sessionId, "replaced-session");
	} finally {
		delete globalThis[key];
	}
});
