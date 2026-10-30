# Round 2: wire the accepted child-authority primitives

## Gate and topology

Primitives are accepted in `0616949`; see [the component record](round-2-child-authority.md).
The operator's third-fork approval and instruction to continue authorize source
implementation and delegated nw-flash writers, not deployment, live-policy edits,
restart, push, credential/audit reads or a runner switch after refusal.

This is still **multi-seam**. Do not give a worker the complete launch + policy +
Guardian + OS outcome. Split the next milestone into the actual launcher and the
parent-owned permission provider. They share the frozen IPC interface, but the
launcher treats payload bytes as opaque; it does not need a policy schema to
implement carriage, placement refusal, identity and first-prompt readiness.
Child-side policy/Guardian consumers follow after the parent payload is reviewed.
This extra serial gate avoids inventing an unreviewed payload across three forks.

| Lane | Repo/cwd and isolation | Exclusive contract/files | Authority and next gate | Handoff / independence |
|---|---|---|---|---|
| launch writer | adripi `.local/round-2/wiring-launch` | `forks/pi-subagents/src/runs/{foreground/subagent-executor.ts,foreground/execution.ts,background/async-execution.ts,background/subagent-runner.ts,background/runner-child-launch.ts,background/run-child-session.ts,shared/child-launch.ts,shared/child-session.ts}`; new `shared/child-authority-launch.ts`; focused launch tests/fixtures. No accepted IPC modules, manifests, packaging, other forks or docs. | Sole writer, no commit/delegate/deploy. Actual dispatch/factory/real-process tests + typecheck, then fresh read-only review. Ask before needing another production file. | Managed `authority-wiring/launch-worker.md`; policy-agnostic caller of accepted provider/IPC. |
| parent-provider writer | adripi `.local/round-2/wiring-provider` | `forks/pi-sbx/src/index.ts`; new `src/{child-authority,action-authorizer}.ts`; focused `test/child-authority*.test.ts` and existing bash/lifecycle tests if their seam changes. No child consumer, config/hardening/file gate, Guardian, subagents, manifests, docs or packaging edits. | Sole writer, no commit/delegate/deploy. Real registered publisher + shared decision-adapter tests, existing sbx suite/typecheck, then fresh read-only review. Ask before another production file is needed. | Managed `authority-wiring/provider-worker.md`; policy owner supplies opaque payload to launcher, without changing IPC. |
| child-policy/Guardian adapters | not provisioned | Future separately owned consumers after payload handoff; exact files must be fixed before launch. | Blocked on parent acceptance of this milestone. | Must not reacquire ambient maintenance, weaken denies, bypass parent or invent another permission service. |
| parent integration | main checkout | Actual diff review, cross-component tests, API/payload arbitration, VENDOR/docs, fixes and commits only after durable handoffs. | No writes to an active lane worktree. | Neither writer's helper green tests certify production child authority. |

Both writers use `neuralwatt/nw-flash`, fresh context and existing native runner;
no child fanout. Fresh reviewers inspect actual diffs, report all concrete P1/P2
findings and test limitations. Model-only supervisor prose never grants permission.
Missing tools/services and failed approvals stop the affected route; no alternate
runner, Bash/native substitution or silent source/test bypass.

## Guarded-mode activation decision

The launch worker requested a binding decision after finding that “guarded” was
undefined. Parent chose **host-registration activation, not a blanket ban in bare
pi-subagents**, with fail-closed strengthening:

- A launch is guarded when the actual host session has mandatory required-child
  extensions registered **or the provider slot is present**, even if malformed or
  unavailable. Mandatory inherited/retained snapshots may only tighten admission.
  Provider-present/registration-missing is not a bare-session fallback. Obtain the
  actual host session id; missing/malformed identity is not proof of bare mode.
- pi-sbx registers canonical **pi-sbx + pi-guardian** entrypoints through the existing
  `pi-subagents/required-child-extensions` API with `requireForAllRunners: true`.
  The registration only demands enforcement; it cannot grant authority or replace
  a live IPC lease. Other mandatory extensions also demand guarded placement.
- Establish guard intent before asynchronous startup can fail. The session-bound
  provider may publish an unavailable `prepare()` service until initialization
  succeeds. Missing registration API, invalid config, disabled sandbox, SRT failure
  or provider loss must not turn an opted-in parent into an unguarded one.
