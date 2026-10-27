# pi-guardian (vendored fork)

This directory is a self-contained fork of
[`andersonbcdefg/pi-guardian`](https://github.com/andersonbcdefg/pi-guardian),
vendored so `adripi` can be cloned and installed on another machine without a
second local-only Git remote.

- Upstream commit: `c8d688a46c2dd6c7f3e5e92b60cac6a2983c4cf6`
- Upstream version: `0.2.0`
- License: Apache-2.0 (see `LICENSE` and `LICENSES/`)

Everything in `src/`, `test/`, `prompts/`, `package.json`, `tsconfig.json`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml` is upstream 0.2.0. The functional
deltas are listed below; nothing else is modified.

## Local changes

1. `src/types.ts` — `GuardianConfig` carries `reviewerExtensions`.
2. `src/config.ts` — accepts `reviewer.extensions`, validates non-empty strings,
   and resolves only path-shaped entries against the agent directory. Any
   `scheme:` specifier (`npm:`, `git:`, `github:`, `http(s):`, `ssh:`, `builtin:`,
   `file:`, …) keeps Pi's own meaning; `C:\…` is still treated as a path.
3. `src/sidecar.ts` — appends each configured entry as an explicit `--extension`
   argument after `--no-extensions`, so the reviewer sidecar can reach a model
   that is only available through a provider extension (Neuralwatt), without
   duplicating models into `models.json`.
4. `src/sidecar.ts` — when guardian runs inside a `pi-subagents` child runner,
   spawn the Pi CLI instead of relaunching the runner bootstrap with Pi flags.
   The child bootstrap expects a config path or stdin, not `--mode`, so the old
   behaviour failed with `readFileSync('--mode')` and guardian failed closed.
   `PI_SUBAGENT_PI_BINARY` overrides the binary.
5. `src/index.ts` — a failed-closed review is reported as a review failure, not
   as a risk denial, and the distinction is driven by the review's `failure`
   value rather than by matching a rationale prefix (a reviewer model could
   quote the prefix). `denialReason` is exported for that test.
6. `test/fork-reviewer-extensions.test.ts` — coverage for 1-5, including every
   non-path specifier, the `PI_SUBAGENT_RUNNER_CONFIG` branch, and both denial
   wordings.
7. `test/state.test.ts` — one-line fixture change (`reviewerExtensions: []`),
   required because 1 makes the field non-optional under strict `tsc`.

Upstream 0.2.0 already covers the rest of what the 0.1.0 fork needed: the
deterministic `permissions.allow` / `permissions.deny` rule family (evaluated
before any reviewer call), `tool_search` exemption, and the durable assessment
record fields (`source`, `rule`). The fork no longer patches anything those
replace.

## Deploy

`install.sh` installs `pi-guardian@0.2.0` from npm and then rsyncs
`forks/pi-guardian/src/` over the managed package's `src/`. The npm install
supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and peer
wiring; the vendored source supplies the fork.

## Update upstream

1. Check out the new upstream version.
2. Reapply changes 1-5 above.
3. Keep `test/fork-reviewer-extensions.test.ts` (adapt fixtures if upstream
   changed `GuardianConfig`).
4. `pnpm install --ignore-scripts --frozen-lockfile && pnpm check && node --test`.
5. Update the version in `packages.txt` and the upstream commit here.
6. Run `./install.sh` to deploy.
