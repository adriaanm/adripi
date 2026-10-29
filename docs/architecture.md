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
  |          -> configured exclusion / approved host execution
  |     read/write/edit/grep/find/ls -> in-process file-policy checks
  |
  +-- sandbox exception broker (published by Guardian)
  |     validate -> deny/defer/allow rules -> semantic reviewer
  |     defer -> human UI, or supported supervisor path
  |     allow -> sandbox grant or host-command route
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
| `pi-sbx` | Session scratch space, Guardian broker client and exception tool, session overlays, trap hints, host-command grants, additive allow-list merging, maintenance-workspace privilege, supervisor fallback, system guidance, Codex-shaped inline escalation and standing-rule handoff |
| `pi-guardian` | Explicit reviewer provider extensions, child-runner invocation fix, review-failure reporting, sandbox exception broker/rules/audit, maintenance-workspace rules, trusted project policy and persistence service, target-only matching for file write/edit payloads |

Detailed provenance and update records:
[`pi-sbx/VENDOR.md`](../forks/pi-sbx/VENDOR.md) and
[`pi-guardian/VENDOR.md`](../forks/pi-guardian/VENDOR.md).

## Authority and state

- **OS boundary:** SRT for sandboxed bash process trees; named built-in file
  tools are gated separately inside Pi.
- **Semantic authority:** Guardian fixed rules and retained-transcript review.
  A reviewer failure denies; a missing broker invokes human fallback instead.
- **Persistence authority:** human-approved settings and project rules. Project
  Guardian policy is trusted by content hash; project sandbox policy has its own
  approval path and merge semantics.
- **Maintenance authority:** the installer grants this repo permission to modify
  the agent directory. That deliberately weakens self-protection for this
  workspace; credentials and Guardian session writes remain protected.
- **Session state:** scratch path, in-memory policy overlays, host grants,
  network tokens and pending once grants. These are not yet one isolated lease
  implementation; concurrent scoped grants and differing expiry paths are
  reviewed gaps.
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
