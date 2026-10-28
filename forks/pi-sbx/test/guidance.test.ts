import { describe, expect, it } from "vitest";
import { sandboxGuidance } from "../src/guidance.ts";

describe("sandbox guidance", () => {
  it("teaches the exception tool, the exact-target rule and the host-command path", () => {
    const text = sandboxGuidance({ scratchDir: "/tmp/scratch-abc", projectPolicyPath: ".pi/guardian.json" });
    expect(text).toContain("request_sandbox_exception({");
    expect(text).toContain('"read" | "write" | "network" | "command"');
    expect(text).toContain("one exact thing");
    expect(text).toContain("runs that exact string on the host");
    expect(text).toContain("no pipes, redirects, chaining, or interpreter prefixes");
    expect(text).toContain("next bash call");
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
