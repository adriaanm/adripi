# Guarded launch and parent-provider source acceptance

This is acceptance of todo **#22**, not completion of production child delegation.
The [wiring contract](round-2-authority-wiring.md) and
[recovery findings](round-2-wiring-recovery.md) remain the design/history records.
The finished writer runs are terminal; the parent integrated the candidates,
read the actual dispatch/provider/lifecycle code and repaired remaining gaps.
No deployment, live-policy change, restart, credential/audit-content access or
push was performed.

## Delivered seams

- `pi-subagents/src/runs/shared/child-authority-launch.ts` supplies admission,
  placement refusal, actual spawned-process IPC preparation, runner binding and
  a process-lifetime nested-launch refusal latch. Actual foreground/async tool
  entry points refuse unsupported requests before run/worktree/workflow/schedule
  mutation; a final spawn check independently defends the resolved placement.
- One **native background child** is supported by the carriage. Foreground,
  chain/parallel/dynamic/workflow, nested, external CLI/job/machine/binary/wrapper,
  managed allocation, schedules and stale retained/append paths explicitly
  refuse. They do not silently change runner or recommend evading the guard.
- The runner captures its real IPC endpoint independently of writable config,
  awaits a live lease before loading extensions, binds the actual resolved
  session/run/agent/index/cwd and requires code-only readiness before a prompt.
  Injected factories cannot skip readiness. Guarded retries are refused rather
  than borrowing the previous session's acknowledgments. Parent loss/revocation
  aborts the real running session; preparation/factory failure disposes authority
  and failed startup attempts terminate the runner.
- `pi-sbx/src/child-authority.ts` publishes session-owned intent **before**
  fallible path validation or asynchronous initialization, demands canonical
  pi-sbx/Guardian entrypoints through the existing registration API and refuses
  second owners (including an explicitly present malformed slot). A failed or
  disabled service stays present and unavailable, never a bare-launch fallback.
- Reinitialization/policy changes revoke old leases synchronously. Shutdown keeps
  unavailable intent and mandatory registration through queue/runtime teardown,
  then releases only its own provider/registration. Prepared decisions combine
  the caller signal and lease revocation, including direct API calls while the
  broker or human is pending; a late allow cannot trigger a new human prompt or
  become consent after revocation.
- `action-authorizer.ts` shares the existing broker/human route with ordinary
  host Bash/network actions. Child path decisions use `authorizePathAction`, the
  immutable prepared ceiling **and** current parent baseline. Mandatory and
  configured denies in either policy stay final even after parent loosening.
  Outside the ceiling, a reviewer allow still needs explicit human **one-action**
  admission. No UI gives unavailable, not supervisor-prose approval. Requests
  retain the parent's actual cwd and host-fixed child identity as evidence.
  Existing broker API has no per-request abort parameter; transport/provider
  cancellation rejects late results and prevents subsequent human admission,
  but does not claim to cancel an already-running Guardian review internally.

## Frozen policy handoff for downstream consumers

The opaque launcher does not interpret this internal pi-sbx payload. Its JSON
shape is `version: 1`, `kind: "pi-sbx.child-policy"`, with:

| Field | Meaning / consumer obligation |
|---|---|
| `anchor.cwd` | Original parent baseline cwd; relative rules/globs retain this anchor, never the child's cwd. |
| `workspace.{spelled,canonical}` | Host-fixed proposed cwd and resolved target. Aliases cannot widen containment. |
| `read.{policy,deny,allow,mandatoryDeny}` | `policy: "deny-based"`; inherited read denies/carve-outs and non-overridable locks. Not fabricated finite read roots. |
| `write.{policy,allow,deny,mandatoryDeny}` | `policy: "allowlist"`; only admitted canonical workspace and separately verified, already-held Git metadata roots. Parent broad temp/sibling/maintenance roots are not copied. |
| `network.policy`, `command.policy` | Both `"parent-decision"`; not an empty permissive local allowlist or permission to execute arbitrary host commands. |

The payload is deep-copied/frozen and refuses oversize data (32KiB, depth 6,
128 keys, 256 array items, 8KiB strings), never truncates exclusions. Launch scope
outside the parent's held write policy refuses; this milestone does **not** add
recursive human launch-scope grants. Workspace overlap with agentDir or the
parent's private scratch refuses in either direction, including aliases. A later
consumer may add only its own genuinely host-created private scratch.

Git directory symlinks and `.git` file pointers retain spelled/canonical checks;
a workspace-local `.git` symlink cannot manufacture a held root elsewhere.
Known Git config/config.worktree/hooks exclusions remain mandatory even when the
Git directory itself cannot be delegated. Linked-worktree discovery admits only
the verified per-worktree Git directory: **shared `commondir` objects/refs and a
complete worktree commit lifecycle are not certified here**. Do not silently
widen that root in a consumer. Resolve necessary additional Git authority and
its negative cases in the separate Git acceptance milestone.

## Parent verification on Node v26.6.0

| Check | Current result |
|---|---|
| pi-sbx `npx vitest run`; `npx tsc --noEmit` | **212 pass / 22 files**; typecheck passes. |
| Subagents typecheck; focused `child-authority*.test.ts` | Typecheck passes; **76 pass** (included again in full suite). |
| Subagents full `npm run test:unit` | **4,216 pass / 17 skip / 0 fail**, 4,233 tests. Sandbox first failed on ps/socket/watcher fixtures; the **same command** passed after reviewed inline host approval. |
| Affected `async-execution.part-*.test.ts` integration suite | **234 pass / 0 fail**. Sandbox first failed on process-tree verification, loopback and watcher fixtures; same command passed with reviewed inline host approval. |
| `just build-subagents`; `verify-build.mjs` | Fresh graph: **383 inputs / 17 exports / 329 compiled modules / 18 module-URL targets / 765 artifacts**. |
| Actual bundle/compiled child-authority tests | **3 pass**: both ALS directions and shared provider identity. |
| `just check`; `git diff --check` | Pass, including **69** deployment fixtures. |

Ignored current logs: `.local/goal-wiring/{build,unit,async-integration,root-check}.log`.
The sbx suite/typecheck was rerun after the final six regressions were added.
Host fixture success is **not** sandbox/OS containment evidence. Historical
review verdicts and earlier helper-green runs were not used to waive defects.

The composed pi-sbx registered-session → actual `executeAsyncSingle` → real Node
IPC → controlled code consumers → existing broker/human fixture proves carriage,
parent cwd/identity, readiness ordering, one-action human admission and mandatory
own-policy refusal. Its acknowledgments are explicitly **test consumers**, not
production pi-sbx/Guardian enforcement.

## Required next gates

Production pi-sbx/Guardian child consumers (**#14**) must enforce this payload,
suppress ambient/root maintenance and broker publication, implement parent-first
native/Bash/network decisions and acknowledge only after enforcement is active.
Today actual required production extensions do not acknowledge: a guarded child
must fail readiness before its first model call. Do not call this operational
production delegation or install a fake acknowledgment to get past it.

Then **#15** must prove OS/native containment, ordinary external-worktree Git
edit/test/review/integration/dirty-preserving cleanup and authenticated Git with
meaningful sibling/maintenance/mandatory-deny negatives. Compatible-runtime
Guardian HTTP headless and live latency/cost acceptance remain separate open
checks. Source/build/fixture success does not authorize deployment or runtime
changes, nor prove that the current Pi process loaded these sources.
