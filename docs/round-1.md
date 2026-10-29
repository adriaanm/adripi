# Implementation round 1: one action-bound escalation path

Status: implementation integrated and source checks recorded; **full verification
remains blocked by the pre-existing Node 26 headless crash**. No live deployment
or push. Initial external-worktree attempt failed at the sandbox/supervisor seam;
the same-protocol retry completed in pre-provisioned isolated worktrees inside
the existing writable workspace. Stop here for the recap/operator interview.

## Operator direction

Use `neuralwatt/nw-flash` implementation workers; parent reviews their work.
Treat the bundled extensions as one product with one implementation and public
API for each behavior. Complete one independent round, then pause for a recap
and requirements interview. Do not deploy, edit live policy, or push.

## Round decisions

- **Canonical model-facing escalation:** permission parameters on the `bash`
  action (`sandbox_permissions`, `justification`, optional scoped paths or
  proposed prefix). Retire the separate `request_sandbox_exception` tool and
  legacy `dangerouslyDisableSandbox` parameter rather than teach two routes.
- Scoped path permissions are for one execution, not a session window. Normal
  file tools retain static policy; an outside-policy filesystem action uses an
  explicitly scoped bash action. Do not add another permission-request tool.
- Unknown network destinations continue through SRT's callback and the same
  Guardian decision contract, for that connection. No separate network-grant
  API, no global network-enable escape.
- Standing permission is a Guardian-owned, human-approved project exception
  rule. Remove automatic persistence fallback to sandbox exclusions. Existing
  nonempty `excludedCommands` must fail closed with a migration instruction,
  not silently remain a second host-execution API. Explicit human sandbox-off
  modes remain visibly unsafe controls, not an agent escalation route.
- Host execution is still a reviewed full-host capability, not a credential
  jail. Apply one shared eligibility and host-enabled check before approval.
  Refuse interpreter/wrapper/general-code execution shapes; require a proposed
  prefix to describe the current command. Broader host capability policy is a
  closing interview topic, not an excuse to weaken eligibility.
- Serialize bash executions while the singleton SRT runtime has temporary policy;
  normal file-tool policy must never read another execution's transient grant.
  Roll back on every error/cancellation path. Background-descendant lifetime is
  not certified by serialization and remains an explicit follow-up.
- Never trust pre-existing unapproved project-policy bytes by appending an
  approved rule. Approval is snapshot-bound; changed/untrusted existing policy
  must be rejected with an actionable explanation, not silently approved.
- Explicit numeric network-port rules remain port-specific. Validate exact
  request target shapes before rule/reviewer evaluation; do not accept wildcard
  capabilities through APIs that promise exact targets.

## Implementation topology and lane board

Classification: **multi-seam**. Each lane has an independently testable contract.
Within the sandbox lane, public API retirement, host admission and execution
leases share the same dispatcher/state and must be changed together.

| Lane | Repo/cwd and isolation | Decision / exclusive ownership | Authority | Gate / durable handoff | Independence |
|---|---|---|---|---|---|
| Sandbox execution | This repo; managed isolated worktree from plan commit, actual path recorded by subagent handoff before mutation | `forks/pi-sbx/src/**`, its tests; canonical inline dispatch, host admission, execution-local policy, unified approval/persistence handoff | Edit own fork only; no deploy/policy/push or child delegation | Vitest + tsc; captured worktree patch and report | Owns execution, consumes existing Guardian broker/service shape |
| Guardian policy persistence | Separate managed worktree from same commit | `forks/pi-guardian/src/project-policy.ts`, `test/project-policy.test.ts`; trusted-snapshot and safe persistence API | Edit named files only; no index edits or deployment | Focused tests + tsc; captured patch and service integration contract | Owns host-authority file mutation; parent adapts the service call site |
| Guardian target rules | Separate managed worktree from same commit | `forks/pi-guardian/src/sandbox/{rules,broker}.ts`, target/rule tests | Edit named sandbox files/tests only; no index or persistence edits | Sandbox tests + tsc; captured patch | Owns broker target/rule admission; independent of execution/storage |
| Integration and review | Parent checkout, only after component handoffs | Personally inspect patches, adapt service call site, align templates/guidance/docs and remove retired API references | Integrate/review/test/commit; no deploy or push | Full applicable checks, negative integration tests, coherent commits | No duplicate implementation writer; owns cross-extension contract |

