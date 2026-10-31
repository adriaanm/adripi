import { decideSandboxException, getGuardianBroker, type SandboxSurface } from "./broker.ts";
import type { HumanChannel, HumanRequest } from "./human-channel.ts";
import { parseHostCommand } from "./host-command.ts";
import { authorizePathAction, type PathAuthorization } from "./path-authorizer.ts";
import { canonicalizeTarget, resolveTarget, type FilePolicy } from "./path-policy.ts";

/**
 * The one parent decision route for a supervised child action, and the shared
 * implementation of the parent's own network and host-command decisions.
 *
 * A child asks the live parent; it never decides its own escalation and never
 * holds a permission store. Three rules keep the two sides from drifting:
 *
 *   1. the same broker (`decideSandboxException`) and the same serialized
 *      `HumanChannel` answer parent and child requests alike;
 *   2. those requests use the *parent's* cwd, because Guardian only reviews its
 *      own session's workspace — a child cwd there would be either a spoof or a
 *      silent borrow of another workspace's authority;
 *   3. the child's identity travels as evidence (`agentName` plus the reason the
 *      reviewer and human read), never as a claim of authority.
 *
 * Path decisions are not re-implemented here: they go through the shared
 * `authorizePathAction` with the child's prepared policy as a narrowing
 * `ceiling` and `admission: "always"`, so authority the parent holds but the
 * child ceiling does not is reviewed and admitted by the human, never
 * auto-allowed.
 */

/** Host-fixed child evidence attached to every child-originated request. */
export interface ChildIdentityEvidence {
  agent: string;
  index: number;
  runId: string;
}

export type ChildActionSurface = "read" | "write" | "network" | "command" | "tool";

export interface ChildAction {
  readonly surface: ChildActionSurface;
  readonly target: string;
  readonly reason: string;
}

/** Terminal outcomes only: an unfinished ask stays with the parent's own route. */
export type ChildActionOutcome = "allow" | "deny" | "unavailable" | "cancelled";

export interface ChildActionDecision {
  readonly outcome: ChildActionOutcome;
  readonly rationale?: string;
  readonly terminate?: boolean;
}

/** The parent baseline a decision is made against; re-read for every request. */
export interface ParentDecisionBaseline {
  /** The parent session cwd. Relative child targets resolve elsewhere; rules anchor here. */
  cwd: string;
  /** The parent's baseline file policy, never a command-scoped widening. */
  policy: FilePolicy;
  /** Host execution stays a parent policy: a child cannot turn it on. */
  allowUnsandboxedCommands: boolean;
}

export interface ParentDecisionRouteOptions {
  surface: SandboxSurface;
  target: string;
  origin?: "tool" | "trap";
  reason?: string;
  command?: string;
  violation?: string;
  /**
   * Produces a validated standing rule for the human to save. It is called only
   * when this decision actually reaches the human, so a reviewer/rule-allowed
   * action never spends a policy snapshot, and the snapshot is still taken
   * before the prompt.
   */
  offerStandingRule?: () => string | undefined;
  onceLabel?: string;
  child?: ChildIdentityEvidence;
}

/**
 * `defer-only` is the parent's own route: the broker decides, and only a defer
 * reaches the human. `always` is required for a child action outside the
 * parent's held scope: a reviewer's semantic allow cannot admit authority the
 * parent did not hold, so the human admits that one action.
 */
export type ParentAdmission = "defer-only" | "always";

export type ParentDecisionRoute =
  | { kind: "allow"; via: "rule" | "reviewer" | "human"; standing: boolean }
  /**
   * `via` names who refused. A human refusal stays attributed to the human: the
   * model must not read "guardian denied" for a decision the person made.
   */
  | { kind: "deny"; via: "rule" | "reviewer" | "human"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "cancelled"; reason: string };

export interface ParentDecisionContext {
  cwd: string;
  human: Pick<HumanChannel, "ask">;
  signal?: AbortSignal;
  /** Injected in tests; production asks the published Guardian broker. */
  decide?: typeof decideSandboxException;
}

const RATIONALE_LIMIT_BYTES = 512;

/** Keep one typed rationale inside the wire bound without splitting a character. */
export function boundedRationale(rationale: string): string {
  if (Buffer.byteLength(rationale, "utf8") <= RATIONALE_LIMIT_BYTES) return rationale;
  let truncated = "";
  let used = 0;
  for (const character of rationale) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > RATIONALE_LIMIT_BYTES) break;
    truncated += character;
    used += size;
  }
  return truncated;
}

function decision(outcome: ChildActionOutcome, rationale: string): ChildActionDecision {
  return Object.freeze({ outcome, rationale: boundedRationale(rationale) });
}

