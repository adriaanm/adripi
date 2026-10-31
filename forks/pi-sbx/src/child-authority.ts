import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decideChildAction,
  type ChildAction,
  type ChildActionDecision,
  type ParentDecisionBaseline,
} from "./action-authorizer.ts";
import { decideSandboxException } from "./broker.ts";
import type { HumanChannel } from "./human-channel.ts";
import { childParentFilePolicy, loadChildDomainMatcher, projectChildRuntime, type ChildEnvironmentPolicy, type ChildIsolationPolicy, type ChildNetworkPolicy } from "./child-runtime-policy.ts";
import { mandatoryWriteBlock } from "./path-authorizer.ts";
import { canWrite, canonicalizeTarget, capturePolicyPathAnchor, isWithin, policyPathAnchorsUnchanged, resolveTarget, type FilePolicy } from "./path-policy.ts";

/**
 * The parent half of trusted child delegation.
 *
 * pi-subagents launches one native child process and hands it this provider's
 * lease over a host-created IPC channel. pi-sbx is the only publisher: it binds
 * the provider to the *live parent session*, derives a bounded policy payload
 * from the parent's **baseline** config, and decides every child action through
 * the parent's existing broker and human adapter.
 *
 * Publication is two-stage, and the order is the safety property: the provider
 * slot is published first (guard intent exists before any slow startup can
 * fail), then the parent session registers its mandatory child extensions with
 * pi-subagents. The registration is what makes every launch route — including
 * non-native runners and retained artifacts — demand pi-sbx and pi-guardian
 * rather than silently dropping them. It is sticky for the whole session:
 * revocation of authority refuses children, it never unregisters and reopens a
 * bare launch. Registration demands enforcement; it confers no authority.
 *
 * Two honest limits, because a provider is not a sandbox:
 *
 *   - A payload handed to a child is a statement of the parent's policy, not
 *     proof that a child enforces it. The child-side policy/Guardian consumers
 *     are a separate milestone; nothing here claims child containment.
 *   - A process that already holds a live child-authority lease must not publish
 *     root authority of its own. This module refuses that case (a runner child
 *     loads pi-sbx inside that lease scope), but a host which loads a child's
 *     extensions outside the lease scope is a launch-contract fault this side
 *     cannot see.
 */

export const CHILD_AUTHORITY_PROVIDER_KEY = Symbol.for("pi-sbx.session-authority.v1");
/** The provider contract version; a mismatch is refused, never adapted. */
export const CHILD_AUTHORITY_PROVIDER_VERSION = 2;
/** Extension ids that must load and acknowledge before a child may prompt at all. */
export const CHILD_AUTHORITY_REQUIRED_CONSUMERS = ["pi-sbx", "pi-guardian"] as const;

/**
 * The frozen pi-subagents slot that carries a live child lease through
 * `AsyncLocalStorage`, mirrored here (never imported) exactly as this package
 * already mirrors Guardian's broker slot. Code-only: no file, environment
 * variable or model message can enter it.
 */
const CHILD_AUTHORITY_LEASE_SLOT_KEY = Symbol.for("pi-subagents.child-authority-lease.v1");
const CHILD_AUTHORITY_LEASE_SLOT_VERSION = 1;

/** The co-installed launcher whose public registration API this provider calls. */
const LAUNCHER_PACKAGE = "pi-subagents";
const LAUNCHER_REGISTRATION_EXPORT = "./required-child-extensions";

/** Bounds mirrored from the transport contract; an oversized payload is refused, never truncated. */
export const CHILD_AUTHORITY_MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_PAYLOAD_DEPTH = 6;
const MAX_PAYLOAD_KEYS = 128;
const MAX_PAYLOAD_ITEMS = 256;
const MAX_PAYLOAD_STRING_BYTES = 8 * 1024;

export interface ChildAuthorityExtensionRequirement {
  id: string;
  path: string;
}

/** Host-bound audience plus the child-declared identity the host already fixed. */
export interface ChildAuthorityIdentity {
  parentSessionId: string;
  runId: string;
  agent: string;
  index: number;
  cwd: string;
}

export type ChildAuthorityPayloadValue =
  | string
  | number
  | boolean
  | null
  | readonly ChildAuthorityPayloadValue[]
  | { readonly [key: string]: ChildAuthorityPayloadValue };

export interface ChildAuthorityPayload {
  readonly [key: string]: ChildAuthorityPayloadValue;
}

