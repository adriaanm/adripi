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
