# Architecture

The setup is four layers, in order:

```text
tool call
  -> pi-sbx (fork)  OS sandbox for bash; session scratchpad; trap hints
  -> pi-guardian    semantic review of the exact action by a separate model
  -> tool executes  (bash inside SRT; write/edit inside the session profile)
  -> pi-review      separate diff review after code changes

sandbox exception (model-asked, or a blocked command)
  -> pi-guardian sandbox broker -> reviewer -> allow / deny / defer
  -> defer -> human prompt; allow -> widen the session profile, re-run inside it
```

Design, rationale and progress: [`plan-sandbox-broker.md`](plan-sandbox-broker.md).

## 1. `pi-sbx` (vendored fork): OS boundary

`pi-sbx` replaces Pi's bash tool. Every command runs under
`@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux) with the
profile in `~/.pi/agent/extensions/sandbox.json`.

- Project writes are allowed; the shared temp root is not.
- `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.config/gh` are unreadable; `.env`,
  key and pem writes are denied.
- Network is a static allowlist (npm, GitHub, PyPI, Maven, Gradle) plus a
  per-connection review for anything else.
- Each session gets a private scratch directory exported as
  `PI_SANDBOX_SCRATCH`; it is added to the effective profile only, removed at
  shutdown, and needs no exception.
- A command blocked by the sandbox returns its normal error plus a hint naming
  the exact path and `request_sandbox_exception`.
- The agent cannot widen this by editing files: the profile is the user's, the
  agent directory is denied by guardian's rules, and the sandbox's own hardening
  list covers the configuration, the installed package and .git/hooks.

The fork adds the broker client, the exception tool, `once`-grant expiry and the
scratchpad on top of `pi-sbx@0.1.3`; see `forks/pi-sbx/VENDOR.md`.

## 2. `pi-guardian`: semantic gate and sandbox broker

Every non-exempt tool call is reviewed before it runs.

- The reviewer is an independent Pi sidecar using the configured
  `reviewer.model`. The included template uses `neuralwatt/nw-flash`.
- It receives the retained transcript, the exact tool input, and
  `guardian-policy.md`.
- Deterministic `permissions.deny`/`allow` rules run before any model call.
- It returns `allow` or `deny`; malformed output, a timeout, or a sidecar
  failure is a fail-closed denial.
- `read`, `grep`, `find`, `ls` and `tool_search` are exempt.
- The sidecar runs with `--no-tools`, `--no-extensions`, `--no-skills`,
  `--no-context-files` and `--no-prompt-templates`; `reviewer.extensions` is the
  only allowlist, for provider extensions.

**Sandbox broker.** At `session_start` guardian publishes a broker on a
`Symbol.for` slot. The sandbox asks it about every exception: a model-asked
`request_sandbox_exception`, a blocked network destination, or a model request to
run unsandboxed.
1. Always-deny classes (credentials, the agent directory, secret writes,
   hook directories) are refused without a model call.
2. `sandboxExceptions.defer` rules route a class to the human.
3. `sandboxExceptions.allow` rules answer without a model call.
4. Otherwise guardian reviews against the **full** transcript — a delta would
   hide the user's authorization, which the tool call that is asking has already
   advanced past — and returns allow, deny, or defer.
5. Scope can only narrow: a `session` grant needs `user_authorization: high` and
   non-high risk, otherwise it becomes `once`.
6. Consecutive denials trip a breaker, so a model cannot spin on the reviewer.

A failed review, an absent broker, or no UI all resolve to denial. `defer` is
the only path to a human prompt.

**Host-command exceptions.** A `command` exception runs one exact command on the
host instead of in the sandbox. It exists for remote git: `git push`, `git pull`
and `git clone` need the host's credential helper, and the token must never enter
the sandbox or the model's context. Three properties keep it narrow:

1. exact match — the executed string must equal the approved string, so a
granted `git push` cannot authorise `git push; something-else`;
2. single invocation — `once` grants are consumed by one execution;
3. shape eligibility — the sandbox refuses metacharacters (`;`, `&&`, `|`,
redirects, command substitution, newlines) and interpreter/wrapper prefixes
(`sh`, `bash`, `env`, `sudo`, `xargs`, …) before a review is even requested,
and the guardian rule layer hard-denies the inclusive patterns as a backstop.

Only the command string is granted; the token stays with the host's credential
helper and never appears in a tool result.

The fork adds `reviewer.extensions`, the subagents child-runner detection, the
broker, and the sandbox-exception policy clause; see
`forks/pi-guardian/VENDOR.md`.

## 3. `pi-review`: diff sidekick

`pi-review` runs after code changes and combines several reviewer roles through
`pi-subagents`:

- `bugbot`, `security-review`, `rulesheriff`, `history-context`, and
  `code-comments`
- a strict gate at threshold 8
- reviewer models configured in `pi-review.json`

Configuration: `~/.pi/agent/pi-review.json`. The included template uses
Neuralwatt models; replace them for another provider.

## 4. `pi-subagents`

`pi-review` depends on `pi-subagents` for isolated reviewer children. It is not
a security boundary; the guardian still reviews the parent tools.

## Why not `models.json` for extension providers?

A `models.json` entry would duplicate the provider's catalog, including prices,
and can go stale when the provider refreshes its model list. Loading the
provider extension in the reviewer sidecar keeps one source of truth and still
prevents the sidecar from loading any other extension. For built-in providers,
no extension is necessary.

## Why not a `piCommand` wrapper?

The wrapper works, but it hides the sidecar contract in a shell script. The
fork makes the allowlist an explicit, tested configuration field. The sidecar
still has no tools and no auto-discovered extensions.
