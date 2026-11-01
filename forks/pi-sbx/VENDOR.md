# pi-sbx (vendored fork)

Fork of [`pi-sbx@0.1.3`](https://github.com/RiverAi7z/pi-sbx), an SRT-backed
Pi bash sandbox. License: see `LICENSE`. Base is upstream except for the deltas
below. These describe current source through round 2's guarded-launch/provider milestone; old grant/exclusion/supervisor
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
14. **Guarded parent provider** (`src/{child-authority,action-authorizer}.ts`, index):
    sticky session intent before path validation/startup, canonical required
    pi-sbx/Guardian registration, immutable workspace/held-Git-only payload,
    deny-based reads and current-parent/prepared-ceiling intersection. Symlinked
    Git roots cannot manufacture canonical held scope; known Git config/hooks
    remain excluded even for unheld metadata. AgentDir/private parent scratch
    cannot be delegated, including when a workspace Git pointer/commondir names
    one of them as already-held metadata. Both canonical roots and aliases are
    excluded on overlap in either direction; two private-directory regressions
    reproduced the pre-fix write-scope leak without accessing credentials/audit.
    Baseline changes revoke synchronously; shutdown keeps
    guard intent through teardown; direct prepared decisions also combine lease
    revocation/caller signals. Shared broker/human adapter preserves ordinary
    Bash/network defaults, source attribution and pre-human rule snapshots.
    Outside-ceiling path actions require explicit human one-action admission,
    never standing child scope. Protocol/provider **2** keeps the existing guard
    Symbol key and routes an exact `tool` action to the SAME parent Guardian
    broker's `reviewTool` method, with host-bound audience/cwd and cancellation.
    A semantic verdict does not grant a path/host exception; missing/legacy/
    malformed service and late approval after revocation refuse. No production
    child consumer is implemented yet. Prepared `anchor.paths` pins all policy
    literal prefixes, workspace/Git roots and aliases. Retargeting a workspace
    or writable read-carveout alias reproduced an unreviewed allow; now it
    revokes before/after decisions and after broker review before human UI.
    Ordinary file creation remains valid. Literal glob-bearing workspace/Git
    metadata roots refuse rather than widen a scope or weaken exclusions.
    `src/child-runtime-policy.ts` projects explicit prepared network/env/host
    ceilings from actual baseline SRT policy. Shipped lazy-validated SRT helpers
    decide exact host:numeric-port intersection; prepared/current deny and strict
    off-list restrictions precede broker/UI, while both-held static allows avoid
    extra review. Declared credential files (including mask) are mandatory child
    read/write locks; env names tighten to deny without reading values. Broad
    socket, loopback and PTY bits are ceilings, not ready-to-copy runtime grants;
    only held directory intersections can become child socket scope. Unsupported
    restrictive filters/proxy/TLS/custom-helper policies and unknown/malformed
    fields refuse. Weak isolation, AppleEvents/Mach/credential injection and
    filesystem/Git-write bypasses are not inherited. Child full-host requests
    require actual parent human admission even after semantic/rule allow; no UI
    is not consent, and the cwd/non-jail scope is explicit. Private consistency
    stamps revoke stale runtime before semantic tool review and cancel baseline
    changes during broker/human waits before consuming late permission. Actual
    child profile construction/consumers and OS containment remain unfinished.
15. **Native output capture** (`src/output-capture.ts`, dispatcher/schema): optional
    `output_file` saves full combined backend stdout/stderr without modifying the
    reviewed command. The shared baseline path authorizer admits the exact log
    write independently of host/scoped-command consent; it never widens SRT.
    Exclusive mode-0600 creation starts only at admitted operations exec: no
    overwrite/append, existing symlink/hardlink targets or implicit mkdir. Alias
    re-resolution and final inode/path checks refuse drift/replacement, not
    hostile same-user races. Bounded synchronous regular-file writes avoid an
    unbounded queue behind the SDK's synchronous onData interface. Status/bytes/
    exit/completeness survive normal, nonzero, cancelled/timed-out and capture-I/O
    failures; native SDK throw/structured-error semantics and bounded previews
    remain intact. No permission store or silent sidecar/retention/redaction.
    Opt-in logs can fill disk and persist until the operator cleans them up;
    scratch logs retain scratch lifetime. Five credential-free actual installed
    SDK1.4 backend probes also pass; no nested SRT or production OS claim.
16. **Strict child-policy data, not readiness:** `src/child-policy.ts` validates
    the complete current-v2 payload and bounds without coercion, verifies the
    consumer cwd/canonical workspace plus every prepared path prefix/all extra
    alias pins, and returns an independent frozen snapshot. No file/env data can
    create a live lease; this decoder does not claim/ack or install enforcement.
    The actual producer now expands file rules against parent cwd/HOME before
    transport; relative/tilde candidate payloads refuse rather than being
    reinterpreted in a child. Private consistency stamps use effective absolute
    rules too: the old raw stamp allowed an exact tool after HOME moved a parent
    denial; the fixed probe revokes before broker review. Existing fixtures now
    assert the expanded rules, not copied relative strings. Production consumer
    dispatch/adapters remain unfinished; source tests are not containment.
17. **Co-installed consumer API facade:** `src/child-consumer-api.ts` reuses the
    installed launcher's declared public `child-authority` export and validates
    the current version/detector/claim/ack methods; registration and consumer
    loading share one bounded export-map resolver. Key presence is a tripwire,
    not authority or a private alternative detector. Seven tests exercise the
    actual public opaque lease/readiness and missing/escaping/old/partial module
    failures. Guardian's actual child entry uses this source subpath; root-only
    Guardian need not load it. No package export/dependency overlay or new grant
    store; actual pi-sbx native/Bash/SRT startup remains unfinished.
18. **Tests:** registered bash dispatch with mocked execution/runtime, concurrent
    scoped versus plain/native-file actions, partial approval, queue cancellation,
    prompt cancellation, setting serialization, partial refresh/rollback failure,
    host admission/fallback, per-connection decisions, policy prepare-before-prompt,
    legacy input rejection, path-authorizer feasibility/defer/cancel cases,
    registered native-gate grant/deny/headless/cancellation/isolation coverage,
    helper/config/lifecycle and actual registered provider coverage, plus composed
    native-launch/real-IPC/controlled-consumer/broker/human tests. Current source:
    **428 tests / 30 files**, typecheck/root checks pass, including 24 actual-SDK
    native fence cases, 21 real-API consumer binding cases, six registered entry
    cases with SDK backends/mock SRT/Guardian acknowledgment, four held-current
    path checks, four output-operation freshness cases, 15 compiler cases, six new scratch scope/cleanup cases, four scoped
    target/snapshot regressions, seven installed
    API bridge cases, 22 capture
    regressions, 58 strict-policy/producer cases and the effective-HOME stamp
    regression (`.local/goal-child-policy/`). The scratch-exclusion fixture now records its actual allocation
    rather than racing other workers by diffing global temp directories.
    These are not production
    child consumers or live nested OS-sandbox tests. See the
    [wiring acceptance/handoff](../../docs/round-2-wiring-acceptance.md).

19. **Policy-only child runtime translation (not installed enforcement):**
    `src/child-config.ts` explicitly constructs a minimal shipped-SRT config from
    the strict current-v2 decoder. It never invokes root config loading, trust,
    maintenance or fresh Git discovery. Only transported write roots enter the
    profile; mandatory read locks become credential DENY, all write exclusions
    remain final and credential environment carries names/DENY only. Every
    connection routes to the parent (no static allow bypass); broad Unix,
    loopback, Mach/AppleEvents/PTY and weaker-isolation ceilings stay disabled.
    Depth null retains the shipped default; unsafe shell variable names refuse.
    The SDK environment adapter also removes shell bootstrap/option/function
    imports before the outer local backend, not merely inside SRT's wrapped
    command. This compiler/helper has 12 source regressions, not an active
    controller, child acknowledgment or OS proof. Runtime dispatch, actual
    spawn wiring, executable provenance and SDK/IPC composition remain open.

20. **Scoped approval cannot be reinterpreted through an alias:** the one Bash
    dispatcher snapshots every lexical/canonical path before the first async
    decision, rechecks all after the last decision, and installs only admitted
    canonical targets. A symlink switched during its own or a later approval
    used to execute with an unreviewed target. Temporary profiles now derive
    from the already-authoritative baseline runtime, not a fresh ambient config/
    Git read while the action is pending. No new path authorizer or engine.
    Three regressions fail against the old dispatcher; four now pass including
    poisoned ambient profile/snapshot isolation. Existing runtime assertions
    check canonical scope in both positive and baseline-isolation negatives.
    This is asynchronous decision consistency, not hostile same-user atomic
    inode immunity or actual OS containment.

21. **Scratch cleanup cannot adopt a replacement directory:** the existing
    allocator accepts an already-held base and synchronous pre-creation policy
    validator, uses exclusive UUID mkdir with mode0700, rejects path-like prefixes,
    and pins bigint dev/inode/birthtime plus canonical identity. Dispose refuses
    replacements/symlinks, never follows moved aliases, and is terminal/idempotent
    after removal or ENOENT. Six regressions cover private held-base allocation,
    refusal before mutation, replaced dirty directories/symlinks, terminal disposal
    and prefix traversal. Root temp behavior remains default; child callers must
    validate held workspace scope and skip global sweeping. This is a prerequisite,
    not production child activation or hostile same-user atomic race immunity.

22. **Actual sandbox child entry/adapters (source component, composition open):**
    `src/index.ts` now dispatches via the SAME installed public detector before
    registering root flags, loading root profiles, publishing authority or
    sweeping/allocating global temp. `child-sandbox.ts` installs a blocking hook
    before async API lookup; only public proof of inactive scope permits root.
    It claims pi-sbx in the SDK lifecycle, strictly decodes/compiles, owns private
    scratch in held workspace, checks actual SDK native source ownership and
    pinned SDK shell/PATH/helper provenance, then acknowledges only after the
    existing controller really reports active. Failure/rebind/revocation/shutdown
    cannot reopen disabled/local/root fallback. No child settings/standing rule,
    local broker/reviewer or independent human channel is installed.

    The SAME Bash dispatcher/queue/SRT/local SDK backend handles sandboxed,
    canonical scoped and exact parent-admitted host commands. Connection admission and every
    held native/log write, scoped exception and host command use current
    parent authority without a synthetic review/cost or reusable grant; a semantic
    tool allow is separate. Outer environment strips bootstrap/options/functions
    before the existing local backend starts; its actual public SDK-resolved
    shell and named outer PATH helpers are pinned, not replaced by another engine.
    Both caller and lease cancellation reach execution; rollback poisons on error.
    Output capture checks bound authority and opened/named file identity before
    actual writes; replacement/revocation/cancel stops writes and preview, keeps
    prior bytes, closes the handle and cannot report a late success.

    `child-native-tools.ts` retains real SDK schemas/builders with invocation-local
    operations. Fences run AFTER asynchronous semantic hooks and before/after each
    actual filesystem step, addressing only the admitted canonical target. Edit
    needs both read and write authority, and its speculative render-time disk
    preview is removed. Native process/device namespaces (/proc,/sys,/dev) cannot
    expose the Node host or disabled TTY scope. ls never borrows recursive grants
    or follows metadata outside its admitted tree. These SDK rg/fd implementations
    lack a subprocess fence hook: native grep/find explicitly refuse, never run
    unconfined or invoke a substitute search/shell engine. Actual agent auth and
    this loaded enforcement/SDK package stay mandatory-locked even if agent-dir
    metadata differs from the parent. Delegated prompt guidance states the limits.

    428 tests/types and 213 non-headless Guardian tests/types pass. The six real
    registered-entry cases still MOCK SRT and Guardian acknowledgment; binding
    tests use the real opaque claim/ack API with explicit controller/Guardian
    fixtures. They do NOT establish both production consumers in the actual SDK
    factory/Node IPC or any OS containment. First SDK generation/lifetime model
    provenance, complete bootstrap/dependency/trusted-code provenance, combined
    startup/teardown, actual deployed runtime/OS/Git/live
    accounting remain open. No deployment, restart, policy/toggle edit or push.

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

`install.sh` installs npm `pi-sbx@0.1.3` and mirrors this `src/` over the installed
copy through the common `source` deploy mode. All forks are planned before writes;
source/target symlinks refuse and atomic replacement avoids shared-hardlink writes. No deployment happened in round 1. Fully quit/restart Pi after human
installation; inspect kept live configs for nonempty retired exclusions.

For an upstream update:

1. Reconcile all deltas above, not just scratch or the first broker patch.
2. Keep registered-tool negative tests and cross-extension service tests.
3. Run `npx vitest run`, `npx tsc --noEmit`, and repository `just check`.
4. Update pins/provenance deliberately, deploy separately, and exercise loaded
   schema, sandbox/host/scoped behavior and negative cases in a fresh Pi process.
