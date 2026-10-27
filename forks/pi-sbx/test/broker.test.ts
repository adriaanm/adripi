import { afterEach, describe, expect, it } from "vitest";
import {
	decideSandboxException,
	getGuardianBroker,
	publishGuardianBrokerForTest,
	withSessionException,
	type SandboxBrokerService,
	type SessionLayer,
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
	it("defers when no broker is published", async () => {
		const decision = await decideSandboxException({
			surface: "write",
			target: "/tmp/x",
			scope: "once",
			cwd: "/work",
		});
		expect(decision.kind).toBe("defer");
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
			scope: "session",
			origin: "trap",
			violation: "not allowlisted",
			cwd: "/work",
		});
		expect(seen).toMatchObject({
			origin: "trap",
			surface: "network",
			target: "registry.npmjs.org:443",
			scope: "session",
			violation: "not allowlisted",
			cwd: "/work",
		});
	});
});

describe("withSessionException", () => {
	const base: SessionLayer = {
		filesystem: { allowWrite: ["."] },
		network: { allowedDomains: ["example.com"] },
		excludedCommands: ["make"],
	};

	it("maps each surface onto the right session-layer key", () => {
		const write = withSessionException(base, "write", "/home/u/.gradle");
		expect(write.filesystem?.allowWrite).toEqual([".", "/home/u/.gradle"]);
		expect(write.filesystem?.allowRead).toBeUndefined();

		const read = withSessionException(base, "read", "/usr/share/x");
		expect(read.filesystem?.allowRead).toEqual(["/usr/share/x"]);

		const network = withSessionException(base, "network", "repo.maven.apache.org:443");
		expect(network.network?.allowedDomains).toEqual(["example.com", "repo.maven.apache.org:443"]);

		const command = withSessionException(base, "command", "xcodebuild -resolvePackageDependencies");
		expect(command.excludedCommands).toEqual(["make", "xcodebuild -resolvePackageDependencies"]);
	});

	it("never mutates the input layer and never duplicates entries", () => {
		const once = withSessionException(base, "write", "/home/u/.gradle");
		const twice = withSessionException(once, "write", "/home/u/.gradle");
		expect(twice.filesystem?.allowWrite).toEqual([".", "/home/u/.gradle"]);
		expect(base.filesystem?.allowWrite).toEqual(["."]);
		expect(base.network?.allowedDomains).toEqual(["example.com"]);
		expect(base.excludedCommands).toEqual(["make"]);
	});
});

describe("planExceptionOutcome", () => {
	it("maps allow to a grant, deny to a message, defer to the human", async () => {
		const { planExceptionOutcome } = await import("../src/broker.ts");
		expect(
			planExceptionOutcome({ kind: "allow", scope: "session", review: { rationale: "ok", source: "reviewer" } }),
		).toEqual({ action: "grant", scope: "session" });
		expect(
			planExceptionOutcome({ kind: "deny", reason: "no", review: { rationale: "no", source: "reviewer" } }),
		).toEqual({ action: "deny", message: "no" });
		expect(planExceptionOutcome({ kind: "defer", review: { rationale: "unsure", source: "rule" } })).toEqual({
			action: "ask-human",
		});
	});
});

describe("withoutSessionException", () => {
	it("removes a grant and drops empty containers", async () => {
		const { withoutSessionException } = await import("../src/broker.ts");
		const layer = {
			filesystem: { allowWrite: ["."], allowRead: ["."] },
			network: { allowedDomains: ["example.com"] },
			excludedCommands: ["make"],
		};
		const removedWrite = withoutSessionException(layer, "write", ".");
		expect(removedWrite.filesystem?.allowWrite).toBeUndefined();
		expect(removedWrite.filesystem?.allowRead).toEqual(["."]);

		const removedNetwork = withoutSessionException(layer, "network", "example.com");
		expect(removedNetwork.network?.allowedDomains).toBeUndefined();

		const removedCommand = withoutSessionException(layer, "command", "make");
		expect(removedCommand.excludedCommands).toBeUndefined();

		// Unrelated targets are left alone, and the input is not mutated.
		expect(withoutSessionException(layer, "write", "/elsewhere").filesystem?.allowWrite).toEqual(["."]);
		expect(layer.filesystem?.allowWrite).toEqual(["."]);
	});
});