Initial managed worktrees were allocated under `/Users/adriaan/g/worktrees/adripi`.
Their bash profile could not write there. Deferred inline escalation failed with
`Tool contact_supervisor not found`: the current adapter tries to call a
model-only tool through the nested-tool API. Attention notices therefore had no
actual pending supervisor request. The parent paused all three runs, read their
handoffs and captured owned partial patches; no partial implementation was
accepted. Original run IDs: sandbox `85d1a57c`, persistence `0941f76b`, targets
`f2f3e8e5` (workflow `717ec43a`).

Retry isolation paths, provisioned by the parent inside this repo's existing
ignored `.local/` and existing sandbox write boundary:

- `.local/round-1/sandbox` — fresh execution lane;
- `.local/round-1/persistence` — captured owned persistence partial patch;
- `.local/round-1/targets` — captured owned rules partial patch.

Each is a separate detached Git worktree at plan commit `3aa00d0`, with its fork
`node_modules` linked to the parent checkout. Probe files were not copied. Retry
uses the same native subagent protocol and exact model; no policy grants, host
execution fallback, live install or alternate validation location. Workers must
verify an ordinary write/test fixture in their assigned cwd before implementing
and stop/report if it fails. Parent owns final integration and review.

## Acceptance / round boundary

Repair F1/F2/F4/F5's deterministic boundary gaps and retire the obsolete grant
stores/routes that cause F3. Test registered execution wiring, not only helpers.
Parent must review the actual diff and negative cases before acceptance. Capture
remaining findings (including lifecycle, audit, child containment, deployment
freshness and full Node headless verification) without claiming they are fixed.
Update the product guide to distinguish historical review baseline from the
accepted round. Pause after this round; do not start another improvement wave.

## Parent review and integration

All three retry workers used `neuralwatt/nw-flash` in workflow
`fd5f5cb7-7486-4c51-a14a-2f81d7c8a4e0`; their owned changes were inspected and
copied into the parent checkout, excluding dependency symlinks and probe files.
Reports are in that workflow's `round-1-retry/{sandbox,persistence,targets}.md`
artifacts. Worker completion was not treated as acceptance. Parent read the
source, adapted Guardian's actual service/consumer contract and added negative
registered-tool/service tests.

Parent integration found and repaired gaps beyond the handoff claims:

- The bash schema still exposed a `network.enabled` field: removed it, reject
  unknown nested override fields, and validate exact scoped target syntax locally.
- Unavailable-SRT fallback still skipped host admission: route it through the
  same planner, policy and broker as explicit host escalation.
- Persistence needed a pre-prompt snapshot, not one captured when the user
  finished answering: the Guardian service now prepares a bound commit closure,
  rejects disposed sessions, and applies only returned bytes/rules.
- Cancellation while review/UI was open could arrive after admission: check it
  before execution/persistence and pass signals into all human questions.
- Settings could refresh the singleton during scoped execution: serialize runtime
  mutations with bash; closure rejects queued work and waits for active rollback.
- A partially failed runtime update needs rollback too; failed rollback must
  poison dispatch/reset instead of leaving a widened singleton usable.
- Missing Guardian must not bypass its hard restrictions via a synthetic human
  defer: exceptions now fail closed until the broker is published.
- Host executable heads also reject assignment/keyword/expansion spellings;
  network standing proposals preserve the actual shown port and bracket IPv6.

Templates, installer messages, current docs, agent guidance and vendoring records
now describe the one API/store. The original as-built guide is preserved as
[product-baseline.md](product-baseline.md), not overwritten as if its probes had
verified the changed runtime. `excludedCommands` migration is documented; live
files were not migrated or edited.

### Source acceptance by finding

