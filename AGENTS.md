# AGENTS.md

Standing guidance for agent sessions working in this repo. `adripi` is not an
application: it installs and maintains the Pi + `pi-sbx` + `pi-guardian` setup in
the agent directory (`~/.pi/agent`). Most changes here only matter once they are
deployed there, so read the deploy section before concluding anything works.

## Deploy loop

`forks/pi-sbx` and `forks/pi-guardian` load from installed `src/`. The third fork,
`forks/pi-subagents`, loads a **built shared bundle + compiled src** graph; a
source-only overlay is invalid. All installed copies live under
`~/.pi/agent/npm/node_modules/<package>/`.

1. edit the fork in this repo, keep `VENDOR.md` deltas current;
2. for pi-subagents, provision its locked dependencies (`npm ci --ignore-scripts`
   in the fork, only when needed), then `just build-subagents`. This builds and
   checks the actual bundle/compiled authority registry without deploying;
3. `./install.sh` (or `just install`) — preflights build readiness, sets pnpm's
   hoisted layout (migrating an isolated install from its frozen lock without
   lifecycle scripts), installs pinned packages, validates **all** deploy plans,
   mirrors source forks and deploys the complete verified third-fork graph,
   seeds configs and applies the agent-dir grant. Stale/tampered artifacts refuse; existing policy is not generally merged;
4. **fully quit and restart Pi**. An in-place extension reload can leave the old
   instance registered: the symptom is a tool that reports state the new code
   should not have (e.g. a host grant that still runs sandboxed, or "No guardian
   sandbox broker is published" while guardian is clearly reviewing calls).

Keep `settings.npmCommand` as `["pnpm", "--config.node-linker=hoisted"]`:
Pi's TypeScript loader can resolve from a public package-root symlink rather
than its canonical `.pnpm` directory, losing otherwise installed dependencies.
A global `srt` binary does not repair extension module resolution. Layout
migration can replace overlays; never run it without the subsequent full deploy.

`./install.sh` never overwrites existing live config files, so a template change
in `config/` does not reach an installed machine unless `install.sh` learns to
merge it (see the agent-dir grant step) or the human edits the live file.

## Policy layering (pi-sbx)

- Global profile: `~/.pi/agent/extensions/sandbox.json`. Project profile:
  `<workspace>/.pi/sandbox.json`, applied after one confirmation.
- **Allow lists are additive above the user's own file**: `network.allowedDomains`,
  `network.allowUnixSockets`, `filesystem.allowRead`, `filesystem.allowWrite`
  union project- and session-layer entries instead of replacing them. The
  defaults → global step still replaces, so the global profile can withdraw a
  built-in default. Deny lists and other arrays replace (highest layer wins).
- Human session settings and copied command-local path layers are additive.
  Model exceptions do not mutate session policy. Every path is decided before
  SRT changes; serialized bash restores baseline in `finally`, and native file
  tools always read baseline. Native Read/Write/Edit and scoped Bash use one
  action-bound path authorizer: native grants admit only that operation, never
  mutate baseline and never widen recursive traversal. Mandatory reads precede
  allowRead carve-outs; other read denies need a strictly more-specific exact
  carve-out. Network decisions apply to one connection without
  adding an allowlist entry. Numeric Guardian port rules match only that port;
  bare hosts and `host:*` mean all ports.
- Writes are allowlist-based: lifting a deny is not enough, an `allowWrite` root
  must exist too. Reads are deny-based with `allowRead` carve-outs.

## Permanent per-project capabilities

Do not invent a per-session workaround for something a project needs every time;
put it in that project's `.pi/sandbox.json` (`.pi` is mandatory deny-write, so
the agent cannot widen its own policy — the human writes it).

- Unix sockets: `network.allowUnixSockets: ["/dir"]` grants `network-bind`
  (bind/listen) *and* `network-outbound` (connect) for that directory; the
  directory also needs `allowRead`/`allowWrite` for its non-socket files.
- Loopback TCP: `network.allowLocalBinding: true`.
- Host-only commands: use a trusted Guardian project rule such as
  `command:just some-recipe:*`. It pre-authorizes an explicit inline host request,
  not a plain command. `excludedCommands` and its UI/fallback are retired;
  nonempty legacy lists fail closed with migration instructions.

## Agent-dir maintenance

`agentDirWriteProjects` (top level in `sandbox.json`, under `permissions` in
`guardian.json`) lists absolute project roots allowed to read and write the agent
dir. `install.sh` adds this repo, which is why a session here can repair the
profile it installs. Keep it that way; it is the only reason agent-dir edits are
not blocked.

- Exactly one file is read-denied: `<agentDir>/auth.json`. Skills, installed
  packages, session transcripts, subagent artifacts, `settings.json`, the sandbox
  and reviewer configuration are all readable, so a normal tool read needs no
  exception.
