# Production child consumers: integration commission

Commission baseline: launch/provider `cd15ee4`, Guardian accounting `8f7551c`.
Later source milestones and remaining gates are recorded below.
Todo #14 remains unfinished; #15 is the separate OS/external-worktree/Git acceptance.
This record is an implementation contract/plan, **not** consumer acceptance.
No worker is active. The parent is the sole sequential writer in main; no
concurrent component writers, deployment, live-policy/toggle changes or runtime
replacement are authorized by this plan.

## Protocol / parent-service phase: implemented and source-verified

The SAME public API now uses provider/wire **2**. Guard/ALS/runner-latch Symbol
keys intentionally retain their `.v1` names so old hosts observe intent and fail
closed rather than launch bare. The policy payload now says `version: 2`;
network/environment/host ceilings are projected below. At that milestone there
was no production consumer acknowledgment; the later Guardian-only follow-up
below does not satisfy the separate pi-sbx/readiness gate. There is no parallel v1 approval implementation or new permission store.

- `tool` targets carry exact GuardianAction JSON, capped at **64,000 UTF-16
  characters / 256KiB UTF-8**; ordinary target/reason and **policy** bounds do
  not expand. The launcher stays opaque; Guardian strictly validates exact
  input/nesting, unknown fields, depth/size, host audience and child cwd. The
  parent's configured action budget can further tighten this limit. Parent
  batch `terminate` is typed metadata and cannot accompany an allow.
- `SandboxBrokerService.reviewTool` runs the actual parent fixed/semantic engine,
  full directives and host-bound requester evidence, same durable reviewer/
  accounting/denial consumption and stale-evidence validator. Relative arguments
  use child cwd; rule/maintenance anchoring remains the real parent. Exact child
  action/audience is audited. Parent transcript cursor is not consumed. A
  semantic allow does not grant filesystem, command or host authority.
- **Additional reproduced ceiling defect:** replacing the admitted workspace by
  a sibling symlink, or repointing a writable read-carveout alias into a denied
  tree, returned `allow` without review in the pre-fix source. Evidence:
  `.local/goal-consumers/anchor-drift-probe.log` (both tests failed on the allow).
  New `anchor.paths` contains bounded, immutable spelled/canonical associations
  for every policy's non-glob prefix, original parent cwd, workspace/Git roots
  and aliases. Drift revokes before/after decisions, with another check after
  broker review **before human admission**. Consumers must enforce these same
  pins even for locally held native/Bash actions. Ordinary creation at a stable
  prefix is not drift. Literal glob-bearing workspace/Git roots cannot be
  represented safely by this matcher/runtime contract and refuse instead of
  admitting a sibling glob or losing mandatory metadata exclusions. This is
  between-action snapshot consistency, **not** hostile same-user race immunity.

Verification on Node **v26.6.0**, current ignored evidence `.local/goal-consumers/`:

| Gate | Evidence / result |
|---|---|
| pi-sbx full suite and types | **222 tests / 22 files**, typecheck pass, including exact-tool service failure/revocation and alias-drift regressions. |
| Guardian full `npm test` / types | **178 total / 177 pass / one known Node26 HTTP-headless native assertion**; typecheck pass. Thirteen new delegated parsing/registered-engine/real-IPC/stale tests pass, including full content, directives, nesting, cost attribution, denial/warning/generation/parent/shutdown/cancellation and queued sibling rejection. |
| Subagents focused authority / types | **79 pass**, typecheck pass. Large Unicode exact-tool round trip; old provider/wire refusal; typed termination/replay/cancellation negatives. |
| Subagents full unit | **4,219 pass / 17 skip / 0 fail** (4,236 tests). Sandbox failed on process/socket fixtures; the exact command passed after reviewed host approval. |
| Affected async integration | **234 pass** after exact reviewed host rerun for loopback/process fixture restrictions. |
| Fresh build, verifier, actual bundle/compiled graph | **3 graph tests pass**, **383 inputs / 17 exports / 329 compiled modules / 18 module-URL targets / 765 artifacts**; artifact prefix `c4e4ea8c6b475776`. |
| Root/source checks | `just check` passes, including **69 deployment fixtures**; `git diff --check` and a final build verifier pass. |

The real Node IPC integration uses the actual pi-sbx provider, real launcher
registration/controller/client, registered parent Guardian and a credential-free
sidecar verdict fixture. Its child acknowledgments are **protocol-test code**,
not production consumers or SRT enforcement. No first production child model
prompt is authorized by these results. At that milestone compatible-runtime
HTTP, actual child OS/Git containment and live usage/latency remained open;
the later Node24 VM follow-up below clears only the first. No deployment,
restart, host runtime/dependency installation, live-policy/toggle edit or push.

## Runtime-authority phase: parent projection and decisions (source only)

`child-runtime-policy.ts` now derives explicit policy data from the actual parent
**baseline** SRT config and environment denial names; a command-local widening or
ambient child configuration is not an input. In addition to existing paths/pins,
the staged v2 policy contains:

```text
network.policy = "parent-decision"
network.allowedDomains / deniedDomains / strictAllowlist
network.unixSocketCeiling = { all, roots }   # ceilings, NOT child SRT grants
network.allowLocalBinding                   # parent ceiling, NOT direct permission
command = { policy: "parent-decision", allowHost }
environment.deny                            # names only; includes masked sources
isolation = { allowPty, mandatoryDenySearchDepth } # depth null means SRT default
```

- Delegated connection decisions use the shipped SRT splitter, host validator/canonicalizer and
  domain matcher. A destination must name an exact host and **numeric port**;
  unknown ports cannot skip a port-specific deny. Validate the original host
  **before** the splitter canonicalizes brackets (otherwise `[user@allowed.com]`
  becomes `allowed.com`). Prepared AND current deny/strict-off-list restrictions
  are final, with no reviewer/UI call. An allow held by both static policies has
  no extra review charge. Other connections use the existing actual-parent route,
  without adding a domain/token or silently treating a repeated allow as standing.
  Lazy helper loading refuses incompatible/missing SRT after guard publication;
  it never falls back to another matcher or absent provider slot.
- Parent Unix socket paths are pinned in both original and canonical spellings.
  The exported intersection helper narrows ceilings to separately held child
  workspace/private-scratch directories, not parent temp, Git-only metadata or
  maintenance namespaces. It is **not** itself runtime enforcement. Loopback/PTY
  booleans likewise cannot simply be copied: shipped macOS `allowLocalBinding`
  can open all localhost ports and `allowPty` allows the TTY namespace. Actual
  consumers must prove a narrowed platform implementation or leave those features
  disabled/refuse unsupported placement, never claim bounded enforcement from a
  parent-positive bit. These consumer/OS gates remain unfinished.
- Declared credential environment **names**, including masked sources, tighten
  to deny; socket-handle names `SSH_AUTH_SOCK` and `GPG_AGENT_INFO` are also denied.
  No values are read/copied. Actual runtime credential file declarations (deny
  **and** mask) enter mandatory child read/write locks, even if a native baseline
  adapter omitted one; a credential directory cannot become a child workspace. Credential injection, filesystem disablement, Git-config-write,
  weaker isolation, AppleEvents/Mach authority and parent Git trust exceptions
  are not lent to the child. Known restrictive request filters, proxy/TLS services
  and custom execution helpers explicitly refuse rather than being dropped or
  replaced. Unknown top-level/network/filesystem/credential/Git policy fields,
  malformed feature bits/depth/names, and policy bounds fail closed. Actual
  translation into a child SRT profile still requires implementation/verification.
- A prepared host-disabled ceiling cannot reopen after parent loosening. An
  eligible child **full-host** command now requires actual parent human admission,
  even after a rule/reviewer allow; no UI is unavailable, not consent. The review
  and human see the host-assigned execution cwd and explicit non-jail scope. No
  child standing rule is offered. This is one exact host execution, **not**
  credential/filesystem containment of the approved host process tree.
- Private baseline consistency evidence (not a grant store) revokes stale child
  runtime before exact-tool semantic review. Mechanical path/network actions
  continue checking prepared/current authority. If the baseline changes while
  broker review or human admission is pending, late permission is cancelled;
  the pre-human check prevents a stale broker allow from reaching the UI. Losing
  the authoritative baseline also revokes the lease. Source covers files,
  environment/socket changes, late network tightening and host disablement.

Verification in `.local/goal-consumers/runtime-*`: pi-sbx **254 tests / 24 files**
and types; Guardian **177 non-headless tests** (including all **13 delegated**
actual-IPC/service tests and two cross-fork authority integration tests) and types;
subagents **79 focused tests**
and fresh unchanged build verifier; root **69 deployment fixtures**/checks. These
are source tests, not production consumers or nested/host OS containment. No new
full Guardian HTTP/runtime clearance or live cost/latency measurement is claimed.

## Reserved Git metadata follow-up: source fix, not consumer acceptance

A writable workspace could name the already-held parent agent directory or
private scratch through its Git pointer and receive that root in `write.allow`.
Both new private-fixture regressions failed before the fix
(`.local/goal-consumers/git-reserved-before.log`); no real credential/audit file
was accessed. Git metadata admission now excludes canonical roots and aliases
that overlap either reserved namespace in either direction, just as workspace
admission does. An already-held parent capability is not automatically delegable.

Current pi-sbx verification: **256 tests / 24 files** and types pass; root checks,
including **69 deployment fixtures**, and `git diff --check` pass. This repairs
provider scope derivation only; production consumers, SDK resource isolation and
actual OS/Git containment remain unfinished. No deployment/live change occurred.

## Child-context dispatch follow-up: source prerequisite, not consumer acceptance

`pi-subagents/child-authority` now exports `hasChildAuthorityContext`. Ordinary
root dispatch does not create a registry. A live ALS store selects child dispatch;
a corrupt/undefined registry refuses. Any runner-latch presence, even an
undefined/malformed value, preserves child intent and nested-launch refusal after
scope exit. The function creates no authority and does not claim or acknowledge a
consumer. Real extension startup has not yet been wired to this prerequisite.

Verification: **83 focused authority tests**, types, fresh build/verifier and
**4 actual bundle/compiled graph tests** pass; root **69 deployment fixtures**
pass. Artifact prefix `e687d77d2d57b6eb`. Initially the full subagents suite hit
sandbox process/socket restrictions and the host retry was refused for a missing
Guardian broker. The subsequent operator-requested plain default-Bash run now
passes: **4,240 total / 4,223 pass / 17 skip / zero failures**, **441 suites**,
92.13s. Types, fresh verifier and four graph tests pass again. Todo #26 is closed;
loaded Guardian broker availability remains unverified, not a prerequisite for
this already-passing source suite. Output is retained under
`.local/goal-output-capture/subagents-full-unit.log`. No host exception, runtime
switch, broker/toggle change, deployment or restart was performed.

The guarded SDK resource/model follow-up below now addresses borrowed project
trust and SDK model fallback. Still needed before readiness: implement and compose
the real pi-sbx/Guardian consumers under SDK + IPC, including strict policy
decoding, active narrowed SRT/native adapters, exact parent review, action/scratch
pins, freshness and fail-closed teardown. Factory setup alone cannot acknowledge
those consumers or authorize a first prompt.

