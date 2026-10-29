import { afterEach, describe, expect, it } from "vitest";
import {
	decideSandboxException,
	getGuardianBroker,
	projectPolicyRule,
	publishGuardianBrokerForTest,
	withScopedPaths,
	type SandboxBrokerService,
} from "../src/broker.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
	while (disposers.length > 0) disposers.pop()!();
});

function publish(service: SandboxBrokerService) {
	disposers.push(publishGuardianBrokerForTest(service));
	return service;
}

describe("broker slot", () => {
	it("is empty until published, then resolves, and is disposed", () => {
		expect(getGuardianBroker()).toBeUndefined();
		const dispose = publishGuardianBrokerForTest({
			review: async () => ({ kind: "defer", review: { rationale: "x", source: "rule" } }),
		});
		expect(getGuardianBroker()?.review).toBeTypeOf("function");
		expect(() =>
			publishGuardianBrokerForTest({
				review: async () => ({ kind: "defer", review: { rationale: "y", source: "rule" } }),
			}),
		).toThrow(/already published/);
		dispose();
		expect(getGuardianBroker()).toBeUndefined();
	});
});

describe("decideSandboxException", () => {
	it("fails closed when no broker is published", async () => {
		const decision = await decideSandboxException({
			surface: "write",
			target: "/tmp/x",
			scope: "once",
			cwd: "/work",
		});
		expect(decision.kind).toBe("deny");
	});

	it("passes allow/deny through and turns a throwing broker into a denial", async () => {
		const allow = publish({
			review: async () => ({ kind: "allow", scope: "session", review: { rationale: "ok", source: "reviewer" } }),
		});
		expect((await decideSandboxException({ surface: "write", target: "/tmp/x", scope: "once", cwd: "/work" })).kind).toBe(
			"allow",
		);
		allow.review = async () => ({ kind: "deny", reason: "no", review: { rationale: "no", source: "reviewer" } });
		expect((await decideSandboxException({ surface: "write", target: "/tmp/x", scope: "once", cwd: "/work" })).kind).toBe(
			"deny",
		);
		allow.review = async () => {
			throw new Error("sidecar timeout");
		};
		const failed = await decideSandboxException({ surface: "write", target: "/tmp/x", scope: "once", cwd: "/work" });
		expect(failed.kind).toBe("deny");
		expect(failed.kind === "deny" ? failed.reason : "").toMatch(/review failed/i);
	});

	it("builds a request with the caller's origin and context", async () => {
		let seen: unknown;
		publish({
			review: async (request) => {
				seen = request;
				return { kind: "defer", review: { rationale: "x", source: "rule" } };
			},
		});
		await decideSandboxException({
			surface: "network",
			target: "registry.npmjs.org:443",
			scope: "once",
			origin: "trap",
			violation: "not allowlisted",
			cwd: "/work",
		});
		expect(seen).toMatchObject({
			origin: "trap",
			surface: "network",
			target: "registry.npmjs.org:443",
			scope: "once",
			violation: "not allowlisted",
			cwd: "/work",
		});
	});
});

describe("scoped path layer", () => {
	it("adds paths to a copy without mutating the baseline session layer", () => {
		const baseline = {
			network: { allowedDomains: ["npmjs.org"] },
			filesystem: { allowRead: ["/data"], allowWrite: ["."] },
		};
		const scoped = withScopedPaths(baseline, [
			{ surface: "write", target: "/home/u/.gradle" },
			{ surface: "read", target: "/usr/share/x" },
		]);
		expect(scoped).toEqual({
			network: { allowedDomains: ["npmjs.org"] },
			filesystem: {
				allowRead: ["/data", "/usr/share/x"],
				allowWrite: [".", "/home/u/.gradle"],
			},
		});
		// The baseline is untouched, so native file tools and later commands
		// never see the transient grant.
		expect(baseline.filesystem).toEqual({ allowRead: ["/data"], allowWrite: ["."] });
	});

	it("does not introduce network or command grants", () => {
		const scoped = withScopedPaths({}, [{ surface: "read", target: "/x" }]);
		expect(scoped).toEqual({ filesystem: { allowRead: ["/x"] } });
	});
});

describe("project policy rule text", () => {
	it("uses guardian's <surface>:<pattern> spelling", () => {
		expect(projectPolicyRule("command", "git push:*")).toBe("command:git push:*");
		expect(projectPolicyRule("network", "example.test")).toBe("network:example.test");
		expect(projectPolicyRule("read", "/data")).toBe("read:/data");
	});
});