export interface ChildAuthorityProviderLease {
  /** The parent's derived policy for this child; always this package's own payload shape. */
  readonly payload: ChildAuthorityPolicyPayload;
  readonly requiredConsumers: readonly string[];
  /** Aborted when this lease is revoked: the parent policy or the session is gone. */
  readonly signal: AbortSignal;
  decide(action: ChildAction, signal: AbortSignal): Promise<ChildActionDecision>;
  dispose(): void;
}

export interface ChildAuthorityProvider {
  readonly version: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
  readonly sessionId: string;
  readonly requiredExtensions: readonly ChildAuthorityExtensionRequirement[];
  prepare(identity: ChildAuthorityIdentity, signal: AbortSignal): Promise<ChildAuthorityProviderLease>;
}

/**
 * The launcher's public registration API, mirrored from
 * `pi-subagents/required-child-extensions` (never imported statically: pi-sbx
 * has no dependency on the launcher). Registration lives in a process-global,
 * versioned registry keyed by session, so a separately loaded copy of that
 * module still shares one store with the launch path.
 */
export interface RequiredChildExtensionRegistration {
  dispose(): void;
}

export interface ChildAuthorityRegistrationApi {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: readonly ChildAuthorityExtensionRequirement[];
    requireForAllRunners?: boolean;
  }): RequiredChildExtensionRegistration;
}

/** The installed launcher package is absent: no child launch exists to guard. */
export class ChildAuthorityLauncherMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildAuthorityLauncherMissingError";
  }
}

/**
 * The parent's derived policy for one child. Writes are an explicit allowlist
 * (assigned workspace plus separately verified Git metadata); reads stay
 * deny-based. `anchor.cwd` is the parent baseline cwd: every relative or glob
 * entry resolves against it, never against the child's cwd.
 */
export interface ChildAuthorityPolicyPayload extends ChildAuthorityPayload {
  readonly version: typeof CHILD_AUTHORITY_PROVIDER_VERSION;
  readonly kind: "pi-sbx.child-policy";
  readonly anchor: { readonly cwd: string; readonly paths: readonly { readonly spelled: string; readonly canonical: string }[] };
  readonly workspace: { readonly spelled: string; readonly canonical: string };
  readonly read: {
    readonly policy: "deny-based";
    readonly deny: readonly string[];
    readonly allow: readonly string[];
    readonly mandatoryDeny: readonly string[];
  };
  readonly write: {
    readonly policy: "allowlist";
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly mandatoryDeny: readonly string[];
  };
  readonly network: ChildNetworkPolicy;
  readonly environment: ChildEnvironmentPolicy;
  readonly isolation: ChildIsolationPolicy;
  readonly command: { readonly policy: "parent-decision"; readonly allowHost: boolean };
}

export interface ChildAuthorityPublication {
  readonly provider: ChildAuthorityProvider;
  /**
   * Settles when the session's mandatory child-extension registration is live,
   * or rejects when it could not be established. The provider slot stays
   * published either way, so a bare (unguarded) launch never reappears; `prepare`
   * refuses until this settles and whenever it failed.
   */
  readonly ready: Promise<void>;
  /** Revoke every live lease; the provider and the registration stay in place. */
  revoke(reason: string): void;
  /** Revoke and remove the provider slot, then release our own registration. */
  dispose(): void;
}