function cancelled(rationale: string): ParentDecisionRoute {
  return { kind: "cancelled", reason: rationale };
}

/** What the reviewer and human are told: the child's ask, named as the child's. */
export function childRequestReason(
  reason: string | undefined,
  child: ChildIdentityEvidence | undefined,
): string | undefined {
  if (!child) return reason;
  const ask = reason?.trim() ? reason.trim() : "no reason was given";
  return `child agent ${child.agent} #${child.index} (run ${child.runId}) asked: ${ask}`;
}

/**
 * One parent decision through the existing broker and human adapter. This is the
 * single route for the parent's network and host-command decisions as well, so
 * a child request cannot take a cheaper path than the parent's own.
 */
export async function decideWithParentRoute(
  request: ParentDecisionRouteOptions,
  context: ParentDecisionContext,
  admission: ParentAdmission = "defer-only",
): Promise<ParentDecisionRoute> {
  const { cwd, human, signal } = context;
  if (signal?.aborted) return cancelled("the sandbox approval was cancelled, so the action did not run");
  const decide = context.decide ?? decideSandboxException;
  const decisionResult = await decide({
    surface: request.surface,
    target: request.target,
    scope: "once",
    origin: request.origin ?? "tool",
    reason: childRequestReason(request.reason, request.child),
    command: request.command,
    violation: request.violation,
    cwd,
    agentName: request.child?.agent,
  });
  if (signal?.aborted) return cancelled("the sandbox approval was cancelled, so the action did not run");
  if (decisionResult.kind === "deny") {
    return { kind: "deny", via: decisionResult.review.source, reason: decisionResult.reason };
  }
  if (decisionResult.kind === "allow" && admission === "defer-only") {
    return { kind: "allow", via: decisionResult.review.source, standing: false };
  }

  // Only now is a standing rule relevant: ask the trusted snapshot service
  // immediately before the prompt, never for a connection or command the
  // reviewer already settled.
  const offered = request.offerStandingRule?.();
  const humanRequest: HumanRequest = {
    surface: request.surface,
    target: request.target,
    reason: childRequestReason(request.reason, request.child),
    standingRule: offered,
    onceLabel: request.onceLabel,
  };
  const answered = await human.ask(humanRequest, signal);
  if (signal?.aborted) return cancelled("the sandbox approval was cancelled, so the action did not run");
  if (answered.kind === "unavailable") return { kind: "unavailable", reason: answered.reason };
  // A standing answer without an offered rule is not a saving consent.
  if (answered.kind === "deny") return { kind: "deny", via: "human", reason: answered.reason };
  return { kind: "allow", via: "human", standing: answered.standing && offered !== undefined };
}

function routeDecision(route: ParentDecisionRoute, allowRationale: string): ChildActionDecision {
  switch (route.kind) {
    case "allow": return decision("allow", `${allowRationale} (${route.via})`);
    case "deny": return decision("deny", route.reason);
    case "unavailable": return decision("unavailable", route.reason);
    case "cancelled": return decision("cancelled", route.reason);
  }
}

function pathDecision(result: PathAuthorization): ChildActionDecision {
  switch (result.kind) {
    case "allow":
      return decision(
        "allow",
        result.granted
          ? "the parent admitted this path for one action after an explicit human decision"
          : "the path is inside both the parent's current authority and the delegated child policy",
      );
    case "deny": return decision("deny", result.reason);
    case "deferred": return decision("unavailable", result.reason);
    case "cancelled": return decision("cancelled", result.reason);
  }
}

export interface ChildActionContext {
  /** Required for exact-tool review; only the actual prepared provider binds this audience. */
  parentSessionId?: string;
  /** The host-bound child that asked. */
  identity: ChildIdentityEvidence;
  /** The child's assigned workspace: relative action targets resolve here. */
  childCwd: string;
  /** Current parent baseline, re-read by the caller for every request. */
  baseline: ParentDecisionBaseline;
  /**
   * The immutable policy this child was prepared with. It can only narrow the
   * parent baseline: anything outside it takes the review + human route.
   */
  ceiling: FilePolicy;
  human: Pick<HumanChannel, "ask">;
  signal?: AbortSignal;
  decide?: typeof decideSandboxException;
}

/**
 * Decide one child action against the current parent authority.
 *
 * Reads and writes reuse the parent's own path authorizer with the prepared
 * child policy as a ceiling and forced one-action human admission. A path both
 * policies hold needs no second store; a path only the parent holds — a
 * maintenance grant, the temp root, the session scratchpad, a sibling project —
 * is reviewed and then admitted by the human, never silently returned.
 */
