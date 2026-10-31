# Production child consumers: integration commission

Current source baseline: launch/provider `cd15ee4`, Guardian accounting `8f7551c`.
Todo #14 is active; #15 remains the separate OS/external-worktree/Git acceptance.
This record is an implementation contract/plan, **not** consumer acceptance.
No worker is active. The parent is the sole sequential writer in main; no
concurrent component writers, deployment, live-policy/toggle changes or runtime
replacement are authorized by this plan.

## Protocol / parent-service phase: implemented and source-verified

The SAME public API now uses provider/wire **2**. Guard/ALS/runner-latch Symbol
keys intentionally retain their `.v1` names so old hosts observe intent and fail
closed rather than launch bare. The policy payload now says `version: 2`; network/
environment/host-ceiling projection is still staged and consumers still cannot
ack. There is no parallel v1 approval implementation or new permission store.

- `tool` targets carry exact GuardianAction JSON, capped at **64,000 UTF-16
  characters / 256KiB UTF-8**; ordinary target/reason and **policy** bounds do
  not expand. The launcher stays opaque; Guardian strictly validates exact
  input/nesting, unknown fields, depth/size, host audience and child cwd. The
  parent's configured action budget can further tighten this limit. Parent
  batch `terminate` is typed metadata and cannot accompany an allow.
- `SandboxBrokerService.reviewTool` runs the actual parent fixed/semantic engine,
  full directives and host-bound requester evidence, same durable reviewer/
  accounting/denial consumption and stale-evidence validator. Relative arguments
  use child cwd; rule/maintenance anchoring remains the real parent. Exact child
  action/audience is audited. Parent transcript cursor is not consumed. A
  semantic allow does not grant filesystem, command or host authority.
- **Additional reproduced ceiling defect:** replacing the admitted workspace by
  a sibling symlink, or repointing a writable read-carveout alias into a denied
  tree, returned `allow` without review in the pre-fix source. Evidence:
  `.local/goal-consumers/anchor-drift-probe.log` (both tests failed on the allow).
  New `anchor.paths` contains bounded, immutable spelled/canonical associations
  for every policy's non-glob prefix, original parent cwd, workspace/Git roots
  and aliases. Drift revokes before/after decisions, with another check after
  broker review **before human admission**. Consumers must enforce these same
  pins even for locally held native/Bash actions. Ordinary creation at a stable
  prefix is not drift. Literal glob-bearing workspace/Git roots cannot be
  represented safely by this matcher/runtime contract and refuse instead of
  admitting a sibling glob or losing mandatory metadata exclusions. This is
  between-action snapshot consistency, **not** hostile same-user race immunity.

Verification on Node **v26.6.0**, current ignored evidence `.local/goal-consumers/`:

| Gate | Evidence / result |
|---|---|
| pi-sbx full suite and types | **222 tests / 22 files**, typecheck pass, including exact-tool service failure/revocation and alias-drift regressions. |
| Guardian full `npm test` / types | **178 total / 177 pass / one known Node26 HTTP-headless native assertion**; typecheck pass. Thirteen new delegated parsing/registered-engine/real-IPC/stale tests pass, including full content, directives, nesting, cost attribution, denial/warning/generation/parent/shutdown/cancellation and queued sibling rejection. |
| Subagents focused authority / types | **79 pass**, typecheck pass. Large Unicode exact-tool round trip; old provider/wire refusal; typed termination/replay/cancellation negatives. |
| Subagents full unit | **4,219 pass / 17 skip / 0 fail** (4,236 tests). Sandbox failed on process/socket fixtures; the exact command passed after reviewed host approval. |
| Affected async integration | **234 pass** after exact reviewed host rerun for loopback/process fixture restrictions. |
| Fresh build, verifier, actual bundle/compiled graph | **3 graph tests pass**, **383 inputs / 17 exports / 329 compiled modules / 18 module-URL targets / 765 artifacts**; artifact prefix `c4e4ea8c6b475776`. |
| Root/source checks | `just check` passes, including **69 deployment fixtures**; `git diff --check` and a final build verifier pass. |

The real Node IPC integration uses the actual pi-sbx provider, real launcher
registration/controller/client, registered parent Guardian and a credential-free
sidecar verdict fixture. Its child acknowledgments are **protocol-test code**,
not production consumers or SRT enforcement. No first production child model
prompt is authorized by these results. Full compatible-runtime HTTP, actual
child OS/Git containment and live usage/latency remain open. No deployment,
restart, runtime/dependency installation, live-policy/toggle edit or push.

## Source-proven gaps at the initial baseline

1. Real pi-sbx/Guardian extensions do not claim/acknowledge the live lease, so the
   current runner must refuse the first model prompt. Do not add an acknowledgment
   to the ordinary root startup: that would retain ambient maintenance/config and
   a second local Guardian broker rather than consume delegated authority.
2. The existing IPC action can carry only read/write/network/command targets
   (2KiB target, 512B reason). It cannot convey an **exact full Guardian tool
   action**, including write/edit content, unknown extension/MCP inputs and nested
   parent-call arguments. Passing only a path, tool name, hash or prose would
   silently remove semantic review. This requires a deliberate versioned extension
   of the **same** host-created IPC API, not another transport/permission store.
3. The staged policy's network/command fields name only parent-decision routing.
   They do not project configured static network denials, credential-environment
   handling or a prepared host-disabled ceiling into the child SRT. Root-global
   settings must not be reloaded as a substitute, nor can fresh child config mint
   grants. Resolve this projection explicitly before a production consumer acks.