export interface ChildAuthorityPublishOptions {
  /** The live parent session id, fixed by the host. */
  sessionId: string;
  /** The agent directory, used to resolve the installed Guardian entrypoint. */
  agentDir: string;
  /** The project config directory name (`.pi`): the child's own policy stays deny-write. */
  configDirName: string;
  /**
   * This session's scratchpad, read live: guard intent is published before the
   * scratchpad exists. It is a parent-session grant, not a delegable one — the
   * child gets its own private scratch only from its own runtime.
   */
  getSessionScratchDir?: () => string | undefined;
  /** The parent's current baseline, or undefined when it is not authoritative. */
  getBaseline(): ParentDecisionBaseline | undefined;
  /** The one serialized human adapter shared with every other surface. */
  getHuman(): Pick<HumanChannel, "ask">;
  /** Injected in tests; production asks the published Guardian broker. */
  decide?: typeof decideSandboxException;
  /** Injected in tests; production resolves the two installed extension entrypoints. */
  requiredExtensions?: readonly ChildAuthorityExtensionRequirement[];
  /** Injected in tests; production loads the installed launcher's public export. */
  loadRegistration?: (agentDir: string) => Promise<ChildAuthorityRegistrationApi>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * A live child lease in this process means this process *is* a delegated child:
 * it may consume its parent's authority, never publish a second root of its own.
 */
function liveChildAuthorityLease(): boolean {
  const slot = (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_LEASE_SLOT_KEY];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
  const record = slot as { version?: unknown; storage?: { getStore?: () => unknown } };
  if (record.version !== CHILD_AUTHORITY_LEASE_SLOT_VERSION) return false;
  if (typeof record.storage?.getStore !== "function") return false;
  return record.storage.getStore() !== undefined;
}

/**
 * The two extension entrypoints a child must actually load: this sandbox, and
 * the reviewer that owns the exception broker. pi-sbx resolves its own loaded
 * entrypoint; Guardian is the co-installed package beside it.
 *
 * Called only after guard intent is published. A path that cannot be
 * canonicalized keeps its absolute spelling; activate() catches missing or
 * malformed paths and fails registration (and therefore every prepare())
 * instead of leaving the session looking bare.
 */
export function resolveChildAuthorityExtensionPaths(agentDir: string): ChildAuthorityExtensionRequirement[] {
  return [
    { id: "pi-sbx", path: canonicalOrSpelled(fileURLToPath(new URL("./index.ts", import.meta.url))) },
    { id: "pi-guardian", path: canonicalOrSpelled(join(agentDir, "npm", "node_modules", "pi-guardian", "src", "index.ts")) },
  ];
}

function canonicalOrSpelled(path: string): string {
  return realpathOrSelf(path);
}

/** A required consumer must be an actual, canonical file before registration. */
function verifyExtensionFiles(extensions: readonly ChildAuthorityExtensionRequirement[]): void {
  for (const extension of extensions) {
    try {
      if (statSync(extension.path).isFile()) continue;
    } catch {
      // Fall through to the refusal below.
    }
    throw new Error(
      `child authority requires the ${extension.id} extension entrypoint at ${extension.path}, which is not an installed file; ` +
      "child delegation is refused instead of launching a child that cannot load its required consumers",
    );
  }
}

function extensionSnapshot(
  extensions: readonly ChildAuthorityExtensionRequirement[],
): readonly ChildAuthorityExtensionRequirement[] {
  const ids = new Set<string>();
  const paths = new Set<string>();
  return Object.freeze(extensions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "path")) {
      throw new Error("child authority required extensions accept only an id and an absolute path");
    }
    const { id, path } = entry as { id?: unknown; path?: unknown };
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new Error("child authority required extension ids must be safe host-owned identifiers");
    }
    if (typeof path !== "string" || /[*?[]/.test(path) || path.includes("\0")) {
      throw new Error(`child authority required extension '${id}' needs an exact path`);
    }
    if (!isAbsolute(path) || path.trim() !== path || Buffer.byteLength(path, "utf8") > 4096) {
      throw new Error(`child authority required extension '${id}' needs an absolute path of at most 4096 bytes`);
    }
    if (ids.has(id)) throw new Error(`child authority required extension id '${id}' is duplicated`);
    if (paths.has(path)) throw new Error(`child authority required extension path '${path}' is duplicated`);
    ids.add(id);
    paths.add(path);
    return Object.freeze({ id, path });
  }));
}

function requireConsumersWithinExtensions(extensions: readonly ChildAuthorityExtensionRequirement[]): void {
  const ids = new Set(extensions.map((entry) => entry.id));
  const missing = CHILD_AUTHORITY_REQUIRED_CONSUMERS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw new Error(`child authority requires the consumers ${missing.join(", ")} to be loaded extensions; child delegation is refused`);
  }
}

interface VerifiedGitMetadata {
  root: string;
  aliases: string[];
  mandatoryDeny: string[];
}

function gitMetadataCandidates(workspace: string): VerifiedGitMetadata[] {
  const dotGit = join(workspace, ".git");
  const deny = (root: string): string[] => [
    join(root, "config"),
    // `config.worktree` carries the same hooks/alias surface as `config`.
    join(root, "config.worktree"),
    join(root, "hooks"),
  ];
  const spelled = isDirectory(dotGit) ? dotGit : readGitDirPointer(dotGit);
  if (!spelled) return [];
  const root = canonicalizeTarget(spelled, workspace);
  const aliases = root === spelled ? [] : [spelled];
  return [{ root, aliases, mandatoryDeny: unique([root, ...aliases].flatMap(deny)) }];
}

/**
 * A linked worktree (or submodule) keeps a `.git` file that points at the real
 * git dir. Only a pointer to an existing directory that looks like git metadata
 * is followed; a malformed or invented target admits nothing.
 */