| Finding | This round's outcome | Limit |
|---|---|---|
| F1 host admission | All agent host paths use host-enabled policy, shape/prefix admission and exact-command decision | Human sandbox-off is deliberately unsafe; executable capabilities are not exhaustively classified |
| F2 scoped isolation | Queue, copied runtime-only layer, baseline file gate, pre-execution target decisions and fail-closed rollback | Background descendants and long-lived connections are not contained/certified by this |
| F3 network-once expiry | Old token/store and granting-tool expiry route removed; callback decides each connection | Actual installed proxy/OS smoke tests still needed |
| F4 network ports | Numeric ports stay exact; bare/`:*` rules cover all ports | Runtime transport semantics still depend on SRT |
| F5 policy trust | Prepared trusted snapshot, stale/unapproved/symlink rejection, atomic writes, returned-byte application | No cross-process file lock or hostile same-user filesystem-race defence |
| F7 inconsistent human path | One adapter; headless defer explicitly stops without impossible nested tools | Usable human-only child approval transport is still absent |
| F11 target admission | Exact shape checks before broker rules/reviewer; roots and canonical aliases protected | Not proof of every external tool's target interpretation |

F6's full toggle/publication lifecycle, F8's correlated consume/revoke audit,
F9's active-runtime doctor and F10's child/MCP/extension containment remain open.
Disposing prepared-save services is not a claim that F6 is fully solved.

### Verification evidence

Commands were run in the parent checkout against integrated source, with no
host execution probes or nested `sandbox-exec`/SRT profiles:

| Check | Result |
|---|---|
| `just check` | Passed: shell syntax and updated config-template checks |
| `cd forks/pi-sbx && npx vitest run` | 18 files, **104 tests passed** |
| `cd forks/pi-sbx && npx tsc --noEmit` | Passed |
| Guardian `node --test` excluding only `test/headless.test.ts` | **96 tests passed** |
| `cd forks/pi-guardian && npm run check` | Passed |
| `cd forks/pi-guardian && npm test` | **Not green:** 96 passed, `headless.test.ts` aborted in Node `26.6.0`, assertion `(env_->execution_async_id()) == (0)` in `node::InternalCallbackScope::Close` |
| `git diff --check` | Passed before implementation commits |

The same native headless failure was already reproduced on clean baseline HEAD
before this round. It was reproduced again after integration; it is not a newly
explained or repaired failure. No compatible alternate Node was installed/tested.
The full-suite/headless verification task stays open. Registered-tool tests mock
execution and the runtime; the cross-fork service test uses the real Guardian
publisher and sandbox consumer but launches no reviewer/host command.

### Delivery and pause

Target-admission/port repair is commit `fabb57c`; the coupled dispatch/persistence
repair and matching documentation are committed together separately. There was
no `install.sh`, live-policy edit, restart, network Git operation or push.
Existing ignored worktrees/artifacts preserve the worker evidence.

### Operator interview follow-up

The operator answered:

1. Unify with "a Bash tool among the other tools." The working interpretation is
   one tool-permission mechanism with Bash as a peer of native file tools, not a
   requirement to route file actions through bash. The operator subsequently
   confirmed this interpretation; the round-1 bash-only implementation remains
   the current source behavior.
2. Delegation goes through the parent first; the parent may pass on its own
   authorizations. This calls for provenance-backed, bounded child grants and a
   real parent request path, not free-form `ALLOW` text or automatic human asks
   for capabilities the parent already holds.
3. Standing workspace roots are enough. This repository's special authorization
   to modify agent configuration can be modeled as an additional maintenance
   workspace root. The operator confirmed this means configured `agentDir`
   (`~/.pi/agent` here), to make this session's own config maintenance less
   obstructed. It does not make the directory writable to ordinary projects or
   remove credential/audit exclusions.
4. Daily Git and worktrees are the priority for subagent flows. Proposed
   acceptance gates cover authenticated Git with reused delegated authority and
   worktree provisioning/preflight/edit-test/integration/cleanup, including
   external worktrees and unauthorized sibling sentinels.

Details and remaining clarifications are in
[product requirements](product-requirements.md#operator-decisions-after-round-1).
No prompt/latency budget was specified. A read-only
[Claude/Codex comparison](reference-permissions.md) supports the common-tool and
additional-root direction while recording API/enforcement differences. Both live
profiles already list this repository for agent-directory maintenance. No second
implementation wave or live policy change is inferred from these interview
answers; full headless validation is still separately blocked.
