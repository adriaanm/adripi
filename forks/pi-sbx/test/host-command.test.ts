import { describe, expect, it } from "vitest";
import { checkPrefixRule, isBannedExecutable, parseHostCommand } from "../src/host-command.ts";

describe("parseHostCommand", () => {
	it("accepts one plain command and splits it into words", () => {
		const parsed = parseHostCommand("git push -u origin main");
		expect(parsed).toEqual({
			ok: true,
			command: { command: "git push -u origin main", argv: ["git", "push", "-u", "origin", "main"], executable: "git" },
		});
		expect(parseHostCommand("  gh pr view 42  ").ok).toBe(true);
		expect(parseHostCommand("git clone 'https://example.test/a b.git'").ok).toBe(true);
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
			'git push "$(whoami)"',
			"git push \"`whoami`\"",
			"git push & sleep 1",
			"! sh -c x",
			"SAFE=1 git push",
			"g?t push",
			"/tmp/{a,b} x",
			"git\u0000 push",
			"git push\ngit clone https://example.test/a/b",
			"git push \"unbalanced",
		]) {
			expect(parseHostCommand(command).ok, command).toBe(false);
		}
	});

	it("refuses interpreters and wrappers in every spelling", () => {
		for (const command of [
			"sh -c 'git push'",
			"bash -c x",
			'"/bin/sh" -c "git push"',
			"/bin/zsh -c 'git push'",
			"/usr/bin/env git push",
			"env git push",
			"sudo git push",
			"eval git push",
			"xargs git push",
			"python3.12 -c 'import os'",
			"/usr/local/bin/node -e x",
			"node20 x.js",
			"osascript -e 'tell app'",
			"find . -exec git push ';'",
		]) {
			const parsed = parseHostCommand(command);
			expect(parsed.ok, command).toBe(false);
		}
		expect(isBannedExecutable("/bin/sh")).toBe(true);
		expect(isBannedExecutable("'python3'")).toBe(true);
		expect(isBannedExecutable("git")).toBe(false);
		expect(isBannedExecutable("gh")).toBe(false);
	});

	it("allows literal values inside single quotes", () => {
		const parsed = parseHostCommand("git push '$HOME'");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.command.argv).toEqual(["git", "push", "$HOME"]);
	});

	it("refuses an empty command", () => {
		expect(parseHostCommand("   ")).toMatchObject({ ok: false, reason: "empty command" });
	});
});

describe("checkPrefixRule", () => {
	const command = parseHostCommand("git push -u origin main");
	if (!command.ok) throw new Error("fixture should be eligible");

	it("accepts a true categorical prefix of the current command", () => {
		expect(checkPrefixRule(command.command, ["git", "push"])).toEqual({ ok: true, pattern: "git push:*" });
		expect(checkPrefixRule(command.command, ["git"])).toEqual({ ok: true, pattern: "git:*" });
	});

	it("refuses a rule for another command", () => {
		expect(checkPrefixRule(command.command, ["git", "pull"]).ok).toBe(false);
		expect(checkPrefixRule(command.command, ["gh", "pr"]).ok).toBe(false);
		expect(checkPrefixRule(command.command, ["git", "push", "origin", "main", "extra"]).ok).toBe(false);
	});

	it("refuses patterns, metacharacters and banned heads", () => {
		for (const rule of [["git", "push*"], ["git push"], ["git", "push;rm"], ["bash"], ["/bin/sh"]]) {
			expect(checkPrefixRule(command.command, rule).ok, JSON.stringify(rule)).toBe(false);
		}
		expect(checkPrefixRule(command.command, []).ok).toBe(false);
		expect(checkPrefixRule(command.command, undefined)).toEqual({ ok: true });
	});
});