- Keep mandatory registration for the parent session's entire active lifetime.
  Sandbox off/tightening/failure revokes or refuses children; it does **not** dispose
  registration. Dispose only at terminal session shutdown after launch quiescence.
  Never replace/dispose another owner's provider or registration.
- A bare pi-subagents host with neither mandatory registration nor a provider keeps
  upstream launch behavior. That is outside this sandbox product's containment
  claim, not a compatibility fallback taken after guarded admission fails.
- In the runner, the actual host-created process IPC endpoint independently
  requires a live lease. Writable config/env cannot drop a guard bit and skip
  `awaitLease`/readiness. Mere endpoint detection grants nothing; authenticated
  preparation, identity and code-only acknowledgments are still mandatory.

This refines the caller/provider activation contract without changing the accepted
IPC API. Both sole writers were notified through supervisor reply/live guidance.
Review must include registered+missing provider, provider+missing registration,
malformed provider, failed initialization/toggle without downgrade, and writable
runner config unable to suppress actual-channel admission. This decision does not
certify that either writer has implemented it yet.

## Frozen cross-component obligations

- Use only `pi-subagents/child-authority` for host-code API. Provider slot remains
  `Symbol.for("pi-sbx.session-authority.v1")`, version 1, with existing
  `{sessionId, requiredExtensions, prepare(identity, signal)}` contract. Prepared
  lease remains `{payload, requiredConsumers, signal?, decide(action, signal), dispose}`.
  No new model parameter, compatibility API, env/hash/file grant, permission store,
  unauthenticated inbox, `defer` terminal result or unavailable-only approval stub.
- Provider-required consumer ids are **`pi-sbx` and `pi-guardian`**, with actual
  canonical extension entrypoints in `requiredExtensions`. Code-only claim/ack
  is the readiness proof, not a retained manifest or extension-load success alone.
- One actual native background runner process hosts one admitted child. Parent
  holds the real ChildProcess handle and one controller. Runner captures its own
  process IPC endpoint, constructs exactly one client and awaits its live lease.
  Host fixes session/run/agent/index/cwd; lease identity must equal the actual
  resolved child about to load. Config/artifact fields remain proposals.
- Wrap actual extension load **and session_start** in `withChildAuthority`;
  `assertReady()` must succeed before any first prompt/model call, including a
  custom factory or retry path. Failure shuts down child/session/lease, not just
  logs a warning. Parent loss/abort/revocation aborts the actual running session,
  including work that is not currently asking a permission question.
- In guarded mode, before unsupported mutation or launch, explicitly refuse foreground shared
  process, chains/parallel/dynamic multi-child runners, nested children, external
  CLI/job/machine/binary/wrapper runners, unattended schedules and managed-worktree
  setup. Initially **all managed allocation is refused**; a human/parent-created
  external worktree can be a proposed cwd and needs provider admission. Do not
  silently force async/native or swap runners. Retained artifacts confer no lease:
  resume must prepare fresh authority or clearly refuse until it can.
- Missing, malformed, disabled, wrong-session or disposed provider fails closed
  on the guarded production launch, not an upstream unbounded fallback. Human
  sandbox-off does not imply safe child support; refusing is acceptable. Existing
  bootstrap file barriers may remain lifecycle synchronization, never authority.
- Reach `prepare()` immediately after authenticated spawn/channel attachment,
  before slow setup or any model call. Respect the documented prepare/lease clock
  distinction and default 30s/35s startup budget; pass explicit paired bounds if
  needed. Do not shorten real parent reviewer/human approval to a demo timeout.
- Per-process globals require process isolation and placement rejection. Do not
  publish a second root authority inside a runner or let unsupported child paths
  take the ordinary maintainer/global-policy branch. The child-consumer milestone
  must enforce this before production acceptance; no consumer is stubbed as ready.

## Parent provider / policy milestone

The provider is code-only and bound to the actual active parent session/cwd and
lifetime. Publish/dispose with session lifecycle, refuse a second owner, revoke
all prepared leases on shutdown or authority-invalidating changes. It reads the
parent's **baseline effective** config/policy, never a copied command-local layer,
raw model fields or a freshly loaded cwd profile as a substitute for held scope.
Do not use the session-bound Guardian broker with a spoofed child cwd: requests
still go through the real parent context, with explicit child identity evidence.

For preparation:

