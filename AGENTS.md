# AGENTS.md

Standing guidance for agent sessions working in this repo. `adripi` is not an
application: it installs and maintains the Pi + `pi-sbx` + `pi-guardian` setup in
the agent directory (`~/.pi/agent`). Most changes here only matter once they are
deployed there, so read the deploy section before concluding anything works.

## Deploy loop

`forks/pi-sbx` and `forks/pi-guardian` are vendored sources; Pi loads the copies
under `~/.pi/agent/npm/node_modules/<package>/src/`.

1. edit the fork in this repo, keep `VENDOR.md` deltas current;
2. `./install.sh` (or `just install`) — rsyncs both forks, seeds configs, and
   applies the agent-dir grant;
3. **fully quit and restart Pi**. An in-place extension reload can leave the old
   instance registered: the symptom is a tool that reports state the new code
   should not have (e.g. a host grant that still runs sandboxed, or "No guardian
   sandbox broker is published" while guardian is clearly reviewing calls).

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
- Session grants are additive, normalized and validated before they enter the
  layer. A `host:*` grant (the "any port" spelling) is stored as the bare host;
  a target the runtime cannot represent is refused instead of making every later
  `loadConfig` fail, which used to disable the sandbox for the whole session.
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
- Host-only commands: `excludedCommands: ["just some-recipe:*"]` runs the whole
  process tree on the host, unsandboxed. The prefix must start the command line;
  arguments may follow, a chained or piped line is not excluded. This is the
  permanent form of a `command` exception — no prompt, no per-session grant.

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
  (`agentDirWriteProjects(<path>)`), not via the reviewer: the reviewer cannot
  see which project holds the grant and would refuse its own maintenance path.

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
- A subagent that hits a deferred exception asks its supervisor through
  `contact_supervisor` and needs an explicit `ALLOW`/`DENY` token; a missing
  supervisor channel fails closed.

## Prompt-level guidance

`pi-sbx` adds a `<sandbox>` system-prompt section while the sandbox is on
(`src/guidance.ts`): writable/readable scope, the never-grantable credential
stores, the exception tool's one-exact-target rule, which git needs an exception
(only network git that authenticates: clone/fetch/pull/push/ls-remote) and which
does not, the host-command path (request, then run the exact line unchanged as
the next bash call), "a denial is final", and "circumvention is not a workaround".
Keep it short and behavioural —
it is the only place a model learns this harness's conventions, so a new rule
belongs there as well as in this file.

## Verification

- `just check` — shell syntax plus the config templates.
- `cd forks/pi-sbx && npx vitest run && npx tsc --noEmit`
- `cd forks/pi-guardian && npm test && npm run check` (`node --test`).
  `test/headless.test.ts` crashes node 26 with an assertion in libuv
  (`env_->execution_async_id()`); it fails identically on a clean `HEAD`, so do
  not chase it.
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
