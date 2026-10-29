# Implementation round 1: one action-bound escalation path

Status: in progress from `03d05a6`; initial external-worktree attempt paused
because of a live sandbox/supervisor integration failure. Same-protocol retry
uses pre-provisioned isolated worktrees inside the already writable workspace.

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