- Writes are the boundary. The agent dir is deny-write for every project except
  one listed in `agentDirWriteProjects`; `auth.json` and `guardian-sessions`
  (Guardian's audit trail) stay deny-write even for it, and `<workspace>/.pi`
  stays mandatory deny-write.
- `<workspace>/.pi` stays mandatory deny-write, so a granted project still cannot
  edit its own project policy.
- Guardian decides file-tool maintenance calls in its **rule engine**
  (`permissions.agentDirWriteProjects(<path>) root=<root>`), not via the reviewer:
  the reviewer cannot see which project holds the grant. The file-tool and
  exception rule engines share that resolver; both OS and Guardian require
  spelled/canonical cwd containment. The published broker rejects another cwd
  rather than borrowing that workspace's authority. Explicit user/project
  restrictions and auth/audit/policy exclusions still win.

## Commit regularly

Commit as you go: one commit per coherent, verified change (a fork fix with its
failure-mode doc and tests, a config/template change with its check, a wodou-side
record). Do not let a session end with a verified fix sitting uncommitted, and do
do not batch unrelated work into one "update" commit.

- Run `just check` before committing (and the fork test suites when you touched
  their `src/`).
- Commit the pair: behaviour **and** the explanation. `VENDOR.md` deltas,
  `config/README.md`, `docs/` and `AGENTS.md` belong in the same commit as the
  code they describe, or the next session will not know why the code looks odd.
- Commit messages state the failure mode, not just the change ("a `host:*` grant
  poisoned the profile" beats "normalize network targets").
- Deploying is a separate step and needs the human: source can be committed and
  pushed before `./install.sh` has run anywhere.
- Push when the human asks, or when they asked for it at the start of the task;
  `git push` needs a reviewed host-command exception (remote git uses the host
  credential helper).

## Standing permissions and escalation

- Per-project standing sandbox permissions live in `<workspace>/.pi/guardian.json`
  (`sandboxExceptions.allow`), trusted by content hash and asked once in a UI
  session. Global denies and `defer`s always win; a project can pre-authorize,
  never loosen. Only that one key is honoured. `.pi` is deny-write for the agent
  in both layers, so a policy is never self-granted.
- Command rules accept `prefix:*` for "this command with any arguments" (space
  boundary); bare globs still work for everything else.
- A headless deferred exception fails closed with an actionable explanation.
  `contact_supervisor` is model-only, not a nested-call service; do not invoke it
  through `ctx.executeTool` or treat a parent `ALLOW` token as human authority.
  Usable human-only child approval transport remains a product requirement.
- Guardian's standing-rule service prepares a rule against trusted policy bytes
  before the human prompt, then commits against that snapshot. Never re-read and
  trust whatever policy appears after saving. Changed/unapproved/symlinked policy
  is refused; a disposed service cannot commit a prepared save.

## Following Codex's escalation pattern

Models are trained on Codex's harness, so the bash tool speaks its dialect
(`forks/pi-sbx/src/inline-escalation.ts`): `sandbox_permissions`
(`use_default` | `require_escalated` | `with_additional_permissions`),
`justification`, `prefix_rule`, `additional_permissions.file_system.{read,write}`.
Two rules follow from that shape and must stay true:

- **The escalation travels with the command.** `with_additional_permissions`
  widens for that one call, runs the command inside the sandbox, then revokes the
  grants; `require_escalated` runs the exact line on the host. Never reintroduce a
  mandatory "request, wait, re-run" two-step for something a single call can do.
- **A proposed rule is the human's call.** `prefix_rule` becomes a project rule
  only after a "Save a standing permission?" confirmation; the sandbox hands it to
  guardian's `pi-guardian:project-policy` service (guardian owns and trust-hashes
  `<workspace>/.pi/guardian.json`) and never writes policy itself. Without that
  service no standing permission is saved; there is no fallback policy store.
- **One public API.** `request_sandbox_exception` is retired, and
  `dangerouslyDisableSandbox` is explicitly rejected. Filesystem overrides
  support only `additional_permissions.file_system.{read,write}`. Native tools
  retain their own schemas and request exact-target authority at their gate,
  through the same path authorizer; never rewrite a denied Edit as Bash. Network
  is reviewed by the proxy per connection. Missing/failed Guardian denies rather
  than bypassing its hard restrictions through a local human fallback.
- **Failure is the trigger.** The guidance tells the model to re-run a
  sandbox-failing command with escalation attached, without messaging the user
  first. Scope it: prefer the path-scoped tier over host execution, and keep
  `prefix_rule` categorical and narrow (no shells, interpreters, `rm`, heredocs).

## Prompt-level guidance

`pi-sbx` adds a `<sandbox>` system-prompt section while the sandbox is on
(`src/guidance.ts`): writable/readable scope, the never-grantable credential
stores, exact scoped paths, which git needs an exception (only network git that
authenticates: clone/fetch/pull/push/ls-remote) and which does not, the inline
host-command path (request and execute the reviewed string in the same call),
"a denial is final", and "circumvention is not a workaround".
Keep it short and behavioural —
it is the only place a model learns this harness's conventions, so a new rule
belongs there as well as in this file.

## Native Bash output capture

`output_file` captures the combined backend stream without modifying `command`,
so a plain host request stays plain. The log path uses baseline exact-write
validation separately from execution approval and never widens SRT. New file
only, existing parent directory, mode 0600; no overwrite/append or final symlinks.
Open only at admitted operations exec; preserve native SDK error semantics and
partial logs with exit/cancellation/completeness metadata. Disk errors abort and
fail rather than claim full output. Do not use capture to write denied policy,
credential or audit paths. Logs are unredacted and have no quota/automatic expiry;
project logs persist and scratch logs follow scratch cleanup. See the fork README.

## Guardian reviewer context

`forks/pi-guardian/src/managed-reviewer.ts` owns the durable SDK reviewer;
`sidecar.ts` launches only a tool-free ephemeral CLI bootstrap. Preserve the exact
UUID, source-framed user directives, denials, raw audit and parent cursor.
Deterministic pruning precedes Pi summarization of residual **untrusted** task
evidence. Prior allows never become standing permission. Oversized pinned/legacy
history and failed or ineffective summaries fail closed; do not reset the session
or switch models. Tool and sandbox reviews share a per-UUID queue/lock, which is
released only after process termination. Never remove a lock whose owner is
running. SIGKILL stale locks require human investigation. Budget settings are
owned/in-memory and must not mutate live Pi settings. See
`docs/guardian-context.md`; deployment remains a separate human step.

## Guardian costs

`forks/pi-guardian/src/usage.ts` projects Guardian-only full-tree cumulative
usage. Keep it out of native parent/subagent totals: custom entries only, never
synthetic assistant/SDK usage messages. Failed reviews/retries/summaries can cost
money; successful checkpoints link an already-counted summary record. Missing
prices/usage and unfinished transports must stay explicit, not become zero.
`/guardian costs` and widget inspection never change the toggle/config or grant
authority. See `docs/guardian-costs.md`; estimates are not provider invoices.

## Verification

- `just check` — shell syntax plus the config templates.
- `just check-child-composition` — fresh third-fork build/graph and both actual
  registered consumers through SDK/Node IPC, including source/compiled detached
  launch/startup/CLI/default factory/drain and negative cases. OS backend,
  provider, reviewer and human answers are explicit fixtures; not deployed/OS/live
  acceptance. The test reuses upstream isolated HOME/temp/runtime-environment setup.
  Default locked SDK1.2; optional existing native-peer loader also verifies actual
  SDK1.4 with matching peers, without installation. See reproduction/scope in
  `docs/round-2-production-consumers.md`.
- `cd forks/pi-sbx && npx vitest run && npx tsc --noEmit`
- `cd forks/pi-guardian && npm test && npm run check` (`node --test`).
  `test/headless.test.ts` crashes macOS Node26 with an assertion in libuv
  (`env_->execution_async_id()`), also reproduced on a clean `HEAD`. The full
  **215-test suite including HTTP headless passes on Linux/arm64 Node24.22.2**
  in an explicitly authorized `container` VM; see
  `docs/guardian-container-verification.md` and `scripts/verify-guardian-vm.mjs`.
  That is not a host Node26 fix, deployed acceptance or standing VM permission.
  Fresh Guardian/pi-sbx verification uses their existing frozen pnpm locks;
  pi-sbx's secondary npm lock is stale (#31), not permission to upgrade deps.
- When the sandbox is active you cannot nest `srt`/`sandbox-exec` to test a
  profile from inside a session; verify policy logic with the exported helpers
  (`loadConfig`, `createFilePolicy`/`canRead`/`canWrite`, `evaluatePermissions`)
  and leave the OS-level half to the human's next session.

## Pitfalls

- Guardian matches path rules against the literal text of shell input (including
  `~`/`$HOME` spellings), so a command or a heredoc that merely mentions a
  protected path can be denied. Verified: `write`/`edit` payloads are exempt and
  matched on their target path only.
- `srt` rejects `host:*` in `allowedDomains` and accepts a bare host for any
  port; it also requires bracketed IPv6 literals.
- macOS resolves `/tmp` to `/private/tmp`; list both spellings for socket
  directories.
