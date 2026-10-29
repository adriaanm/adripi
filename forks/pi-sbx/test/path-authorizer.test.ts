import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DecideOptions, SandboxExceptionDecision } from "../src/broker.ts";
import type { HumanDecision, HumanRequest } from "../src/human-channel.ts";
import {
  authorizePathAction,
  mandatoryWriteBlock,
  pathActionAllowed,
  pathGrantFeasibility,
} from "../src/path-authorizer.ts";
import type { FilePolicy } from "../src/path-policy.ts";

function policy(root: string, overrides: Partial<FilePolicy> = {}): FilePolicy {
  return {
    denyRead: [],
    allowRead: [],
    allowWrite: [root],
    denyWrite: [],
    mandatoryDenyRead: [],
    mandatoryDenyWrite: [],
    ...overrides,
  };
}

function allowDecision(): SandboxExceptionDecision {
  return { kind: "allow", scope: "once", review: { rationale: "ok", source: "reviewer" } };
}

function deferredDecision(): SandboxExceptionDecision {
  return { kind: "defer", review: { rationale: "ask", source: "reviewer" } };
}

function recorder(decision: SandboxExceptionDecision) {
  const seen: DecideOptions[] = [];
  return {
    seen,
    decide: vi.fn(async (options: DecideOptions) => {
      seen.push(options);
      return decision;
    }),
  };
}

function human(decision: HumanDecision) {
  const seen: HumanRequest[] = [];
  return {
    seen,
    ask: vi.fn(async (request: HumanRequest) => {
      seen.push(request);
      return decision;
    }),
  };
}

describe("path grant feasibility", () => {
  it("treats a missing allow root as grantable but a deny list as final", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-feasible-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-auth-outside-"));
    const target = join(outside, "file.txt");
    const base = policy(root);
    expect(pathActionAllowed({ surface: "write", target, reason: "x" }, root, base)).toBe(false);
    expect(pathGrantFeasibility({ surface: "write", target, reason: "x" }, root, base)).toEqual({ ok: true });

    const denied = policy(root, { denyWrite: [join(outside, "*.txt")] });
    expect(pathGrantFeasibility({ surface: "write", target, reason: "x" }, root, denied).ok).toBe(false);
  });

  it("refuses a mandatory lexical alias even when the canonical target is free", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-alias-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-auth-alias-out-"));
    symlinkSync(outside, join(root, ".pi"));
    const base = policy(root, { mandatoryDenyWrite: [join(root, ".pi")] });
    const lexical = join(root, ".pi", "x");
    const target = join(outside, "x");
    expect(mandatoryWriteBlock(target, [lexical], root, base)).toBe(lexical);
    expect(pathGrantFeasibility({ surface: "write", target, aliases: [lexical], reason: "x" }, root, base).ok).toBe(false);
  });

  it("permits specific read carve-outs but never credentials or exact exclusions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-read-"));
    const secret = join(root, "secret");
    const credential = join(root, "token");
    const base = policy(root, { denyRead: [secret], mandatoryDenyRead: [credential] });
    expect(pathGrantFeasibility({ surface: "read", target: join(secret, "x"), reason: "x" }, root, base).ok).toBe(true);
    expect(pathGrantFeasibility({ surface: "read", target: secret, reason: "x" }, root, base).ok).toBe(false);
    const credentialResult = pathGrantFeasibility({ surface: "read", target: credential, reason: "x" }, root, base);
    expect(credentialResult.ok).toBe(false);
    if (!credentialResult.ok) expect(credentialResult.reason).toContain("never grantable");
  });
});

