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

7. **Trap hints** (`src/trap-hints.ts`). A sandboxed command that fails with
   `Operation not permitted` / `Permission denied` gets an extra text block
   naming the exact denied path and telling the model to call
   `request_sandbox_exception` for it. No automatic retry: the surface cannot be
   inferred reliably from the violation log, and the retry must stay a reviewed
   decision.
8. **`once` scope** is real: the grant is applied for exactly the next sandboxed
   command (or the next network connection) and removed afterwards via
   `withoutSessionException` + reload. Verified: command A allowed, command B
   denied in the same session.
9. **Host-command exceptions** (`src/host-command.ts`). `surface: "command"`
   grants run one exact command on the host (remote git), exact-match and
   single-use, with metacharacter/interpreter shapes refused before review.
   `test/host-command.test.ts` covers eligibility and the grant store.
10. **Grants are additive and validated** (`src/config.ts`, `src/broker.ts`,
    `src/index.ts`). Found by an
    `Invalid sandbox runtime config: network.allowedDomains.0` report:
    a `host:*` target (the trap's spelling for "any port") is stored as the bare
    host, since the runtime schema rejects a `:*` port suffix and a bare host
    already matches every port (`configNetworkTarget`, applied in
    `withSessionException`/`withoutSessionException`/`hasSessionException`).
    `merge` now unions the allow lists (`network.allowedDomains`,
    `network.allowUnixSockets`, `filesystem.allowRead`, `allowWrite`) for every
    step above the user's own file, so a project or session layer adds grants
    instead of replacing the inherited ones — previously one
    `write /tmp/sgo-501` grant dropped the workspace and one `allowedDomains`
    entry dropped the package hosts. The defaults → global step keeps replace
    semantics so the global profile can still withdraw the default temp-root
    write. Finally, `applySessionGrant` validates the candidate layer before
    adopting it, so an unusable target is refused with a message instead of
    making every later `loadConfig` fail, which disabled the sandbox for the
    rest of the session. `test/broker.test.ts` and
    `test/config-hardening.test.ts` cover all of it.

11. **Agent-dir reads are scoped to what is sensitive** (`src/hardening.ts`).
    `denyRead` no longer covers the whole agent dir. Hidden are only
    `auth.json`, `models.json`, `guardian.json`, `extensions/sandbox.json` and
    `guardian-sessions` — the credentials and the sandbox/guardian
    configuration. Installed packages, skills (`npm/node_modules/pi-subagents/skills/…`),
    session transcripts, `settings.json` and the policy text stay readable, so a
    normal `read` of a skill or a subagent artifact no longer trips the sandbox.
    Writes remain denied wholesale.

12. **`agentDirWriteProjects`** (`src/config.ts`). An absolute project root
    listed in the *global* profile may write the agent dir, so the repo that
    installs this stack can repair the profile it installs. Read from the global
    layer only — a project or session layer must not widen it — and matched
    against the session cwd, including subdirectories. The grant drops the
    agent-dir write lock and opens reads of the two config files it maintains
    (`guardian.json`, `extensions/sandbox.json`); `auth.json`, `models.json` and
    `guardian-sessions` stay read- and write-denied even there, and
    `<workspace>/.pi` stays mandatory deny-write. `install.sh` grants this repo's
    root; removing the entry revokes it. `test/config-hardening.test.ts` covers
    the read matrix, the reachable root boundary, subdirectories, a lookalike
    sibling, malformed values, and a project-layer attempt to widen it.

Remaining (W5-W6 in `docs/plan-sandbox-broker.md`): the stack swap and the
architecture/README rewrite.

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