## Post-capture verification iteration (still no consumer acceptance)

Native Bash `output_file` source is implemented in `a65229d`; the fork README and
VENDOR describe its exact-write gate, backend capture, partial/error semantics and
retention limits. Full pi-sbx **278 tests / 25 files**, types, **5 installed-SDK1.4
backend probes**, root **69 deployment fixtures** and diff checks pass. The probes
use real local SDK processes/output, not nested SRT or production consumers. A
global-temp scratch fixture race was repaired by recording its own allocation.

Guardian **177 non-headless tests** and types passed again on host Node26.6.0.
At that point bounded Homebrew/nvm/mise/fnm/Volta/common-path inspection found no
compatible executable; #30 requested operator-provided/authorized infrastructure.
No pointless re-crash or silent live-runtime selection was performed.

## Compatible-runtime VM follow-up: HTTP source gate closed

The operator subsequently authorized `container` CLI use. Official pinned
Node24.22.2 on Linux/arm64 passes **all 178 Guardian tests**, zero failures/skips,
including the actual Pi1.0 CLI/HTTP JSON no-session status/nested-review/rule-deny
test, also run standalone. Guardian and pi-sbx types pass. Parent and child Node
executables/version are checked and child PATH pinned. SDK versions remain
Guardian1.0 / pi-sbx0.84.4 / subagents1.2, with existing frozen Guardian/pi-sbx
pnpm locks and subagents npm ci; manifest/lock hashes are unchanged. A synthetic
HOME and only a read-only tracked-source archive avoid host credential/audit/
config mounts. All task-owned VMs were removed after logs were copied.

Todos **#4/#30 are closed**, not bypassed or certified by skipped tests. This
Linux result does not fix host Node26's native assertion. See
[the evidence and bounded reproduction recipe](guardian-container-verification.md).
The initial provisioning failure exposed a stale secondary pi-sbx npm lock;
separate #31 tracks it, without changing dependency versions for verification.

Remaining order/dependencies: #14 real consumers; #29 separately authorized
deployment/restart and loaded identities; #28 actual broker availability before
host acceptance; #15 production OS/Git; #24 live accounting; #25 measured
context/latency/total cost. Source/fixture success cannot substitute for those.
The VM authorization did not authorize live config/session/toggle edits,
credential/audit-content reads, host runtime replacement, deployment or push.

## Guarded SDK resource/model follow-up (source prerequisite)

The real default factory uses the same public child-context detector and always
creates guarded settings with `projectTrusted:false`; a parent's boolean is not
trust for another cwd. Unsupported SDK trust semantics refuse. Existing trusted
global user/provider resources and explicit host-selected extensions remain;
child `.pi` settings/packages/auto extensions/SYSTEM and project MCP servers do
not become startup authority. No parallel resource loader or ambient child
permission store is introduced.

A guarded launch needs an explicit fully qualified provider/model before SDK
loading. It owns a fresh ModelRuntime; SDK resolution must return that exact
provider/id without fallback warnings, and actual SDK startup cannot substitute
another model. Reported extension import/startup and provider/native/virtual
registration failures are fatal even for non-required extensions, rather than
silently retaining a built-in/default provider. Partially initialized sessions
are disposed. Unguarded factory behavior is unchanged.

Fourteen regressions cover real settings/resource discovery, global provider
retention versus a child override, unsupported trust APIs, reported provider/load/
startup failures, exact model/warning/default negatives, and startup model drift.
Actual SDK/faux-provider `session_start` observes false project trust and the
selected tuple; a real built-in MCP startup cannot connect a child-project trap
server. No model request is sent and the live lease's readiness assertion still
fails: this does **not** stand in for production consumers, SRT enforcement or
first-prompt composition. All nine initial cases failed against the old factory.
Verification: all **4,254 unit tests / 442 suites**, **4,237 pass / 17 skip /
0 fail**, with bounded Node test concurrency 4 (141.61s); **61 focused factory
tests**, types, fresh build/verifier, **4 actual graph tests**, root **69**
fixtures and diff checks pass. Graph remains **383 inputs / 17 exports / 329
compiled modules / 18 module-URL targets / 765 artifacts**, artifact prefix
`f8de079a155088c5`. Logs: `.local/goal-wiring-sdk/`. A prior default-concurrency
full run passed the new cases but hit the unrelated owned-npm timeout fixture's
500ms PID-file deadline; all seven npm-root cases pass in isolation and the
entire suite passes at concurrency 4. No production timeout, dependency, model,
installed runtime, policy or Guardian toggle was changed to obtain that result.
The remaining acceptance boundaries above are unchanged.

## Full current-v2 policy decoder and parent-expanded paths (source only)

`pi-sbx/src/child-policy.ts` now supplies one strict decoder for the real consumer
work. It checks the complete current-v2 schema, exact tags/booleans/arrays and
unknown fields; all existing transport bounds remain unchanged. A snapshot must
match the claimed cwd/canonical workspace and hold that canonical write root.
Every file-policy/static-glob/socket prefix needs its actual prepared pin, and
**all** pins, including extra Git/socket aliases, are revalidated. The result is
an independent deeply frozen snapshot, **not** a claim, grant or acknowledgment.
At that milestone the consumer entry points did not use it yet. The Guardian
follow-up below now does; actual pi-sbx runtime enforcement remains open.

The real producer now expands all file-policy entries in the parent cwd/HOME
before transport, preserving globs. A child must not reinterpret a relative or
tilde credential/path rule in another HOME; old relative-entry candidates refuse
at this decoder instead of being rebased. Complete source deployment and restart
remain necessary; no mixed-version live rollout is claimed. Private baseline
consistency stamps use the same effective absolute policy. A regression with the
prior raw stamp returned **allow** after HOME changed an effective parent deny;
the repaired stamp revokes before exact-tool review can consume stale scope.

Verification: **337 pi-sbx tests / 26 files**, types and root checks pass. This
includes **58 decoder/producer cases** and the separate effective-HOME freshness
regression. Durable evidence: `.local/goal-child-policy/`, including the failing
pre-fix stamp probe. No SRT nesting, live config/install, credentials, reviewer
calls or provider spending were used as proof. Production consumer acknowledgments
remain forbidden until the actual adapters/lifecycle are active.

## Guardian semantic consumer and shared installed API facade (partial wiring)

The actual Guardian entry now routes child intent through the SAME co-installed
public claim/ack API, via `pi-sbx/src/child-consumer-api.ts`. The facade resolves
only the install's declared public launcher export, validates current API shape/
version, and never creates an alternative registry, broker or grant. Presence of
either stable ALS/runner key is only a fail-closed tripwire: malformed/undefined
intent must reach the public detector, not ordinary root startup. Standalone root
Guardian does not gain a mandatory runtime dependency on either other package.
The source-mode installer mirrors this facade together with the complete src tree;
no package-manifest/dependency overlay or extra export was invented.

`pi-guardian/src/child-consumer.ts` installs an actual blocking hook **before**
asynchronous API lookup. In a genuine child it never enters root config loading,
local reviewer/broker/widget/toggle/maintenance setup or speculative review. Its
session-start handler claims the opaque live lease, decodes/revalidates the full
current-v2 policy, binds the SDK session, and acknowledges **only Guardian's own
installed semantic forwarding/lifecycle**. Both real consumer ids are required.
Missing/bad API, policy, cwd, identity, transport/revocation/cancellation or repeated
startup stays blocked; shutdown cannot reopen root mode. Root behavior is retained
only if the actual public detector proves an inactive context.

Each tool forwards exact cloned input and the complete nested parent chain through
the existing `tool` route. Root and delegated Guardian now share the same action/
parent constructor. Parent records contain exactly the permitted tool/name/input
fields, not accidental nested cwd/parent fields. Unknown/missing/cyclic/foreign or
more-than-32 parent chains refuse, never truncate. Active evidence (not a permission
cache) rejects duplicate active ids and is capped at 256 entries even if an SDK
fails to deliver cleanup events. Policy pins and session/cancellation are checked
again after awaiting the parent. The shared exact-JSON validator rejects values
that stringify would erase/change (including accessors, custom coercion, sparse
arrays or reference graphs), without invoking getters/toJSON. In delegated mode
it also locks the **actual SDK execution input**, including nested values and its
event binding, before review. The SDK explicitly permits mutable tool_call input;
a review clone alone did not prevent in-flight or later-handler substitution.
Guarded placements cannot patch arguments after this review boundary. No child
usage message, local cost ledger or
second reviewer is created; actual paid work remains the parent's accounting.
A semantic allow grants **no path, output_file, command or host scope**.

Verification: **344 pi-sbx tests / 27 files**, types; **213 non-headless Guardian
tests**, types; fresh unchanged `f8de079a155088c5` graph and root checks (**69
fixtures**) pass. Seven bridge tests use the actual public API/opaque lease and
reject missing/escaping/old/partial exports. **36 Guardian consumer cases** include
the actual registered entry loaded by Pi's real SDK/Jiti in a curated co-installed
source layout with intentionally broken root Guardian config; exact large/nested
inputs; unready scope; policy/cwd/replay/evidence-cap/chain/oversize negatives;
post-allow pin drift; cancellation/revocation/session changes and teardown;
actual-input locking and ten lossy/non-JSON argument refusals without coercion.
Evidence: `.local/goal-child-bridge/`, `.local/goal-guardian-consumer/`.

**This is partial source implementation, not combined production acceptance.**
The focused tests' sandbox acknowledgment is explicitly a fixture. The real
registered Guardian-entry test leaves pi-sbx unacknowledged and `assertReady`
failing, rather than faking a first prompt. At this milestone pi-sbx native/Bash/SRT
adapters were unimplemented; full registered SDK + real IPC composition and startup
model-generation gating remain required. The prior full Node24 HTTP result
predates this follow-up; host Node26's known native assertion is not repaired.
No deployment/restart/toggle, OS-containment, paid-provider or live-cost/latency
result is claimed.

## Policy-only SRT translation (source prerequisite; runtime wiring pending)

`pi-sbx/src/child-config.ts` now constructs the existing controller's typed config
from the strict decoded policy, not `loadConfig` or a child/global profile.
No defaults/maintenance/root Git discovery can add an allow root: only transported
workspace/admitted Git roots enter the runtime. Mandatory read exclusions use
SRT credential **DENY**, not masking; write exclusions stay explicit and Git
config writes/trust injection stay disabled. Environment carries deny names only;
unrepresentable shell names refuse. The minimal profile routes **all** connections
to the real parent (empty local allowedDomains, parent static denies retained).
Broad Unix sockets, localhost binding, Mach/AppleEvents, PTY and weaker isolation
are disabled rather than treating positive parent ceilings as new grants.

The reusable SDK environment adapter drops bootstrap/option/imported-function
inputs before the **outer** local shell starts. SRT's inner `unset` alone is too
late to stop BASH_ENV or an exported wrapper function from running beforehand.
The existing SDK operations/shell engine remains the required execution backend;
actual spawn wiring and executable/startup provenance still need implementation
and proof. Computing config paths here is display/type metadata, not a profile
read or permission source; root settings/persistence/publisher handlers must never
be installed from it.