## Binding architectural decisions (protocol phase above; consumers remaining)

Use one updated protocol/provider version, with fail-closed version mismatch;
no parallel v1/v2 approval path. Keep the **existing provider Symbol key** so old
launchers still observe guard intent rather than treating a new key as bare mode.
The process-wide ALS registry identity/claim/ack mechanism remains the accepted
one, shared across the complete bundle/compiled graph. Do not change upstream
builder, dependencies or the host-created IPC trust boundary.

Extend the existing action union with a `tool` action whose target is serialized
exact `GuardianAction` JSON. Tool targets need the existing 64,000-character
Guardian action ceiling (bounded UTF-8 transport envelope, not the 2KiB hostname/
path target cap); keep ordinary action and **policy** payload bounds separate.
Strictly validate shape, identity, size/depth and nested argument evidence. Model
fields cannot choose the active parent, cwd, reviewer or lease audience. Unknown
versions/oversized actions fail before execution; never truncate safety evidence.

The parent provider routes tool actions into the **existing Guardian broker's
host-only service**, adding a tool-review method rather than publishing another
permission service. That method reuses fixed-rule/semantic assessment, full parent
user provenance, stale-evidence validation, durable writer queue and accounting.
Rules anchor to the actual parent policy; child relative file inputs resolve in
its host-bound cwd. Retain exact original inputs/cwd in semantic evidence. Known
child own-policy/credential/audit restrictions remain final through the sandbox
consumer, even if the parent's maintenance rule semantically allows an action.
A tool-review verdict alone grants no filesystem/host exception.

Keep the ordinary layering: Guardian reviews exact tool semantics; pi-sbx enforces
native paths and Bash OS scope. Outside-scope path admission uses the existing
common authorizer and actual **parent** human UI. Do not introduce a cross-hook
approval cache or charge/ask the human twice for the same path decision. Root
maintenance may be used only by the real parent in an action-local decision;
no child global-maintenance matching, child project trust or root publication.
Host command eligibility and held/disabled ceilings remain final. Explicit host
execution is full-host authority, not a child filesystem jail; its child-scope
human-admission rule must be fixed and tested before enabling that path.

Project a minimal, versioned runtime policy from the parent's **baseline**:
original-cwd anchored read rules/carve-outs and write exclusions; admitted workspace
and verified Git roots only; separately host-created child scratch; credential
file locks and environment-name denials (no values); explicit static network
allows/denies and narrow supported runtime features. Configured denials in prepared
and current policy cannot be overridden. Reuse SRT's shipped domain-pattern /
host-canonicalization helpers rather than inventing a second hostname matcher;
missing/incompatible helpers must refuse, not relax. Socket namespaces and any
weaker-isolation/interprocess features need explicit narrowing, not copying broad
parent temp/maintenance capability. No unsupported option may silently weaken the
child. The old v1 payload in the #22 handoff is historical once this amendment is
implemented; document the actual new schema before consumer acceptance. Keep
`anchor.paths` complete and validate them before locally held actions as well
as across asynchronous exception decisions; immutable strings alone did not
freeze filesystem alias resolution.

## Sequential file ownership / gates

| Step | Sole writer / owned seams | Required evidence |
|---|---|---|
| Protocol and parent service | Parent: subagents child-authority domain/IPC/API and focused fixtures; pi-sbx broker/action/provider and tests; Guardian broker/types/index and shared tool-evidence helper/tests if extraction is needed | Strict exact-tool wire bounds, old/malformed version refusal, same real process correlation/replay/cancellation, actual parent fixed/semantic review with original directives/nesting/cwd, stale/generation failure and cost attribution. |
| Production pi-sbx consumer | Parent: new child-consumer/policy modules, index dispatch/file gate/config adapter seams and focused tests | Detect real code-only scope/lifetime latch, claim through co-installed public API, no ambient config/maintenance/root publisher; immutable policy/native and SRT projection; child-owned scratch only; actual parent exceptions; no local human/save store; cancellation/rollback/lifecycle and disabled/unavailable negatives. |
| Production Guardian consumer | Parent: new child consumer plus shared evidence/service seams and tests | No child root config/project-trust/reviewer/broker; forward complete actions/parent chain to real parent; block unknown identity/loss; installed hooks before ack, no fabricated readiness. |
| Composition/acceptance | Parent: actual child-session/launch test fixtures, VENDOR/product/architecture/acceptance docs | Real registered production consumers inside the actual SDK factory and real Node IPC, not test ack consumers; no first prompt before both active. Native read/write/edit, sandboxed/scoped Bash, network and explicit host decisions; meaningful deny/maintenance/alias/sibling/cancellation negatives; fork full relevant suites/typechecks/build/graph/root gates. |

Readiness is the final barrier: acknowledge each required consumer only after its
actual handlers and fail-closed lifecycle are installed and (for pi-sbx) SRT is
active. The normal root extension path remains unchanged outside genuine child
scope. A missing/malformed live lease in a latched runner never falls back to it.
Unsupported foreground/nested/workflow/scheduled/retained placements remain
refused. Preserve the accepted complete build graph and native tool schemas.

Unit/mocked SRT projection and credential-free SDK/IPC integration are source
acceptance, not OS containment. #15 must separately exercise the production child
under the actual runtime and prove external-worktree edit/test/review/integration,
required common Git metadata authority, sibling/mandatory-deny negatives and
dirty-preserving cleanup. A compatible-runtime HTTP headless run and live context
latency/cost acceptance (#4/#24/#25) remain open; the known Node26 native assertion
is not permission to replace the runtime or bypass an approval refusal.