1. Derive a bounded immutable versioned JSON payload from the current parent
   policy and actual proposed child identity. Parent-owned payload format is
   internal to pi-sbx; document it in the handoff before consumers are written.
   No secrets/content, raw config layers, functions or model-supplied grant list.
2. Reads remain deny-based. Preserve parent read denies and their scoped carve-out
   semantics; do not claim finite inherited read roots. Anchor relative/glob rules
   to their original cwd, not the child's cwd. Preserve lexical and canonical locks.
3. Initial write scope is the admitted child workspace plus necessary separately
   verified Git metadata; never copy every parent write root, broad temp root or
   maintenance grant into the child. The later consumer may add only its genuinely
   host-created private scratch, not arbitrary model paths. A cwd under a parent
   allow root is not proof all its descendants escape configured deny patterns.
4. Mandatory credentials/auth/audit, parent/child own-policy and configured write denies
   remain final. A workspace inside a forbidden root or alias must refuse before
   review. Do not use an exact native operation grant as recursive child scope.
5. If proposed workspace/Git roots are not already held, either refuse this first
   milestone clearly or obtain explicit existing human admission describing the
   subtree and child-lifetime scope. Reviewer allow alone must not manufacture
   beyond-held launch authority. Record which initial capability is implemented.
   Arbitrary child project config is not newly trusted just because the parent's
   project was trusted; no ambient maintenance reacquisition.

For action decisions:

- The real child request uses existing common path authorization and the actual
  parent Guardian + serialized HumanChannel, not a fake reviewer or another tool.
  Mandatory/configured exclusions are checked first. Within-held delegable scope
  can allow without manufacturing a second policy store.
- Beyond-held *action-local* read/write requests need the actual existing human
  admission route (including after a semantic allow when the parent did not hold
  that scope); no human transport returns `unavailable`, never fabricated consent.
  New approval authorizes this one action, not persistent policy or child baseline.
- Network and command use the same existing broker/human route as parent actions;
  command shape/host-enabled gates still win. Factor shared decision code if
  necessary so the child and ordinary Bash/network paths cannot drift. Native
  tools remain native. A child's request cannot save standing policy on its own.
- Re-evaluate the **current** parent baseline on each request; tightening/shutdown,
  caller abort and provider disposal revoke/deny. Do not wait for an abort-ignoring
  reviewer forever or treat late allow as consent. Existing transport bounds and
  cancellation must reach the actual broker/human operation where supported.

This milestone does not implement the child runtime policy, Guardian maintenance
suppression or actual OS/native enforcement. It must return an honest handoff
rather than simulate those consumers or report full parent-first delivery.

## Validation and next gate

The first candidates are **not accepted**. See the [review/recovery
record](round-2-wiring-recovery.md) for terminal run evidence, parent-arbitrated
blockers and the bounded same-owner correction pass. That record supplements
this contract; it does not authorize child consumers or deployment.

Launch tests must hit the registered dispatch/spawn/factory boundaries and real
IPC: no first prompt when consumers are missing, wrong identity, failed startup,
parent loss, provider cancellation and unsupported placements **before mutation**.
Injected factories must not bypass readiness. Preserve existing capability/tool
ceilings and native tool schemas. Use controlled code consumers in fixtures only,
explicitly distinguish them from pi-sbx/Guardian implementation.

Provider tests must exercise actual publication from registered pi-sbx lifecycle,
real parent baseline scope/maintenance narrowing, original-cwd glob anchoring,
current-policy tightening, missing/throwing Guardian, headless defer, real parent
human ask/allow/deny/cancel, foreign identity and disposal. Pure payload helper
tests are insufficient. Run focused tests/typecheck, then the affected full suite.
Guardian full headless remains blocked by Node 26; don't switch runtimes or claim
that suite green. Full subagents fixture suite can require explicitly reviewed
host execution for ps/local sockets (known baseline), not permission widening to
claim OS acceptance. Keep long logs in ignored local paths and return exact
commands/results/failures and changed files via managed output artifacts.

Stop and contact the parent for a contract change, a needed unowned production
file, unavailable decision service/tool, or unsupported safe wiring. Workers do
not integrate each other's files. Parent reads actual diffs, fixes accepted gaps,
verifies the real composed services and commits before provisioning the downstream
child consumers. Full child/OS/external-worktree/authenticated-Git acceptance is
still todo #15, never inferred from this intermediate milestone.
