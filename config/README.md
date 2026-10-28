# config

Templates installed by `install.sh` into `~/.pi/agent`. Existing files are kept,
so you can customize them on each machine.

- `guardian.json` — semantic reviewer and sandbox-broker settings. The template
  uses `neuralwatt/nw-flash` and loads the Neuralwatt provider extension in the
  reviewer sidecar. `sandboxExceptions.{allow,defer,deny}` carries the
  `surface:pattern` rules for sandbox exceptions; credentials, the Pi agent
  directory and secret-file writes are always denied in code and cannot be
  granted.
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
by this repo's own sessions.

## Paths outside the project

An exception is a reviewed decision, not a config edit:

1. the agent calls `request_sandbox_exception` with one target (a command, a
   `host:port`, or an absolute path) and a reason;
2. `pi-guardian` reviews it against the conversation; credential stores, the Pi
   agent directory, `.env`/key/pem writes and `.git/hooks` are hard-denied
   before the reviewer runs;
3. when guardian defers, you are asked ("Allow for this session" / "Deny");
4. a grant applies for that command (`once`) or the session, in memory only —
   nothing is persisted, and a restart starts from this profile again.

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
  A session-scope grant follows the same rule.
- **Unix sockets.** `network.allowUnixSockets: ["/tmp/sgo-501"]` makes the
  runtime emit `network-bind` (bind/listen) *and* `network-outbound` (connect)
  rules for that directory, plus `system-socket AF_UNIX`; the directory also
  needs `allowRead`/`allowWrite` for its non-socket files. `allowLocalBinding`
  adds loopback TCP bind/inbound and connects to `localhost`.
- **Host-only commands.** `excludedCommands: ["just ios-device-logs:*"]` runs a
  matching command — and its whole process tree — on the host, unsandboxed.
  The prefix matches the command start; arguments may follow, and a compound or
  piped command line is not excluded. This is the permanent form of a
  `command` exception: narrow, explicit, and chosen by the human who writes the
  file.

To make a path permanently writable, add it to `filesystem.allowWrite` in
`sandbox.json` yourself. For a network host, add it to
`network.allowedDomains`. Prefer narrow entries (`~/.gradle/caches`) over
`~/.gradle`.

### Maintaining this profile from its own repo

`agentDirWriteProjects` (top level in `sandbox.json`, and under `permissions` in
`guardian.json`) lists absolute project roots whose sessions may write the agent
dir. `install.sh` adds this repo's own root, so a session in `~/g/adripi` can
repair `extensions/sandbox.json`, `guardian.json`, `settings.json` or the
deployed fork sources instead of asking you to switch the sandbox off.

- Read from the **global** profile only: a project or session layer cannot widen
  it, and a session outside the listed roots still sees the full lock.
- `<agentDir>/auth.json` and `<agentDir>/guardian-sessions` stay read- and
  write-denied either way, and `<workspace>/.pi` (the project's own policy file)
  stays mandatory deny-write.
- This is a real privilege: a session in a listed workspace can change what Pi
  and Guardian load next, including the sandbox profile and the reviewer.
  Delete the entry from both live configs to revoke it.

### Remote git

`git push`, `git pull` and clones of private repositories need the host's
credential helper, so they cannot run inside the sandbox. Ask for a `command`
exception with the exact command — for example `git push -u origin main`.
Guardian reviews it; on approval that exact string runs once on the host with
your normal git credentials, and the token never enters the sandbox or the
conversation. Chained commands, redirects, command substitution and interpreter
wrappers are refused by the sandbox before review and hard-denied by guardian's
rules.

## Why JSON, not TOML

`sandbox.json` is the shape `@anthropic-ai/sandbox-runtime` validates
(`SandboxRuntimeConfig`); both the loader and the runtime accept it directly, so
there is no second syntax to keep in sync.

## Guardian reviewer extensions

The vendored guardian fork adds `reviewer.extensions`. Only the entries in that
array are loaded by the reviewer sidecar. The sidecar still uses `--no-tools`
and `--no-extensions`; it cannot call tools and no other user/project extension
is loaded.

Use this when the reviewer provider is supplied by a Pi extension, for example:

```json
"reviewer": {
  "model": "neuralwatt/nw-flash",
  "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"]
}
```

For a built-in provider, or a provider defined in `models.json`, leave
`reviewer.extensions` empty.
