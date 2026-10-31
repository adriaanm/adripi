import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decideChildAction,
  decideWithParentRoute,
  type ChildActionContext,
  type ParentDecisionBaseline,
} from "../src/action-authorizer.ts";
import {
  publishGuardianBrokerForTest,
  type SandboxExceptionDecision,
  type SandboxExceptionRequest,
} from "../src/broker.ts";
import { publishChildAuthority, type ChildAuthorityPublication } from "../src/child-authority.ts";
import { HumanChannel } from "../src/human-channel.ts";
import { projectChildRuntime } from "../src/child-runtime-policy.ts";
import { canWrite, createFilePolicy, type FilePolicy } from "../src/path-policy.ts";

/**
 * The child asks the live parent; these tests use the real Guardian broker slot,
 * the real serialized human channel, the real shared path authorizer and the
 * real prepared lease payload. Only the UI answer and the broker's own review
 * verdict are fixtures.
 *
 * The parent baseline is deliberately the *granted maintainer* shape this repo
 * installs (`agentDirWriteProjects` lifts the agent-dir write lock), because that
 * is where the child ceiling has to prove it narrows rather than merely echo.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-child-decision-")));
const AGENT_DIR = join(ROOT, "agent");
const AUTH = join(AGENT_DIR, "auth.json");
const AUDIT = join(AGENT_DIR, "guardian-sessions");
const CHILD_DIR = join(ROOT, "child");
const PARENT_SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-child-scratch-")));
const SIBLING = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-child-sibling-")));
mkdirSync(AUDIT, { recursive: true });
mkdirSync(CHILD_DIR, { recursive: true });
writeFileSync(AUTH, "{}\n");
const CHILD = realpathSync(CHILD_DIR);
const POLICY_PATH = join(ROOT, ".pi", "guardian.json");
const SANDBOX_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const GUARDIAN_ENTRY = fileURLToPath(new URL("../../pi-guardian/src/index.ts", import.meta.url));
const SESSION_ID = "session-1";
const IDENTITY = { agent: "worker", index: 0, runId: "run-1" };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface PolicyOverrides {
  allowWrite?: string[];
  allowRead?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  mandatoryDenyRead?: string[];
  mandatoryDenyWrite?: string[];
}

function filePolicy(overrides: PolicyOverrides): FilePolicy {
  return createFilePolicy({
    filesystem: {
      denyRead: overrides.denyRead ?? [],
      allowRead: overrides.allowRead ?? [],
      allowWrite: overrides.allowWrite ?? [ROOT],
      denyWrite: overrides.denyWrite ?? [],
    },
    mandatoryDenyRead: overrides.mandatoryDenyRead ?? [AUTH],
    mandatoryDenyWrite: overrides.mandatoryDenyWrite ?? [AUTH, AUDIT],
  });
}

/** The granted maintainer shape: the agent dir, the temp root and a sibling are all writable. */
function grantedBaseline(
  overrides: PolicyOverrides = {},
  extra: Partial<ParentDecisionBaseline> = {},
): ParentDecisionBaseline {
  const base = filePolicy({
    allowWrite: [ROOT, AGENT_DIR, SIBLING, tmpdir()],
    ...overrides,
  });
  return {
    cwd: ROOT, policy: base, allowUnsandboxedCommands: true,
    runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: {
      allowWrite: base.allowWrite, denyWrite: base.denyWrite, denyRead: base.denyRead, allowRead: base.allowRead,
    } },
    environmentDeny: [], ...extra,
  };
}

/** What a prepared payload reduces to for one workspace: a narrowing ceiling. */
function ceiling(workspace: string = CHILD): FilePolicy {
  return filePolicy({
    allowWrite: [workspace],
    mandatoryDenyWrite: [AUTH, AUDIT, join(workspace, ".pi")],
  });
}

const cleanup: Array<() => void> = [];

