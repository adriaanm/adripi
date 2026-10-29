import { describe, expect, it } from "vitest";
import { sandboxGuidance } from "../src/guidance.ts";

describe("sandbox guidance", () => {
  it("teaches Codex-shaped inline escalation, scoped first", () => {
    const text = sandboxGuidance({ scratchDir: "/tmp/scratch-abc", projectPolicyPath: ".pi/guardian.json" });
    // Inline, on the failing call: no request-then-rerun round trip.
    expect(text).toContain("do not message the user first");
    expect(text).toContain('sandbox_permissions: "with_additional_permissions"');
    expect(text).toContain("additional_permissions: { file_system:");
    expect(text).toContain("taken back afterwards");
    // Host tier and the standing-rule proposal.
    expect(text).toContain('sandbox_permissions: "require_escalated"');
    expect(text).toContain('prefix_rule: ["git", "push"]');
    expect(text).toContain("never a shell, interpreter, or rm");
    // The bare request tool for destinations and paths.
    expect(text).toContain("request_sandbox_exception({");
    expect(text).toContain("/tmp/scratch-abc");
    expect(text).toContain(".pi/guardian.json");
  });

  it("says denials are final and that circumvention is not a workaround", () => {
    const text = sandboxGuidance();
    expect(text).toContain("A denial is final for that target");
    expect(text).toContain("Never reach the same effect another way");
    expect(text).toContain("$PI_SANDBOX_SCRATCH");
    expect(text).not.toContain("project policy");
  });

  it("names the never-grantable credential stores", () => {
    const text = sandboxGuidance();
    for (const store of ["auth.json", "~/.config/gh", "~/.ssh", "~/.aws", "~/.gnupg"]) {
      expect(text).toContain(store);
    }
  });
});
