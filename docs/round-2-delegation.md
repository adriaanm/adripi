# Round 2 dependency: trusted child authority and approval transport

**Status: investigated, not implemented.** This records the parent-reviewed
conclusion of workflow `4a89c5cc-5fb5-4f66-a588-6fc1ce1a9f93`'s read-only
`delegation-substrate` lane. The operator authorized round-2 development, not a
silent deployment or a new unreviewed transport. D2/PR3 and full child/worktree
acceptance remain open.

## What the installed package actually exposes

Inspected `pi-subagents@0.81.0` under `<agentDir>/npm/node_modules/pi-subagents`:

| Supported export | Relevant contract | What it does not provide |
|---|---|---|
| `required-child-extensions` | `registerRequiredChildExtensions({ sessionId, extensions: [{ id, path }], requireForAllRunners? })` | No launch-specific authority payload or decision callback. A required path is not a grant. |
| `capability-ceiling` | Tool-name/agent-name restrictions and `denyExtensions` | No filesystem roots, command grants or provenance. |
| `preflight` | `resolveSubagentLaunchContract`, including required-extension evidence | No filesystem-authority/worktree readiness input. Its task-text authority warning is not enforcement. |
| `delegation` | `prompt-template:subagent:*` events and structured task/results | No host authorization envelope or approval service. |
| `control-channel` | `requestAsyncStop` | No child-to-parent permission request/reply API. |

`extensionBindings` is model-settable configuration, not a trusted capability.
The native supervisor tools are model-only conversation coordination. They do
not expose a code-callable, typed grant service; their free-form replies do not
prove held authority or human consent. Private worktree and launch modules are
not public extension APIs.

References within that installed package:

- `package.json` exports map and `src/api/{preflight,delegation,control-channel}.d.ts`.
- `src/shared/required-child-extensions.d.ts` and
  `bundle/chunk-CTPAE36Y.js`: validate only id/path, retain required snapshots.
- `src/runs/shared/capability-ceiling.d.ts`.
- `src/runs/shared/child-launch.js` and the **actually exported bundle**'s
  `chunk-XMFLCKMQ.js` (`buildInProcessChildLaunch`, `ambientExtensions`).
- `src/runs/shared/child-session.js` and `bundle/chunk-26C3WLYQ.js`
  (`noExtensions: !launch.ambientExtensions`).
- `bundle/chunk-BPS2AGBZ.js` (`registerNativeSupervisorClient`).

Readable `src/*.js` helped trace the package, but its public exports select
`bundle/*.js`; source-only inspection is not proof of loaded bundle behaviour.
The relevant extension-loading branches were checked in both.

## Why simply making the sandbox a required child extension is not accepted

The scout identified a real loading gap: foreground `host: "parent"` child
launches disable ambient extensions, and background runners can disable them
through their tool plan. Therefore ambient installation alone does not establish
that either guard is loaded into a child. Required extensions are a useful
host-owned loading primitive, but they are not a complete authority solution.

The suggested registration-only change is **not safe to call narrowing**:

1. Child `cwd` is a launch input, while the sandbox's default `allowWrite: ["."]`
   is interpreted relative to that cwd. Loading a fresh profile does not intersect
   it with parent-held scope. An arbitrary/external cwd does not acquire trusted
   authority merely because a model selected it. Nested cwd inside a globally
   listed maintenance project may also independently match that grant; it is
   false that all children necessarily lose maintenance authority.
2. `forks/pi-sbx/src/manager.ts` delegates to SRT's process-global
   `RuntimeSandboxManager`, while execution queues are extension-instance local.
   Two in-process sandbox instances can update/reset the same singleton without
   sharing their queues. Registering another instance is not session isolation.
3. Guardian's broker and project-policy services are process-global single-owner
   slots. A second broker publisher throws and is reported unavailable; it does
   **not** inherently replace the parent's broker as one scout claim suggested.
   A child consuming the parent slot is not its own session-bound authorization
   service either. The new cwd binding refuses a different workspace; it does
   not constitute a child delegation protocol.
4. `requireForAllRunners: true` also rejects incompatible external/machine
   placements. That is an explicit product trade-off, not a change to smuggle in
   while claiming all existing runners are supported.

No required-child registration or alternate execution mode was added in this
wave. Existing loading/containment gaps remain visible rather than receiving a
speculative partial fix.

## Minimum dependency change to decide next

Recommended next scope: a narrowly vendored/upstream **host launch-authority
hook plus request-bound parent approval service** in `pi-subagents`, consumed by
the existing authorization adapters, not another model-facing exception tool.
This needs explicit acceptance of a third vendored component and its update/test
burden (or an upstream release supplying the seam).

The contract must cover:

- The host derives a child-specific subset from authority the parent actually
  holds: assigned workspace, necessary Git metadata/scratch, selected maintenance
  scope and any delegable exact command authority. Model task/cwd/bindings are
  proposals, not proof. Non-delegable exclusions remain authoritative.
- A launch-bound envelope identifies parent session, child/run audience,
  authorization source, scope and lifetime. Foreground, background, retained and
  nested paths all carry it, or reject unsupported placement. Readable/writable
  manifests, ambient env and replayed model text are not sufficient trust roots.
- A host-callable child request first reaches the parent with a real request ID.
  Replies are verified against held/delegable scope; beyond-held authority needs
  the existing human route. Deny, unavailable, timeout, cancellation and shutdown
  are distinct. A waiting notice exists only for a delivered pending request.
- Cross-process transport authenticates the launch/request audience and protects
  integrity and replay boundaries. A new unauthenticated socket/file inbox is
  not an acceptable shortcut. In-process runtime/service ownership must be
  isolated or that placement must fail closed; do not silently switch runners.
- The host preflights file and Bash scope, Git metadata, scratch and required
  dependencies **before** the first child model call. Cleanup preserves dirty
  work on failure. External worktrees must not require an entire sibling-tree
  directory to be globally writable.

## Evidence we have, and what remains unproved

This wave adds a real local-Git fixture: provision a worktree outside its fixture
parent, check projected scope, run the registered native gate and core Write,
commit/review/fast-forward the fixture change, then remove only the clean
worktree. Parent-checkout writes, sibling direct/symlink writes, maintenance and
policy edits are negatives. Failure retains the fixture; successful cleanup does
not use force.

That is **not** a child launch, SRT profile, authenticated Git or approval
transport test. The source tests and the actual first-wave workers establish
useful components, not PR2/PR3/D4 completion. Real installed-runtime acceptance
still requires separately authorized deployment and a full restart. No network
Git/push or latency/overhead claim was made.
