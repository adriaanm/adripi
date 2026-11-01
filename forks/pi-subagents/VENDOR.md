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