function humanContext(options: { hasUI?: boolean; select?: unknown } = {}): ExtensionContext {
  return {
    cwd: ROOT,
    mode: options.hasUI === false ? "print" : "tui",
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => false,
    executeTool: vi.fn(),
    ui: {
      select: options.select ?? vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function humanChannel(context: ExtensionContext): HumanChannel {
  const channel = new HumanChannel(() => context, () => POLICY_PATH);
  cleanup.push(() => channel.shutdown());
  return channel;
}

function publishBroker(decide?: (request: SandboxExceptionRequest) => Promise<SandboxExceptionDecision>) {
  const requests: SandboxExceptionRequest[] = [];
  const review = vi.fn(async (request: SandboxExceptionRequest) => {
    requests.push(request);
    return decide ? decide(request) : { kind: "allow", scope: "once", review: { rationale: "allowed in test", source: "reviewer" } } as SandboxExceptionDecision;
  });
  const unpublish = publishGuardianBrokerForTest({ review });
  const release = (): void => {
    const index = cleanup.indexOf(release);
    if (index >= 0) cleanup.splice(index, 1);
    unpublish();
  };
  cleanup.push(release);
  return { requests, review, release };
}

function childContext(overrides: Partial<ChildActionContext> = {}): ChildActionContext {
  return {
    identity: IDENTITY,
    childCwd: CHILD,
    baseline: grantedBaseline(),
    ceiling: ceiling(),
    networkCeiling: projectChildRuntime(grantedBaseline(), ROOT).network,
    hostCeiling: true,
    human: humanChannel(humanContext()),
    ...overrides,
  };
}

function publication(
  baselineRead: () => ParentDecisionBaseline | undefined,
  options: { select?: unknown } = {},
): ChildAuthorityPublication {
  const human = humanChannel(humanContext({ select: options.select }));
  const published = publishChildAuthority({
    sessionId: SESSION_ID,
    agentDir: AGENT_DIR,
    configDirName: ".pi",
    getSessionScratchDir: () => PARENT_SCRATCH,
    getBaseline: baselineRead,
    getHuman: () => human,
    // Real, canonical consumer files: a successful prepare requires them.
    requiredExtensions: [
      { id: "pi-sbx", path: SANDBOX_ENTRY },
      { id: "pi-guardian", path: GUARDIAN_ENTRY },
    ],
    // Registration is exercised by the registered-lifecycle tests; decisions
    // only need a satisfied registration.
    loadRegistration: async () => ({
      registerRequiredChildExtensions: (_input: unknown) => ({ dispose() {} }),
    }),
  });
  cleanup.push(() => published.dispose());
  return published;
}

function leaseFor(published: ChildAuthorityPublication, cwd: string = CHILD_DIR) {
  return published.provider.prepare({
    parentSessionId: SESSION_ID,
    runId: IDENTITY.runId,
    agent: IDENTITY.agent,
    index: IDENTITY.index,
    cwd,
  }, new AbortController().signal);
}

afterEach(() => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop()!;
    try { dispose(); } catch { /* disposal must not mask a failure */ }
  }
});

describe("child action decisions through the parent route", () => {
  it("allows what both the parent and the prepared ceiling hold without a second review", async () => {
    const broker = publishBroker();
    const context = childContext();
    const read = await decideChildAction({ surface: "read", target: join(ROOT, "notes.md"), reason: "read the task" }, context);
    const write = await decideChildAction({ surface: "write", target: join(CHILD, "out.md"), reason: "write the result" }, context);
    expect(read.outcome).toBe("allow");
    expect(write.outcome).toBe("allow");
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("denies a credential exclusion before any reviewer or human sees it", async () => {
    const broker = publishBroker();
    const select = vi.fn(async () => "Allow this one file read");
    const decision = await decideChildAction(
      { surface: "read", target: AUTH, reason: "inspect the token" },
      childContext({ human: humanChannel(humanContext({ select })) }),
    );
    expect(decision.outcome).toBe("deny");
    expect(decision.rationale).toContain("never grantable");
    expect(broker.review).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("asks the human for a path beyond the parent baseline even after a reviewer allow", async () => {
    const broker = publishBroker();
    const select = vi.fn(async () => "Allow this one file read");
    const decision = await decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({
        baseline: grantedBaseline({ denyRead: ["secret"] }),
        human: humanChannel(humanContext({ select })),
      }),
    );
    expect(decision.outcome).toBe("allow");
    expect(decision.rationale).toContain("human");
    expect(broker.review).toHaveBeenCalledOnce();
    // Parent-bound cwd and named child evidence: Guardian only reviews its own session.
    expect(broker.requests[0]).toMatchObject({
      surface: "read",
      cwd: ROOT,
      scope: "once",
      origin: "tool",
      agentName: "worker",
    });
    expect(broker.requests[0]!.reason).toContain("child agent worker #0 (run run-1)");
    expect(select).toHaveBeenCalledOnce();
  });

  it("treats a human denial as final for that one action only", async () => {
    publishBroker();
    const select = vi.fn(async () => "Deny");
    const denied = await decideChildAction(
      { surface: "write", target: join(ROOT, "elsewhere", "denied.md"), reason: "write outside" },
      childContext({
        baseline: grantedBaseline({ allowWrite: [CHILD] }),
        human: humanChannel(humanContext({ select })),
      }),
    );
    expect(denied.outcome).toBe("deny");
    expect(select).toHaveBeenCalledOnce();
  });

  it("returns unavailable instead of consent when no human transport exists", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const unavailable = await decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({
        baseline: grantedBaseline({ denyRead: ["secret"] }),
        human: humanChannel(humanContext({ hasUI: false })),
      }),
    );
    expect(unavailable.outcome).toBe("unavailable");
    expect(unavailable.rationale).toContain("no human approval channel");
  });

  it("denies when Guardian is missing", async () => {
    const noBroker = await decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secret"] }) }),
    );
    expect(noBroker.outcome).toBe("deny");
    expect(noBroker.rationale).toContain("No guardian sandbox broker");
  });

  it("denies when Guardian throws", async () => {
    publishBroker(async () => { throw new Error("reviewer exploded"); });
    const failed = await decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secret"] }) }),
    );
    expect(failed.outcome).toBe("deny");
    expect(failed.rationale).toContain("review failed");
  });

  it("denies a request Guardian refuses without asking the human", async () => {
    const broker = publishBroker(async () => ({ kind: "deny", reason: "not for a child", review: { rationale: "no", source: "reviewer" } }));
    const select = vi.fn(async () => "Allow this one file read");
    const denied = await decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secret"] }), human: humanChannel(humanContext({ select })) }),
    );
    expect(denied.outcome).toBe("deny");
    expect(denied.rationale).toBe("not for a child");
    expect(broker.review).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });

  it("propagates cancellation and never treats a late reviewer allow as consent", async () => {
    const held = deferred<SandboxExceptionDecision>();
    const broker = publishBroker(() => held.promise);
    const abort = new AbortController();
    const select = vi.fn(async () => "Allow this one file read");
    const pending = decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secret"] }), human: humanChannel(humanContext({ select })), signal: abort.signal }),
    );
    await vi.waitFor(() => expect(broker.review).toHaveBeenCalledOnce());
    abort.abort();
    held.resolve({ kind: "allow", scope: "once", review: { rationale: "late", source: "reviewer" } });
    const decision = await pending;
    expect(decision.outcome).toBe("cancelled");
    expect(select).not.toHaveBeenCalled();
  });

  it("cancels a human ask that is already open", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const asked = deferred<void>();
    const abort = new AbortController();
    const select = vi.fn((_title: string, _options: string[], options?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
      asked.resolve();
      options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const pending = decideChildAction(
      { surface: "read", target: join(ROOT, "secret", "plan.md"), reason: "read the plan" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secret"] }), human: humanChannel(humanContext({ select })), signal: abort.signal }),
    );
    await asked.promise;
    abort.abort();
    expect((await pending).outcome).toBe("cancelled");
  });

  it("decides a network destination through the same broker and human route", async () => {
    const broker = publishBroker(async () => ({ kind: "defer", review: { rationale: "unknown host", source: "reviewer" } }));
    const select = vi.fn(async () => "Allow this connection");
    const allowed = await decideChildAction(
      { surface: "network", target: "example.test:443", reason: "fetch the dependency" },
      childContext({ human: humanChannel(humanContext({ select })) }),
    );
    expect(allowed.outcome).toBe("allow");
    expect(broker.requests[0]).toMatchObject({ surface: "network", target: "example.test:443", cwd: ROOT, agentName: "worker" });
    expect(select).toHaveBeenCalledOnce();
    // One connection at a time, and no option to save a standing rule from a child ask.
    const humanOptions = (select.mock.calls[0] as unknown as [string, string[]])[1];
    expect(humanOptions).toEqual(["Allow this connection", "Deny"]);
  });

  it("keeps the host gate ahead of any review for a child command", async () => {
    const broker = publishBroker();
    const disabled = await decideChildAction(
      { surface: "command", target: "git push", reason: "publish the fix" },
      childContext({ baseline: grantedBaseline({}, { allowUnsandboxedCommands: false }) }),
    );
    expect(disabled.outcome).toBe("deny");
    expect(disabled.rationale).toContain("allowUnsandboxedCommands");

    const wrapper = await decideChildAction(
      { surface: "command", target: "/bin/sh -c 'git push'", reason: "publish the fix" },
      childContext(),
    );
    expect(wrapper.outcome).toBe("deny");
    expect(wrapper.rationale).toContain("not eligible");
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("reviews an eligible child command without offering a standing rule", async () => {
    const broker = publishBroker(async () => ({ kind: "defer", review: { rationale: "host work", source: "reviewer" } }));
    const select = vi.fn(async () => "Run once outside the sandbox");
    const allowed = await decideChildAction(
      { surface: "command", target: "git push -u origin main", reason: "publish the fix" },
      childContext({ human: humanChannel(humanContext({ select })) }),
    );
    expect(allowed.outcome).toBe("allow");
    expect(broker.requests[0]).toMatchObject({ surface: "command", target: "git push -u origin main", cwd: ROOT });
    const humanOptions = (select.mock.calls[0] as unknown as [string, string[]])[1];
    expect(humanOptions).toEqual(["Run once outside the sandbox", "Deny"]);
  });

  it("decides the parent's own route through the broker first, then the human", async () => {
    const broker = publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const select = vi.fn(async () => "Allow this connection");
    const human = humanChannel(humanContext({ select }));
    const route = await decideWithParentRoute({ surface: "network", target: "example.test:443", origin: "trap" }, { cwd: ROOT, human });
    expect(route).toMatchObject({ kind: "allow", via: "human" });
    expect(broker.requests[0]!.agentName).toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
  });

  it("prepares a standing-rule snapshot only when the connection reaches the human", async () => {
    const allowed = publishBroker();
    const offered = vi.fn(() => "network:example.test:443");
    const human = humanChannel(humanContext({ select: vi.fn(async () => "Allow this connection") }));
    const allowedRoute = await decideWithParentRoute({
      surface: "network",
      target: "example.test:443",
      origin: "trap",
      offerStandingRule: offered,
    }, { cwd: ROOT, human });
    expect(allowedRoute).toMatchObject({ kind: "allow", via: "reviewer" });
    expect(offered).not.toHaveBeenCalled();
    allowed.release();

    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const select = vi.fn(async () => "Always allow network:example.test:443");
    const deferredRoute = await decideWithParentRoute({
      surface: "network",
      target: "example.test:443",
      origin: "trap",
      offerStandingRule: offered,
    }, { cwd: ROOT, human: humanChannel(humanContext({ select })) });
    expect(offered).toHaveBeenCalledOnce();
    expect(deferredRoute).toMatchObject({ kind: "allow", via: "human", standing: true });
  });

  it("attributes a human refusal to the human, not to Guardian", async () => {
    publishBroker(async () => ({ kind: "defer", review: { rationale: "unsure", source: "reviewer" } }));
    const human = humanChannel(humanContext({ select: vi.fn(async () => "Deny") }));
    const route = await decideWithParentRoute({ surface: "network", target: "example.test:443", origin: "trap" }, { cwd: ROOT, human });
    expect(route).toMatchObject({ kind: "deny", via: "human" });
  });
});

describe("the prepared child ceiling cannot be widened by the parent baseline", () => {
  it("does not auto-allow a maintainer parent's agent-dir grant", async () => {
    const broker = publishBroker();
    const select = vi.fn(async () => "Deny");
    const context = childContext({
      baseline: grantedBaseline(),
      human: humanChannel(humanContext({ select })),
    });
    // The parent holds this write (granted agentDirWriteProjects shape); the child
    // ceiling does not. It must not return silently.
    const decide = await decideChildAction(
      { surface: "write", target: join(AGENT_DIR, "extensions", "sandbox.json"), reason: "maintain the profile" },
      context,
    );
    expect(decide.outcome).toBe("deny");
    expect(broker.review).toHaveBeenCalledOnce();
    expect(broker.requests[0]).toMatchObject({ surface: "write", cwd: ROOT, agentName: "worker" });
    expect(select).toHaveBeenCalledOnce();
  });

  it("does not auto-allow the parent's own scratchpad, temp root or a sibling root", async () => {
    const broker = publishBroker();
    const select = vi.fn(async () => "Deny");
    const context = childContext({
      baseline: grantedBaseline(),
      human: humanChannel(humanContext({ select })),
    });
    for (const target of [join(PARENT_SCRATCH, "x.md"), join(tmpdir(), "pi-sbx-child-temp.md"), join(SIBLING, "y.md")]) {
      const decide = await decideChildAction({ surface: "write", target, reason: "write outside the workspace" }, context);
      expect(decide.outcome, target).toBe("deny");
    }
    expect(broker.review).toHaveBeenCalledTimes(3);
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("still allows the workspace the ceiling actually holds", async () => {
    const broker = publishBroker();
    const decide = await decideChildAction(
      { surface: "write", target: join(CHILD, "out.md"), reason: "write the result" },
      childContext(),
    );
    expect(decide.outcome).toBe("allow");
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("keeps a mandatory ceiling exclusion final even in a granted project", async () => {
    const broker = publishBroker();
    const decide = await decideChildAction(
      { surface: "write", target: join(CHILD, ".pi", "sandbox.json"), reason: "widen my own sandbox" },
      childContext({ baseline: grantedBaseline({ allowWrite: [ROOT, AGENT_DIR, join(CHILD, ".pi")] }) }),
    );
    expect(decide.outcome).toBe("deny");
    expect(broker.review).not.toHaveBeenCalled();
  });
});

describe("current parent authority on every child request", () => {
  it("allows within held scope, then denies after the parent policy tightens", async () => {
    publishBroker();
    let current = grantedBaseline();
    const published = publication(() => current);
    const lease = await leaseFor(published);
    const target = join(CHILD, "out.md");
    expect((await lease.decide({ surface: "write", target, reason: "write the result" }, new AbortController().signal)).outcome).toBe("allow");
    current = grantedBaseline({ denyWrite: [CHILD] });
    const tightened = await lease.decide({ surface: "write", target, reason: "write the result" }, new AbortController().signal);
    expect(tightened.outcome).toBe("deny");
    expect(tightened.rationale).toContain("deny-write");
  });

  it("does not return a parent-held maintenance grant through a real prepared lease", async () => {
    const broker = publishBroker();
    const select = vi.fn(async () => "Deny");
    const published = publication(() => grantedBaseline(), { select });
    const lease = await leaseFor(published);
    const decision = await lease.decide(
      { surface: "write", target: join(AGENT_DIR, "extensions", "sandbox.json"), reason: "maintain the profile" },
      new AbortController().signal,
    );
    expect(decision.outcome).toBe("deny");
    // A real broker round-trip and a real human question, not a silent allow.
    expect(broker.review).toHaveBeenCalledOnce();
    expect(broker.requests[0]!.reason).toContain("child agent worker #0 (run run-1)");
    expect(select).toHaveBeenCalledOnce();
  });

  it("returns unavailable when the parent baseline stops being authoritative", async () => {
    publishBroker();
    let current: ParentDecisionBaseline | undefined = grantedBaseline();
    const published = publication(() => current);
    const lease = await leaseFor(published);
    current = undefined;
    const decision = await lease.decide({ surface: "read", target: join(ROOT, "notes.md"), reason: "read" }, new AbortController().signal);
    expect(decision.outcome).toBe("unavailable");
    await expect(leaseFor(published)).rejects.toThrow(/not initialized, valid and enabled/);
  });

  it("refuses a foreign session identity, an unheld workspace and an alias of the agent dir", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline({ allowWrite: [CHILD] }));
    await expect(published.provider.prepare({
      parentSessionId: "another-session",
      runId: "run-1",
      agent: "worker",
      index: 0,
      cwd: CHILD_DIR,
    }, new AbortController().signal)).rejects.toThrow(/foreign child authority identity/);
    await expect(published.provider.prepare({
      parentSessionId: SESSION_ID,
      runId: "run-1",
      agent: "worker",
      index: 0,
      cwd: join(ROOT, "outside"),
    }, new AbortController().signal)).rejects.toThrow(/outside the parent's writable scope/);

    const alias = join(ROOT, "child-alias");
    symlinkSync(AGENT_DIR, alias, "dir");
    await expect(published.provider.prepare({
      parentSessionId: SESSION_ID,
      runId: "run-1",
      agent: "worker",
      index: 0,
      cwd: alias,
    }, new AbortController().signal)).rejects.toThrow(/agent directory|mandatory deny-write path/);
  });

  it("refuses a workspace inside the granted agent dir or the parent scratchpad", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline());
    const agentChild = join(AGENT_DIR, "child");
    mkdirSync(agentChild, { recursive: true });
    await expect(leaseFor(published, agentChild)).rejects.toThrow(/agent directory or the parent's private scratchpad/);
    const scratchChild = join(PARENT_SCRATCH, "child");
    mkdirSync(scratchChild, { recursive: true });
    await expect(leaseFor(published, scratchChild)).rejects.toThrow(/agent directory or the parent's private scratchpad/);
  });

  it("revokes every lease when the provider is disposed", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published);
    expect(lease.signal.aborted).toBe(false);
    published.dispose();
    expect(lease.signal.aborted).toBe(true);
    const decision = await lease.decide({ surface: "read", target: join(ROOT, "notes.md"), reason: "read" }, new AbortController().signal);
    expect(decision.outcome).toBe("cancelled");
    await expect(leaseFor(published)).rejects.toThrow(/disposed/);
  });

  for (const phase of ["broker", "human"] as const) {
    it(`cancels a directly called prepared decision when revoked during ${phase} approval`, async () => {
      const entered = deferred<void>();
      const reviewed = deferred<SandboxExceptionDecision>();
      const answered = deferred<string>();
      publishBroker(async () => {
        if (phase === "broker") { entered.resolve(); return reviewed.promise; }
        return { kind: "allow", scope: "once", review: { rationale: "fixture", source: "reviewer" } };
      });
      const select = vi.fn(async () => { entered.resolve(); return answered.promise; });
      const published = publication(() => grantedBaseline(), { select });
      const lease = await leaseFor(published);
      const pending = lease.decide({ surface: "write", target: join(AGENT_DIR, "settings.json"), reason: "one child action" }, new AbortController().signal);
      await entered.promise;
      published.revoke("parent policy changed");
      reviewed.resolve({ kind: "allow", scope: "once", review: { rationale: "late fixture allow", source: "reviewer" } });
      answered.resolve("Allow this one file write");
      expect((await pending).outcome).toBe("cancelled");
      expect(select).toHaveBeenCalledTimes(phase === "broker" ? 0 : 1);
    });
  }

  it("revokes prepared leases on a policy reload without unpublishing the provider", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published);
    published.revoke("the parent sandbox policy changed");
    expect(lease.signal.aborted).toBe(true);
    const fresh = await leaseFor(published);
    expect(fresh.signal.aborted).toBe(false);
  });

  it("keeps the payload's own workspace ceiling and the parent's non-delegable grants apart", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published);
    expect(lease.payload.write.allow).toEqual([CHILD]);
    expect(lease.payload.write.mandatoryDeny).toContain(join(CHILD, ".pi"));
  });
});

