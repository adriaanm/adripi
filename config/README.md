# config

Templates installed by `install.sh` into `~/.pi/agent`. Existing files are kept,
so you can customize them on each machine. See the
[as-built product guide](../docs/product.md) for the complete current contract and
[review](../docs/review/recommendations.md) for known safety/ergonomic gaps.

- `guardian.json` — semantic reviewer and sandbox-broker settings. The template
  uses `neuralwatt/nw-flash` and loads the Neuralwatt provider extension in the
  reviewer sidecar. `sandboxExceptions.{allow,defer,deny}` carries the
  `surface:pattern` rules for sandbox exceptions; credentials, audit and
  secret-file writes are denied in code. Agent-directory writes have only the
  trusted maintenance-workspace carve-out described below.
- `guardian-policy.md` — the reviewer policy. Workspace-local work is allowed,
  credentials and security configuration are denied, sandbox exceptions need
  trusted-user authorization, and uncertainty fails closed.
- `sandbox.json` — the OS sandbox profile for the vendored `pi-sbx` fork,
  installed as `~/.pi/agent/extensions/sandbox.json`. Project writes are
  allowed; the shared temp root is not; `~/.ssh`, `~/.aws`, `~/.gnupg` and
  `~/.config/gh` are unreadable; package hosts (npm, GitHub, PyPI, Maven,
  Gradle) are allowlisted, and anything else is reviewed per connection.
- `pi-review.json` — the diff-review gate and reviewer models.

## Scratch space

Each session gets a private scratch directory under the host temp tree, exported
to sandboxed commands as `PI_SANDBOX_SCRATCH`. It is added to the effective
profile at session start, removed at shutdown, and never written to this config.
Temporary files belong there; no exception is needed.

## Agent directory

One file is read-denied: `<agentDir>/auth.json` (provider credentials and OAuth
tokens). Everything else is data a sandboxed command may legitimately read —
installed packages and their skills, session transcripts and subagent artifacts,
`settings.json`, `guardian.json`, `extensions/sandbox.json`.

Writes are the guarded side: the agent dir is deny-write for every project except
one listed in `agentDirWriteProjects`, `auth.json` and `guardian-sessions` are
unwritable even there, and `<workspace>/.pi` stays mandatory deny-write. That is
how the sandbox and reviewer configuration is protected from modification except
by this repo's own sessions. Both the spelled cwd and its canonical target
must remain inside the configured project root. Guardian keeps user-deny
provenance and configured audit protection separate from the liftable lock;
its published broker is bound to the active session cwd.

## Paths outside the project

An exception is a reviewed decision, not a config edit:

1. The agent attaches the request to the **same bash call**: use
   `sandbox_permissions: "with_additional_permissions"`, a `justification`, and
   `additional_permissions.file_system.{read,write}` arrays of exact absolute or
   `~/…` paths. Native Read/Write/Edit keep their own schemas and request a
   grantable exact target through the same path authorizer at their file gate.
   Neither route changes baseline or opens a session-grant window; recursive
   traversal is not widened. Do not switch tools after a denial.
2. Guardian validates and reviews every target before the runtime changes.
   Credentials, secret writes and protected roots/aliases are denied by rules.
   Missing or failed Guardian denies; only a real `defer` asks the human.
3. The command runs inside the sandbox with a copied, execution-local profile.
   Bash executions and runtime-setting changes serialize; file tools never see
   transient paths. The baseline is restored on success, failure and cancellation.
   A failed restore disables further execution rather than leaving a grant live.
4. For host-only work use `sandbox_permissions: "require_escalated"` and a
   `justification`. Policy, executable/shape and prefix checks precede broker
   review. The reviewed string runs once on the host in that call; no token or
   next-command grant is stored. Host execution is full-host authority.
5. Unknown network destinations use the same decision contract per connection,
   without modifying the allowlist. Numeric rules such as
   `network:example.test:443` match only that port; bare hosts and `:*` mean all
   ports. IPv6 targets must be bracketed.

All surfaces use one serialized human UI adapter. A headless `defer` fails closed
with instructions; it does not invoke model-only `contact_supervisor` through
Pi's nested-tool API. Child approval transport is a remaining requirement.

## Permanent, per-project policy

A project can carry its own `<workspace>/.pi/sandbox.json` (same shape as this
profile). It is merged over the global one at session start after one
confirmation, and the directory is mandatory deny-write for the sandbox and the
file tools, so the agent cannot widen its own policy.

- **Allow lists are additive.** `filesystem.allowRead`, `filesystem.allowWrite`,
  `network.allowedDomains` and `network.allowUnixSockets` union across layers;
  a project entry adds a grant and never revokes a global one (otherwise
  "write /tmp/sgo-501" would drop the workspace and "add one host" would drop
  the package hosts). Deny lists and every other array keep replace semantics.
  Human session settings and a command-local scoped layer follow the same rule;
  model-requested permissions do not mutate those session settings.
