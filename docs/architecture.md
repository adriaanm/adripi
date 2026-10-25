# Architecture

The setup is four layers, in order:

```text
tool call
  -> pi-perm        filesystem/network/command policy + SRT OS sandbox
  -> pi-guardian    semantic review of the exact action by a separate model
  -> tool executes  (bash inside SRT; write/edit under the permission profile)
  -> pi-review      separate diff review after code changes
```

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

- The reviewer is an independent Pi sidecar using `neuralwatt/nw-flash`.
- It receives the retained transcript, the exact tool input, and
  `guardian-policy.md`.
- It returns `allow` or `deny`; malformed output or sidecar failure is a
  fail-closed denial.
- `read`, `grep`, `find`, and `ls` are exempt.
- The sidecar runs with `--no-tools`, `--no-extensions`, `--no-skills`,
  `--no-context-files`, and `--no-prompt-templates`.
- The one exception to `--no-extensions` is `reviewer.extensions`. In this
  setup it names `npm:@aliou/pi-neuralwatt@0.18.0`, so the sidecar gets the
  provider's live model catalog and prices without a `models.json` copy.

The fork adds `reviewer.extensions` to `guardian.json`; the patch is vendored
in `forks/pi-guardian` (see `VENDOR.md`).

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
- Neuralwatt models for every role

Configuration: `~/.pi/agent/pi-review.json`.

## 4. `pi-subagents`

`pi-review` depends on `pi-subagents` for isolated reviewer children. It is not
a security boundary; the guardian still reviews the parent tools.

## Why not `models.json`?

`models.json` would duplicate the Neuralwatt catalog, including prices, and
would go stale when `nw-flash` moves or the provider refreshes `/v1/models`.
Loading the provider extension in the reviewer sidecar keeps one source of
truth and still prevents the sidecar from loading any other extension.

## Why not a `piCommand` wrapper?

The wrapper works, but it hides the sidecar contract in a shell script. The
fork makes the allowlist an explicit, tested configuration field. The sidecar
still has no tools and no auto-discovered extensions.
