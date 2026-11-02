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

### Guarded SDK resource/model startup (source prerequisite)

The actual default SDK factory now selects guarded behavior through the SAME
public context detector. Guarded child settings always use `projectTrusted:false`,
regardless of the parent's launch boolean; unsupported SDK trust semantics refuse.
This excludes child `.pi` settings/packages/auto extensions/SYSTEM and gives the
real built-in MCP startup an untrusted context, while retaining explicitly
selected code and trusted global user/provider resources. It does not create a
parallel loader or copy grants from child-local configuration.

Guarded launches require an explicit fully qualified provider/model before SDK
loading and own a fresh ModelRuntime. SDK resolution must return that exact tuple
without fallback warnings, and `session_start` cannot silently change the selected
model. Reported extension import/startup and provider/native/virtual registration
failures are fatal even for non-required extensions, rather than leaving a
built-in/default provider in charge. Partial initialized sessions are disposed.
Ordinary unguarded factory behavior is unchanged. This is selection fidelity,
not a model-derived permission or a consumer claim/acknowledgment.

Fourteen new regressions include real resource discovery, trusted global provider
retention, actual SDK/faux-provider `session_start` and real built-in MCP refusing
a child-project server. The readiness assertion remains unsatisfied in the SDK
fixture: no production enforcement/first-prompt acknowledgment is claimed. Nine
initial regression cases failed against the prior factory, including executed
child-project override code and accepted model/startup substitution. See the
[consumer integration record](../../docs/round-2-production-consumers.md) for
current verification and remaining production/runtime gates.

pi-sbx now has the actual registered parent publisher, narrowing policy and shared
Guardian/human adapter. The actual Guardian semantic child consumer now claims/
acknowledges only its installed forwarding/lifecycle through that same public API;
pi-sbx's actual native/Bash/SRT entry is now source-implemented (`19af0d2`), but
**combined production SDK/IPC readiness is not accepted**. The separate component
and acknowledgment fixtures do not authorize a first production model prompt.
Real registered SDK/IPC composition is not replaced by a focused role fixture. These
seams do not certify child containment, full headless,
external worktrees or authenticated Git. No live installation/policy/restart/push
was performed. See the [current wiring acceptance and payload handoff](../../docs/round-2-wiring-acceptance.md)
and [component history](../../docs/round-2-child-authority.md).

### SDK generation lifetime barrier (source prerequisite)

The runner's first-prompt assertion missed SDK requests triggered during startup.
The credential-free real-SDK/faux regression dispatched **one** request before
both consumers acknowledged when only the new guard installation was disabled;
with the guard, it dispatches **zero** and refuses startup. Evidence:
`.local/goal-wiring-sdk/generation-{before,focused,full}.log`.

The same default factory now captures its existing scoped opaque lease through an
internal domain accessor (no public consumer/ack, registry, grant or transport),
and fences its fresh SDK ModelRuntime's public stream/generation boundaries.
The original provider/transport is retained. All required consumers must be ready;
bound session/model identity and lease/caller cancellation are checked before
requests and again after asynchronous public headers/payload/response/stream
callbacks. The composed signal reaches the existing SDK transport, including
summaries/cache warming. Physical virtual-model requests stay tied to the live
SDK-routed agent model; no alternate router is added. Provider registration and
refresh have finished at exact model resolution and cannot be replaced later
behind the same ID. Generation dispatch cannot be overwritten. Extension errors
close the guarded lifetime even after startup; teardown closes it before emitting
supported shutdown/dispose. Auth needed for already-owned cancellation cleanup is
not disabled by fencing generation. Ordinary unguarded behavior is unchanged.

