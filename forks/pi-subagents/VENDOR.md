# Vendored pi-subagents

- Upstream: <https://github.com/nicobailon/pi-subagents>
- Base: npm `pi-subagents@0.81.0`, registry `gitHead`
  `1bc941363cb62fc23c94c5519364b03dc150be3e`.
- Source: public GitHub archive at that exact commit, retrieved 2026-10-29.
- License: MIT; upstream `LICENSE` retained.
- Imported source, runtime assets, build inputs and **all** upstream tests are
  retained. Only `.github/`, `.greptile/` and `banner.png` are omitted. No build
  output, dependency tree or local fixture state is tracked.

## Baseline evidence before fork changes

Provisioned with `npm ci --ignore-scripts --cache
../../.local/round-2-subagents/npm-cache`. This uses the upstream lockfile and a
project-local cache; no runtime/dependency versions were changed. npm reported
**two dependency vulnerabilities (one moderate, one high)**. An optional follow-up
audit query was refused by Guardian's reviewer rate limit and was not retried or
performed by another route; details/remediation remain unverified.

On Node `v26.6.0`:

- `npm run typecheck`: passed.
- `node --experimental-strip-types --import
  ./test/support/isolated-temp-root.mjs --test --test-concurrency=4
  test/unit/*.test.ts`: **4,140 passed, 17 skipped, zero failed**, 4,157 tests,
  431 suites. The initial sandboxed run failed on restricted process inspection
  (`spawnSync ps EPERM`). The exact command was rerun with reviewed inline host
  execution and passed. This baseline therefore is **not** proof of sandboxed
  fixture or OS enforcement success.
- `npm run build:pkg`: passed inside the sandbox using the upstream builder.

Logs are ignored local evidence under `.local/round-2-subagents/`. This does not
resolve Guardian's separately reproduced Node 26 headless-test crash.

## Local deltas

- One new host-only public export, `pi-subagents/child-authority`, added to the
  existing shared bundle graph; unchanged upstream builder and lockfile.
- Transport/domain primitives bind one prepared provider lease to the actual
  spawned process IPC handle. Bounded JSON/actions, full session/run/lease
  correlation, no lifetime replay eviction (revoke after 256 accepted ids),
  bounded preparation and terminal allow/deny/unavailable/cancelled outcomes.
  No files, env hashes, model fields or supervisor prose create authority.
- Process-wide versioned AsyncLocalStorage carries live code-only leases across
  bundled and compiled imports. Required consumers must claim+acknowledge before
  requests/readiness. Provider-required consumer ids must be a subset of the
  provider's required extension ids. Launch must create exactly one runner client.
- Parent/child cancellation, request bounds, client/lease release, provider abort,
  process loss and disposal fail closed; late/malformed prepared leases release
  usable provider disposers. Approval defaults are 600s parent / 605s child;
  preparation is 30s and child lease arrival 35s, measured from different events.
  Launch must reach preparation promptly or explicitly budget startup slack.
- Real-process IPC positives/negatives and source export fixtures; a separate
  post-build test proves actual bundle/compiled ALS and provider-slot identity.
- `scripts/verify-build.mjs` fingerprints source (including lockfile) **and** all
  artifact file contents/modes. Root `scripts/build-subagents.mjs` wraps the
  unchanged builder, refuses mid-build input drift and never installs/deploys.
  `forks.txt` now selects built mode: deploy the complete bundle/compiled src,
  root modules and runtime assets, preserving installed dependency/extension
  wiring and merging only validated new exports. Source-only deployment is invalid.

Parent acceptance on Node `v26.6.0`: typecheck, **47 IPC tests**, **69 offline
packaging fixtures** (`just check`), build/verifier and **3 actual graph tests**
passed inside the sandbox. Full `npm --prefix forks/pi-subagents run test:unit`:
**4,187 passed, 17 skipped, zero failed** (4,204 tests / 437 suites) after an
explicitly reviewed host rerun. The sandboxed full run hit process inspection,
local socket/TCP restrictions and watcher pressure; no suite-green OS claim.
Ignored evidence: `.local/round-2-subagents/parent-{ipc-tests,check,unit-host}.log`.

### Guarded launch/provider wiring

- Actual foreground/async tool entry points and defensive spawn admission use
  registration **or any provider-slot presence** (including malformed/unavailable)
  plus inherited mandatory demand; unknown identity cannot prove bare mode.
  Bare pi-subagents behavior is retained only when genuinely outside the guard.
- One native background child carries a host-created IPC lease before extension
  loading; actual resolved identity and code-only readiness precede the first
  prompt, including injected factories. Guarded retries refuse reused readiness.
  A process-lifetime shared latch refuses nesting after revocation/ALS disposal.
