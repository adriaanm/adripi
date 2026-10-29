# Architecture

For the complete current contract, see the [as-built product guide](product.md).
Known gaps and proposed acceptance criteria are in the
[review](review/recommendations.md). The earlier
[broker plan](plan-sandbox-broker.md) records design history, not a certification
that every original invariant still holds after later additions.

## Components

```text
Pi host (trusted process and extensions)
  |
  +-- pi-guardian: tool_call authorization
  |     fixed deny -> fixed allow/exemption -> semantic reviewer
  |       |
  |       +-- separate Pi reviewer process
  |             explicit provider extension allowlist; no built-in tools
  |
  +-- pi-sbx: named file-tool policy hooks + replacement bash tool
  |     bash -> default SRT execution
  |          -> execution-local scoped SRT profile / approved host execution
  |     read/write/edit/grep/find/ls -> in-process file-policy checks
  |
  +-- sandbox exception broker (published by Guardian)
  |     validate/exact-target admission -> deny/defer/allow rules -> reviewer
  |     defer -> one serialized human UI adapter; no headless channel -> stop
  |     allow -> one execution or one network connection
  |
  +-- pi-review + pi-subagents: separate advisory diff-review workflow
```

Hooks execute in registration order. Guardian reviews actions before tool
execution; the bash tool then chooses its execution mode. This is not a universal
pipeline that OS-sandboxes every tool before the semantic gate. Other extension
and MCP implementations run with the host authority of their implementation,
subject to applicable tool hooks. Child containment requires verification of the
actual launch path, not an assumption about the approved parent call.

## Local modifications

| Fork | Main additions |
|---|---|
| `pi-sbx` | Scratch space, one inline escalation API/dispatcher, serialized execution-local path policy and rollback, baseline native file gate, per-connection network decisions, one human adapter, additive policy layers, maintenance privilege, guidance and snapshot-bound standing-rule handoff |
| `pi-guardian` | Explicit reviewer provider extensions, child-runner invocation fix, review-failure reporting, sandbox exception broker/rules/audit, maintenance-workspace rules, trusted project policy and persistence service, target-only matching for file write/edit payloads |

Detailed provenance and update records:
[`pi-sbx/VENDOR.md`](../forks/pi-sbx/VENDOR.md) and
[`pi-guardian/VENDOR.md`](../forks/pi-guardian/VENDOR.md).

## Authority and state

- **OS boundary:** SRT for sandboxed bash process trees; named built-in file
  tools are gated separately inside Pi.
- **Semantic authority:** Guardian fixed rules and retained-transcript review.
  Reviewer failure and a missing broker deny. Only an actual defer asks a human.
- **Persistence authority:** human-approved settings and project rules. Project
  Guardian policy is trusted by content hash; project sandbox policy has its own
  approval path and merge semantics.
- **Maintenance authority:** the installer grants this repo permission to modify
  the agent directory. That deliberately weakens self-protection for this
  workspace; credentials and Guardian session writes remain protected.
- **Action state:** one queue owns bash executions and runtime-setting changes.
  A scoped runtime layer is copied and restored, never shared with the baseline
  read by file tools. No host/network/next-command grant store remains.
  Background-descendant lifetimes remain unverified.
- **Standing permission:** Guardian prepares a rule against trusted policy bytes
  before the human prompt; commit rejects stale/unapproved/symlinked policy and
  trusts/applies only returned bytes. No sandbox-exclusion fallback or post-write
  policy re-read. Writes are atomic but not locked across separate processes.
- **Audit:** Guardian status/assessment/exception entries plus reviewer
  transcripts. Complete correlated grant-consumption/revocation auditing is not
  implemented.

## Deployment

Pi normally loads sources under `<agentDir>/npm/node_modules`, not the vendored
working tree. `install.sh` installs pinned packages and rsyncs fork `src/` over
the npm copies, seeds absent configs and merges maintenance-root grants. It does
not generally migrate existing live policy.

Fully quit and restart Pi after deploying. Source files matching the repo do not
prove the active tool schemas or handlers match. Verification must exercise the
loaded runtime as well as repository tests.
