import { describe, expect, it } from "vitest";
import { parseSupervisorDecision, supervisorQuestion } from "../src/supervisor-ask.ts";

describe("supervisor escalation", () => {
  it("asks for an explicit token and names the request", () => {
    const question = supervisorQuestion({
      surface: "command",
      target: "git push -u origin main",
      reason: "repin needs the host credential helper",
      cwd: "/home/u/proj",
    });
    expect(question).toContain("surface: command");
    expect(question).toContain("target: git push -u origin main");
    expect(question).toContain("project: /home/u/proj");
    expect(question).toContain("why: repin needs the host credential helper");
    expect(question).toContain("ALLOW session");
    expect(question).toContain("belongs to the user");
  });

  it("parses the token out of a supervisor reply", () => {
    expect(parseSupervisorDecision("**Reply from supervisor:**\nALLOW session")).toEqual({ kind: "allow", scope: "session" });
    expect(parseSupervisorDecision("ALLOW once")).toEqual({ kind: "allow", scope: "once" });
    expect(parseSupervisorDecision("allow")).toEqual({ kind: "allow", scope: "session" });
    expect(parseSupervisorDecision("**Reply from supervisor:**\nDENY\nnot now")).toEqual({ kind: "deny" });
  });

  it("treats anything else as no decision", () => {
    expect(parseSupervisorDecision("")).toBeUndefined();
    expect(parseSupervisorDecision("sure, go ahead")).toBeUndefined();
    expect(parseSupervisorDecision("the user is away, maybe later")).toBeUndefined();
    // A token must start the line, so prose that merely mentions it is ignored.
    expect(parseSupervisorDecision("I would not say ALLOW session here")).toBeUndefined();
  });
});
