# pi-sbx (vendored fork)

Fork of [`pi-sbx@0.1.3`](https://github.com/RiverAi7z/pi-sbx), an SRT-backed
Pi bash sandbox. License: see `LICENSE`. Base is upstream except for the deltas
below. These describe current source through round 2's first wave; old grant/exclusion/supervisor
routes in Git history are retired, not additional supported APIs.

## Current deltas

1. **Scratch** (`src/scratch.ts`, index wiring/tests): private session temp
   directory, exported as `PI_SANDBOX_SCRATCH`, added to a copied effective
   profile, disposed at shutdown and swept by age. Shared temp-root write is not
   required by the shipped configuration.
2. **Dependencies:** explicit devDependencies on `@earendil-works/pi-tui` and
   `typebox`, which upstream imports without declaring.
3. **Broker client** (`src/broker.ts`): mirrors Guardian's decision JSON and
   `Symbol.for` slot. Missing/throwing Guardian denies; only a real defer reaches
   human UI. The sandbox executes decisions, never publishes a second reviewer.
   `withScopedPaths` copies a command-local layer without changing session state.
4. **One escalation API** (`src/inline-escalation.ts`, `src/index.ts`): bash
   `sandbox_permissions`, `justification`, optional `prefix_rule` and
   `additional_permissions.file_system.{read,write}`. Unknown parameters and
   invalid combinations fail without running anything. The separate
   `request_sandbox_exception` tool, legacy `dangerouslyDisableSandbox`, session
   exception overlays, host/network/next-command grant stores and expiry hooks
   are removed. Legacy parameters are explicitly rejected.
5. **One execution seam and queue** (`src/index.ts`, `src/execution-queue.ts`):
   normal, scoped and host agent execution share dispatch; active human shell
   execution and runtime-setting changes share the queue. Every scoped target is
   decided before runtime mutation. Temporary SRT policy never enters baseline
   `config`/`sessionConfig`, so native file tools cannot borrow another call's
   grants. Restore baseline on failure/cancellation/partial runtime update; if
   restoration itself fails, poison dispatch and reset instead of leaving a
   potentially widened runtime available. Closure rejects queued work and drains
   active cleanup before reset. Background-descendant lifetime is not certified.
6. **Host gate** (`src/host-command.ts`): honor `allowUnsandboxedCommands`,
   reject shell composition/expansion, control characters, assignment heads and
   known interpreter/wrapper/code-runner shapes; bind prefix proposals to the
   current parsed command before review. Execute the exact reviewed trimmed
   string once. Even unavailable-SRT fallback passes this gate/review. Explicit
   human sandbox-off modes remain unsafe controls. This is not an exhaustive
   executable capability classifier or a credential jail.
7. **Human decisions** (`src/human-channel.ts`): one serialized adapter for all
   surfaces and standing-save questions, with cancellation/shutdown signals.
   No UI means an actionable fail-closed defer, not a fabricated nested
   `contact_supervisor` invocation or a parent token treated as human consent.
8. **Network** (index callback): one decision per off-list connection, no token
   or static allowlist mutation. Bracket IPv6. Standing proposals name the shown
   port, not a silent all-port expansion. Long-lived connection containment is
   not proven by callback serialization.
9. **Standing rules** (broker client/index): only Guardian owns persistence.
   Prepare the rule/trusted snapshot before prompting; commit after human yes.
   No service means no save, not a fallback store. `excludedCommands` and its
   command/settings UI routes are retired. A nonempty legacy list fails config
   closed with migration instructions; an empty old array is accepted.
10. **Additive layers** (`src/config.ts`): network/path allow lists union above
    the human's global profile; defaults → global and other arrays still replace.
    Scoped candidates validate before runtime use. Normal human session settings
    remain distinct from model-requested permissions.
11. **Maintenance** (`src/hardening.ts`, config): agent-dir reads deny only
    `auth.json`; global-only `agentDirWriteProjects` authorizes maintainer roots
    to write the agent directory. Credentials and Guardian audit writes remain
    denied, and workspace `.pi` stays mandatory deny-write. Both the spelled cwd
    and its canonical target must stay inside the configured project root; a
    symlink out of a maintainer workspace cannot retain its OS maintenance scope.
12. **Guidance/hints** (`src/guidance.ts`, `src/trap-hints.ts`): system-prompt
    sandbox section, workspace/scratch/credential conventions, exact inline retry
    examples and authenticated-network-git hints. Local Git remains sandboxed.
    Denial is final; switching tools is not a workaround. No old tool signature
    or mandatory request-then-rerun protocol remains in current guidance.
13. **Shared path authority** (`src/path-authorizer.ts`, `src/file-gate.ts`,
    `src/index.ts`): one action-bound decision for command-scoped Bash paths and
    native read/write/edit. Grant feasibility runs before any review or human
    question: mandatory policy/credential/audit locks (lexical and canonical),
    configured deny-write entries and mandatory reads are final refusals.
    Non-mandatory read denies may accept a strictly more-specific exact allowRead
    carve-out, preserving the advertised scoped-read API. A native grant admits only the
    resolved target of that one call; nothing is stored, the next call starts
    from baseline, and grep/find/ls traversal is never widened. Gate decisions
    use the event's cwd and signal, so a parallel Bash call cannot lend its
    context or cancellation. Missing/throwing Guardian, a headless defer and
    cancellation fail closed with an actionable result. Mandatory reads precede
    baseline allowRead entries and cannot be reopened by them, including recursive
    traversal. Native targets are resolved again after an asynchronous decision;
    changed targets fail closed (not a hostile same-user filesystem-race defence).
    This is sandbox adapter behavior, not a child approval transport.
14. **Tests:** registered bash dispatch with mocked execution/runtime, concurrent
    scoped versus plain/native-file actions, partial approval, queue cancellation,
    prompt cancellation, setting serialization, partial refresh/rollback failure,
    host admission/fallback, per-connection decisions, policy prepare-before-prompt,
    legacy input rejection, path-authorizer feasibility/defer/cancel cases,
    registered native-gate grant/deny/headless/cancellation/isolation coverage,
    helper/config/lifecycle coverage. These are not live nested OS-sandbox tests.

## Failure modes repaired in round 1

Inline host escalation skipped the old validator; consumed host grants bypassed
host-disabled policy; command-local paths leaked through shared state; a network
once token expired on its granting tool's own result; policy fallback/exclusions
created multiple host paths. Consolidation removes those stores and admission
bypasses rather than adding another compatibility API. Parent integration also
closed unavailable-SRT host fallback, bound save snapshots before prompts,
checked late cancellation and fail-closed rollback, and serialized settings.

See [current contract](../../docs/product.md),
[round-1 evidence](../../docs/round-1.md), [round 2](../../docs/round-2.md), and
[archived baseline](../../docs/product-baseline.md). Earlier macOS probes in the
Git history exercised the now-retired session-grant protocol; they do not verify
this round's installed runtime.

## Deploy/update

`install.sh` installs npm `pi-sbx@0.1.3` and rsyncs this `src/` over the installed
copy. No deployment happened in round 1. Fully quit/restart Pi after human
installation; inspect kept live configs for nonempty retired exclusions.

For an upstream update:

1. Reconcile all deltas above, not just scratch or the first broker patch.
2. Keep registered-tool negative tests and cross-extension service tests.
3. Run `npx vitest run`, `npx tsc --noEmit`, and repository `just check`.
4. Update pins/provenance deliberately, deploy separately, and exercise loaded
   schema, sandbox/host/scoped behavior and negative cases in a fresh Pi process.
