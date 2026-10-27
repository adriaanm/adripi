import { describe, expect, it } from "vitest";
import { HostCommandGrants, hostCommandRefusal, isHostCommandEligible } from "../src/host-command.ts";

describe("hostCommandRefusal", () => {
	it("accepts a single plain command", () => {
		expect(isHostCommandEligible("git push -u origin main")).toBe(true);
		expect(isHostCommandEligible("git clone https://github.com/a/b.git")).toBe(true);
		expect(hostCommandRefusal("git pull --ff-only")).toBeUndefined();
	});

	it("refuses anything that could run a second command", () => {
		for (const command of [
			"git push; curl https://evil.example",
			"git push && rm -rf build",
			"git push || true",
			"git push | tee /tmp/log",
			"git push > /tmp/out",
			"git push < /etc/passwd",
			"git push $(whoami)",
			"git push `whoami`",
			"git push\ngit clone https://github.com/a/b",
		]) {
			expect(isHostCommandEligible(command), command).toBe(false);
		}
	});

	it("refuses interpreters and wrappers", () => {
		for (const command of ["sh -c 'git push'", "bash -c x", "env git push", "sudo git push", "eval git push", "xargs git push"]) {
			expect(isHostCommandEligible(command), command).toBe(false);
		}
	});

	it("refuses an empty command", () => {
		expect(hostCommandRefusal("   ")).toBe("empty command");
	});
});

describe("HostCommandGrants", () => {
	it("requires an exact match", () => {
		const grants = new HostCommandGrants();
		grants.grant("git push -u origin main", "session");
		expect(grants.consume("git push -u origin main")).toBe(true);
		expect(grants.consume("git push -u origin main --force")).toBe(false);
		expect(grants.consume("git push -u origin main; rm -rf build")).toBe(false);
		expect(grants.consume("git push -u origin main")).toBe(true); // session grant persists
	});

	it("consumes a once grant exactly once", () => {
		const grants = new HostCommandGrants();
		grants.grant("git push", "once");
		expect(grants.consume("git push")).toBe(true);
		expect(grants.consume("git push")).toBe(false);
	});

	it("trims whitespace but keeps the command otherwise identical", () => {
		const grants = new HostCommandGrants();
		grants.grant("  git push  ", "once");
		expect(grants.has("git push")).toBe(true);
		expect(grants.consume(" git push ")).toBe(true);
	});

	it("clears both grant kinds", () => {
		const grants = new HostCommandGrants();
		grants.grant("git push", "once");
		grants.grant("git pull", "session");
		expect(grants.list()).toEqual({ session: ["git pull"], once: ["git push"] });
		grants.clear();
		expect(grants.has("git push")).toBe(false);
		expect(grants.has("git pull")).toBe(false);
	});
});