- **Unix sockets.** `network.allowUnixSockets: ["/tmp/sgo-501"]` makes the
  runtime emit `network-bind` (bind/listen) *and* `network-outbound` (connect)
  rules for that directory, plus `system-socket AF_UNIX`; the directory also
  needs `allowRead`/`allowWrite` for its non-socket files. `allowLocalBinding`
  adds loopback TCP bind/inbound and connects to `localhost`.
- **Host-only commands.** Use Guardian's `command:just ios-device-logs:*`
  project rule (below). It pre-authorizes an explicitly requested host execution,
  never reroutes a plain command automatically. `excludedCommands` is retired:
  nonempty legacy lists fail configuration closed with migration instructions.
  An empty legacy list remains harmless, but new templates omit it.

To make a path permanently writable, add it to `filesystem.allowWrite` in
`sandbox.json` yourself. For a network host, add it to
`network.allowedDomains`. Prefer narrow entries (`~/.gradle/caches`) over
`~/.gradle`.

### Cross-workspace maintenance from adripi

`adripi-project-sandbox.json` is an **opt-in project profile**, not an installer
seed or a replacement for the global sandbox profile. To install it manually,
from this repository run:

```sh
mkdir -p .pi
cp config/adripi-project-sandbox.json .pi/sandbox.json
```

Start a fresh Pi session in this repo and approve the project profile when
prompted. Its additive `filesystem.allowRead` / `allowWrite` roots cover
`~/.pi/agent`, `~/g/bq268/wata` and `~/g/sgola`, plus this repo's existing write
scope. Adjust those home-relative paths if the checkout layout differs. There
is no separate `workspaceRoots` setting, and this profile does not import the
other projects' network, socket or command permissions.

Deny arrays replace rather than union. This template therefore retains all six
secret-file write denies from `sandbox.json` and adds home-relative equivalents
(`~/**/.env`, `~/**/*.key`, etc.). Relative globs alone protect only the current
workspace, not the added roots. If the live global profile has extra custom
write denies, retain them in this project profile too before installing it.

This deliberately trusts adripi sessions to edit the two other workspaces,
including their `.pi` configs. It does **not** make this repo's own `.pi`
writable, remove inherited secret-file restrictions, expose `auth.json`, permit
Guardian audit writes, or exempt operations from Guardian review. Agent-dir
maintenance additionally requires this repo's absolute root in **both global**
`agentDirWriteProjects` lists described below; the installer already provisions
that grant. Adding it to a project profile would be ignored.

### Maintaining this profile from its own repo

`agentDirWriteProjects` (top level in `sandbox.json`, and under `permissions` in
`guardian.json`) lists absolute project roots whose sessions may write the agent
dir. `install.sh` adds this repo's own root, so a session in `~/g/adripi` can
repair `extensions/sandbox.json`, `guardian.json`, `settings.json` or the
deployed fork sources instead of asking you to switch the sandbox off.

- Read from the **global** profile only: a project or session layer cannot widen
  it, and a session outside the listed roots still sees the full lock.
- `<agentDir>/auth.json` stays read- and write-denied; Guardian's
  `<agentDir>/guardian-sessions` stays write-denied but is readable. The
  `<workspace>/.pi` directory stays mandatory deny-write.
- This is a real privilege: a session in a listed workspace can change what Pi
  and Guardian load next, including the sandbox profile and the reviewer.
  Delete the entry from both live configs to revoke it.

### Standing permissions per project

A project can carry its own Guardian policy at `<workspace>/.pi/guardian.json`.
It is how "this project may push to its own repo with the host's gh credentials"
becomes a standing permission instead of a prompt every time:

```json
{
  "sandboxExceptions": {
    "allow": [
      "command:git ls-remote:*",
      "command:git fetch:*",
      "command:git pull:*",
      "command:git push:*",
      "command:gh pr create:*",
      "command:gh pr view:*"
    ],
    "deny": [],
    "defer": []
  }
}
```

Only **network** git belongs in that list. `status`, `diff`, `log`, `show`, `add`,
`commit`, `branch`, `switch`, `merge`, `rebase`, `tag`, `stash` and `worktree` run
inside the sandbox and need neither a rule nor an exception; `clone`, `fetch`,
`pull`, `push`, `ls-remote` and `submodule update --remote` do, because they
authenticate with the remote (an anonymous fetch of a public repo may still work
sandboxed).