**356 pi-sbx tests / 28 files** and types pass, including **12** new translation
cases against the actual producer/SRT schema, poison ambient profiles, changed
Git pointer, native policy negatives, optional-depth behavior and synthetic-only
environment filtering. The initial held-write fixture incorrectly passed the
macOS `/var` alias to a matcher whose native gate supplies the canonical target;
correcting that call preserves the actual gate contract and all negative checks.
Evidence: `.local/goal-child-runtime/`. These functions do **not** install adapters,
activate SRT, allocate scratch or acknowledge a consumer. #14, actual SDK/IPC
composition, startup generation/lifetime model/provider fidelity, supported-tool
ownership, and all deployed/OS/live-cost gates remain open.

## Shared scoped dispatcher: canonical admission and baseline isolation

Three new registered-Bash regressions failed against the prior dispatcher: an
alias repointed during its approval still returned `sandbox:build`; repointing
an earlier target during a later approval also executed; a stable alias was
installed as its original spelling, not the canonical target actually admitted.
Evidence: `.local/goal-child-runtime/scoped-alias-before.log`. This was the real
shared dispatch/authorizer with a mocked OS backend, not an actual containment
probe or an independent child exception implementation.

The same dispatcher now captures every target before awaiting decisions, rechecks
all aliases after all approvals, and adds **canonical targets** to one temporary
runtime. It uses the already-authoritative baseline plus the existing
`withScopedPaths` and shipped SRT schema, not root `loadConfig`/Git discovery at
execution time. Thus delegated runtime integration can use this same seam without
reintroducing root profiles/maintenance. Runtime rollback and native-file baseline
isolation remain unchanged; tests now assert canonical admission **and** canonical
absence after restore. A fourth regression poisons the ambient profile during
approval and proves that it cannot replace the action's in-memory baseline.

**360 pi-sbx tests / 28 files**, types, **213 non-headless Guardian tests** and types
pass; the fresh subagents graph/root checks remain required. This verifies snapshot
and asynchronous alias consistency, not hostile same-user atomic inode immunity,
child consumer acknowledgment or actual OS containment. #14 runtime integration
and the remaining composition/deployment/OS/live-accounting gates are still open.

## Held-base scratch and dirty-preserving cleanup prerequisite

The existing scratch allocator now accepts a held base directory plus a synchronous
candidate validator **before** exclusive creation. The child adapter must supply
its already-held workspace and the same policy/pin checks; the callback is not a
permission grant. There is no second allocator or parent-temp inheritance. UUID
creation is mode0700; prefix path traversal refuses before mutation. Root sessions
keep their default temp base. Children must never call the global stale sweep.

Cleanup previously recursively removed whatever reused the scratch pathname. It
now checks bigint dev/inode/birthtime and canonical identity, refuses a replacement
directory or symlink without touching its dirty files, and never adopts a later
replacement after terminal disposal/ENOENT. Refusal is explicit rather than silently
deleting or sweeping another root. This is between-operation consistency, **not**
hostile same-user atomic inode immunity, full worktree cleanup or OS containment.

**366 pi-sbx tests / 28 files**, types, and **213 non-headless Guardian tests**/types
pass. Six new scratch cases cover held-base mode/validation, no mutation on refusal,
replacement directory and symlink preservation, terminal disposal and bad prefixes.
Evidence: `.local/goal-child-runtime/scratch-full.log`. Actual child startup dispatch,
controller activation/own acknowledgment and complete SDK/IPC composition remain
unfinished; #14 and all later live acceptance gates remain open.

## Actual pi-sbx child entry and SDK operation fences (source component)

`index.ts` now selects the real installed public API **before** root flags,
profile/trust/settings, publisher or global scratch sweep. An immediate blocking
hook precedes asynchronous lookup. Only the actual public detector proving no
child intent may register ordinary root behavior. The new `ChildSandbox` claims
`pi-sbx` at SDK session start, validates complete v2 policy/identity/pins, allocates
only held workspace scratch, verifies native owner provenance, and acknowledges
only after the existing controller is actually active. Missing runtime, second
startup/session, drift, transport loss and shutdown cannot reopen root or local
fallback. Child has no local reviewer/broker, human channel or standing-rule UI.

The shared Bash dispatcher, queue, canonical scoped snapshot and rollback remain
one execution path. Child host and scoped exceptions and independent output-file
writes route to the actual parent; static parent restrictions stay final. Held
native/log IO also requests the **current** parent via the shared path authorizer,
without pretending it is a new grant or fabricating review/cost records. Terminal
parent unavailability/cancellation retain their kinds/reasons, not a local prompt.
The existing output capture also checks bound authority at open/write boundaries,
revalidates the admitted file identity on every chunk, and stops both writes and
preview after replacement/revocation/cancellation. Four new real-file regressions
retain preceding bytes but reject late success; cleanup always closes the handle.
All connection admission stays parent-routed. Positive socket/local-bind/PTY bits
remain disabled ceilings. `user_bash` and unowned/unsupported tools refuse.

The existing local SDK backend receives stripped bootstrap/options/imported-function
environment **before** its outer shell. The SDK-resolved shell, absolute PATH and
named outer PATH-helper identities/metadata are pinned and rechecked at action/operation
boundaries, including after awaits. Writable/relative helper namespaces refuse;
existing helper edits are detected even without directory timestamp changes. This
is not a replacement shell or hostile same-user atomic inode isolation.

Real SDK Read/Edit/Write/Ls builders retain native schemas and result formatting;
operation adapters check policy/authority/cancellation and alias identity before
and after actual IO. Edit needs both read and write and cannot run its unfenced
speculative disk-preview renderer. Writes target the admitted canonical file,
including stable final symlinks and exact parent-directory admission. ls does not
borrow recursive grants or expose symlink metadata beyond the admitted tree.
Native `/proc`, `/sys`, `/dev` access cannot expose the unjailed Node host or turn
TTY ceilings into authority. The SDK's native rg/fd builders have no helper-process
fence hook: grep/find explicitly refuse without an operation, not an unconfined
helper or substitute search/shell implementation. The actual SDK agent auth and
enforcement/SDK packages also remain mandatory-locked if host metadata places them
outside the prepared parent's agent namespace. This narrows, never grants scope.

Verification: **428 pi-sbx tests / 30 files** and types; **213 non-headless Guardian
tests** and types. New coverage includes 24 actual-SDK native cases, 21 binding
cases using the real opaque public API, six registered pi-sbx-entry cases using
real SDK IO/Bash and mocked SRT/Guardian acknowledgment, four shared-authorizer
held-current regressions, four output-capture operation freshness cases and three
additional compiler namespace exclusions.
Evidence: `.local/goal-child-runtime/{sbx-full,registered-source}.log`.

**#14 remains unfinished.** Those explicit controller/Guardian fixtures are not
both real registered consumers inside the actual SDK factory/Node IPC. First SDK
generation (including startup-triggered calls), lifetime model/provider/selected
tool fidelity, complete bootstrap/dependency and trusted-global-code provenance,
combined lifecycle/failure tests
and the complete composition gates below still need proof. Grep/find remain
explicitly unsupported in this SDK, not a claimed supported-helper OS result.
No deployed identity, actual OS containment/Git workflow, paid accounting or
representative live total cost/latency is certified. No deployment, restart,
policy/toggle edit, protected-content access or push occurred.

## SDK generation lifetime barrier (source prerequisite)

A real SDK/faux request triggered inside startup bypassed the runner's ordinary
first-prompt assertion. Disabling only the new generation guard reproduces **one
native provider call before either consumer acknowledgment**; enabling it refuses
with **zero calls**. No network/paid provider was involved. The regression uses
the actual SDK runtime/session binding, not a substitute model engine; its separate
positive case acknowledges explicit barrier fixtures and dispatches once.

The default factory captures the SAME scoped opaque lease via an internal domain
accessor, without creating another registry or claiming/acknowledging a consumer.
Its fresh SDK runtime keeps the original public generation implementations and
transport but fences stream/image/classifier/deferred requests, with mandatory
stream/streamSimple support. Bound session/model and all consumers' readiness,
lease/startup/request cancellation, and public asynchronous headers/payload/
response/stream callback boundaries are checked before consuming results. Signals
flow into the SDK transport. This includes SDK summaries/cache warming, not only
normal prompt calls. The live SDK-routed physical agent model is required for
virtual requests; this is not another model router. Post-resolution provider
registry replacement/refresh or guarded dispatcher replacement refuses. Any
reported extension error also closes the lifetime after startup. Supported
shutdown/dispose closes generation while leaving owned cancellation auth usable.

**19 boundary fixtures + two actual SDK/faux regressions**, **4,275 full subagents
tests / 4,258 pass / 17 skip / zero failures / 443 suites**, concurrency4, and types
pass; pi-sbx **428 / 30 files** and types pass. Evidence:
`.local/goal-wiring-sdk/generation-{before,focused,full}.log`. Native stream
iteration/result and async image/classifier results also reject late identity/
cancellation, without inventing model messages or usage. An installed **SDK1.4.0**
credential-free probe has zero calls before readiness, then one successful normal
faux response with explicit role fixtures (`generation-sdk14.{mjs,log}`).

The fresh verified graph has **384 inputs / 17 exports / 330 compiled modules /
18 module-URL targets / 768 artifacts**, artifact `ff7fafc443439a30`; its four graph
tests also prove compiled SDK capture shares the bundle/compiled opaque lease and
does not itself claim/acknowledge a consumer. Guardian remains **213 non-headless**
and types; `just check` (including 69 deployment fixtures), fresh verifier and
`git diff --check` pass before the coherent source commit.

This closes the demonstrated missing-readiness generation boundary, **not #14**.
No generation fixture is both actual registered production consumers/Node IPC.
Complete bootstrap/dependency/provider-data provenance, policy-aware startup
resource delivery, actual virtual dispatch and selected-tool fidelity remain to
be audited with the complete composition matrix. No deployed/OS/Git/paid-provider
or live total-cost/latency result, installation, restart, policy/toggle edit,
protected-content access or push is claimed.

## Both registered consumers with real SDK/IPC (source composition follow-up)

`just check-child-composition` now builds/verifies the actual third-fork graph,
runs the four bundle/compiled identity tests, then runs
`scripts/child-composition.test.mjs`. The gate preflights build freshness and
verifies the **complete copied** `dist-pkg` graph again in each synthetic install;
it does not install an API facade or a source-only third fork. Both actual
pi-sbx/Guardian entries load through the locked SDK **1.2.0** resource loader/Jiti.
The real default factory, standard `runChildSession`, host-created Node IPC,
controller, pi-sbx provider and registered parent Guardian are used. No fixture
claims or acknowledges a consumer. Every actual faux-provider generation observes
`assertReady()` with both real consumer ids; successful startup also proves the
SDK's real `sourceInfo.path` matches the installed native adapters.

Thirteen source cases cover:

- Native write/read/edit and genuine SDK Bash plus independent `output_file`.
  Exact Unicode write/edit content and original parent directives survive. Four
  tools produce three semantic reviews (read is a fixed allow); held native IO
  and output capture have their own current-parent requests but no duplicate
  semantic review, human question or synthetic parent assistant usage. The
  parent's seeded review cursor is unchanged. Scratch is removed on shutdown.
- Missing runtime, broken required Guardian import, conflicting native read
  registration and an actual SDK request from a startup hook before consumer
  startup all refuse with **zero provider calls and no mutation/scratch leak**.
  The SDK itself rejects the duplicate read registration before the sandbox's
  ownership check; this is not evidence for a post-startup owner-replacement race.
- Parent semantic denial/termination, no inherited maintenance despite parent
  semantic allow, unavailable independent output-write admission (no dispatch),
  actual controller connection callbacks for held/static-denied hosts, scoped
  runtime rollback/no lending to subsequent native IO, explicit-host mandatory
  exact parent human admission/no standing rule, and parent cancellation while
  the real sidecar transport has a review in flight.

The matrix exposed two actual failure-reporting defects after fixture corrections:
`.local/goal-consumers/composition-before.log` has **9 pass / 2 fail**. A parent
terminal deny stopped the SDK batch but `prompt()` resolved normally, so the child
runner reported exit0 without a final assistant message. The real Guardian child
consumer now poisons/disposes the **same shared lease** before returning that
terminal verdict; the runner's existing revocation listener produces failure,
without mutation or another generation. Nonterminal denials remain action-local.
Bash refusal/defer content was also persisted by the SDK with `isError:false`.
The shared pi-sbx registration uses the SDK's public `tool_result` return contract
to mark these as errors without losing exact content/details or capture metadata;
merely adding `isError` to `ToolDefinition.execute` would not set that SDK bit.

The conflicting-registration startup negative additionally exposed asynchronous
`EPIPE` during revocation after controller error listeners were detached. Each
native IPC send now owns its error callback, on **both** peers. Failure terminally
disposes the existing controller/client/lease, including pending work; no retry,
fallback endpoint or authority is invented. Four deterministic native-endpoint
write-failure cases cover the parent late revoke and runner request/cancel/release;
**31 IPC tests** pass. This is normal async error ownership, not a protocol change.

Verification at that combined-consumer milestone: **13/13 composition**, **429 pi-sbx / 30 files** and types,
**214 non-headless Guardian** and types, **4,279 subagents unit / 4,262 pass /
17 skip / zero fail / 443 suites**, concurrency4, and types. Fresh graph:
**384 inputs / 17 exports / 330 compiled modules / 18 module-URL targets /
768 artifacts**, artifact `27cf8b4eaeb2ea26`; four graph tests pass.
Evidence: `.local/goal-consumers/{composition-before,composition-after,
composition-subagents-full,ipc-callback-tests}.log`, and the current fork logs
under `.local/goal-child-runtime/` and `.local/goal-guardian-consumer/`.

**This advances source composition, not complete #14 or deployed acceptance.**
The SRT OS backend, local faux model, semantic verdict/usage and human answers are
explicit doubles. Connection callbacks do not open real sockets; the explicit-host
branch runs the harmless test command in the existing test process environment,
not an OS-host escape or real human approval. The driver supplies launch-shaped
input to the standard session runner, not the complete detached launch-plan/CLI
pipeline. Bootstrap/dependency/provider-data and trusted-global-code provenance,
policy-aware startup resources, actual virtual routing and selected-tool lifetime
fidelity still need audit and the remaining combined negative matrix. Nested/MCP/
unknown-tool evidence has separate source coverage, not a claimed supported nested
runtime here. The earlier full Node24 HTTP result predates these consumer changes.
Deployment/restart/live broker, actual OS/Git, paid-provider accounting and
representative total cost/latency stay separate and open. No installation, restart,
policy/toggle edit, protected-content access, host-runtime replacement or push.

## Exact selected-model metadata, not just matching names

The generation barrier still accepted changed API, endpoint, headers or compatibility
metadata behind an unchanged provider/model name. Six regressions failed before
this fix (`.local/goal-consumers/model-metadata-before.log`). The same SDK guard
now snapshots the actual exactly resolved model **before SDK session creation**,
without mutating the native model/provider. It compares all own data fields,
including non-enumerable and nested metadata, at the existing generation/lifetime
checks. Each invocation also retains its own metadata snapshot across asynchronous
transport callbacks, stream iteration/results and image/classifier completion.
Equivalent accessor-free SDK copies remain valid. Cancellation and readiness still
come from the same lease; there is no new router, provider, grant or approval cache.

Snapshots refuse accessors without invoking them, proxies without inspection traps,
functions/symbols/custom prototypes, cycles and excessive shapes. Bounds are depth12,
1,024 visited values/array length and 65,536 cumulative UTF-8 key/string bytes;
excess refuses rather than truncating. No metadata/header values enter diagnostic
messages. Provider auth resolution and transport stay on the native SDK path;
this does **not** prove the provenance of their code/data or effective auth overrides.
Virtual physical catalog/router provenance is still a separate open gate.

The durable combined matrix now has **14 cases**, including a real SDK extension
successfully mutating the model endpoint before generation (a marker proves the
assignment ran), followed by **zero provider dispatch, no task-file mutation and no
scratch leak**. The focused generation file adds **14 regressions** beyond its
original19 cases. Full subagents: **4,293 total / 4,276 pass / 17 skip / zero fail /
443 suites**, concurrency4, and types. Both real-consumer composition and all four
built graph identity tests pass. pi-sbx **429 / 30 files** and types, Guardian **214
non-headless** and types pass again. Fresh graph remains **384 inputs / 17 exports /
330 compiled / 18 module-URL targets / 768 artifacts**, artifact `21e2e8d81e15401a`.
A credential-free SDK **1.4.0** barrier/faux completion probe passes again (fixture
acknowledgments, not the combined production-consumer gate).

A local synthetic iterator with full native faux-model metadata took **119–126ms
for10,000 guarded events**, versus **1.7–2.0ms** unguarded, approximately12µs/event
for the whole guard on this machine. This bounds the observed ordinary hot-path
cost, not live provider latency, paid costs or a before/after savings claim.
Evidence: `.local/goal-consumers/model-metadata-{focused,full,composition,sdk14,bench}.log`.
The full detached/bootstrap/resource/virtual/tool-lifetime/deployed/OS/Git/live-cost
requirements above remain open. No install, restart, live config/toggle change,
protected-content access, host-runtime replacement or push occurred.

## Current-source full Guardian CLI/HTTP refresh

The authorized unchanged Node24 VM recipe now verifies committed source
`1e935e6b680d629a0a1abd6185e5ee67f0ed1617`: **215/215 Guardian tests, zero
failures/skips**, including the real Pi CLI/HTTP headless test; the standalone
HTTP test also passes without skipping. Guardian/pi-sbx types pass. Frozen
provisioning leaves all seven manifest/lock hashes unchanged. This replaces the
older178-test result as the latest full HTTP source evidence; the host Node26
assertion remains neither fixed nor certified. The pinned guest uses only a
read-only curated archive, synthetic HOME/agent/config/cache and credential-free
local HTTP fixtures. Logs/inspection are retained, and its owned VM is removed.
See `guardian-container-verification.md` for exact image/archive/driver hashes.
This closes the stale-full-HTTP-evidence item above, not #14 or the separate
bootstrap/virtual/resources/tool-lifetime/deployed/OS/Git/live-cost gates.

## Guarded detached startup cannot inherit unvetted preloads

A real `executeAsyncSingle`/Node bootstrap regression wrote a harmless marker
from inherited `NODE_OPTIONS --import=...` **before child authority binding**, even
though parent preparation subsequently refused. Its runner was terminated and
observed before checking the marker. Seven further spawn-boundary negatives also
failed before the fix (`.local/goal-consumers/bootstrap-before.log`). Later SDK
readiness or tool hooks cannot retroactively contain this startup code.

The existing guarded launch admission now refuses nonempty `NODE_OPTIONS`,
`NODE_PATH`, `LD_*`, `DYLD_*`, `OPENSSL_CONF`, `OPENSSL_MODULES`, `OPENSSL_ENGINES`
and unowned `JITI_*` overrides **before spawn**. The existing host-owned
`JITI_ALIAS` peer map is still explicitly constructed/replaced, not accepted from
the caller. Empty values remain empty; unguarded startup configuration remains
unchanged. It does not silently strip user flags (which could weaken memory/TLS
configuration), parse a second trusted flag dialect, grant preload-file authority
or retry another runner. A guarded launch currently requires a clean host startup
environment; filesystem/host standing permissions cannot authorize these overrides.
Diagnostics name only the key, never its value.

Ten added regressions cover actual harmless preload prevention, seven unsupported
variable classes, unguarded preservation and empty/host-owned alias handling.
Full subagents **4,303 total / 4,286 pass / 17 skip / zero fail / 443 suites**,
concurrency4, and types pass. Fresh complete graph **384 inputs / 17 exports /
330 compiled / 18 module-URL targets / 768 artifacts**, artifact `0bdb7d1beead1157`;
four graph tests and all **14 combined-consumer cases** pass again. Evidence:
`.local/goal-consumers/bootstrap-{before,focused,full,composition}.log`.

This closes ambient preload inheritance in the actual detached spawn path, not
complete bootstrap/dependency/resource/provider provenance or the full actual-
consumer detached CLI pipeline. The earlier current215-test Node24 HTTP result
remains the Guardian-source gate (no Guardian source changed here). All remaining
#14/deployment/OS/Git/live-accounting/latency boundaries stay open. No live startup
environment/config/toggle/runtime was changed, and no install/restart/push occurred.

## Actual detached source and compiled CLI pipeline

The combined gate now runs the **actual `executeAsyncSingle` launch builder**, its
private config/startup commit, real Node bootstrap CLI/heavy execution entry,
existing host-created IPC/controller, default factory/resource loader, both actual
consumers and normal session/storage/drain/finalization. It does not pass the
launch-shaped input driver or inject a replacement child factory into these cases.
Four cases run from source and the same four from the copied **complete verified
compiled graph**: success, unavailable SRT backend, broken actual Guardian import
and terminal parent semantic denial. The compiled path uses its real JS bootstrap
and locked runtime dependencies, not a source overlay. SDK **1.2.0** is observed
inside the genuine credential-free faux provider, not assumed from package names.

Success writes exact Unicode content through the actual native tool; both real
roles are ready at both model calls. Startup negatives have zero model dispatch,
no task mutation/reviewer call/scratch leak. Terminal denial has one ready model
call, full exact denied content/directives, no mutation or later generation, and a
failed task status. All eight await actual process-terminal `observed` proof and
match its runner instance to persisted status; the private config is consumed.
If the controller initialized, final runtime reset and owned scratch disposal are
checked. The test deadline terminates/awaits only its own runner. Existing upstream
isolated-temp/HOME/test-environment setup prevents shared/live Pi inputs or global
artifact cleanup. No fixture claims/acks for either consumer: the faux provider
only captures the existing opaque lease during extension load and observes readiness
later (streaming intentionally does not retain ambient ALS scope).