- Unsupported foreground/chain/parallel/dynamic/workflow/schedule, external
  CLI/job/machine/binary/wrapper, managed allocation and retained/append paths
  refuse before mutation, rather than silently switching runner. Startup/factory
  failure disposes authority and terminates failed runners; parent loss stops the
  real active session. Expected IPC closure no longer produces a trailing EPIPE
  diagnostic; errors still fail authority/startup rather than being suppressed.
- Recovery/binary/Claude fixtures now use actual host session identity; the
  captured-mandatory workflow test expects the earlier admission refusal instead
  of unreachable child discovery. These are guard-contract changes, not broader
  capability-ceiling or external-runner permission changes.

Guarded launch (#22) parent verification: **76** focused authority tests; full unit suite
**4,216 pass / 17 skip / 0 fail**; affected async integration **234 pass**;
subagents typecheck/build/verifier and **3** actual-graph tests pass. Full unit
and affected integration commands needed reviewed host reruns after sandbox
ps/socket/watcher failures; no OS-containment claim. Graph: **383 inputs / 17
exports / 329 compiled modules / 18 module-URL targets / 765 artifacts**.

### Exact-tool protocol prerequisite for production consumers

Provider and wire protocol **2** reuse the existing guard Symbol and ALS registry;
old providers/envelopes refuse without reopening bare launch. A new opaque `tool`
action carries exact GuardianAction JSON (64,000 UTF-16 characters / 256KiB UTF-8
maximum); ordinary targets remain 2KiB, reasons 512B and policy payloads 32KiB.
No safety evidence is truncated. Parent `terminate` metadata is typed, bounded
and forbidden on an allow; it cannot mint a grant. Unicode large-action, old-wire,
strict identity and real-process round-trip negatives/positives are added. The
upstream builder, dependency versions, public export count and single graph are
unchanged; no alternate protocol/store is retained.

Current source verification: **79** focused authority tests; **4,219 pass / 17
skip / 0 fail** full unit (4,236 tests); affected async integration **234 pass**;
types/build/verifier and **3** actual graph tests pass. Full unit/integration
commands passed via exact reviewed host reruns after sandbox process/socket
failures, not as containment evidence. Graph remains **383 inputs / 17 exports /
329 compiled modules / 18 module-URL targets / 765 artifacts**. Evidence:
`.local/goal-consumers/`. Real parent semantic service is separately verified
cross-fork; production acknowledgments are still forbidden until enforcement.
See the [consumer contract/record](../../docs/round-2-production-consumers.md).

### Child-context dispatch prerequisite (source only)

The same public `child-authority` API now exposes `hasChildAuthorityContext` for
future consumer root/child dispatch. It creates no ALS registry on ordinary root
startup; an inactive valid registry is not child authority, while an active store
selects child dispatch. A malformed or explicitly undefined registry refuses
instead of reopening root startup. Any process-lifetime runner-latch **presence**,
including malformed/undefined values and after scope exit, selects child mode and
refuses nested placement. The latch key is shared with the launcher, not a second
registry. This is intent detection, not a lease grant or consumer acknowledgment.

Verification: **83** focused authority tests and typecheck pass; fresh build and
verifier plus **4 actual bundle/compiled graph tests** pass (including cross-graph
context/latch checks). Graph remains **383 inputs / 17 exports / 329 compiled
modules / 18 module-URL targets / 765 artifacts**, artifact prefix
`e687d77d2d57b6eb`; root **69 deployment fixtures** pass. Initially the full unit
command hit sandbox process/socket restrictions and its host rerun did not execute
because the Guardian broker was unavailable. A later operator-requested ordinary
`npm --prefix forks/pi-subagents run test:unit` now passes on the current source:
**4,240 total / 4,223 pass / 17 skip / 0 fail**, **441 suites**, 92.13s. No host
exception, runtime change or Guardian toggle was used for that successful run;
this closes todo #26, not OS containment or loaded-broker acceptance. Types,
fresh verifier and all four graph tests passed again. Durable ignored output:
`.local/goal-output-capture/subagents-full-unit.log`; original tool artifact:
`/var/folders/wv/sk29c9qn6xnd_rvynqrkx3pm0000gn/T/pi-bash-99c5c06b62d08e8b.log`.
Historical failed-run evidence remains `.local/goal-consumers/open-*` and the
command/denial transcript. No deployment, restart or live-policy change.

pi-sbx now has the actual registered parent publisher, narrowing policy and shared
Guardian/human adapter. **Production child consumers are not implemented**: real
required extensions cannot acknowledge and therefore must not reach a first
model prompt. These seams do not certify child containment, full headless,
external worktrees or authenticated Git. No live installation/policy/restart/push
was performed. See the [current wiring acceptance and payload handoff](../../docs/round-2-wiring-acceptance.md)
and [component history](../../docs/round-2-child-authority.md).
