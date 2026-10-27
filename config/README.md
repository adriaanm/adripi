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

To make a path permanently writable, add it to `filesystem.allowWrite` in
`sandbox.json` yourself. For a network host, add it to
`network.allowedDomains`. Prefer narrow entries (`~/.gradle/caches`) over
`~/.gradle`.

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
