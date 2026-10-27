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

Pending (W4 in `docs/plan-sandbox-broker.md`): `src/broker.ts` (guardian broker
client with human fallback), the `request_sandbox_exception` tool, routing
`prompts.requestUnsandboxed` / `prompts.requestNetwork` through the broker, and
widen-and-rerun on traps.

## Verified on macOS (2026-10-27)

- `touch ./in-project && echo OK` → inside the sandbox, one command unit.
- `touch ~/.gradle/x` → sandbox denial reported to the model, with an explicit
  escalation offer.
- `printf hi > "$PI_SANDBOX_SCRATCH/probe.txt" && cat … && echo SCRATCH-OK` →
  `hiSCRATCH-OK`; no exception needed.

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
