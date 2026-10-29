# Reference models: tool permissions and workspace authority

Read-only follow-up to the operator interview after round 1. The operator
confirmed that Bash should be a peer of the other tools in one authorization
system, and that the maintenance root is the configured `agentDir`
(`~/.pi/agent` here). This is research and requirements evidence, not a new
implementation wave or live-policy change.

## Claude Code: common permission vocabulary, separate OS enforcement

Official documentation inspected:

- [Permissions](https://code.claude.com/docs/en/permissions), especially
  tool specifiers, Read/Edit, working directories and additional directories.
- [Sandboxing](https://code.claude.com/docs/en/sandboxing).
- [Subagents](https://code.claude.com/docs/en/sub-agents), especially permission
  modes and foreground/background permission prompts.

The documented model supports the operator's interpretation:

- Bash is a tool in the permission system alongside file operations and other
  tools. Rules describe the action, e.g. `Bash(npm run build)` and
  `Read(./.env)`. File modification path rules use `Edit`, including writes.
  There is no requirement to route native file actions through Bash to obtain
  permission.
- `--add-dir`, `/add-dir` and `additionalDirectories` extend filesystem scope.
  A workspace root is not the same thing as permission to run every command,
  a change in permission mode, or trust in all configuration found there.
- Additional directories grant file access, not wholesale configuration loading;
  the docs list particular discovery exceptions. Do not conflate filesystem
  authority and executable-resource trust in our design either.
- OS-level shell sandboxing complements tool permissions. A shared permission
  vocabulary is not proof that native file tools and arbitrary subprocesses
  have identical enforcement or coverage. Claude documents command-text rule
  limits and separate filesystem/network enforcement.
- Subagents inherit the parent's permission rules. Documented permission modes
  constrain overrides, and background permission prompts surface in the main
  session. That supports shared authority and real parent-session routing; it
  does not prove that a parent model's arbitrary text constitutes human consent.

These are documentation claims, not a source audit or verification that every
Claude version implements every detail. We should borrow the coherent mental
model, not claim complete compatibility or copy all its modes and exceptions.

## Codex: shared orchestration and effective permission profiles

Inspected the local checkout at `~/g/codex`, HEAD `970111f6cb`.
The working tree had an unrelated tracked provider change and untracked local
files; no permission-source files listed below were reported modified. Nothing
was changed, built or executed in that repository.

Source references are relative to that checkout:

| Source | Evidence |
|---|---|
| `codex-rs/core/src/tools/orchestrator.rs` | `ToolOrchestrator` coordinates approval, sandbox selection and retry authority. It consumes tool runtimes and an environment permission profile/workspace roots. Its header explicitly calls for fresh review when a retry escalates authority. |
| `codex-rs/core/src/unified_exec/process_manager.rs` | Command execution invokes the shared orchestrator. |
| `codex-rs/core/src/tools/handlers/apply_patch.rs:526–598` | Native patch handling derives permissions for affected paths, uses granted permissions, then runs `ApplyPatchRuntime` through that same orchestrator; patching is not forced through the model's shell tool. |
| `codex-rs/core/src/tools/handlers/shell_spec.rs:225–272` | Command-specific inline fields include `sandbox_permissions`, `justification`, `prefix_rule`, and feature-dependent `additional_permissions`. Shared machinery does not require every tool to have the same input schema. |
| `codex-rs/utils/cli/src/shared_options.rs:65–76` | `--add-dir` explicitly makes additional directories writable alongside the primary workspace. |
| `codex-rs/core/src/config/mod.rs:1713–1743,3710–3752` | Runtime/profile roots combine into effective roots; primary cwd and requested additional writable roots seed the workspace set. |
| `codex-rs/core/src/agent/child_config.rs:104–203` | Child configuration uses the parent's effective turn settings, including approval policy, reviewer, cwd and a permission-profile snapshot, rather than cloning stale persisted settings alone. |
| `codex-rs/core/src/agent/control/spawn.rs:486–583` | A V2 resume path checks current parent authority and intersects a retained child permission profile with that authority; changed policy is not blindly restored from the old child. This is evidence for that path, not a proof of every child lifecycle. |
| `codex-rs/protocol/src/permissions.rs:40–51` | Protected workspace metadata names remain explicit under writable roots. A root grant need not erase exclusions. |

Important difference: this checkout also contains a separate, feature-dependent
`request_permissions` tool. See `codex-rs/core/src/tools/handlers/request_permissions.rs`
and its description in `codex-rs/core/src/tools/handlers/shell_spec.rs:149–190`: the client may grant a subset
for the turn or session, applied to later shell-like commands. Therefore Codex
is **not** evidence that only our round-1 inline API is the universal design,
nor that Codex and Claude expose identical permission grammars. Our requirement
is one coherent mechanism across the supported tools; whether to expose a
separate permission tool is not settled by borrowing the name of another agent.
The operator's already-selected direction does not require reintroducing one.

## Applying the model to adripi

The desired conceptual split is:

```text
session authorization context
  workspace roots + read/write scope + protected exclusions
  command/network rules + grant provenance/delegability
             |
             +-- Read / Write / Edit / Bash -> common authorization decision
             |                                -> tool-specific enforcement
             +-- parent -> bounded child authorization context
                          -> uncovered requests return to parent first
```

This is an architectural target, not an implemented API. Bash still needs OS
sandbox enforcement and exact reviewed host execution. A native write needs
path enforcement, not shell parsing. One mechanism means one interpretation of
roots, effective authority and grant provenance, not pretending these executors
are the same or inferring filesystem effects from arbitrary shell text.

### Agent-directory maintenance as an additional workspace

Yes: treating the configured agent directory as an additional maintenance root
for this privileged session is the intended way to avoid repeated exceptions
for the configuration this project exists to maintain. It must feed both the
OS file policy and Guardian's deterministic authorization/review context. It
should also be representable in the bounded authority passed to an assigned
child, rather than rediscovered from the child's cwd or prompt prose.

This parent already has much of that behavior through the existing special
case. Read-only inspection found `/Users/adriaan/g/adripi` in both:

- live sandbox `agentDirWriteProjects`;
- live Guardian `permissions.agentDirWriteProjects`.

`forks/pi-sbx/src/config.ts` opens the agent-directory write lock and supplies a
write allow-root for a permitted cwd. `forks/pi-guardian/src/permissions.ts`
decides the corresponding native maintenance file-tool actions deterministically.
The additional-root design would unify that authority and its delegation, not
create access this parent currently entirely lacks. Merely adding `allowWrite`
would not overcome a remaining deny in another layer.

Boundaries retained by the operator's existing maintenance authorization:

- This session/root is explicitly privileged; arbitrary projects cannot declare
  themselves entitled to modify agent configuration.
- `auth.json` stays read/write denied; Guardian audit-session writes stay denied.
- Workspace policy self-protection remains. A child cannot widen its own roots.
- Inherited authority is verified and bounded; a parent can pass on held,
  delegable authorization, not manufacture a new human decision.
- Editing installed sources/configuration is distinct from activating a new
  extension instance. Source deployment, preserved live config, full restart
  and active-schema verification remain separate concerns.

The saved live Guardian configuration also had `enabled: false` when inspected.
It was left unchanged; a file value is not proof of the current loaded runtime's
state. No guard was disabled as part of this investigation, no root was added,
and no credential or audit file was read or changed.

## First implementation acceptance priorities

1. Daily Git within an authorized workspace and authenticated operations covered
   by appropriate standing/parent-held authority.
2. Parent-provisioned worktrees, including outside the checkout, with equivalent
   baseline file-tool/bash scope, dependency/scratch preflight and bounded
   delegated rights before child launch.
3. The same paths and actions correctly refused from an ordinary project or an
   unrelated sibling workspace; maintenance credential/audit exclusions survive.
4. A child needing authority outside its grant produces an actual request in the
   parent's pending state. Missing authority does not trigger tool substitution,
   phantom waiting notices or duplicate human approvals for already-held rights.

No test results for those future gates are claimed here. Round 1's source checks
and the pre-existing full Guardian headless failure remain recorded separately.