function readGitDirPointer(dotGit: string): string | undefined {
  if (!existsSync(dotGit)) return undefined;
  let content: string;
  try {
    content = readFileSync(dotGit, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (!match?.[1]) return undefined;
  const gitDir = resolve(dirname(dotGit), match[1].trim());
  if (!isDirectory(gitDir)) return undefined;
  if (!existsSync(join(gitDir, "HEAD")) && !existsSync(join(gitDir, "commondir"))) return undefined;
  return gitDir;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export interface DeriveChildPolicyInput {
  baseline: ParentDecisionBaseline;
  identity: Pick<ChildAuthorityIdentity, "cwd">;
  configDirName: string;
  /** The agent directory: a maintenance grant is never a child's launch scope. */
  agentDir: string;
  /** A parent-session-only grant (its scratchpad) that must not be delegated. */
  sessionScratchDir?: string;
}

export interface DerivedChildPolicy {
  payload: ChildAuthorityPolicyPayload;
  /** The canonical workspace the child was admitted for. */
  workspace: string;
}

/**
 * Derive one child's policy from the parent's current baseline.
 *
 * Refusals happen here, before any review: a workspace the parent does not hold
 * is not delegated (this milestone asks the human for a child *launch* scope
 * only through a policy the human already wrote, not through a reviewer), a
 * workspace inside the agent directory or the parent's scratchpad is a parent
 * capability rather than launch scope, and mandatory credential/audit/own-policy
 * locks are never lifted. Git metadata is
 * added only when it is verified for this workspace *and* already held by the
 * parent; otherwise the child simply gets the workspace and no git write scope.
 */
export function deriveChildPolicy(input: DeriveChildPolicyInput): DerivedChildPolicy {
  const baseline = { ...input.baseline, policy: childParentFilePolicy(input.baseline) };
  const spelled = resolveTarget(input.identity.cwd, baseline.cwd);
  const workspace = canonicalizeTarget(input.identity.cwd, baseline.cwd);
  const aliases = spelled === workspace ? [] : [spelled];
  // This matcher/runtime contract cannot represent literal glob characters as
  // exact allow roots. Never turn one assigned directory into a sibling glob.
  if ([workspace, ...aliases].some(path => /[*?[]/.test(path))) {
    throw new Error("the child workspace contains glob characters and cannot be expressed as an exact delegated root");
  }
  const locked = mandatoryWriteBlock(workspace, aliases, baseline.cwd, baseline.policy);
  if (locked) {
    throw new Error(
      `the child workspace ${input.identity.cwd} resolves to ${locked}, a mandatory deny-write path (credentials, audit, policy); no child write authority can be delegated there`,
    );
  }
  // A maintainer parent may write the agent dir and its own scratchpad; neither is
  // launch authority for a child, whatever spelling or alias the proposal uses.
  const excluded = [input.agentDir, input.sessionScratchDir]
    .filter((root): root is string => Boolean(root))
    .map((root) => canonicalizeTarget(root, baseline.cwd));
  for (const candidate of [workspace, ...aliases]) {
    const excludedRoot = excluded.find((root) => isWithin(candidate, root) || isWithin(root, candidate));
    if (excludedRoot) {
      throw new Error(
        `the child workspace ${input.identity.cwd} overlaps ${excludedRoot}, which is the agent directory or the parent's private scratchpad; ` +
        "that is a parent-session capability, not a delegable child launch scope",
      );
    }
  }

  const held = [workspace, ...aliases].filter((candidate) => canWrite(candidate, baseline.cwd, baseline.policy));
  if (held.length !== 1 + aliases.length) {
    throw new Error(
      `the child workspace ${input.identity.cwd} is outside the parent's writable scope, so this milestone has no held write authority to delegate; ` +
      "add the project to the parent's policy or refuse the launch",
    );
  }

  const discoveredGit = gitMetadataCandidates(workspace);
  if (discoveredGit.some(candidate => [candidate.root, ...candidate.aliases].some(path => /[*?[]/.test(path)))) {
    throw new Error("verified Git metadata contains glob characters; required exclusions cannot be expressed exactly");
  }
  const git = discoveredGit
    // Already-held is necessary, not sufficient: a Git pointer/commondir must
    // never launder the parent's maintenance or private-scratch capability.
    .filter(candidate => [candidate.root, ...candidate.aliases].every(path =>
      !excluded.some(root => isWithin(path, root) || isWithin(root, path))))
    .filter((candidate) => !mandatoryWriteBlock(candidate.root, candidate.aliases, baseline.cwd, baseline.policy))
    .filter((candidate) => [candidate.root, ...candidate.aliases].every((path) => canWrite(path, baseline.cwd, baseline.policy)));

  const runtime = projectChildRuntime(baseline, baseline.cwd);
  const payload: ChildAuthorityPolicyPayload = {
    version: CHILD_AUTHORITY_PROVIDER_VERSION,
    kind: "pi-sbx.child-policy",
    anchor: { cwd: baseline.cwd, paths: [] },
    workspace: { spelled: input.identity.cwd, canonical: workspace },
    read: {
      policy: "deny-based",
      deny: unique(baseline.policy.denyRead),
      // The parent's own scratchpad is a session grant, not a child capability.
      allow: unique(baseline.policy.allowRead.filter((entry) => entry !== input.sessionScratchDir)),
      mandatoryDeny: unique(baseline.policy.mandatoryDenyRead),
    },
    write: {
      policy: "allowlist",
      allow: unique([workspace, ...git.map((candidate) => candidate.root)]),
      deny: unique(baseline.policy.denyWrite),
      mandatoryDeny: unique([
        ...baseline.policy.mandatoryDenyWrite,
        join(workspace, input.configDirName),
        ...discoveredGit.flatMap((candidate) => candidate.mandatoryDeny),
      ]),
    },
    ...runtime,
    command: { policy: "parent-decision", allowHost: baseline.allowUnsandboxedCommands },
  };
  const paths = [baseline.cwd, spelled, workspace,
    ...payload.read.deny, ...payload.read.allow, ...payload.read.mandatoryDeny,
    ...payload.write.allow, ...payload.write.deny, ...payload.write.mandatoryDeny,
    ...git.flatMap(candidate => [candidate.root, ...candidate.aliases]),
    // Retain spellings too: canonicalizing a socket ceiling once is not proof
    // that its alias still names the same held namespace later.
    ...(baseline.runtime.network.allowUnixSockets ?? []), ...runtime.network.unixSocketCeiling.roots];
  const anchors = [...new Map(paths.map(path => {
    const anchor = capturePolicyPathAnchor(path, baseline.cwd);
    return [anchor.spelled, anchor] as const;
  })).values()];
  const anchored = { ...payload, anchor: { ...payload.anchor, paths: anchors } };
  return { payload: boundedPayload(anchored) as ChildAuthorityPolicyPayload, workspace };
}

/**
 * Validate the payload against the transport bounds and return an immutable
 * deep copy. An oversized payload is a refusal: a truncated policy would let a
 * child believe it holds less than the parent stated.
 */
export function boundedPayload(value: unknown): ChildAuthorityPayload {
  assertBounded(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > CHILD_AUTHORITY_MAX_PAYLOAD_BYTES) {
    throw new Error(`the derived child policy exceeds ${CHILD_AUTHORITY_MAX_PAYLOAD_BYTES} bytes; child authority is refused`);
  }
  return deepFreeze(JSON.parse(serialized) as ChildAuthorityPayload);
}

function assertBounded(value: unknown, depth: number): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("child policy numbers must be finite");
    return;
  }
  if (typeof value === "string") {
    if (value.includes("\0")) throw new Error("child policy strings must not contain NUL");
    if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_STRING_BYTES) throw new Error("child policy strings must be at most 8192 bytes");
    return;
  }
  if (typeof value !== "object") throw new Error("child policy accepts only JSON values");
  if (depth >= MAX_PAYLOAD_DEPTH) throw new Error(`child policy must nest at most ${MAX_PAYLOAD_DEPTH} levels`);
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ITEMS) throw new Error(`child policy arrays hold at most ${MAX_PAYLOAD_ITEMS} items`);
    for (const item of value) assertBounded(item, depth + 1);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PAYLOAD_KEYS) throw new Error(`child policy objects hold at most ${MAX_PAYLOAD_KEYS} keys`);
  for (const [key, item] of entries) {
    if (!key || key.includes("\0")) throw new Error("child policy keys must be non-empty and without NUL");
    assertBounded(item, depth + 1);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function requireIdentity(value: unknown, sessionId: string): ChildAuthorityIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("child authority requires the host-bound identity object");
  }
  const record = value as Partial<ChildAuthorityIdentity>;
  if (record.parentSessionId !== sessionId) {
    throw new Error(
      `foreign child authority identity: session '${String(record.parentSessionId)}' is not this provider's session '${sessionId}'`,
    );
  }
  if (typeof record.runId !== "string" || !record.runId.trim()) throw new Error("child authority requires the host-fixed run id");
  if (typeof record.agent !== "string" || !record.agent.trim()) throw new Error("child authority requires the child agent name");
  if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) {
    throw new Error("child authority requires the child index as a non-negative integer");
  }
  if (typeof record.cwd !== "string" || !isAbsolute(record.cwd) || record.cwd.includes("\0")) {
    throw new Error("child authority requires the child workspace as an absolute path without NUL");
  }
  return Object.freeze({
    parentSessionId: sessionId,
    runId: record.runId,
    agent: record.agent,
    index: record.index,
    cwd: record.cwd,
  });
}

