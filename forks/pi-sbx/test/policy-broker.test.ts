import { afterEach, describe, expect, it } from "vitest";
import { getProjectPolicyService, PROJECT_POLICY_KEY, type ProjectPolicyService } from "../src/broker.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function publish(service: ProjectPolicyService) {
  const target = globalThis as Record<symbol, unknown>;
  target[PROJECT_POLICY_KEY] = service;
  disposers.push(() => delete target[PROJECT_POLICY_KEY]);
  return service;
}

describe("project policy service", () => {
  it("is absent when guardian is not loaded", () => {
    expect(getProjectPolicyService()).toBeUndefined();
  });

  it("hands a human-approved rule to guardian instead of writing policy itself", () => {
    const calls: string[] = [];
    const service = publish({
      path: "/work/project/.pi/guardian.json",
      persistRule: (rule) => {
        calls.push(rule);
        return { ok: true, path: "/work/project/.pi/guardian.json", hash: "abc", added: true };
      },
    });
    expect(getProjectPolicyService()).toBe(service);
    expect(service.path).toBe("/work/project/.pi/guardian.json");
    expect(service.persistRule("command:git push:*")).toEqual({
      ok: true,
      path: "/work/project/.pi/guardian.json",
      hash: "abc",
      added: true,
    });
    expect(calls).toEqual(["command:git push:*"]);
  });

  it("surfaces guardian's refusal verbatim", () => {
    const service = publish({ path: "/p/.pi/guardian.json", persistRule: () => ({ ok: false, reason: "permission denied" }) });
    const result = service.persistRule("command:git push:*");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("permission denied");
  });
});