export async function decideChildAction(
  action: ChildAction,
  context: ChildActionContext,
): Promise<ChildActionDecision> {
  if (context.signal?.aborted) return decision("cancelled", "the request was cancelled before it was decided");
  switch (action.surface) {
    case "read":
    case "write":
      return decideChildPathAction(action, context);
    case "network":
      return decideChildNetworkAction(action, context);
    case "command":
      return decideChildCommandAction(action, context);
    case "tool":
      return decideChildToolAction(action, context);
  }
}

async function decideChildToolAction(action: ChildAction, context: ChildActionContext): Promise<ChildActionDecision> {
  const broker = getGuardianBroker();
  if (!context.parentSessionId || !broker?.reviewTool) return decision("unavailable", "No parent exact-tool review authority is available; nothing was granted");
  try {
    const result = await broker.reviewTool({
      identity: { ...context.identity, parentSessionId: context.parentSessionId, cwd: context.childCwd },
      action: action.target,
      signal: context.signal,
    });
    if (context.signal?.aborted) return decision("cancelled", "The child tool review was cancelled before consumption");
    if (!result || !["allow", "deny", "unavailable", "cancelled"].includes(result.outcome) ||
        (result.rationale !== undefined && (typeof result.rationale !== "string" || result.rationale.includes("\0"))) ||
        (result.terminate !== undefined && typeof result.terminate !== "boolean") || (result.outcome === "allow" && result.terminate === true)) {
      return decision("unavailable", "The parent returned a malformed exact-tool verdict; nothing was granted");
    }
    return Object.freeze({ ...decision(result.outcome, result.rationale ?? "The parent decided this exact tool action"), ...(result.terminate ? { terminate: true } : {}) });
  } catch {
    return decision(context.signal?.aborted ? "cancelled" : "unavailable", "The parent exact-tool review failed; nothing was granted");
  }
}

async function decideChildPathAction(
  action: ChildAction,
  context: ChildActionContext,
): Promise<ChildActionDecision> {
  const surface = action.surface === "read" ? "read" : "write";
  // The child names a path in its own workspace; the decision is still made in
  // the parent's context below.
  const target = canonicalizeTarget(action.target, context.childCwd);
  const lexical = resolveTarget(action.target, context.childCwd);
  const result = await authorizePathAction({
    surface,
    target,
    aliases: lexical === target ? [] : [lexical],
    reason: childRequestReason(action.reason, context.identity) ?? action.reason,
    origin: "tool",
    violation: `the child asked for ${surface} access outside its delegated policy`,
    agentName: context.identity.agent,
  }, {
    cwd: context.baseline.cwd,
    policy: context.baseline.policy,
    ceiling: context.ceiling,
    admission: "always",
    human: context.human,
    signal: context.signal,
    decide: context.decide,
  });
  return pathDecision(result);
}

async function decideChildNetworkAction(
  action: ChildAction,
  context: ChildActionContext,
): Promise<ChildActionDecision> {
  // V1 deliberately routes every child connection through the parent's real
  // decision route: the payload carries no static network state, so a child can
  // never claim local network policy. That is an explicit intermediate limit,
  // not proof of network containment.
  const route = await decideWithParentRoute({
    surface: "network",
    target: action.target.trim(),
    origin: "tool",
    reason: action.reason,
    violation: "the child asked for a network destination outside its delegated policy",
    child: context.identity,
  }, { cwd: context.baseline.cwd, human: context.human, signal: context.signal, decide: context.decide });
  return routeDecision(route, "the parent admitted this connection for one use");
}

async function decideChildCommandAction(
  action: ChildAction,
  context: ChildActionContext,
): Promise<ChildActionDecision> {
  const { baseline } = context;
  // The host tier is the parent's own policy, and its shape gate runs before any
  // review: a child cannot widen either.
  if (!baseline.allowUnsandboxedCommands) {
    return decision("deny", "the parent's sandbox policy does not allow unsandboxed commands (allowUnsandboxedCommands is false)");
  }
  const parsed = parseHostCommand(action.target);
  if (!parsed.ok) return decision("deny", `host execution is not eligible: ${parsed.reason}`);
  const route = await decideWithParentRoute({
    surface: "command",
    target: parsed.command.command,
    origin: "tool",
    reason: action.reason,
    command: parsed.command.command,
    violation: "the child asked to run a command on the host",
    child: context.identity,
  }, { cwd: baseline.cwd, human: context.human, signal: context.signal, decide: context.decide });
  return routeDecision(route, "the parent admitted this host command for one execution");
}
