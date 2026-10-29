import { describe, expect, it } from "vitest";
import { planInlineEscalation } from "../src/inline-escalation.ts";

const base = { command: "git push -u origin main" };

describe("inline escalation", () => {
  it("does nothing by default and rejects stray escalation fields", () => {
    expect(planInlineEscalation(base)).toEqual({ kind: "none" });
    expect(planInlineEscalation({ ...base, sandbox_permissions: "use_default" })).toEqual({ kind: "none" });
    expect(planInlineEscalation({ ...base, justification: "why" }).kind).toBe("invalid");
    expect(planInlineEscalation({ ...base, prefix_rule: ["git", "push"] }).kind).toBe("invalid");
  });

  it("requires a justification and binds a prefix rule to the current command", () => {
    expect(planInlineEscalation({ ...base, sandbox_permissions: "require_escalated" }).kind).toBe("invalid");
    const plan = planInlineEscalation({
      ...base,
      sandbox_permissions: "require_escalated",
      justification: "push the branch",
      prefix_rule: ["git", "push"],
    });
    expect(plan).toMatchObject({
      kind: "host",
      justification: "push the branch",
      prefixRule: "git push:*",
      command: { executable: "git" },
    });
    // A proposal for another command can never become a standing rule.
    expect(planInlineEscalation({
      ...base,
      sandbox_permissions: "require_escalated",
      justification: "x",
      prefix_rule: ["git", "pull"],
    }).kind).toBe("invalid");
  });

  it("refuses host shapes that would run a second command or an interpreter", () => {
    for (const command of [
      "git push\ngit clone https://example.test/a/b",
      "git push; curl https://example.test",
      "/bin/sh -c 'git push'",
      "python3 -c 'print(1)'",
    ]) {
      const plan = planInlineEscalation({ command, sandbox_permissions: "require_escalated", justification: "x" });
      expect(plan.kind, command).toBe("invalid");
    }
  });

  it("refuses prefix rules that would allow arbitrary execution", () => {
    for (const rule of [["bash"], ["python3"], ["rm"], ["sh", "-c"], ["git", "push && curl"]]) {
      const plan = planInlineEscalation({
        ...base,
        sandbox_permissions: "require_escalated",
        justification: "x",
        prefix_rule: rule,
      });
      expect(plan.kind, JSON.stringify(rule)).toBe("invalid");
    }
  });

  it("prefers widening the sandbox for specific paths", () => {
    expect(
      planInlineEscalation({
        ...base,
        sandbox_permissions: "with_additional_permissions",
        justification: "needs the go cache",
        additional_permissions: { file_system: { write: ["~/.cache/go-build"], read: ["/data"] } },
      }),
    ).toEqual({
      kind: "scoped",
      justification: "needs the go cache",
      targets: [
        { surface: "read", target: "/data" },
        { surface: "write", target: "~/.cache/go-build" },
      ],
    });
    // Relative paths and empty requests are rejected rather than guessed at.
    expect(planInlineEscalation({ ...base, sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: { file_system: { read: ["relative/path"] } } }).kind).toBe("invalid");
    expect(planInlineEscalation({ ...base, sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: {} }).kind).toBe("invalid");
    // Network is per destination, not a boolean.
    expect(planInlineEscalation({ ...base, sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: { file_system: {}, ...{ network: { enabled: true } } } }).kind).toBe("invalid");
    // A prefix rule belongs to the host tier.
    expect(planInlineEscalation({ ...base, sandbox_permissions: "with_additional_permissions", justification: "x", prefix_rule: ["git", "push"], additional_permissions: { file_system: { read: ["/data"] } } }).kind).toBe("invalid");
  });
});
