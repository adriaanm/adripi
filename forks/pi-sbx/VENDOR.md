# pi-sbx (vendored fork)

Fork of [`pi-sbx@0.1.3`](https://github.com/RiverAi7z/pi-sbx) — an SRT-backed
bash sandbox for Pi with per-command ids, violation reporting, a session config
layer, and escalation prompts. Vendor this fork so `adripi` can ship a sandbox
whose escalation path is decided by `pi-guardian` instead of a human-only prompt.

- Upstream: `RiverAi7z/pi-sbx` (npm `pi-sbx@0.1.3`)
- License: see `LICENSE`
- Base is unmodified upstream except for the deltas below.

## Deltas

1. **Session scratchpad** (`src/scratch.ts`, wired in `src/index.ts`).
   A unique directory per session under the host temp tree
   (`pi-sbx-scratch-*`) is created at `session_start`, added to the effective
   runtime profile's `allowRead`/`allowWrite` — never to the persisted config —
   exported to sandboxed commands as `PI_SANDBOX_SCRATCH`, named in the bash
   tool's `promptGuidelines`, removed at `session_shutdown`, and swept by age
   (24 h) at the next start. Rationale: the agent must have somewhere to put
   temporary files without spending a guardian-reviewed exception on it.
   `withScratchpad` returns a copy, so a config reload never mutates the
   user's layer.
2. **`test/scratch.test.ts`** — lifecycle, sweep-by-age, prefix isolation, and
   the copy/dedupe behaviour of `withScratchpad`.
3. **`package.json` devDependencies** — add `@earendil-works/pi-tui` and
   `typebox`. Upstream imports both (`src/settings-ui.ts`, tool schemas) without
   declaring them, so `pnpm typecheck` fails on a fresh checkout.
4. **Guardian broker client** (`src/broker.ts`). Mirrors guardian's contract
   (same `Symbol.for` slot), turns a missing broker into `defer`, turns a
   throwing broker into a denial, and applies session-scope grants to the
   in-memory session layer (`withSessionException`): write/read → filesystem
   allow lists, network → `allowedDomains`, command → `excludedCommands`. The
   persisted config is never touched and the layer is rebuilt on reload.
5. **`request_sandbox_exception` tool** — one target per call, `reason`
   required; guardian decides, the human is asked only when the broker defers
   or is absent (no UI → deny). The network ask callback and the
   `dangerouslyDisableSandbox` path both consult the broker first instead of
   prompting immediately.
6. **`test/broker.test.ts`** — slot lifecycle, defer/allow/deny passthrough,
   broker failure → denial, request shaping, and the session-layer mapping.

Pending (W4 in `docs/plan-sandbox-broker.md`): widen-and-rerun on traps (grant a
policy widening and re-run inside the sandbox instead of escalating to the
host), and end-to-end tests for the tool's human-defer branch.

## Verified on macOS (2026-10-27)

- `touch ./in-project && echo OK` → inside the sandbox, one command unit.
- `touch ~/.gradle/x` → sandbox denial reported to the model, with an explicit
  escalation offer.
- `printf hi > "$PI_SANDBOX_SCRATCH/probe.txt" && cat … && echo SCRATCH-OK` →
  `hiSCRATCH-OK`; no exception needed.
- Guardian-driven exception: the model called `request_sandbox_exception` for
  `write /Users/adriaan/.gradle` (session). Guardian allowed it, the session
  layer reloaded, and `touch ~/.gradle/.sbx-broker-probe` ran **inside** the
  sandbox and printed `BROKER-GRANT-OK`.

## Deploy

`install.sh` installs `pi-sbx@0.1.3` from npm, then rsyncs
`forks/pi-sbx/src/` over the managed package's `src/`. Peer dependencies
(`@earendil-works/pi-coding-agent`, `@anthropic-ai/sandbox-runtime`,
`minimatch`) come from the npm install and the Pi host.

## Update upstream

1. Copy the new upstream `src/`, `test/`, `package.json`, `tsconfig.json` over
   the fork.
2. Reapply deltas 1-3 (scratch module + wiring, scratch tests, devDeps).
3. `pnpm install --ignore-scripts && pnpm typecheck && pnpm test`.
4. Update the pinned version in `packages.txt` and this file.
