import { describe, expect, it } from "vitest";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { removeSandboxViolationTags, ViolationTracker } from "../src/violations.ts";

describe("violation tracking", () => {
  it("tracks recent violations and removes model-only tags", () => {
    const store = new SandboxViolationStore();
    const tracker = new ViolationTracker();
    tracker.start(store);
    store.addViolation({ line: "deny file-write", command: "test", timestamp: new Date() });
    expect(tracker.getTotal()).toBe(1);
    expect(tracker.getRecent()[0]?.line).toBe("deny file-write");
    expect(removeSandboxViolationTags("visible\n<sandbox_violations>\ndeny\n</sandbox_violations>")).toBe("visible");
    tracker.stop();
  });
});