**19 boundary fixtures plus two actual SDK/faux cases** pass; all acknowledgments
in these generation tests are explicit barrier fixtures, not production consumers.
Full source: **4,275 total / 4,258 pass / 17 skip / zero fail**, **443 suites**,
concurrency4; typecheck pass. A credential-free installed SDK **1.4.0** probe also
refuses startup warming (zero calls) and finishes an acknowledged faux prompt
(one call, normal stop); `.local/goal-wiring-sdk/generation-sdk14.{mjs,log}`. The
fresh graph has **384 inputs / 17 exports / 330 compiled modules / 18 module-URL
targets / 768 artifacts**, artifact `ff7fafc443439a30`; four graph tests prove
compiled SDK lease capture shares bundle/compiled ALS without claiming/acking.
pi-sbx remains **428 / 30 files** plus types; Guardian **213 non-headless**/types.
Native stream iteration/result and async image/classifier results discard late
identity/cancellation output without synthetic messages/usage. Complete
bootstrap/dependency/provider-data provenance, actual virtual dispatch, policy-aware
startup resources, selected-tool fidelity, registered production SDK/IPC composition
and deployed/OS/Git/paid-cost/latency gates are still open. No live installation,
restart, policy/toggle edit, credential/audit content access or push occurred.

## Combined-consumer IPC teardown follow-up

The source SDK/IPC composition negative for conflicting native registration
reproduced an asynchronous `EPIPE` after the controller had removed its error
listener. Every authority send now owns its native asynchronous completion/error
callback: parent grant/decision/revoke failures dispose the controller; runner
request/cancel/release failures close the same client/lease. No retries, fallback
endpoint, new protocol or approval mechanism. Disposal stays idempotent and a
backpressure return is not confused with write failure. Four deterministic
actual-endpoint error-injection tests cover parent late revoke and all three
runner send kinds; the full IPC file has **31 tests**.

Full unit: **4,279 total / 4,262 pass / 17 skip / zero fail / 443 suites**, concurrency4;
types pass. Fresh graph: **384 inputs / 17 exports / 330 compiled modules /
18 module-URL targets / 768 artifacts**, artifact `27cf8b4eaeb2ea26`; four graph
tests pass. The root `just check-child-composition` gate adds **13 source cases**
with both actual registered consumers and the real default SDK/session runner,
whole copied verified API graph, actual Node IPC/controller/provider and registered
parent Guardian. SRT backend, provider, reviewer verdict/usage and human answers
remain explicit doubles. This is not the complete detached-launch/bootstrap,
virtual/resource provenance, deployed/OS/Git or paid-provider/latency gate. No live
installation, restart, policy/toggle edit, protected-content access or push.

## Matching model names did not pin generation metadata

Six regressions reproduced API/baseUrl/headers/compatibility and asynchronous
metadata substitution behind unchanged provider/model names. The same internal
SDK guard now takes the actual exactly resolved model before session creation,
retains an independent all-own-data snapshot (including non-enumerable/nested
fields), and checks it at existing lifetime/generation boundaries. Per-invocation
snapshots also reject drift after async hooks/native results. Equal SDK data copies
remain valid; native provider/auth/transport and unguarded paths stay unchanged.
No new registry/router/permission/cache or synthetic messages/usage.

The snapshot refuses accessors/proxies without invoking them, code/symbol/custom
prototype/cyclic shapes, depth>12, >1,024 visited values/array length and >65,536
cumulative UTF-8 key/string bytes. Refusal never truncates or logs header values.
These checks pin selected/request model data, not effective auth overrides or full
virtual provider/catalog/code provenance. Those acceptance gates remain open.

Fourteen additional unit regressions pass. Full unit **4,293 total / 4,276 pass /
17 skip / zero fail / 443 suites**, concurrency4, and types pass. Root source
composition **14/14** includes actual SDK pre-generation endpoint mutation with
zero dispatch/mutation/scratch leak; four graph tests pass. Fresh graph **384 inputs /
17 exports / 330 compiled / 18 module-URL targets / 768 artifacts**, artifact
`21e2e8d81e15401a`. pi-sbx429/types, Guardian214 non-headless/types and the explicit
credential-free SDK1.4 barrier/faux fixture pass again. Local synthetic iteration
measured119–126ms per10,000 guarded events (~12µs/event total guard), not a live
latency/billing or savings result. Evidence/scope in
`docs/round-2-production-consumers.md` and `.local/goal-consumers/model-metadata-*`.
No deployment/restart/live policy/toggle/protected-content/runtime replacement/push.

## Ambient Node preloads ran before child authority binding

