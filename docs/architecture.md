# Architecture

The setup is four layers, in order:

```text
tool call
  -> pi-perm        filesystem/network/command policy + SRT OS sandbox
  -> pi-guardian    semantic review of the exact action by a separate model
  -> tool executes  (bash inside SRT; write/edit under the permission profile)
  -> pi-review      separate diff review after code changes
```

> **Planned replacement.** Layer 1 (`pi-perm`) is being replaced by an
> SRT substrate whose every escalation is decided by `pi-guardian`, with the
> model able to request exceptions. Design, rationale and progress:
> [`plan-sandbox-broker.md`](plan-sandbox-broker.md).

## 1. `pi-perm`: OS boundary

`pi-perm` owns the sandbox and the structured profile in
`~/.pi/agent/extensions/pi-perm/config.json`.

- `:workspace_roots` is read+write; `.git`, `.codex`, and `.agents` are
  read-only; `.env` files, `.git/hooks`, and dangerous prefixes are denied.
- Network is enabled for package installs and API calls.
- Bash runs under `srt` (`@anthropic-ai/sandbox-runtime`).
- The profile is `workspace`; additional repositories require an explicit
  absolute subpath grant.
- `defaultAction: "allow"` is intentional: the OS boundary plus the semantic
  reviewer are the gate, not a pile of regexes.

`pi-perm` cannot be widened by the agent. Only a human edits the profile.

Why JSON: `pi-perm@0.1.8` rejects nested TOML filesystem tables because
`smol-toml` returns null-prototype objects and the validator only accepts plain
objects. The JSON config avoids that bug.

## 2. `pi-guardian`: semantic gate

Every non-exempt tool call is reviewed before it runs.

- The reviewer is an independent Pi sidecar using the configured
  `reviewer.model`. The included template uses `neuralwatt/nw-flash`.
- It receives the retained transcript, the exact tool input, and
  `guardian-policy.md`.
- It returns `allow` or `deny`; malformed output or sidecar failure is a
  fail-closed denial.
- `read`, `grep`, `find`, and `ls` are exempt.
- The sidecar runs with `--no-tools`, `--no-extensions`, `--no-skills`,
  `--no-context-files`, and `--no-prompt-templates`.
- The one exception to `--no-extensions` is `reviewer.extensions`. When the
  reviewer model is supplied by an extension, this lists just that extension
  so the sidecar can reach the model without a `models.json` copy. Built-in
  providers and providers defined in `models.json` leave it empty.

The fork adds `reviewer.extensions` to `guardian.json`; the patch is vendored
in `forks/pi-guardian` (see `VENDOR.md`). It is required when an extension must
be enabled to reach the reviewer model; upstream hardcodes `--no-extensions`
without an allowlist.

The fork also detects a `pi-subagents` child runner. The child runs a Node
bootstrap rather than the Pi CLI, so guardian spawns the `pi` executable for
the sidecar instead of passing Pi flags to the bootstrap. Failed-closed reviews
are also reported as review failures, not risk verdicts.

Guardian denials are final for the agent. A human can use `/guardian` to
inspect status or disable review as a deliberate recovery action. The agent
must not edit `guardian.json`, `guardian-policy.md`, or `pi-perm` config to get
around a denial.

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