Rules can also arrive from the agent: when the model proposes a `prefix_rule`
on an escalation (`prefix_rule: ["git", "push"]` → `command:git push:*`) you are
asked once, "Save a standing permission?", and guardian appends it to this file
and records trust for the new content. Nothing is written without that yes, and
the command still has to request the exception each time — the rule skips the
broker's reviewer, not fixed restrictions or the ordinary tool gate. Saves apply
immediately in the current session as well as future sessions; no reload is
needed. Repeating the same proposed rule must not repeat the save offer:
Guardian reports whether that exact rule is already in its trusted snapshot.
This only suppresses save UI, not broker deny/defer decisions. A different or
broader proposal still needs its own approval, even if an existing rule already
allows the current command. (Older installed code could allow by the saved rule
and still repeat the save prompt; deploying the fix needs a full Pi restart.)
Guardian captures a trusted policy snapshot **before** offering to save the rule; a
changed, newly appeared, invalid or unapproved file is refused rather than
implicitly trusted. Symlinked policy files/directories are rejected; writes use
an exclusive temporary file and atomic rename. Guardian trusts and applies only
the returned bytes, never a post-write re-read. Separate processes are not
locked: simultaneous external writers can still lose an update; this is not a
hostile same-user filesystem-race defence.

These rules pre-authorize the *exception*, not the sandbox: the agent still has
to attach `sandbox_permissions: "require_escalated"` and a `justification` to
the exact bash command, which then runs on the host with your credentials. A command run
inside the sandbox cannot use `gh` or a git credential helper — `~/.config/gh`
and friends are permanently denied, by design.

- Command rules accept `prefix:*` for "this command with any arguments"; the
  space boundary means `command:git push:*` does not match `git pusher`, and a
  trailing colon without `*` (`command:git pull:`) is rejected as a rule that
  would silently match nothing.
- Layering, tightest first: the global hard denies and global `defer`s always
  win, then the project's own deny/defer, then the project's `allow`, then the
  global `allow`. A project can pre-authorize its workflow, never erase a global
  restriction.
- The file is **trusted by content hash**. Guardian asks once, in a session with
  a UI, and records the hash in `<agentDir>/guardian-project-trust.json`; a
  subagent (no UI) applies the policy only when that exact content was approved.
  Editing the file requires a fresh approval and is otherwise ignored.
- Only `sandboxExceptions` is honoured. `pi-sbx` makes `<workspace>/.pi`
  mandatory deny-write, and Guardian denies writes there too, so an agent cannot
  pre-authorize itself.

### Remote git

`git push`, `git pull` and clones of private repositories need the host's
credential helper, so they cannot authenticate inside the sandbox. Attach
`require_escalated` and a justification to the exact bash command — for example
`git push -u origin main`.
Guardian reviews it; on approval that exact string runs once on the host with
your normal git credentials, and the token never enters the sandbox or the
conversation. Chained commands, redirects, command substitution and interpreter
wrappers are refused by the sandbox before review and hard-denied by guardian's
rules.

## Why JSON, not TOML

`sandbox.json` is the shape `@anthropic-ai/sandbox-runtime` validates
(`SandboxRuntimeConfig`); both the loader and the runtime accept it directly, so
there is no second syntax to keep in sync.

## Guardian context budgets

`reviewer.context` defaults to `maxTokens: 32768`, `targetTokens: 8192`,
`pruneAfter: 8`, `maxDirectiveChars: 128000`. Defaults apply in code to existing
configs: no template merge/live edit is required. Guardian prunes repeated allows
and duplicate evidence first, summarizing residual task evidence only if needed.
Full ordered user directives and denials stay protected. Token estimates include
policy/output headroom and are not exact provider counts. Excessive protected
history or unsafe legacy recovery fails closed, never silently truncates it.

All reviews of one UUID serialize, including sandbox reviews and compaction.
Timeout waits for process exit. A stale `.guardian-<UUID>.lock` requires human
investigation; do not remove one while its owner is running. Stable UUID, audit,
denial streak and parent cursor survive pruning. This changes no standing
permission or live Guardian toggle. See [the implementation record](../docs/guardian-context.md).

## Guardian costs

No pricing/reporting config migration is needed. Guardian adds a separate token
and known-USD-estimate line to its widget; `/guardian costs` shows review,
format-retry, summary and legacy breakdowns without changing the enabled flag.
Parent/subagent native totals are untouched. Zero/absent tariffs are unpriced,
missing usage unreported, and unfinished transports remain visible. See
[the accounting record](../docs/guardian-costs.md); these are SDK estimates, not
provider/subscription invoices or live cost-savings measurements.

## Guardian reviewer extensions

The vendored guardian fork adds `reviewer.extensions`. Only the entries in that
array and the trusted internal managed-review bootstrap are loaded explicitly.
The actual SDK reviewer loads only those providers and no tools or ambient
resources. The CLI still uses `--no-tools` and `--no-extensions`.

Use this when the reviewer provider is supplied by a Pi extension, for example:

```json
"reviewer": {
  "model": "neuralwatt/nw-flash",
  "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"]
}
```

For a built-in provider, or a provider defined in `models.json`, leave
`reviewer.extensions` empty.