describe("prepared runtime and asynchronous baseline consistency", () => {
  it("does not reopen prepared network or host denials after the parent loosens", async () => {
    const broker = publishBroker();
    let current = grantedBaseline({}, {
      runtime: { network: { allowedDomains: [], deniedDomains: ["*:443"] }, filesystem: { allowWrite: [ROOT], denyWrite: [], denyRead: [] } },
      allowUnsandboxedCommands: false,
    });
    const lease = await leaseFor(publication(() => current));
    current = grantedBaseline();
    expect((await lease.decide({ surface: "network", target: "example.com:443", reason: "fetch" }, new AbortController().signal)).outcome).toBe("deny");
    expect((await lease.decide({ surface: "command", target: "git status", reason: "host" }, new AbortController().signal)).outcome).toBe("deny");
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("cancels before human admission if baseline restrictions change during review", async () => {
    const reviewed = deferred<SandboxExceptionDecision>();
    const broker = publishBroker(() => reviewed.promise), select = vi.fn(async () => "Allow this connection");
    let current = grantedBaseline();
    const lease = await leaseFor(publication(() => current, { select }));
    const pending = lease.decide({ surface: "network", target: "example.com:443", reason: "fetch" }, new AbortController().signal);
    await vi.waitFor(() => expect(broker.review).toHaveBeenCalledOnce());
    current = grantedBaseline({}, { runtime: { network: { allowedDomains: [], deniedDomains: ["*:443"] }, filesystem: { allowWrite: [ROOT], denyWrite: [], denyRead: [] } } });
    reviewed.resolve({ kind: "allow", scope: "once", review: { source: "reviewer", rationale: "late semantic allow" } });
    expect((await pending).outcome).toBe("cancelled");
    expect(lease.signal.aborted).toBe(true); expect(select).not.toHaveBeenCalled();
  });

  it("cannot consume a late human full-host allow after host execution is disabled", async () => {
    publishBroker();
    const entered = deferred<void>(), answered = deferred<string>();
    const select = vi.fn(async () => { entered.resolve(); return answered.promise; });
    let current = grantedBaseline();
    const lease = await leaseFor(publication(() => current, { select }));
    const pending = lease.decide({ surface: "command", target: "git status", reason: "host" }, new AbortController().signal);
    await entered.promise;
    current = grantedBaseline({}, { allowUnsandboxedCommands: false });
    answered.resolve("Run once outside the sandbox");
    expect((await pending).outcome).toBe("cancelled"); expect(lease.signal.aborted).toBe(true);
  });

  for (const change of ["files", "environment", "sockets"] as const) {
    it(`requires a fresh runtime before semantic tool review after ${change} policy changes`, async () => {
      const broker = publishBroker(); let current = grantedBaseline();
      const lease = await leaseFor(publication(() => current));
      current = change === "files" ? grantedBaseline({ denyRead: [CHILD] }) : change === "environment" ?
        grantedBaseline({}, { environmentDeny: ["NEW_SECRET_NAME"] }) :
        grantedBaseline({}, { runtime: { network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true }, filesystem: { allowWrite: [ROOT], denyWrite: [], denyRead: [] } } });
      expect((await lease.decide({ surface: "tool", target: "{}", reason: "exact tool" }, new AbortController().signal)).outcome).toBe("cancelled");
      expect(lease.signal.aborted).toBe(true); expect(broker.review).not.toHaveBeenCalled();
    });
  }
});

describe("the child's own policy and metadata stay final", () => {
  it("denies a write to the child's own policy file and Git config through the live lease", async () => {
    publishBroker();
    const published = publication(() => grantedBaseline());
    const workspace = join(ROOT, "with-git");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    const canonical = realpathSync(workspace);
    const lease = await leaseFor(published, workspace);
    expect(lease.payload.write.allow).toContain(join(canonical, ".git"));
    const policyWrite = await lease.decide(
      { surface: "write", target: join(canonical, ".pi", "sandbox.json"), reason: "widen my own sandbox" },
      new AbortController().signal,
    );
    expect(policyWrite.outcome).toBe("deny");
    expect(policyWrite.rationale).toContain("mandatory deny-write path");
    const gitConfig = await lease.decide(
      { surface: "write", target: join(canonical, ".git", "config"), reason: "add a hook" },
      new AbortController().signal,
    );
    expect(gitConfig.outcome).toBe("deny");
  });

  it("anchors relative and glob rules at the parent cwd, not the child's", async () => {
    const broker = publishBroker();
    const context = childContext({ baseline: grantedBaseline({ denyRead: ["secrets/**"] }) });
    // `<child>/secrets/new.md` is not what the parent's rule denies; the rule names
    // `<parent-cwd>/secrets/**`, so the child keeps its own scope.
    const insideChild = await decideChildAction(
      { surface: "read", target: join(CHILD, "secrets", "new.md"), reason: "read a child file" },
      context,
    );
    expect(insideChild.outcome).toBe("allow");
    expect(broker.review).not.toHaveBeenCalled();
    // The parent's own denied glob still needs the parent's route.
    const select = vi.fn(async () => "Allow this one file read");
    const beyond = await decideChildAction(
      { surface: "read", target: join(ROOT, "secrets", "plan.md"), reason: "read a parent secret" },
      childContext({ baseline: grantedBaseline({ denyRead: ["secrets/**"] }), human: humanChannel(humanContext({ select })) }),
    );
    expect(beyond.outcome).toBe("allow");
    expect(beyond.rationale).toContain("human");
    expect(select).toHaveBeenCalledOnce();
  });
});

describe("prepared path anchors cannot be retargeted into fresh authority", () => {
  it("refuses a literal workspace name that would become a sibling-matching allow glob", async () => {
    const workspace = join(ROOT, "literal[ab]"); mkdirSync(workspace);
    const published = publication(() => grantedBaseline());
    await expect(leaseFor(published, workspace)).rejects.toThrow(/glob characters.*exact delegated root/);
  });

  it("refuses verified Git metadata whose literal name cannot preserve exact exclusions", async () => {
    const workspace = join(ROOT, "git-glob-workspace"), metadata = join(ROOT, "git[ab]");
    mkdirSync(workspace); mkdirSync(metadata); writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(metadata, join(workspace, ".git"));
    const published = publication(() => grantedBaseline());
    await expect(leaseFor(published, workspace)).rejects.toThrow(/Git metadata contains glob characters/);
  });

  it("keeps ordinary file creation and policy-prefix materialization inside the admitted namespace", async () => {
    const broker = publishBroker();
    const workspace = join(ROOT, "stable-prefix"), cache = join(workspace, "new-cache"); mkdirSync(workspace);
    const baseline = grantedBaseline({ allowRead: [cache] });
    const published = publication(() => baseline);
    const lease = await leaseFor(published, workspace);
    expect(lease.payload.anchor.paths).toContainEqual({ spelled: cache, canonical: cache });
    mkdirSync(cache); writeFileSync(join(cache, "file"), "ordinary data");
    expect((await lease.decide({ surface: "write", target: join(cache, "next"), reason: "ordinary file creation" }, new AbortController().signal)).outcome).toBe("allow");
    expect(lease.signal.aborted).toBe(false);
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("revalidates anchors after asynchronous review before asking the parent human", async () => {
    const reviewed = deferred<SandboxExceptionDecision>();
    const broker = publishBroker(() => reviewed.promise);
    const select = vi.fn(async () => "Allow this one file write");
    const workspace = join(ROOT, "retarget-during-review"); mkdirSync(workspace);
    const published = publication(() => grantedBaseline(), { select });
    const lease = await leaseFor(published, workspace);
    const pending = lease.decide({ surface: "write", target: join(SIBLING, "outside.txt"), reason: "one outside file" }, new AbortController().signal);
    expect(broker.review).toHaveBeenCalledOnce();
    rmdirSync(workspace); symlinkSync(SIBLING, workspace);
    reviewed.resolve({ kind: "allow", scope: "once", review: { source: "reviewer", rationale: "late semantic allow" } });
    expect((await pending).outcome).toBe("cancelled");
    expect(select).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(true);
  });

  it("revokes if the admitted workspace becomes a symlink to a parent-held sibling", async () => {
    const broker = publishBroker();
    const workspace = join(ROOT, "retarget-workspace");
    mkdirSync(workspace);
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published, workspace);
    rmdirSync(workspace);
    symlinkSync(SIBLING, workspace);
    const result = await lease.decide({ surface: "write", target: join(SIBLING, "escape.txt"), reason: "follow moved workspace" }, new AbortController().signal);
    expect(result.outcome).not.toBe("allow");
    expect(lease.signal.aborted).toBe(true);
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("revokes when a writable read-carveout alias is repointed into a prepared read denial", async () => {
    const broker = publishBroker();
    const workspace = join(ROOT, "retarget-carveout"), visible = join(workspace, "visible"), alias = join(workspace, "allowed");
    const denied = join(SIBLING, "sensitive");
    mkdirSync(join(visible, "sub"), { recursive: true }); mkdirSync(join(denied, "sub"), { recursive: true });
    symlinkSync(visible, alias);
    const baseline = grantedBaseline({ denyRead: [denied], allowRead: [join(alias, "sub")] });
    const published = publication(() => baseline);
    const lease = await leaseFor(published, workspace);
    unlinkSync(alias); symlinkSync(denied, alias);
    const result = await lease.decide({ surface: "read", target: join(denied, "sub", "data.txt"), reason: "follow writable carveout" }, new AbortController().signal);
    expect(result.outcome).not.toBe("allow");
    expect(lease.signal.aborted).toBe(true);
    expect(broker.review).not.toHaveBeenCalled();
  });
});

describe("exact parent tool review is not a sandbox exception", () => {
  const action = { surface: "tool" as const, target: JSON.stringify({ tool_name: "write", tool_call_id: "tool", cwd: CHILD, input: { path: "file", content: "界".repeat(3000) } }), reason: "review full runtime arguments" };

  it("fails closed on an absent or legacy broker and cannot invent a parent identity", async () => {
    const context = childContext({ parentSessionId: SESSION_ID });
    expect((await decideChildAction(action, context)).outcome).toBe("unavailable");
    const broker = publishBroker();
    expect((await decideChildAction(action, context)).outcome).toBe("unavailable");
    expect(broker.review).not.toHaveBeenCalled();
  });

  it("forwards exact content/host identity to the same broker without path grants or local UI", async () => {
    const review = vi.fn(async () => { throw new Error("no exception request belongs here"); });
    const reviewTool = vi.fn(async () => ({ outcome: "deny" as const, rationale: "parent semantic denial", terminate: true }));
    cleanup.push(publishGuardianBrokerForTest({ review, reviewTool }));
    const context = childContext({ parentSessionId: SESSION_ID });
    const result = await decideChildAction(action, context);
    expect(result).toMatchObject({ outcome: "deny", terminate: true });
    expect(reviewTool).toHaveBeenCalledWith({ action: action.target,
      identity: { ...IDENTITY, parentSessionId: SESSION_ID, cwd: CHILD }, signal: undefined });
    expect(canWrite(join(SIBLING, "file"), ROOT, context.ceiling)).toBe(false);
    expect(review).not.toHaveBeenCalled();
    expect((await decideChildAction(action, { ...context, parentSessionId: undefined })).outcome).toBe("unavailable");
    expect(reviewTool).toHaveBeenCalledOnce();
  });

  it("never accepts a malformed or contradictory tool verdict", async () => {
    for (const result of [{ outcome: "ALLOW" }, { outcome: "allow", terminate: true }, { outcome: "deny", terminate: "true" }, { outcome: "allow", rationale: 1 }]) {
      const dispose = publishGuardianBrokerForTest({ review: async () => { throw new Error("unexpected exception"); },
        reviewTool: async () => result as never });
      try { expect((await decideChildAction(action, childContext({ parentSessionId: SESSION_ID }))).outcome).toBe("unavailable"); }
      finally { dispose(); }
    }
  });

  it("revoking a prepared lease cancels a late exact-tool allow", async () => {
    const pending = deferred<{ outcome: "allow" }>();
    const reviewTool = vi.fn(() => pending.promise);
    cleanup.push(publishGuardianBrokerForTest({ review: async () => { throw new Error("unexpected exception"); }, reviewTool }));
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published);
    const decision = lease.decide(action, new AbortController().signal);
    expect(reviewTool).toHaveBeenCalledOnce();
    published.revoke("parent policy changed");
    pending.resolve({ outcome: "allow" });
    expect((await decision).outcome).toBe("cancelled");
  });
});

describe("payload bounds and immutability", () => {
  it("refuses a derived payload that cannot fit the transport bound", async () => {
    const values = Array.from({ length: 300 }, (_, index) => `deny-${index}`);
    const published = publication(() => grantedBaseline({ denyRead: values }));
    await expect(leaseFor(published)).rejects.toThrow(/at most 256 items/);
  });

  it("hands the child an immutable payload copy", async () => {
    const published = publication(() => grantedBaseline());
    const lease = await leaseFor(published);
    expect(Object.isFrozen(lease.payload)).toBe(true);
    expect(Object.isFrozen(lease.payload.write)).toBe(true);
    expect(Object.isFrozen(lease.payload.write.allow)).toBe(true);
    expect(() => { (lease.payload.write.allow as string[]).push("/tmp"); }).toThrow(TypeError);
  });
});