**22/22 composition cases** and four graph identity tests pass, including the
previous14 source-composition cases. Full subagents remain **4,303 / 4,286 pass /
17 skip / zero fail**, types; graph remains artifact `0bdb7d1beead1157` (384 inputs,
17 exports,330 compiled,18 module-URL targets,768 files). Evidence:
`.local/goal-consumers/full-detached-{matrix,compiled,final,gate,root}.log`.
Initial probe failures were corrected readiness-observer fixture placement, not
an authority bypass or an invented alternative runner.

This closes the previously untested supported detached **source/compiled CLI**
composition. It does not prove live installed SDK1.4 composition, public parent SDK
tool-event dispatch, all bootstrap/executable/dependency/provider/auth/resource
provenance, actual virtual routing, selected-tool lifetime fidelity or every negative
matrix case. OS SRT, model provider, semantic verdict/usage and human answers remain
explicit doubles. Deployment/broker/actual OS/Git/paid-cost/latency acceptance and
#14's remaining source audit stay open; no install/restart/live policy/toggle/
protected-content/runtime replacement/push occurred.

## Guarded runtime selection cannot fall back to PATH

A spawn-boundary regression forced the current executable's access check to fail;
the old guarded path then attempted bare `node` from PATH. Existing guarded
admission now requires an absolute, usable **current Node executable**, and rejects
an uncompiled Bun host too (including one named `node`). No retry/alternate runtime,
public flag or unguarded resolver change. This fixes runtime selection, not an
inode/code/dependency pin or complete bootstrap provenance claim.

The pre-fix regression, both new negatives, full **4,305 unit / 4,288 pass /
17 skip / zero fail / 443 suites** (concurrency4), types, **22 composition**, four
graph tests and root checks pass. Graph384 inputs/17 exports/330 compiled/18 URLs/
768 files, artifact `f2e150f60f4d2368`. Evidence:
`.local/goal-consumers/executable-{before,full,composition,root}.log`.
No live runtime/config/policy/toggle change, install, restart or push.

## Real SDK virtual routes keep the selection virtual

Two new actual source/compiled detached cases failed before the repair: SDK1.2
keeps `session.model`/`agent.state.model` virtual, routing only an individual request.
The previous opaque fixture fabricated a physical agent-state switch, so its passing
result was not native virtual-route proof. That assumption is removed.

The existing generation fence now observes **the same SDK `resolveModel`**, forwards
its exact native result, composes cancellation and checks readiness/selection before
and after the asynchronous router. The result must match the native physical
catalogue; lookup identity is pinned. Later physical generation requires the exact
SDK-owned reference, its independent bounded metadata snapshot and matching current
catalogue data. Copied/unknown references, drift, cancellation and lookup replacement
refuse. Weak metadata observations preserve native cache-warmer reference reuse;
they are not approval decisions, scope grants or a fallback selector. Every action
still checks current lifetime/readiness/data. Native routing/provider/auth/stream
engines are not substituted, and cleanup auth remains usable after guard closure.

The two actual cases now record real `user` then `continuation` route callbacks,
selected virtual ID and prior physical response; actual provider callbacks see only
`trusted/model`/`fixture-faux`, both consumer roles ready, exact native Unicode write,
full parent directive/input, observed CLI process close/reset/no scratch leak.
**24 composition + four graph** tests pass. Seven added unit cases and corrected
fixture cover same-reference native reuse, invented/copied references, pre-readiness
routing, asynchronous cancel, nested/endpoint drift, catalogue data/replacement and
lookup identity. Full **4,310 / 4,293 pass / 17 skip / zero fail /443 suites** and types
pass. Graph384 inputs/17 exports/330 compiled/18 URLs/768 files, source
`a99282fe3ff5c9fb`, artifact `ab5e595679b5ef7e`. Evidence:
`.local/goal-consumers/virtual-{before,focused,full,composition,root}.log`.

This is actual SDK1.2 routing composition, not SDK1.4/live provider, effective-auth
endpoint overrides, provider-code/dependency integrity or native cache-warming
integration certification. Those remaining provenance/acceptance gates stay open;
no live install/restart/config/policy/toggle/protected-content/runtime change or push.

## Full source matrix on the genuine installed SDK1.4

The same **24 cases pass on genuine SDK1.4.0 and its own peers**, not just the
previous narrow readiness probe. This includes both actual consumer entries,
source/compiled complete detached CLI pipelines, native IO/Bash/output, virtual
routing, startup refusals, semantic termination, mechanical/host/network decisions,
cancellation and drain. Native provider callbacks assert the real SDK's VERSION;
root tests derive the expected version from the selected package manifest.

Reuse the existing opt-in native peer loader and resolver rather than install,
upgrade, inject a fake SDK or add a production SDK override. The default remains
the locked SDK1.2.0; the test-only launch-shaped runner now receives the synthetic
layout's exact SDK path and imports its matching pi-ai peer. Missing peers fail;
there is no different-runtime/provider fallback. The ordinary detached cases still
use the real factory/host-constructed runner aliases. Both24-case runs have zero
failures/skips. Evidence `.local/goal-consumers/native-matrix-sdk{12,14}.log`.

Reproduce after `just build-subagents`, selecting an already provisioned read-only
SDK package directory (not its CLI executable):

```sh
PI_SUBAGENTS_NATIVE_PI_ROOT=/absolute/pi-coding-agent-package \
  node --import ./forks/pi-subagents/test/support/isolated-temp-root.mjs \
  --import ./forks/pi-subagents/test/support/native-peer-loader.mjs \
  --test scripts/child-composition.test.mjs
```

Only synthetic HOME/agent/settings/model/session files and task-owned artifacts
are used. This is source/API compatibility evidence with real SDK1.4, **not a live
installation or OS/provider/reviewer/human/billing test**. The backend/verdict/usage/
human/provider doubles stay explicit; trusted executable/dependency/provider-code/
effective-auth/resource provenance and remaining public-parent/tool-lifetime gates
remain under audit. Source units/types unchanged at4,310/4,293 pass/17 skip; build
source/artifact still `a99282fe3ff5c9fb`/`ab5e595679b5ef7e`. No install/restart/live
config/policy/toggle/protected-content/runtime replacement or push.

## Selected-tool data/code must survive startup and async boundaries

Two actual combined SDK regressions were red: changing a native schema during
`before_agent_start` completed successfully; replacing native Read after startup
allowed one model request before operation ownership caught it. The existing
model-generation fence now pins the SDK's public tool APIs, complete declaration/
source data, definition identities/code references and selected active/callable
ceilings before extension startup. It checks them at generation, async callback,
iteration/result and native-routing boundaries. Later narrowing remains allowed;
new names, replacement, schema/source/code drift, missing APIs, accessor/proxy data
and malformed/unbounded selections refuse and close the same lease. No new role,
ack, API/protocol, registry, permission decision/store or substitute tool engine.

Owned snapshots retain real TypeBox symbol/code identities instead of JSON loss,
without invoking getters/proxies/functions. Limits are256 tools,16,384 aggregate
nodes,512KiB text and depth12; selection lists use existing stricter data bounds.
Model metadata stays data-only. SDK definitions remain mutable as upstream defines;
mutation is detected rather than freezing/replacing its state/schema machinery.

Both negatives now reach their marked post-startup attempt and have **zero model
calls, no command/native mutation/reviewer request or scratch leak** on SDK1.2 AND
SDK1.4. Existing operation-level source ownership remains independently enforced.
Eleven new unit cases cover identity/schema/lookup/selection/code drift, narrower
loadouts, accessor/proxy non-invocation, malformed selections and async hooks.
Two startup mocks now supply the real public empty-tool APIs so their original
startup/model-switch failure and disposal assertions still execute.

Verification: **4,321 total /4,304 pass/17 skip/zero fail/443 suites**, types;
**26/26 composition cases on EACH SDK1.2.0 and1.4.0**, four graph tests and root
checks. Graph384 inputs/17 exports/330 compiled/18 URLs/768 files, source
`c6b40d5f7e4cb132`, artifact `4b73c50b862cbb40`. Evidence:
`.local/goal-consumers/tool-fidelity-{before,focused,full,composition,sdk14,root}.log`.
Synthetic iteration-only fixture (seven actual SDK native-tool declarations,1000
async events, four samples) measured **189.7–266.9ms guarded vs0.16–0.38ms bare**;
this full per-event check is not a latency improvement or paid/live measurement.
Evidence `tool-fidelity-bench.{mjs,log}` in the same directory. No native file tool,
model provider, SRT or paid call executes in that benchmark. Representative total
cost/latency remains #24/#25's separate live acceptance requirement.

This strengthened selected-tool lifetime fidelity. The follow-up below covers
public-parent dispatch and SDK-native startup registration; executable/dependency/
provider/effective-auth/resource/deployed/OS/Git/live-cost gates remain open.

## Actual public parent SDK dispatch and startup discovery

Two tests now invoke the **actual parent SDK's `subagent` tool**, rather than
calling `executeAsyncSingle` directly. Both real parent pi-sbx/Guardian entries
load alongside the complete built subagents bundle. The parent pi-sbx entry owns
publication, baseline policy and required-extension registration: this test creates
no provider/registration/claim/ack. Normal public dispatch reaches the compiled
Node bootstrap, actual child SDK, both actual child consumers and registered parent
Guardian. Parent/child controller initialization records distinct actual PIDs.
Synthetic native Unicode Write completes; observed process finalization, session,
launch digest and parent tool-call identity agree; runtime/scratch cleanup occurs.
The actual parent SDK branch retains its reviewed cursor, carries the exact actual
user directive, and projects two Guardian review calls (parent delegation + child
tool), not an extra review for held mechanical admission. Accounting amounts and
reviewer verdicts are fixtures, not paid evidence.

This exposed a genuine startup conflict: the existing native supervisor helper
registers during `session_start`, after the initial definition snapshot. Moving
registration earlier is **not** the repair: the SDK cannot yet reliably enumerate
other extensions' pending tools, so a pre-existing trusted supervisor declaration
then conflicts. Tests cover both absent and pre-existing supervisor tools.

Instead, the same generation guard has a **single internal startup seal**, called
by the existing factory after extension binding and native MCP readiness, before
returning a promptable child. No generation/classification/image/native route may
run before that seal, **even after both consumers acknowledge**. Existing tool
API/definition/schema/source/code identities remain pinned during startup, and
pre-existing active/callable selections cannot widen. SDK-owned discovery may add
tools; the final bounded snapshot/ceilings then remain immutable except narrowing.
A seal cannot repeat, adopt drift, or complete after cancellation/revocation. This
is lifecycle/data provenance, not another role acknowledgement, permission decision,
registry, approval transport, resource loader, tool implementation or provider.
Upstream supervisor registration stays in its supported phase.

A real SDK negative observes both actual consumer acknowledgements, then attempts
startup generation: zero provider calls, exact startup refusal recorded before
lifetime teardown, no review/mutation/scratch leak. Existing post-startup schema/
owner negatives still dispatch zero calls. Fifteen additional unit cases cover
startup dispatch, additions, immutable existing definitions/APIs/selections,
narrowing, one-shot seal and revocation.