An actual detached launch/Node regression executed inherited `NODE_OPTIONS`
preload code before binding IPC, despite later parent preparation refusal. Its
owned runner was terminated/observed; seven further spawn-boundary negatives also
failed before repair. Existing guarded admission now refuses nonempty
`NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `OPENSSL_CONF`, `OPENSSL_MODULES`,
`OPENSSL_ENGINES` and unowned `JITI_*` before spawn. The existing explicit host
`JITI_ALIAS` peer-map replacement remains; empty values and unguarded configuration
remain unchanged. No silent flag/environment sanitization, preload grant, new
trusted flag parser, protocol or fallback runner; error messages expose names only.

Ten additional regressions; full **4,303 total / 4,286 pass / 17 skip / zero fail /
443 suites**, concurrency4, and types pass. Four graph and14 combined-consumer cases
pass. Graph **384 inputs / 17 exports / 330 compiled / 18 module-URL targets /
768 artifacts**, artifact `0bdb7d1beead1157`. Evidence under
`.local/goal-consumers/bootstrap-*`; scope and remaining provenance/CLI/deployed/
OS/Git/live-cost gates in `docs/round-2-production-consumers.md`. Guardian source
is unchanged since its current215/215 Node24 HTTP gate. No live startup/config/
policy/toggle/runtime change, deployment, restart, protected-content access or push.

## Real source/compiled detached CLI composition

The root gate now adds eight actual detached launch cases: `executeAsyncSingle`
through startup commit/native Node bootstrap/heavy runner/default SDK factory/both
real consumers/real IPC/registered parent/drain/observed process finalization.
Success, unavailable backend, broken Guardian and terminal denial run from source
and the complete copied/verified compiled graph with its actual JS bootstrap and
locked dependencies. No factory injection or fixture consumer claim/ack. The native
faux provider observes SDK1.2/real role readiness using the lease retained at load.
Config consumption, launch digest, runner-instance proof, exact content/directives,
zero-dispatch startup failures, no mutation/next generation after denial, reset and
scratch disposal are checked. Existing upstream isolated-temp/HOME setup is reused.

Root composition **22/22** and four graph tests pass; source unit/types remain
**4,303 / 4,286 pass / 17 skip / zero fail**; same artifact `0bdb7d1beead1157`.
This is actual source/compiled CLI composition, not live installed SDK1.4/public
parent SDK tool-event/complete bootstrap/resource/virtual/tool-lifetime/OS/deployed/
paid-provider proof. Explicit doubles and outstanding gates/evidence are documented
in `docs/round-2-production-consumers.md`. No live deployment/restart/config/toggle/
protected-content/runtime change or push.

## Guarded Node selection still attempted PATH fallback

When the current executable's access check failed, guarded background launch used
upstream's bare `node` fallback. A pre-fix spawn regression proves it. The existing
admission now refuses any non-absolute/non-current selection and uncompiled Bun
hosts, even when named `node`. Unguarded resolution stays unchanged; no alternate
runtime, retry or public compatibility flag. This is selection proof, not full
executable/code/dependency integrity certification.

Two new negatives pass; full **4,305 total / 4,288 pass / 17 skip / zero fail /
443 suites**, types,22 composition and four graph tests pass. Same384-input,
17-export,330-compiled,18-URL,768-artifact graph, digest `f2e150f60f4d2368`.
Evidence/scope: `docs/round-2-production-consumers.md` and
`.local/goal-consumers/executable-*`. No live runtime/policy/config/toggle,
install/restart/protected-content change or push.

## Fabricated physical state did not prove native virtual routing

Actual source and compiled SDK1.2 detached virtual cases failed: SDK retains the
virtual selection, routing the request only. Replace the opaque physical-agent-state
assumption with observation of its existing public `resolveModel`/physical catalogue.
Preserve native output/reason/state/router/provider/auth/transport. Check readiness,
selection and composed cancellation before/after async resolution, pin lookup and
bounded metadata, require actual observed SDK-owned physical references and matching
current catalogue data at generation/hooks/results. Native cache-warmer reference
reuse remains possible, with fresh checks; weak observations are data, never grants.
Copied/unknown references, changed metadata/catalogue and lookup replacement refuse.
No new public API, protocol, permission store, provider or fallback router.

Real virtual `user`/`continuation`/previous-response callbacks and physical provider
identity/readiness/native writes/process drain pass in source AND full compiled
CLI graph. **24 composition/4 graph**, full **4,310 /4,293 pass/17 skip/zero fail/
443 suites**, types and root checks pass. Artifact `ab5e595679b5ef7e`, same384 inputs/
17 exports/330 compiled/18 URLs/768 files. Evidence/scope and remaining SDK1.4,
effective-auth/provider-code/dependency/cache-warming/live acceptance gates:
`docs/round-2-production-consumers.md`. No deployment/restart/live policy/config/
toggle/protected-content/runtime change or push.

## Native SDK1.4 full matrix, without deployment

Root source composition can use the existing `PI_SUBAGENTS_NATIVE_PI_ROOT` +
`native-peer-loader.mjs` harness. Layout symlinks resolve the selected SDK's actual
peer packages with the existing resolver; the narrower launch-shaped runner imports
that same explicit layout SDK/pi-ai pair. Default remains locked1.2.0; missing
peers fail, no production resolver change/dependency repair/fallback. Genuine
provider callbacks assert SDK VERSION in the complete detached cases.

All **24 actual consumer/source+compiled CLI/virtual/native IO/Bash/output/refusal/
cancellation/drain cases pass on both SDK1.2.0 and genuine installed SDK1.4.0**, zero
failures/skips. Synthetic HOME/agent/config/credentials/fixtures, explicit backend/
provider/reviewer/human doubles; no deployed/OS/live billing or complete provenance
claim. Source units/types/build unchanged (4,310/4,293 pass/17 skip; artifact
`ab5e595679b5ef7e`). Reproduction and remaining gates:
`docs/round-2-production-consumers.md`. No live install/restart/policy/config/toggle/
protected-content/runtime replacement or push.

## Tool provenance survived admission but changed before generation

Actual SDK post-startup schema mutation previously completed; tool-owner replacement
allowed one model request before operation ownership refusal. Extend the existing
generation fence to public SDK tool APIs/declarations/source/definition/code identity
and selected active/callable ceilings. Pin before extension startup, recheck every
generation/async hook/iteration/result/native route, allow narrowing not widening.
Retain real TypeBox symbols/functions as exact code references, no getter/proxy/code
invocation or JSON loss; model metadata remains data-only.256 tools/16,384 aggregate
nodes/512KiB text/depth12; malformed/oversized/missing APIs fail on the same lease.
No freeze/substitute of upstream schemas/state, new public API/protocol/role/ack,
permission decision/store, registry or backend.

Two genuine negatives now dispatch zero calls/no mutation/review/scratch leak on
SDK1.2 AND1.4. Eleven unit cases plus faithful empty-tool APIs for two existing
startup mocks pass. Full **4,321/4,304 pass/17 skip/zero fail/443 suites**, types;
**26/26 composition per SDK**, four graph/root checks pass. Artifact
`4b73c50b862cbb40` (384 inputs/17 exports/330 compiled/18 URLs/768 files).
Local seven-tool1000-event fixture costs189.7–266.9ms vs0.16–0.38ms bare, not live
latency/savings/billing proof. Remaining scope and exact evidence:
`docs/round-2-production-consumers.md`. No live install/restart/policy/config/toggle/
protected-content/runtime replacement or push.

## Startup discovery conflicted with the pinned SDK tool loadout

Actual public parent SDK dispatch now loads both real parent entries and the full
built subagents graph; actual pi-sbx owns publication/policy/registration, without
fixture claims/acks/providers. Normal subagent tool dispatch reaches compiled CLI,
both child consumers, real parent broker and native Unicode Write; exact identity,
observed process finalization, actual parent directive/cursor and two-call Guardian
cost projection hold. Missing/existing trusted supervisor declarations both work.
SRT OS backend/violation telemetry, provider/reviewer/usage/human are explicit doubles;
real shipped schema/matcher helpers and Guardian prompt assets are installed.

The supervisor helper legitimately registers at session_start. Earlier registration
conflicts with other extensions' pending definitions; preserve upstream lifecycle.
Add one internal generation-guard seal after SDK binding/native MCP readiness,
before returning a promptable child. Even both consumer acks cannot enable startup
generation. Existing APIs/definitions/schema/source/code and pre-existing selection
ceilings stay pinned; SDK startup additions receive the final bounded snapshot.
Afterwards no additions/replacement/widening; narrowing remains supported. No repeat
seal/revocation adoption/new role/ack/permission mechanism/loader/transport/backend.
Actual both-acked startup refusal and15 unit additions supplement existing negatives.

**4,336/4,319 pass/17 skip/zero fail/443 suites**, types; **29/29 per genuine SDK1.2
and1.4**, four graph tests. Source `70c8dc45739f2f51`, artifact `02d417062d9ace54`;
384 inputs/17 exports/330 compiled/18 URLs/768 files. Public tasks explicitly use
async:true/acceptance:false/seven native tools, not default/control-workflow or live
OS/billing proof. See `docs/round-2-production-consumers.md` for exact evidence and
remaining acceptance/provenance/lifecycle/deployment/OS/Git/cost/latency gates.
No live install/restart/policy/config/toggle/protected-content/runtime replacement,
paid-provider operation or push.

## Structured output was rejected as an unowned tool

Actual public SDK outputSchema tasks could not complete: pi-sbx rejected the
existing structured_output helper. Names/inline labels cannot authorize it. Mark
its exact producer function with the current opaque lease reference and bind one
non-replaceable SDK-definition inspector on that same lease after startup. Add
pure code/lifetime inspection to the existing public child-authority API, consumed
by pi-sbx; no separate registry/permission store/approval path/role/ack/wire change.
Internal marking/binding functions are not public package-API exports. Arbitrary
privileged host code remains outside this boundary, as with the provider API.

Preserve native schema/validation/capture/termination. Check current definition,
pinned metadata, lease and caller cancellation around async validation/capture.
No model-selected file target, filesystem/host/maintenance scope or semantic-review
exemption. Metadata-only code captures the actual current scope without assuming
process cwd equals task cwd; runner/SDK/consumer cwd checks stay exact. No inspector
replacement or producer retargeting; old API without inspection refuses in pi-sbx.

Actual public dispatch now proves default lightweight acceptance, typed capture and
terminal return, and parent semantic denial without capture; three reviews count
once, cursor/directives/process/cleanup remain checked. Seven unit additions prove
foreign-code/lease refusal, binding identity, validation and async cancellation/
revocation/replacement. Generic supervisor/wait/MCP controls remain unsupported.
**4,343/4,326 pass/17 skip/zero fail/443 suites**, types; **32/32 per genuine SDK1.2
and1.4**, four graph tests. Source `b62b504e34add416`, artifact `dfa62bc52350e223`,
graph384/17/330/18/768. See docs/round-2-production-consumers.md for explicit
OS/provider/reviewer/usage/human doubles and remaining acceptance boundaries.
No live install/restart/policy/config/toggle/protected-content/runtime replacement,
paid-provider operation or push.

## Factory disposal during SDK startup still returned a promptable child

Recheck the existing factory disposal epoch and caller abort after SDK/MCP startup,
before sealing/return. Normal shutdown cleans the stale session and creation
rejects; no new runner/registry/timeout. Two controlled fixtures prove exactly-once
cleanup/no returned child. This is not a claim that disposal interrupts or waits
for a non-cooperative extension initializer; actual process ownership stays separate.
Full4345/4328pass/17skip/0fail443suites (concurrency1), types;32/32 per genuineSDK1.2/
1.4 and4graph tests. Unrelated concurrent npm PID-marker/viewer JSON races passed
in isolation; no weakened assertions/timeouts. Sourcecfd3726816ece325/artifact
bfceb9573fdad484, graph384/17/330/18/768. Exact evidence/remaining boundaries:
docs/round-2-production-consumers.md. No live install/restart/policy/config/toggle/
protected-content/runtime replacement/paid-provider operation/push.

## Timeout termination evidence raced the fixture's own startup

The global-npm-root timeout test still intermittently missed its PID marker even
with sh/concurrency1: the real subprocess could be killed before its first script
instruction. Observe the actual ChildProcess through Node's existing public
`child_process` diagnostics channel and await that exact process's native close/
SIGTERM. No mocked/replaced execFile/backend, PID polling, new production API or
weakened500ms timeout. Seven focused tests pass; no runtime/permission change.
Evidence: .local/goal-consumers/provider-fidelity-npm-observation.log.

## Live provider auth/dispatch objects bypassed the locked registry

Pin the actual SDK public getProviders catalogue and getProvider/getProviders/
getAuth API identities at model resolution. Existing guard points inspect only
that request's concrete provider against independent reference/data/code snapshots;
virtual routes must use an initially pinned provider. Catalogue256/16384nodes/
512KiB, each provider1024nodes/64KiB. Malformed/replaced/accessor/proxy/oversized/
lookup-failed state revokes the same lease, no auth-value logging or getters.
Optional cancelDeferred uses the existing active generation fences; getAuth still
works for owned cleanup after close. Async callback/promise finally checks cover
failures too and preserve unchanged errors. No new SDK/provider/transport/registry/
role/wire/ack/public API/permission store. Existing opaque fixtures expose faithful
public APIs instead of substituting an engine.
21 added units:4366total/4349pass/17skip/0fail443suites, types.35 composition per
actual SDK1.2/1.4 +4graph/root gates. Two real pre-generation mutation regressions
previously completed; async real SDK header mutation now also refuses with zero
provider calls/mutation/reviews/scratch leak. Baseline/current1000-event seven-real-
tool/real-faux-metadata fixture ranges186.3–203.0/191.3–210.2ms (mean+4.7µs/event),
not paid/representative latency or savings. Source022b2c6f444686d2/artifact
d3f7ab3618b3946a, graph384/17/330/18/768. Full scope/evidence/remaining private-code,
effective-auth, transport-handoff, deployed/OS/Git/live cost gates:
docs/round-2-production-consumers.md. No live install/restart/config/policy/toggle/
session/protected-content/runtime replacement/paid-provider/push.

## A queued provider swap ran after the last header snapshot

Actual SDK red probe: four microtasks after headers, the swapped streamSimple ran
(calls1/readiness0) before later revocation. Following full bounded data validation,
freeze the existing public provider data graphs and make getProvider/getProviders/
getAuth own properties nonreplaceable with their exact original function values.
No operation/provider/transport wrapper or substitute, function-object/model/tool-
schema freeze, role/API/protocol/store addition. Native private state/auth results
remain untouched; caught ineffective writes may continue with unchanged authority.
Actual delayed4/8 continuation cases prove TypeError/no replacement/original native
operation+assigned Write/both roles ready/reset/cleanup. Immediate violations still
refuse; opaque owner replacement/failure tests remain (not successful data swaps).
3added units;4369total4352pass17skip0fail443suites/types;37/37 per actualSDK1.2/1.4,
4graph/root gates. Source8877dd166fad256e/artifactc8eb7e56a8ae0f5a,384/17/330/18/768.
Synthetic pre-provider-pin/current1000-event7-real-tool/faux-metadata ranges
193.7–208.3/198.8–216.1ms (~6.1µs/event mean difference, not isolated freeze cost or
paid latency/savings). Exact evidence/remaining raw model/private code/effective-
auth/transport/deployed/OS/Git/live-cost gates:docs/round-2-production-consumers.md.
No live install/restart/session/config/policy/toggle/protected-content/runtime
replacement/paid provider/push.

## Raw model endpoint data changed between headers and the native backend

Actual SDK delayed4-microtask red probe: the same native faux backend received
https://changed.invalid (calls1/readiness0), before queued onResponse revocation.
No real HTTP. Passive backend-input observer, not an alternative engine or a
response-factory claim. Generalise validated provider-data freezing to admitted
MODEL DATA: exact selection, equivalent session/request copies and catalogue-
validated native physical references. Keep exact objects/aliases/nonenumerables;
capture each validated getter/route reference once. WeakSet only skips redundant
freezing, never existing per-action checks. No SDK/provider/transport/router/class/
function-value replacement, tool-schema/function-object freeze or new authority
API/wire/store. Native auth results/private state untouched. Caught ineffective
assignments leave original authority valid; uncaught hook failures close normally.
Actual delayed4/8 cases preserve original endpoint/2readycalls/Write/reset/cleanup;
source/compiled/public-parent/default acceptance/structured output/native virtual
routes pass.4added units,4373total4356pass17skip0fail443suites/types;39/39 per genuine
SDK1.2/1.4,4graph/root gates. Sourcedf8360feed30a16f/artifact52fbadba145d6190,
graph384/17/330/18/768. Synthetic baseline(pre-provider-pin)/current1000-event ranges
191.0–201.0/196.7–199.2ms (~2.6us/event mean delta), NOT isolated freeze overhead or
paid latency/savings. Model catalogue before first route, prepared auth/request
values, private/global code/resources/lifecycle/cache-warmer/deployment/OS/Git/
live-cost gates remain open;docs/round-2-production-consumers.md has exact scope.
No live install/restart/session/config/policy/toggle/credential-audit-content/runtime
replacement/paid provider/push.

## A first virtual route accepted catalogue metadata changed since startup

ActualSDKred: before_agent_start mutated physicalgetAll()candidate, selectedvirtual
unchanged. Native lookup agreed with alreadychanged metadata:2readyfauxbackendcalls
at changed.invalid/exit0/nativeWrite. Capture virtual selections' getAllModels data
at exact resolution, not firstuse; validate own slots/no getters/proxies/sparse/
duplicate/unsupportedkind/fallback.8192entries/524288nodes/8MiBaggregatekey+strings,
1024nodes/64KiB/depth12permodel. Key provider/ID/kind; retain exact readonly native
getAllModels value. Native route must match initial AND current metadata before
admission. No new selector/registry/engine/context/API/authority store; membership
is not a dispatch grant. Unselected DTOs not frozen; plain selections and per-event
hot paths do not scan catalogues. Auxiliary router classifier/image operations and
actual cache warming remain separately unaccepted, not implied by route tests.
16addedunits: firstuse/async/newidentity/kinds and9malformed/aggregate bounds;
4389total4372pass17skip0fail443suites/types;40/40 per genuineSDK1.2/1.4,4graph/root.
Sourcebc552639d8d519a7/artifactbc846e76faa123c8 graph384/17/330/18/768. Native ctor-only
bench5samples, empty credentials(all methods throw), noauth/request/network/session:
SDK1.2/1649models baseline0.51–1.38/current16.32–20.36ms;SDK1.4/1713models
0.49–1.40/16.34–22.63ms. Prioraf8802fguard baseline; not wholepaidlatency or permission
proof. docs/round-2-production-consumers.md exactred/scope/evidence/remaining gates.
No live install/restart/session/config/policy/toggle/protected-content/runtime
replacement/paid provider/push.

## Registered provider/config callbacks bypassed their immutable composed object

ActualSDKred: native with real synthetic models.json overlay, and legacy provider
config, both exposed mutable streamSimple sources behind unchanged composer code.
Both replacements ran/2readyfauxcalls/exit0/Write. Withoutoverlay native/public is
already samefrozenobject; native+legacy registrations delete each other, notcompose.
Existing pins now track composed/native/config refs inclundefined; validate all,
then freeze original data and seal exact getter funcs. Per-source1024nodes64KiB,
aggregate16384nodes512KiB,256providers/depth12. No substitute/wrapper/registry/context/
permissionstore/API/role/wire. Immutable own data makes per-event deep snapshots
redundant; check current source identities/absence/lookup failures eachaction instead,
plus all existing model/tool/readiness/lifetime/cancel guards. Functionobjects/private
closure/globalAPI/modelConfig auth/request outputs still not certified. Nativeauth/
cleanup unchanged.12addedunits; immediateviolations0calls/noWrite/leak; registered
4microtick variants TypeError/noreplacement/original2readycalls/Write/reset/cleanup.
4401total4384pass17skip0fail443suites/types;44/44 per genuineSDK1.2/1.4,4graph/root.
Source154dd6afda95173e/artifact5700b701be2a3ea3 graph384/17/330/18/768. Synthetic
1000event7realtool/fauxmetadata against exact1e61c82guard:195.4–205.5msbaseline,
189.6–197.4current (mean~6.9us/event/~3.5% lower), not paid savings/total latency.
Exact evidence/budgets/remaining prepared-auth/code/resources/lifecycle/live gates:
docs/round-2-production-consumers.md. No live install/restart/session/config/policy/
toggle/protected-content/runtime replacement/paidprovider/push.
