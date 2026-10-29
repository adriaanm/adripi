import { describe, expect, it } from "vitest";
import { planInlineEscalation } from "../src/inline-escalation.ts";

describe("inline escalation", () => {
  it("does nothing by default and rejects stray escalation fields", () => {
    expect(planInlineEscalation({})).toEqual({ kind: "none" });
    expect(planInlineEscalation({ sandbox_permissions: "use_default" })).toEqual({ kind: "none" });
    expect(planInlineEscalation({ justification: "why" }).kind).toBe("invalid");
    expect(planInlineEscalation({ prefix_rule: ["git", "pull"] }).kind).toBe("invalid");
  });

  it("requires a justification and turns a prefix rule into a standing rule", () => {
    expect(planInlineEscalation({ sandbox_permissions: "require_escalated" }).kind).toBe("invalid");
    expect(planInlineEscalation({ sandbox_permissions: "require_escalated", justification: "pull latest" })).toEqual({
      kind: "host",
      justification: "pull latest",
    });
    expect(
      planInlineEscalation({ sandbox_permissions: "require_escalated", justification: "push", prefix_rule: ["git", "push"] }),
    ).toEqual({ kind: "host", justification: "push", prefixRule: "git push:*" });
  });

  it("refuses prefix rules that would allow arbitrary execution", () => {
    for (const rule of [["bash"], ["python3"], ["rm"], ["sh", "-c"], ["git", "push && curl"]]) {
      const plan = planInlineEscalation({ sandbox_permissions: "require_escalated", justification: "x", prefix_rule: rule });
      expect(plan.kind, JSON.stringify(rule)).toBe("invalid");
    }
  });

  it("prefers widening the sandbox for specific paths", () => {
    expect(
      planInlineEscalation({
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
    expect(planInlineEscalation({ sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: { file_system: { read: ["relative/path"] } } }).kind).toBe("invalid");
    expect(planInlineEscalation({ sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: {} }).kind).toBe("invalid");
    // Network is per destination, not a boolean.
    expect(planInlineEscalation({ sandbox_permissions: "with_additional_permissions", justification: "x", additional_permissions: { network: { enabled: true } } }).kind).toBe("invalid");
  });
});