Fresh verification: **4,336 total /4,319 pass /17 skip /zero fail /443 suites**;
types; **29/29 composition on each genuine SDK1.2.0 and1.4.0**, zero skips/failures;
four graph tests. Source `70c8dc45739f2f51`, artifact `02d417062d9ace54`, unchanged
graph counts384/17/330/18/768. Evidence `.local/goal-consumers/public-parent-final-
{full,composition,sdk14}.log`; earlier diagnostic logs retain the late-registration
and duplicate-registration failures. Fixture installation now includes real Guardian
prompt assets and real shipped SRT schema/matcher helpers; only OS backend/violation
telemetry, provider, reviewer/usage and human channels are explicit doubles. The
public tasks explicitly use `async:true, acceptance:false` and seven native tools;
this does not prove default acceptance/control-tool workflows or actual OS isolation.
No live install/restart/policy/config/toggle/protected-content/runtime replacement,
paid-provider operation or push occurred. Production-consumer acceptance remains
false; remaining provenance, default/control workflows, lifecycle, deployment,
loaded-broker, OS/Git and live accounting/total-latency gates remain open.

## Lease-bound structured output is not model filesystem authority

The public-parent follow-up now also covers default lightweight acceptance and
`outputSchema`. Default acceptance works, but the real typed-output task previously
failed: pi-sbx rejected `structured_output` as an unknown native tool, so no required
output was captured. Its inline `sourceInfo` label is not proof of ownership.

The actual structured-output producer now marks its exact function with its current
opaque lease reference. After startup, the existing generation fence binds a
non-replaceable inspector on that same lease. The ONE public child-authority API's
`isChildRuntimeControlTool` checks the current actual SDK definition, pinned tool/
model data, exact producer function/lease identity and lifetime. pi-sbx requires
this current API and uses the inspection only for this no-path control operation;
unknown/foreign implementations still refuse. Neither names, inline labels, matching
lease-ID strings nor serialized metadata can replace these references. This is
code provenance, not another reviewer/broker/registry/permission store, wire role,
acknowledgement or filesystem/host/maintenance grant. Arbitrary privileged host
code is outside this boundary, as with the existing host-injected provider API.

Capture rechecks identity, revocation and SDK caller cancellation before/after
asynchronous schema validation and immediately around the existing SDK-owned capture
callback. The value is data; it cannot select a file destination. Native terminal
results and the original schema/validation/capture implementation remain intact.
Metadata-only producers capture the current live scope without assuming Node's
process cwd equals the SDK task cwd; SDK/runner and enforcement-consumer cwd checks
remain exact. The checker cannot be rebound to adopt a second SDK session, nor can
an existing producer function be retargeted to another lease.

Actual public parent/compiled-child tests now show default lightweight acceptance,
validated typed capture and termination, and parent semantic denial preventing
capture despite valid producer provenance. Actual SDK parent accounting is three
reviews for delegation + native Write + structured output, not another mechanical
review; cursor continuity, exact directives, distinct controller PIDs, observed
termination and scratch cleanup remain proven. This is not independent writer
review/verified-command acceptance or generic control/MCP support. Contact-supervisor,
wait and other unfenced tools remain unsupported rather than gaining a name bypass.
Seven unit cases cover foreign code/lease, immutable binding, exact definition,
validation, async revocation/cancellation and replacement before capture. The bridge
also rejects a current-version package missing the required inspection API.

