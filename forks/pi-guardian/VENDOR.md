# pi-guardian (vendored fork)

This directory is a self-contained fork of
[`andersonbcdefg/pi-guardian`](https://github.com/andersonbcdefg/pi-guardian),
vendored so `adripi` can be cloned and installed on another machine without a
second local-only Git remote.

- Upstream commit: `49f28fcda64d642f3343ca6ec5332f157de5b754`
- Upstream version: `0.1.0`
- License: Apache-2.0 (see `LICENSE` and `LICENSES/`)

## Local change

The functional deltas are:

- `src/types.ts`: add `reviewerExtensions` to `GuardianConfig`.
- `src/config.ts`: parse `reviewer.extensions`, keep package sources such as
  `npm:@aliou/pi-neuralwatt@0.18.0` intact, and resolve local filesystem paths.
- `src/sidecar.ts`: append each configured entry as an explicit `--extension`
  argument while keeping `--no-extensions` and `--no-tools`.
- `src/sidecar.ts`: when guardian runs inside a `pi-subagents` child runner,
  spawn the Pi CLI instead of relaunching the runner bootstrap with Pi flags.
  The child bootstrap expects a config path or stdin, not `--mode`, so the old
  behavior failed with `readFileSync('--mode')` and guardian failed closed.
- `src/index.ts`: distinguish a failed-closed review from a risk denial in the
  tool error shown to the child.
- `test/`: coverage for npm source preservation, local path resolution,
  malformed entries, sidecar argument generation, and nested subagent runner
  detection.
- `README.md`: document `reviewer.extensions`.

This lets the reviewer sidecar use the Neuralwatt provider extension, including
its live catalog and prices, without duplicating models in `models.json`.

## Deploy

`install.sh` installs `pi-guardian@0.1.0` from npm and then rsyncs
`forks/pi-guardian/src/` over the managed package's `src/` directory. The npm
install supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
and peer wiring; the vendored source supplies the fork.

## Update upstream

1. Check out the new upstream version.
2. Reapply the `reviewer.extensions` change to `src/types.ts`, `src/config.ts`,
   and `src/sidecar.ts`.
3. Reapply/extend the tests.
4. Run `pnpm install --ignore-scripts --frozen-lockfile && pnpm check && node --test`.
5. Update the version in `packages.txt` and the upstream commit here.
6. Run `./install.sh` to deploy.