describe("authorizePathAction", () => {
  it("admits a baseline-allowed action without a review or a human question", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-allowed-"));
    const broker = recorder(allowDecision());
    const person = human({ kind: "allow", standing: false });
    const result = await authorizePathAction({ surface: "write", target: join(root, "ok"), reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: person,
      decide: broker.decide,
    });
    expect(result).toEqual({ kind: "allow", granted: false });
    expect(broker.decide).not.toHaveBeenCalled();
    expect(person.ask).not.toHaveBeenCalled();
  });

  it("passes an allowed one-call request through the broker with its action context", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-grant-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-grant-out-")), "x");
    const broker = recorder(allowDecision());
    const person = human({ kind: "allow", standing: false });
    const result = await authorizePathAction({
      surface: "write",
      target,
      reason: "build cache",
      origin: "tool",
      command: "make",
    }, { cwd: root, policy: policy(root), human: person, decide: broker.decide });
    expect(result).toEqual({ kind: "allow", granted: true });
    expect(broker.seen).toEqual([expect.objectContaining({
      surface: "write",
      target,
      scope: "once",
      origin: "tool",
      reason: "build cache",
      command: "make",
      cwd: root,
    })]);
    // A broker allow is not a human decision, so no question is asked.
    expect(person.ask).not.toHaveBeenCalled();
  });

  it("returns a broker denial without asking a human", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-deny-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-deny-out-")), "x");
    const broker = recorder({ kind: "deny", reason: "not allowed", review: { rationale: "no", source: "reviewer" } });
    const person = human({ kind: "allow", standing: false });
    const result = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: person,
      decide: broker.decide,
    });
    expect(result).toEqual({ kind: "deny", reason: "not allowed" });
    expect(person.ask).not.toHaveBeenCalled();
  });

  it("asks the one human adapter on a real defer and records the action once", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-defer-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-defer-out-")), "x");
    const broker = recorder(deferredDecision());
    const person = human({ kind: "allow", standing: false });
    const result = await authorizePathAction({ surface: "write", target, reason: "new file" }, {
      cwd: root,
      policy: policy(root),
      human: person,
      decide: broker.decide,
    });
    expect(result).toEqual({ kind: "allow", granted: true });
    expect(person.seen).toEqual([expect.objectContaining({
      surface: "write",
      target,
      reason: "new file",
      onceLabel: "Allow this one file change",
    })]);
    expect(person.seen[0]?.standingRule).toBeUndefined();
  });

  it("fails closed when the deferred question has no supported human channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-headless-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-headless-out-")), "x");
    const broker = recorder(deferredDecision());
    const person = human({ kind: "unavailable", reason: "no human approval channel is available in this mode" });
    const result = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: person,
      decide: broker.decide,
    });
    expect(result).toEqual({ kind: "deferred", reason: "no human approval channel is available in this mode" });
  });

  it("turns a human denial into a final refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-humandeny-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-humandeny-out-")), "x");
    const result = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: human({ kind: "deny", reason: "the user denied the sandbox exception" }),
      decide: recorder(deferredDecision()).decide,
    });
    expect(result).toEqual({ kind: "deny", reason: "the user denied the sandbox exception" });
  });

  it("denies when Guardian publishes no broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-nobroker-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-nobroker-out-")), "x");
    const result = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: human({ kind: "allow", standing: false }),
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") expect(result.reason).toContain("No guardian sandbox broker");
  });

  it("refuses a cancellation before review and after the human answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-cancel-"));
    const target = join(mkdtempSync(join(tmpdir(), "pi-sbx-auth-cancel-out-")), "x");
    const broker = recorder(allowDecision());
    const aborted = new AbortController();
    aborted.abort();
    const first = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      human: human({ kind: "allow", standing: false }),
      signal: aborted.signal,
      decide: broker.decide,
    });
    expect(first.kind).toBe("cancelled");
    expect(broker.decide).not.toHaveBeenCalled();

    const pending = new AbortController();
    const late = await authorizePathAction({ surface: "write", target, reason: "x" }, {
      cwd: root,
      policy: policy(root),
      signal: pending.signal,
      human: {
        ask: vi.fn(async () => {
          pending.abort();
          return { kind: "allow", standing: false } as const;
        }),
      },
      decide: recorder(deferredDecision()).decide,
    });
    expect(late.kind).toBe("cancelled");
  });

  it("checks mandatory reads before baseline allows and never asks for them", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-mandatory-read-"));
    const target = join(root, "credentials", "token");
    const broker = recorder(allowDecision());
    const person = human({ kind: "allow", standing: false });
    const result = await authorizePathAction({ surface: "read", target, reason: "x" }, {
      cwd: root,
      policy: policy(root, { denyRead: [join(root, "credentials")], allowRead: [target], mandatoryDenyRead: [join(root, "credentials")] }),
      human: person, decide: broker.decide,
    });
    expect(result.kind).toBe("deny");
    expect(broker.decide).not.toHaveBeenCalled();
    expect(person.ask).not.toHaveBeenCalled();
  });

  it("applies mandatory write locks only to writes, not to a denied read", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-readlock-"));
    const target = join(root, ".pi", "note.txt");
    const result = await authorizePathAction({ surface: "read", target, reason: "x" }, {
      cwd: root,
      policy: policy(root, { denyRead: [target], mandatoryDenyWrite: [join(root, ".pi")] }),
      human: human({ kind: "allow", standing: false }),
      decide: recorder(allowDecision()).decide,
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("read");
      expect(result.reason).not.toContain("writing");
    }
  });

  it("refuses mandatory and deny-listed writes before review or a human question", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-auth-locks-"));
    const locked = join(root, ".pi");
    const base = policy(root, { mandatoryDenyWrite: [locked], denyWrite: [join(root, "*.key")] });
    const broker = recorder(allowDecision());
    const person = human({ kind: "allow", standing: false });
    const context = { cwd: root, policy: base, human: person, decide: broker.decide };

    for (const target of [join(locked, "sandbox.json"), join(root, "private.key")]) {
      const result = await authorizePathAction({ surface: "write", target, reason: "x" }, context);
      expect(result.kind).toBe("deny");
    }
    expect(broker.decide).not.toHaveBeenCalled();
    expect(person.ask).not.toHaveBeenCalled();
  });
});