Fresh gates: **4,343 total /4,326 pass /17 skip /zero fail /443 suites**, types;
**430 pi-sbx tests /30 files**, types; **32/32 composition on SDK1.2 and1.4**, no
skips/failures; four graph tests. Source `b62b504e34add416`, artifact
`dfa62bc52350e223`, unchanged384/17/330/18/768 graph. Evidence:
`.local/goal-consumers/public-control-{before,source,focused,full,sbx,composition,sdk14}.log`.
The older pi-sbx synthetic launcher fixture now explicitly owns/restores a clean
`NODE_PATH` environment (pnpm's Vitest shim sets it); production override refusal
is unchanged and its negative tests remain. No live deployment/restart/config/
policy/toggle/protected-content/runtime replacement, paid-provider operation or
push. Remaining lifecycle/resource/executable/dependency/provider/effective-auth,
deployment/loaded-broker/OS/Git/live accounting/total-latency gates stay open.

## Startup cannot return a session from a disposed factory epoch

A controlled SDK-startup regression found that disposing the factory while
`bindExtensions` awaited still allowed `create` to return a promptable child after
startup resumed. Before the startup seal/return, recheck the existing disposal
epoch and caller signal; run normal session shutdown and reject stale/cancelled
creation. Two controlled SDK fixtures prove exactly-once cleanup/no returned child.
Guarded caller cancellation already refused at the seal; the explicit factory
check also covers the unguarded factory lifecycle. No new runner/timeout/registry.
This does not claim that factory disposal interrupts or awaits a non-cooperative
in-flight extension initializer; owned native-process termination remains separate.

Fresh **4,345 total /4,328 pass /17 skip /zero fail /443 suites**, types;32/32 on
each genuine SDK1.2/1.4, four graph tests. Full units passed with concurrency1;
earlier concurrent runs hit the existing500ms npm PID-marker scheduling race and
an unrelated viewer fixture's early JSON read. Both files passed in isolation; no
tests/timeouts were weakened. Source `cfd3726816ece325`, artifact `bfceb9573fdad484`,
graph384/17/330/18/768. Evidence `.local/goal-consumers/startup-disposal-{before,
full,npm-isolated,orca-isolated,composition,sdk14}.log`. Remaining gates and no-live-
deployment/approval/billing boundaries are unchanged.

## Child path grants cannot maintain their own runtime code namespace

The compiler protected the SDK package but not an externally installed SDK's peer
namespace or the current Node executable. Three valid anchored-policy regressions
showed write exceptions were feasible for those paths. Add spelled/canonical Node
executable and package paths plus the owning outermost `node_modules` namespace to
local mandatory write denies. This covers sibling/lazy dependencies and nested pnpm
stores rather than just the selected SDK directory. Existing enforcement-package/
agent protection and credential read rules remain; public code stays readable.
File/scoped/sandboxed-Bash policy cannot lend those paths through semantic or human
path admission. Explicit human host execution is still not a filesystem jail.

Four policy-layout tests (external SDK metadata only; genuine schema/backend)
exercise Node, peer, future dependency and pnpm sibling paths. **434 pi-sbx tests /
30 files**, types;32/32 actual composition per genuine SDK1.2/1.4 and4graph tests
pass. Third-fork source/artifact remains `cfd3726816ece325`/`bfceb9573fdad484`.
Evidence `.local/goal-consumers/code-namespace-{before,sbx,composition,sdk14}.log`.
No dependency/manifests/builders/runtime selection were changed or installed.
A child cannot update its own running toolchain's dependency namespace; that is
parent/operator maintenance outside the child's scope. These are path-policy
negative proofs, not certification of all lazy code/content, hardlink/OS aliasing,
arbitrary trusted host changes or effective provider/auth provenance. Remaining
acceptance and no-live-deployment/approval/billing boundaries stay open.

## Live SDK provider objects could bypass the registry lock

Two actual SDK composition regressions changed the public concrete provider's
`streamSimple` or `auth.apiKey.resolve` during `before_agent_start`; both tasks still
completed successfully before the fix. Locking register/refresh APIs and model
metadata did not pin those live SDK-exposed objects.

The existing generation guard now snapshots the actual public `getProviders`
catalogue at exact model resolution and pins `getProvider`/`getProviders`/`getAuth`
API identities. It retains independent bounded provider data and owned function/
symbol identities, not reusable permission decisions. At each existing generation,
callback, iteration/result and structured-control check, inspect only the selected
concrete provider against that initial reference/data. A native virtual route must
also match an initially pinned provider before its reference is observed. Startup
catalogue limits:256 providers/16384 nodes/512KiB total;1024 nodes/64KiB per provider.
Unknown/missing/replaced/malformed/proxy/accessor/oversized data or failed lookup
revokes the same lease without logging auth values or invoking metadata accessors.
No provider/transport/registry replacement, new public API, role, wire field or ack.

The optional public `cancelDeferred` operation now uses the same live lease/model/
provider fences; it is not a cleanup-name exemption for arbitrary remote actions.
Ordinary SDK `getAuth` remains usable after close for owned cleanup. Async callback
and non-stream promise checks run in `finally`, including rejected hooks/results;
unchanged failures retain their original error. No fresh permission is inferred.
This does not certify ownership of arbitrary deferred handles or remote billing.

**4,366 total /4,349 pass /17 skip /zero fail /443 suites**, types.21 added unit
cases plus faithful existing mock API updates. **35/35 on each genuine SDK1.2/1.4**,
zero fail/skip;4graph tests. Actual composition additionally proves an asynchronous
`before_provider_headers` mutation refuses before the captured replacement runs:
zero faux provider calls, file mutation, semantic review or scratch leak in these
negatives. Public-parent/default-acceptance/structured capture/denial, exact cursor/
directive/accounting and actual process termination cases remain green. The flaky
npm PID-marker prerequisite now observes/awaits the real ChildProcess using public
Node diagnostics, no substituted backend or weakened timeout (commit6680c75).

Same-input five-sample guard microbenchmark:1000 synthetic stream events/seven real
SDK native definitions/one real faux provider metadata object, no provider/auth
operation. Baseline186.3–203.0ms versus current191.3–210.2ms; mean increment~4.7µs/
event (~2.5%). Setup~0.37–1.72ms versus~0.38–1.18ms. This bounds only that fixture,
not representative provider latency, live spending, large catalogues or savings.
Source `022b2c6f444686d2`, artifact `d3f7ab3618b3946a`, graph384/17/330/18/768.
Evidence `.local/goal-consumers/provider-fidelity-{before,focused,composition,sdk14,
full,npm-observation,bench,root}.log`, `provider-fidelity-bench.mjs` and historical
`provider-baseline.ts` in that same directory.

These checks pin SDK-exposed provider objects/API code, not every private closure,
underlying provider/global API registry, auth-resolved endpoint/header/environment
value, asynchronous transport handoff or actual network operation. Those resource/
effective-auth/code provenance audits remain open alongside deployment/loaded broker/
OS/Git/live accounting/total latency. No installed config/policy/toggle/session,
protected credential/audit content, runtime replacement, paid provider or push action.

## Provider snapshots alone left an asynchronous code-swap handoff

A continuation probe against the genuine SDK found the missing boundary: schedule
`streamSimple` replacement four microtasks after `before_provider_headers`. The
replacement **ran**, the faux provider recorded1 invocation and readiness observer0
before eventual authority revocation. Thus callback-exit/result checks alone were
not evidence that the earlier pinned code actually served the handoff. Exact red
output: `.local/goal-consumers/provider-handoff-before.log` (`delay:4`,
`replacementRan:true`, `calls:1`, `ready:[]`).

After complete bounded/accessor-free catalogue validation, make the existing public
provider data graphs immutable and install the **same original function values**
as nonreplaceable own `getProvider`/`getProviders`/`getAuth` properties. Provider,
auth and header data fields cannot change between checks or native dispatch.
No provider/transport/function-value substitution, method wrapper, schema freeze,
new API, registry, approval store, role, protocol or lease. At that milestone,
function objects, tool/model definitions, private implementation closure state and
native SDK auth results were not frozen or rewritten (the next section changes
model DATA immutability only). A failed attempt that leaves the original authority
unchanged need not revoke it: native code can continue if the caller catches that
TypeError. Uncaught SDK hook failures still follow normal guarded shutdown. Only
the fresh supported guarded runtime is bound this way; it cannot rebind after close.

Actual delayed4/8-microtask tests record the TypeError, **no replacement invocation**,
and successful use of the unchanged original provider (2 calls, both roles ready),
normal assigned Write/parent review, observed shutdown/reset and no scratch leak.
They do not report successful mutation as a successful refusal. Existing immediate
mutation tests still fail closed before a provider call. Revised opaque fixtures
prove prevented mutations/native values retained, and still test real owner changes,
lookup failures/rejected callbacks/late results;3 added units cover exact native/API
identities and pre-freeze accessor/proxy refusal without traps.

**4,369 total /4,352 pass /17 skip /zero fail /443 suites**, types, **37/37 per
genuine SDK1.2/1.4**, zero composition fail/skip;4graph/root gates. Source
`8877dd166fad256e`, artifact `c8eb7e56a8ae0f5a`, graph384/17/330/18/768. Same-input
five-sample synthetic benchmark vs the pre-provider-pin guard:1000 events/seven real
native definitions/one real faux metadata object,193.7–208.3ms baseline versus
198.8–216.1ms current (mean increment~6.1µs/event/~3.0%); setup~0.38–1.79ms versus
~0.41–1.37ms. This includes the previous provider pinning, not an isolated freeze
cost, real dispatch, large catalogue or representative paid latency/savings.
Evidence `.local/goal-consumers/provider-handoff-{before,focused,after,composition,
sdk14,full,bench,root}.log`; the earlier same-input benchmark script/baseline remain.

This closes that public code/data swap, not mutable raw model/request data, private
provider/global API implementations, auth-resolved endpoint/header/env provenance,
all transport handoffs/network effects or hostile host code. Those source audits,
production acceptance and deployed/broker/OS/Git/paid accounting/total latency gates
remain open. No live install/restart/session/policy/config/toggle, credential/audit
content, runtime replacement, paid provider or push action.

## Raw selected/routed model data could change after the header fence

The next genuine-SDK probe delayed `ctx.model.baseUrl` mutation four microtasks
after headers. A passive input observer delegating to the same native faux backend
recorded **`https://changed.invalid`** (calls1/readiness0), before its queued
`onResponse` check revoked authority. No real HTTP was sent; this proves the changed
endpoint reached the actual SDK-selected test backend, not a live network effect.
Its earlier response-factory observer alone could not see the input: the guard
rejected the queued onResponse before that factory ran. Preserve that distinction.
Exact red output `.local/goal-consumers/model-handoff-before.log`.

Make only admitted bounded/accessor-free model data immutable, retaining original
objects and aliases: initial exact selection, a validated equivalent session/request
copy, and each native physical reference **after** catalogue validation. Same
validated references are captured once for pinning/route tracking; a later getter
result cannot enter the unvalidated freeze traversal. A private WeakSet skips repeat
freezing, never readiness/provenance/cancellation checks; it is not a permission
cache. Generalise the already validated provider-data freezer, not an engine,
router or schema. Native SDK objects/functions/transport/definitions are not
replaced, tool schemas/function objects are not frozen, and derived auth results
remain untouched. A caught unsuccessful assignment preserves unchanged authority;
uncaught SDK hook errors still close the normal lifetime.

Delayed4/8 cases now prove TypeError, exact original endpoint at the native backend,
2calls with both roles ready, assigned Write, reset and scratch cleanup. Normal
source/compiled/public-parent/default acceptance/structured output and virtual
routing continue passing. Opaque fixtures retain model identity/nested aliases/
non-enumerable fields and prove equivalent-copy admission, physical-reference reuse,
invalid-copy/session selection/catalogue drift refusal, late selection change and
metadata accessor refusal.4added units explicitly cover prestartup data-only freeze,
single validated getter/route references and equivalent session copies. This is
not certification of an actual native cache-warmer transport (reference reuse is a
narrower unit proof).

**4,373 total /4,356 pass /17 skip /zero fail /443 suites**, types;
**39/39 per genuine SDK1.2/1.4**, zero composition fail/skip;4graph/root/freshness.
Source `df8360feed30a16f`, artifact `52fbadba145d6190`, graph384/17/330/18/768.
Five-sample1000-event/seven-native-definition/one-faux-metadata synthetic benchmark
vs the pre-provider-pin guard:191.0–201.0ms baseline/196.7–199.2ms current, mean
+2.6µs/event (~1.3%); setup~0.37–1.76ms/~0.41–1.27ms. Not an isolated model-freeze
measurement or representative dispatch/catalogue/paid latency/savings. Evidence
`.local/goal-consumers/model-handoff-{before,focused,composition,sdk14,full,bench,
root}.log` and committed regressions.

At that milestone, remaining audits included physical catalogue data before its
first route admission (addressed below), SDK auth-resolved baseURL/header/env values
and mutable prepared requests, private
provider/base/global API and loaded code/resource/dependency ownership, complete
initialiser drain and actual cache warming. No aggregate transport/consumer
production acceptance or deployed/broker/OS/Git/paid-cost/total-latency claim.
No live install/restart/session/config/policy/toggle/credential/audit-content/runtime
replacement/paid-provider/push action.

## A first virtual route adopted catalogue data changed after startup

A genuine SDK regression changed `ctx.modelRegistry.getAll()`'s physical candidate
in `before_agent_start`, while the selected virtual DTO remained unchanged. The
native resolver and current catalogue agreed on the **already changed** endpoint,
so both checks passed:2ready native faux calls used `https://changed.invalid`,
exitCode0 and the native Write completed. The initial chat catalogue count was1556.
Exact red: `.local/goal-consumers/catalogue-before.log`. No paid/native HTTP claim.

For **virtual selections only**, capture the SDK's public `getAllModels()` data
once at exact model resolution. Bounds:8192 entries,524288 aggregate nodes/8MiB
key+string bytes, existing per-model1024nodes/64KiB/depth12 bounds. Read own data
slots (not iterators/getters); reject proxy/sparse/accessor/unknown-kind/duplicate/
unbounded or unavailable catalogues, never truncate/fallback. Key snapshots by
provider/ID/kind so chat and image/classifier IDs cannot alias. Retain the same
native `getAllModels` function as a nonreplaceable own property. First and later
native route outputs must match the initial data **and** current native physical
catalogue, plus all existing provider/readiness/signal checks before admission.

These are private provenance snapshots, not a second model registry, selector,
engine, SDK, role, API, permission store or allow cache. Native routing/auth remain
responsible for selection and eligibility. Unselected candidate objects are not
frozen; a mutation refuses at route admission, before dispatch. No catalogue scan
per stream event and no catalogue work for plain model selections. Current code
does not infer permission for auxiliary classifier/image model calls from catalogue
membership. Native router classifier calls and actual cache-warmer integration still
need explicit acceptance/refusal verification; normal native physical route/reuse
proof must not stand in for those paths.

Regression now has0backend calls/no Write/failed task/normal reset+cleanup.16added
opaque tests cover api/URL/headers/future data before first use, async mutation,
new identities, distinct model kinds, missing/proxy/accessor/sparse/duplicate/count/
aggregate-byte/node refusals without traps. Both source/compiled native virtual
positive paths still use the original SDK engine and reference semantics.
**4,389 total /4,372 pass /17 skip /zero fail /443 suites**, types,
**40/40 per genuine SDK1.2/1.4**, zero composition fail/skip;4graph/root/freshness.
Source `bc552639d8d519a7`, artifact `bc846e76faa123c8`, graph384/17/330/18/768.

Five constructor-only samples on native SDK catalogues, no network/config refresh,
session, auth or model requests, synthetic non-requesting virtual DTO and injectable
credentials whose every method throws: SDK1.2/1649models baseline0.51–1.38ms versus
current16.32–20.36ms; SDK1.4/1713models baseline0.49–1.40ms/current16.34–22.63ms.
The baseline is exactly the preceding `af8802f` guard. This measures extra startup
work, not a permission/SDK routing proof, memory peak, production/paid cost or total
latency. Evidence `.local/goal-consumers/catalogue-{before,focused,after,composition,
sdk14,full,root,bench-sdk12,bench-sdk14}.log`, local benchmark source/baseline and
committed regressions.

Prepared auth/request values, raw registered provider/config/global API sources,
loaded resource/code/dependency provenance, initializer drain, deployment/broker/
OS/Git/paid accounting and total cost/latency gates remain open. No production
acceptance or live install/restart/session/config/policy/toggle/protected-content/
runtime replacement/paid-provider/push action.

## Public registered sources bypassed immutable composed providers

Two genuine SDK red cases: (1) a native provider under a synthetic `models.json`
overlay, mutating `getRegisteredNativeProvider().streamSimple`; (2) a legacy
registration, mutating `getRegisteredProviderConfig().streamSimple`. Both replaced
code, reached2ready native faux calls, exit0 and completed the Write. Pinning the
composed provider left these public source objects mutable behind its unchanged
composer closure. Exact red `.local/goal-consumers/registered-source-before.log`.
Without an overlay the native provider is the public provider itself and was already
frozen; a second registration is not an overlay (SDK registration deletes the other
registration kind). The test now uses real synthetic models.json composition,
not an impossible simultaneous native/legacy registration.

Extend the existing provider pins to three SDK lookups: composed, registered-native,
registered-config. Snapshot/validate all before freezing, including exact undefined
slots; require public lookup/list agreement. Each source1024nodes/64KiB/depth12,
all source graphs16384nodes/512KiB, existing256provider cap. Reject unavailable APIs,
malformed/accessor/proxy/oversized sources; never ignore one or truncate. Freeze
existing data graphs, retain exact original callable values/SDK objects, and seal
the same getter functions as nonreplaceable own methods. No new registry, router,
provider/transport wrapper, SDK, role/API/wire, context or permission store.

On each action/callback/event, read the three current source references and compare
them, including absence. All captured own data is deeply immutable: this removes
the redundant public-provider snapshot and avoids rescanning large source configs
per SSE event. Exact reference checks, model/tool/lease/readiness/cancellation checks
remain; a lookup failure revokes without printing its details. This does not certify
function properties/implementation closure state or the underlying global API table.
Native auth/credential refresh and cleanup keep their original implementations.

Immediate native/config mutation cases now fail with0backend/semantic calls/no
Write/scratch leak. Both registered sources also have caught4-microtask header
mutation cases: TypeError/no replacement/unchanged native code completes2readycalls,
Write/reset/cleanup.12added opaque units cover immutable sources/native identities,
owner replacement, absent-slot appearance, missing APIs,4bad data shapes and private
lookup-error containment. Two initial fixtures incorrectly resealed an already-bound
lease; corrected them to unsealed fixtures, not a rebind exception.
**4,401 total /4,384 pass /17 skip /zero fail /443 suites**, types,
**44/44 per genuine SDK1.2/1.4**, zero composition fail/skip;4graph/root/freshness.
Source `154dd6afda95173e`, artifact `5700b701be2a3ea3`, graph384/17/330/18/768.
Five-sample1000-event/seven-real-tool/one-real-faux-metadata same-input synthetic
benchmark against the exact preceding1e61c82guard: baseline195.4–205.5ms versus
current189.6–197.4ms (mean~6.9µs/event/~3.5% lower); setup0.40–1.90ms/0.43–1.40ms.
Not representative paid latency/savings, large config/candidate memory or transport.
Evidence `.local/goal-consumers/registered-source-{before,focused,after,composition,
sdk14,full,bench,root}.log`, local same-input benchmark/baseline and committed tests.

Prepared auth/request data and private models.json/global API/closure sources,
code/resource/executable provenance, initializer/cache-warmer/router-classifier
acceptance, live deployment/broker/OS/Git/accounting/total latency remain open.
No aggregate production acceptance or live install/restart/session/config/policy/
toggle/protected-content/runtime replacement/paid-provider/push action.

## Completed header hooks leaked retained aliases into native dispatch

Genuine SDK source trace: `prepareRequest` awaits `getAuth`, merges headers, awaits
`transformHeaders` and passes that same map to the provider. Native extension
`before_provider_headers` mutates it in place; handler return values are ignored.
A retained hook alias changed four microtasks later: both ready backend calls
received synthetic `x-fixture:"changed"` instead of the completed `"original"`.
Delay8 already had the original value at backend entry, but retained the same alias
for later consumer use. Red `.local/goal-consumers/header-handoff-before.log`.
Only a literal synthetic header was observed, never auth keys or arbitrary headers;
this is not an HTTP/billing/complete effective-auth provenance proof.

At the existing public callback boundary, retain all pre/finally checks and then
transfer an independent bounded header record. Validate the completed result as
accessor/proxy/code-free own string/null header data (1024nodes/64KiB/depth12);
reject invalid data without printing values. Preserve null prototype, values/order
and enumerable flags: the generic metadata comparison snapshot normalizes flags,
so returning it unchanged would introduce previously non-enumerable HTTP fields.
Copy the original flags before transfer. No header naming/coercion/merge algorithm,
new callback/service/registry/permission/transport/SDK or model/provider substitution.

Do **not** freeze the producer's reusable signing/header map or the native SDK's
request copy. The producer can mutate/reuse its original map; those later writes
cannot change earlier native request copies. This is per-request data ownership,
not an approval cache. Mutations awaited inside the hook remain supported, and
native errors retain the original exception when lifetime/provenance are current.
Auth/env resolution, caller option ownership, private global/config code and actual
HTTP backend behaviour remain separate audits, not inferred from this map copy.

Actual delay4/8 cases now prove the producer really changed its retained map
without TypeError, backend snapshots stay original,2readycalls/assignedWrite/reset/
cleanup.13added opaque units cover independent/reusable maps, native copy ownership,
async in-hook writes/default hook, null/non-enumerable semantics and8bad shapes
without getters/proxy/function invocation or raw-value error text. Native callback
error/cancellation/provenance failure tests remain intact.
**4,414 total /4,397 pass /17 skip /zero fail /443 suites**, types,
**46/46 per genuine SDK1.2/1.4**, zero composition fail/skip;4graph/root/freshness.
Source `97e4ca14c29ece50`, artifact `f9440553581aecfd`, graph384/17/330/18/768.
Five synthetic same-input samples vs exact preceding897b3d5guard:1000completed
header callbacks/seven real tool schemas/one real faux provider metadata/three
synthetic header fields, baseline373.3–390.6ms/current380.4–396.9ms (mean+3.9µs per
callback/~1.0%); setup0.42–2.01ms/0.42–1.39ms. This path runs per header hook, not per
SSE event. No auth/provider dispatch, HTTP, paid savings or representative total
latency is measured. Evidence `.local/goal-consumers/header-handoff-{before,focused,
after,composition,sdk14,full,bench,root}.log`, local exact baseline/benchmark and
committed regressions.

Aggregate source/deployed consumer acceptance stays false. Initializer/cache-warmer/
auxiliary router/deferred lifecycle, declared code/resource/executable ownership,
prepared auth/env/options, deployment/broker/OS/Git/paid costs/total latency gates
remain open. No live install/restart/session/config/policy/toggle/protected-content/
runtime replacement/paid-provider/push action.

## Source-proven gaps at the initial baseline

1. Real pi-sbx/Guardian extensions do not claim/acknowledge the live lease, so the
   current runner must refuse the first model prompt. Do not add an acknowledgment
   to the ordinary root startup: that would retain ambient maintenance/config and
   a second local Guardian broker rather than consume delegated authority.
2. The existing IPC action can carry only read/write/network/command targets
   (2KiB target, 512B reason). It cannot convey an **exact full Guardian tool
   action**, including write/edit content, unknown extension/MCP inputs and nested
   parent-call arguments. Passing only a path, tool name, hash or prose would
   silently remove semantic review. This requires a deliberate versioned extension
   of the **same** host-created IPC API, not another transport/permission store.
3. The staged policy's network/command fields name only parent-decision routing.
   They do not project configured static network denials, credential-environment
   handling or a prepared host-disabled ceiling into the child SRT. Root-global
   settings must not be reloaded as a substitute, nor can fresh child config mint
   grants. Resolve this projection explicitly before a production consumer acks.

## Binding architectural decisions (protocol phase above; consumers remaining)

Use one updated protocol/provider version, with fail-closed version mismatch;
no parallel v1/v2 approval path. Keep the **existing provider Symbol key** so old
launchers still observe guard intent rather than treating a new key as bare mode.
The process-wide ALS registry identity/claim/ack mechanism remains the accepted
one, shared across the complete bundle/compiled graph. Do not change upstream
builder, dependencies or the host-created IPC trust boundary.

Extend the existing action union with a `tool` action whose target is serialized
exact `GuardianAction` JSON. Tool targets need the existing 64,000-character
Guardian action ceiling (bounded UTF-8 transport envelope, not the 2KiB hostname/
path target cap); keep ordinary action and **policy** payload bounds separate.
Strictly validate shape, identity, size/depth and nested argument evidence. Model
fields cannot choose the active parent, cwd, reviewer or lease audience. Unknown
versions/oversized actions fail before execution; never truncate safety evidence.

The parent provider routes tool actions into the **existing Guardian broker's
host-only service**, adding a tool-review method rather than publishing another
permission service. That method reuses fixed-rule/semantic assessment, full parent
user provenance, stale-evidence validation, durable writer queue and accounting.
Rules anchor to the actual parent policy; child relative file inputs resolve in
its host-bound cwd. Retain exact original inputs/cwd in semantic evidence. Known
child own-policy/credential/audit restrictions remain final through the sandbox
consumer, even if the parent's maintenance rule semantically allows an action.
A tool-review verdict alone grants no filesystem/host exception.

Keep the ordinary layering: Guardian reviews exact tool semantics; pi-sbx enforces
native paths and Bash OS scope. Outside-scope path admission uses the existing
common authorizer and actual **parent** human UI. Do not introduce a cross-hook
approval cache or charge/ask the human twice for the same path decision. Root
maintenance may be used only by the real parent in an action-local decision;
no child global-maintenance matching, child project trust or root publication.
Host command eligibility and held/disabled ceilings remain final. Explicit host
execution is full-host authority, not a child filesystem jail; its child-scope
human-admission rule must be fixed and tested before enabling that path.

Project a minimal, versioned runtime policy from the parent's **baseline**:
original-cwd anchored read rules/carve-outs and write exclusions; admitted workspace
and verified Git roots only; separately host-created child scratch; credential
file locks and environment-name denials (no values); explicit static network
allows/denies and narrow supported runtime features. Configured denials in prepared
and current policy cannot be overridden. Reuse SRT's shipped domain-pattern /
host-canonicalization helpers rather than inventing a second hostname matcher;
missing/incompatible helpers must refuse, not relax. Socket namespaces and any
weaker-isolation/interprocess features need explicit narrowing, not copying broad
parent temp/maintenance capability. No unsupported option may silently weaken the
child. The old v1 payload in the #22 handoff is historical once this amendment is
implemented; document the actual new schema before consumer acceptance. Keep
`anchor.paths` complete and validate them before locally held actions as well
as across asynchronous exception decisions; immutable strings alone did not
freeze filesystem alias resolution.

## Sequential file ownership / gates

| Step | Sole writer / owned seams | Required evidence |
|---|---|---|
| Protocol and parent service | Parent: subagents child-authority domain/IPC/API and focused fixtures; pi-sbx broker/action/provider and tests; Guardian broker/types/index and shared tool-evidence helper/tests if extraction is needed | Strict exact-tool wire bounds, old/malformed version refusal, same real process correlation/replay/cancellation, actual parent fixed/semantic review with original directives/nesting/cwd, stale/generation failure and cost attribution. |
| Production pi-sbx consumer | Parent: new child-consumer/policy modules, index dispatch/file gate/config adapter seams and focused tests | Detect real code-only scope/lifetime latch, claim through co-installed public API, no ambient config/maintenance/root publisher; immutable policy/native and SRT projection; child-owned scratch only; actual parent exceptions; no local human/save store; cancellation/rollback/lifecycle and disabled/unavailable negatives. |
| Production Guardian consumer | Parent: new child consumer plus shared evidence/service seams and tests | No child root config/project-trust/reviewer/broker; forward complete actions/parent chain to real parent; block unknown identity/loss; installed hooks before ack, no fabricated readiness. |
| Composition/acceptance | Parent: actual child-session/launch test fixtures, VENDOR/product/architecture/acceptance docs | Real registered production consumers inside the actual SDK factory and real Node IPC, not test ack consumers; no first prompt before both active. Native read/write/edit, sandboxed/scoped Bash, network and explicit host decisions; meaningful deny/maintenance/alias/sibling/cancellation negatives; fork full relevant suites/typechecks/build/graph/root gates. |

Readiness is the final barrier: acknowledge each required consumer only after its
actual handlers and fail-closed lifecycle are installed and (for pi-sbx) SRT is
active. The normal root extension path remains unchanged outside genuine child
scope. A missing/malformed live lease in a latched runner never falls back to it.
Unsupported foreground/nested/workflow/scheduled/retained placements remain
refused. Preserve the accepted complete build graph and native tool schemas.

Unit/mocked SRT projection and credential-free SDK/IPC integration are source
acceptance, not OS containment. #15 must separately exercise the production child
under the actual runtime and prove external-worktree edit/test/review/integration,
required common Git metadata authority, sibling/mandatory-deny negatives and
dirty-preserving cleanup. Compatible-runtime HTTP source gate #4 now passes in
the explicitly authorized Node24 Linux VM above; live context latency/cost
acceptance (#24/#25) remains open. That result neither fixes host Node26's native
assertion nor permits live-runtime replacement or bypassing an approval refusal.