/**
 * The prepared payload as an immutable narrowing policy. A decision must be
 * admitted by this *and* the current parent baseline; the ceiling never grants
 * anything the parent has stopped holding (the parent policy decides that).
 */
function childPolicyCeiling(payload: ChildAuthorityPolicyPayload): FilePolicy {
  return Object.freeze({
    denyRead: [...payload.read.deny],
    allowRead: [...payload.read.allow],
    mandatoryDenyRead: [...payload.read.mandatoryDeny],
    allowWrite: [...payload.write.allow],
    denyWrite: [...payload.write.deny],
    mandatoryDenyWrite: [...payload.write.mandatoryDeny],
  });
}

/** Private consistency evidence, never an approval cache or serialized grant.
 * Tool review must not bless locally enforced Bash/native scope after the parent
 * baseline changed; a fresh child is required instead of keeping stale SRT. */
function baselineStamp(baseline: ParentDecisionBaseline): string {
  return JSON.stringify({ cwd: baseline.cwd, policy: childParentFilePolicy(baseline),
    allowHost: baseline.allowUnsandboxedCommands, ...projectChildRuntime(baseline, baseline.cwd) });
}

interface LiveLease {
  readonly controller: AbortController;
  disposed: boolean;
}

function exportedEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { default?: unknown; import?: unknown };
  for (const candidate of [record.default, record.import]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/**
 * Load the installed launcher's public registration export (`bundle/*.js` in a
 * built deploy, `src/*.ts` in a source deploy — the package's own export map
 * decides). A missing package means no child launch exists to guard; anything
 * else that is wrong is a registration failure the provider must survive.
 */
export async function loadInstalledChildAuthorityRegistration(
  agentDir: string,
): Promise<ChildAuthorityRegistrationApi> {
  const packageRoot = join(agentDir, "npm", "node_modules", LAUNCHER_PACKAGE);
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new ChildAuthorityLauncherMissingError(
      `the ${LAUNCHER_PACKAGE} launcher is not installed at ${packageRoot}, so there is no child launch to guard`,
    );
  }
  let manifest: { exports?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> };
  } catch (error) {
    throw new Error(
      `the installed ${LAUNCHER_PACKAGE} manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const target = exportedEntry(manifest.exports?.[LAUNCHER_REGISTRATION_EXPORT]);
  if (!target) {
    throw new Error(
      `the installed ${LAUNCHER_PACKAGE} package exposes no ${LAUNCHER_REGISTRATION_EXPORT} entry, so child extensions cannot be demanded`,
    );
  }
  const modulePath = resolve(packageRoot, target);
  if (!existsSync(modulePath)) {
    throw new Error(`the installed ${LAUNCHER_PACKAGE} entry ${modulePath} is missing`);
  }
  const loaded = await import(pathToFileURL(modulePath).href) as { registerRequiredChildExtensions?: unknown };
  if (typeof loaded.registerRequiredChildExtensions !== "function") {
    throw new Error(`the installed ${LAUNCHER_PACKAGE} entry ${modulePath} does not export registerRequiredChildExtensions`);
  }
  return loaded as unknown as ChildAuthorityRegistrationApi;
}

/**
 * Publish the one provider for this process and demand the child extensions from
 * the launcher. Refuses a duplicate owner, a process that is itself an admitted
 * child, a missing session binding and any required consumer that could not be
 * loaded, so a child never receives a lease it could not enforce.
 */
export function publishChildAuthority(options: ChildAuthorityPublishOptions): ChildAuthorityPublication {
  if (typeof options.sessionId !== "string" || !options.sessionId.trim() || options.sessionId.includes("\0")) {
    throw new Error("child authority requires the live parent session id");
  }
  if (typeof options.getBaseline !== "function" || typeof options.getHuman !== "function") {
    throw new Error("child authority requires the live parent baseline and human adapters");
  }
  if (typeof options.configDirName !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(options.configDirName)) {
    throw new Error("child authority requires the project config directory name");
  }
  if (liveChildAuthorityLease()) {
    throw new Error(
      "this process already holds a child-authority lease, so it is a delegated child; " +
      "a runner child must not publish root session authority",
    );
  }
  const slot = globalThis as Record<PropertyKey, unknown>;
  if (CHILD_AUTHORITY_PROVIDER_KEY in slot) {
    throw new Error(`a child authority service is already published at ${String(CHILD_AUTHORITY_PROVIDER_KEY)}; refusing a second owner`);
  }
  const sessionId = options.sessionId;
  // Even malformed required paths must leave guard intent. Resolve/validate only
  // inside activate(), after the slot is published. An empty unavailable service
  // cannot prepare authority, and provider presence still requires guarded admission.
  let requiredExtensions: readonly ChildAuthorityExtensionRequirement[] = Object.freeze([]);

  const leases = new Set<LiveLease>();
  let disposed = false;
  /** Only a registration this publication created is ever disposed by it. */
  let ownedRegistration: RequiredChildExtensionRegistration | undefined;
  let registrationError: Error | undefined;

  const revoke = (reason: string): void => {
    for (const entry of [...leases]) {
      leases.delete(entry);
      entry.disposed = true;
      entry.controller.abort(new Error(reason));
    }
  };

  // Started only after the provider slot is visible (see below): guard intent
  // comes first, and a failure here keeps the slot instead of reopening bare
  // launches.
  const activate = async (): Promise<void> => {
    try {
      requiredExtensions = extensionSnapshot(options.requiredExtensions ?? resolveChildAuthorityExtensionPaths(options.agentDir));
      requireConsumersWithinExtensions(requiredExtensions);
      verifyExtensionFiles(requiredExtensions);
      const load = options.loadRegistration ?? loadInstalledChildAuthorityRegistration;
      const api = await load(options.agentDir);
      if (disposed) return;
      const registration = api.registerRequiredChildExtensions({
        sessionId,
        extensions: requiredExtensions,
        requireForAllRunners: true,
      });
      if (!registration || typeof registration.dispose !== "function") {
        throw new Error("the launcher registration API returned no registration handle");
      }
      if (disposed) {
        // A terminal shutdown won the race: release what we just created.
        disposeRegistrationQuietly(registration);
        return;
      }
      ownedRegistration = registration;
    } catch (error) {
      registrationError = error instanceof Error ? error : new Error(String(error));
      throw registrationError;
    }
  };

  const requireRegistration = async (): Promise<void> => {
    try {
      await ready;
    } catch {
      throw new Error(
        `the parent session could not demand the pi-sbx and pi-guardian child extensions, so no child authority can be prepared: ` +
        (registrationError?.message ?? "unknown registration failure"),
      );
    }
  };

  const prepare = async (
    identity: ChildAuthorityIdentity,
    signal: AbortSignal,
  ): Promise<ChildAuthorityProviderLease> => {
    if (disposed) throw new Error("the child authority provider is disposed");
    if (signal?.aborted) throw new Error("child authority preparation was cancelled");
    await requireRegistration();
    if (disposed) throw new Error("the child authority provider was disposed while preparing the lease");
    if (signal?.aborted) throw new Error("child authority preparation was cancelled");
    const bound = requireIdentity(identity, sessionId);
    // Missing helpers refuse preparation while the guarded slot stays visible.
    await loadChildDomainMatcher();
    if (disposed || signal.aborted) throw new Error("child authority preparation was cancelled while validating runtime helpers");
    // Re-read after the await: a reload can revoke before any lease exists.
    const baseline = options.getBaseline();
    if (!baseline) {
      throw new Error(
        "the parent sandbox policy is not initialized, valid and enabled for this session, so no child authority can be prepared",
      );
    }
    const derived = deriveChildPolicy({
      baseline,
      identity: bound,
      configDirName: options.configDirName,
      agentDir: options.agentDir,
      // Read live: the provider is published before this session's scratchpad exists.
      sessionScratchDir: options.getSessionScratchDir?.(),
    });
    if (disposed) throw new Error("the child authority provider was disposed while preparing the lease");
    const preparedStamp = baselineStamp(baseline);

    const entry: LiveLease = { controller: new AbortController(), disposed: false };
    leases.add(entry);
    const disposeLease = (): void => {
      if (entry.disposed) return;
      entry.disposed = true;
      leases.delete(entry);
      entry.controller.abort(new Error("the child authority lease is disposed"));
    };
    const decide = async (action: ChildAction, decisionSignal: AbortSignal): Promise<ChildActionDecision> => {
      if (entry.disposed) {
        return { outcome: "cancelled", rationale: "the child authority lease was revoked before the action was decided" };
      }
      if (decisionSignal?.aborted) return { outcome: "cancelled", rationale: "the request was cancelled before it was decided" };
      // The current baseline, not the one the payload was derived from: a
      // tightening, a disabled sandbox or a shutdown denies from here on.
      const current = options.getBaseline();
      if (!current) {
        disposeLease();
        return {
          outcome: "unavailable",
          rationale: "the parent sandbox policy is no longer authoritative, so the request was not decided",
        };
      }
      let currentStamp: string;
      try { currentStamp = baselineStamp(current); }
      catch {
        disposeLease();
        return { outcome: "unavailable", rationale: "the current parent runtime policy cannot be projected; child authority was revoked" };
      }
      if (action.surface === "tool" && currentStamp !== preparedStamp) {
        disposeLease();
        return { outcome: "cancelled", rationale: "the parent baseline changed; a tool cannot execute against stale child runtime policy" };
      }
      const decisionStillCurrent = (): boolean => {
        try {
          const latest = options.getBaseline();
          return Boolean(latest && baselineStamp(latest) === currentStamp && policyPathAnchorsUnchanged(derived.payload.anchor.paths, derived.payload.anchor.cwd));
        } catch { return false; }
      };
      if (!policyPathAnchorsUnchanged(derived.payload.anchor.paths, derived.payload.anchor.cwd)) {
        disposeLease();
        return { outcome: "cancelled", rationale: "a prepared policy path was retargeted; child authority was revoked instead of following fresh scope" };
      }
      const result = await decideChildAction(action, {
        identity: { agent: bound.agent, index: bound.index, runId: bound.runId },
        parentSessionId: bound.parentSessionId,
        childCwd: bound.cwd,
        baseline: current,
        ceiling: childPolicyCeiling(derived.payload),
        networkCeiling: derived.payload.network,
        hostCeiling: derived.payload.command.allowHost,
        human: options.getHuman(),
        signal: AbortSignal.any([entry.controller.signal, decisionSignal]),
        decide: async request => {
          if (!decisionStillCurrent()) {
            disposeLease();
            return { kind: "deny", reason: "parent baseline or prepared policy path changed before review", review: { source: "rule", rationale: "the child lease was revoked" } };
          }
          const reviewed = await (options.decide ?? decideSandboxException)(request);
          if (!decisionStillCurrent()) {
            disposeLease();
            return { kind: "deny", reason: "parent baseline or prepared policy path changed during review", review: { source: "rule", rationale: "the child lease was revoked before human admission" } };
          }
          return reviewed;
        },
      });
      if (entry.disposed || decisionSignal.aborted) return { outcome: "cancelled", rationale: "child authority was revoked before decision consumption" };
      if (!decisionStillCurrent()) {
        disposeLease();
        return { outcome: "cancelled", rationale: "the parent baseline or a prepared policy path changed during review; late authority was revoked" };
      }
      return result;
    };
    return Object.freeze({
      payload: derived.payload,
      requiredConsumers: Object.freeze([...CHILD_AUTHORITY_REQUIRED_CONSUMERS]),
      signal: entry.controller.signal,
      decide,
      dispose: disposeLease,
    });
  };

  const provider: ChildAuthorityProvider = Object.freeze({
    version: CHILD_AUTHORITY_PROVIDER_VERSION,
    sessionId,
    get requiredExtensions() { return requiredExtensions; },
    prepare,
  });
  slot[CHILD_AUTHORITY_PROVIDER_KEY] = provider;
  const ready = activate();

  const unpublish = (): void => {
    if (slot[CHILD_AUTHORITY_PROVIDER_KEY] === provider) delete slot[CHILD_AUTHORITY_PROVIDER_KEY];
  };
  return Object.freeze({
    provider,
    ready,
    revoke,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      revoke("the parent session ended or child authority was revoked");
      // Terminal shutdown only: the registration is sticky while the session
      // lives, because unregistering would reopen a bare launch.
      const registration = ownedRegistration;
      ownedRegistration = undefined;
      if (registration) disposeRegistrationQuietly(registration);
      unpublish();
    },
  });
}

function disposeRegistrationQuietly(registration: RequiredChildExtensionRegistration): void {
  try {
    registration.dispose();
  } catch {
    // A failing release must not mask the shutdown that asked for it.
  }
}
