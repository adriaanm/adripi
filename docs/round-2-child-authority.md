# Round 2 continuation: trusted child authority

## Authorization and boundary

The operator answered **“yes, go”** to a narrowly scoped `pi-subagents` fork for
host-only, launch-bound child authority and real bounded parent-first approval.
This accepts a third vendored component and its maintenance burden. It does not
authorize deployment, editing live policy, restarting Pi, pushing, reading
credentials/audit data, or a change of runner to bypass a refusal.

The source delivery at `bc0fd37` / `96ad852` remains separate. Full Guardian
headless validation is still blocked by the reproduced Node 26 assertion. Early
preflight found an older installed sandbox; a later read-only check found the
sandbox/Guardian entrypoints and relevant loaders match source, apparently after
operator action. Matching disk bytes do not certify a restart or loaded behavior.

## Source provenance and build constraint

Read-only registry metadata for `pi-subagents@0.81.0` identifies upstream
`nicobailon/pi-subagents` commit
`1bc941363cb62fc23c94c5519364b03dc150be3e`. Its public GitHub source archive was
retrieved into ignored `.local/round-2-subagents/upstream/`; the license is MIT.
Registry metadata is saved in `.local/round-2-subagents/npm-metadata.json`.

The upstream source package exports TypeScript. `scripts/build-package.mjs`
compiles a `dist-pkg/src` tree and bundles **all public exports into one shared
module graph**, with the published exports resolving to `dist-pkg/bundle`.
The current adripi source-overlay installer is insufficient for this package.
Do not patch only installed readable JS, separately bundle an authority registry,
or silently load a second copy of supposedly shared authority state.

## Seam classification and lane board

This is **multi-seam**: launch lifecycle, trusted permission adapters and package
build/deployment are independently testable contracts. The parent owns design,
contract arbitration, integration, direct diff review, acceptance and commits.
Children use `neuralwatt/nw-flash`, do not commit, do not delegate, and do not edit
live installation/policy. Writers will receive isolated worktrees and exclusive
file ownership after the contract is fixed. No concurrent writers yet.

| Lane | Cwd / inputs | Decision or owned contract | Status / gate |
|---|---|---|---|
| launch-design (read-only) | `/Users/adriaan/g/adripi`; exact upstream archive plus existing fork adapters | Identify actual launch/lifetime seams, safe placement and host-only request/reply design | Planned; source references and bounded proposal, not implementation authority |
| packaging-design (read-only) | same repo; exact upstream archive and `install.sh` / `forks.txt` | Reproducible vendoring/build/overlay plan and focused upstream baseline checks | Planned; no npm install, deployment or remote Git |
| launch substrate writer | isolated cwd to be provisioned | `pi-subagents` host-only authority/approval API, launch enforcement and package-local tests | Pending design; exclusive file list before launch |
| permission adapter writer | separate isolated cwd to be provisioned | Existing pi-sbx/Guardian adapters consume trusted launch identity, intersect held scope and preserve exclusions | Pending design; exclusive file list before launch |
| packaging writer | separate isolated cwd if needed | Reproducible third-fork build/install mapping and fixture checks | Pending packaging design; exclusive file list before launch |
| parent integration | main checkout | Integrate only completed owned handoffs; review actual diffs, repair seams, verify and commit | Blocked on component handoffs |

## Required safety contract

- Child cwd, task text, extension bindings, ambient environment and writable
  manifests are proposals/configuration, never grants.
- The host binds authority to parent session, child/run audience and lifetime;
  derives only a subset actually held and delegable; and checks readiness before
  the first child model call. Ambient maintenance matching must not reacquire
  authority removed by the child ceiling.
- A code-callable request has a real ID and reaches the parent first. Parent
  decisions cannot manufacture authority; beyond-held scope needs the existing
  human admission route. Plain model `ALLOW` text is not a verified decision.
- Missing services, spoofing, replay, wrong audience, cancellation, timeout,
  disposal and unsupported placements fail closed. A waiting notice requires a
  delivered pending request.
- Process-global SRT and Guardian service ownership must be isolated or the
  placement explicitly refused. Do not silently change execution mode. Cover
  foreground, background, retained and nested paths, or reject them explicitly.
- Keep native tools native and the existing public escalation API singular.
  Credentials, audit data, own workspace policy and explicit configured denies
  remain non-delegable exclusions. No new permissive compatibility route/store.
- Authenticated cross-process transport requires verified launch provenance,
  integrity, audience and replay protection; no unauthenticated file/socket inbox.

## Corrected design contract: host-created IPC, not writable carriers

The design-only commit `2f114b1` incorrectly promoted a file plus env digest to
trusted authority, despite the earlier parent rejection of that proposal. That
is withdrawn **before implementation**. No writer was launched: the workflow
call failed because its visible script block was missing. The saved, unexecuted
writer draft is not an implementation contract and must not be run.

Baseline `7b0dc53` has a green typecheck, build and 4,140 unit tests (17 skipped;
full unit baseline required reviewed host execution because `ps` is sandboxed).
The operator subsequently requested continued todo work after the project-config
task, delivered as `3647fe2`. Binding decisions for the corrected work:

1. **Trust travels on a host-created Node IPC handle.** The parent attaches an
   IPC channel to the actual spawned native runner. Neither config-file bytes,
   env variables, file hashes, model input nor supervisor text can create a
   live lease. Binary wrappers, machine/external runners and detach modes that
   cannot retain this authenticated parent relationship are refused, not
   rerouted. Parent disappearance revokes the child lease.
2. **One non-model public API:** `pi-subagents/child-authority`, bundled with the
   existing exports in the upstream shared graph. The transport module mirrors
   the trusted `pi-sbx.session-authority.v1` provider shape; only pi-sbx
   publishes that provider. It binds its real session id, supplies required
   extension paths, prepares a bounded policy payload and reviews action
   requests. No independent permission store or alternative model tool.
3. **Live identity and lifetime.** A host-fixed parent session/run identifies
   the IPC audience. Each child preparation uses a fresh opaque lease id and
   actual resolved child identity (agent, index, cwd). Requests have unique ids,
   bounded payloads/concurrency/timeouts, typed decisions and single-consumer
   correlation. Wrong audience, duplicate/replayed ids, disconnect, provider
   cancellation/disposal and late replies fail closed. A retained artifact is
   history, never a capability: resume requires fresh parent preparation.
4. **Code-only child consumption.** A process-wide, versioned
   `AsyncLocalStorage` slot exposes the live lease only while the host loads
   and binds the required child extensions. The actual child factory checks
   required consumer acknowledgments in memory before permitting a first
   prompt. No ack files. Launch failure disposes the child and lease.
5. **Separate policy from carriage.** pi-subagents transports a bounded JSON
   payload and action decisions; pi-sbx owns deriving/intersecting held policy,
   enforcing it in native/OS adapters, and non-delegable exclusions. Reads are
   deny-based, not honestly expressible as a fabricated finite read-root list.
   Writes start with the assigned workspace and necessary pre-authorized Git /
   scratch scope, not every parent root. Canonical and lexical containment and
   current parent restrictions still apply. Ambient maintenance matching must
   not reacquire withdrawn child authority.
6. **Real parent-first decisions.** A child action outside its launch scope is
   sent to the live parent's existing authorizer, Guardian and human adapter.
   The parent may delegate only authority actually held/delegable; beyond-held
   requests need the existing human route. Mandatory exclusions are denied
   before review. Cancellation is not consent. No unavailable-only stub will
   be reported as delivery of the parent-first requirement.
7. **Initial placement is intentionally narrow.** One native, single-child
   background runner per process. Foreground parent-process, parallel/dynamic
   groups, nested launches, machine/external/binary placements, unattended
   schedules and managed-worktree setup without prior scope admission must
   fail explicitly before their unsupported mutation/launch path. Do not
   silently change runner. Supporting more placements is subsequent work,
   not a claim inferred from unit tests.

### Corrected staged lane board

All writers use `neuralwatt/nw-flash`; none commits, delegates, deploys or changes
live policy. Each has a separate detached worktree under `.local/round-2/`.
The parent is integration-only after handoffs and personally reviews diffs.

| Lane | Isolation path | Exclusive ownership / next gate |
|---|---|---|
| IPC substrate | `authority-transport` | New `forks/pi-subagents/src/{api/child-authority.ts,runs/shared/child-authority.ts,runs/shared/child-authority-ipc.ts}`, `test/unit/child-authority*.test.ts` and IPC fixtures only; real Node IPC positive/negative tests, typecheck. No launch call sites or policy derivation. |
| Packaging | `authority-pkg` | Root `install.sh`, `forks.txt`, `justfile`, `scripts/{build-subagents,deploy-fork,deploy-fork.test}.mjs`; new fork `scripts/verify-build.mjs` only. No package manifest, source, policy or existing unit-test edits. Fixture checks and baseline build. |
| Launch integration | provision after IPC handoff | Existing pi-subagents foreground/background/preflight/child-factory call sites and focused dispatch tests. Frozen API must be reviewed first. |
| Permission adapter | provision after IPC handoff | Existing pi-sbx/Guardian source adapters and their focused tests. Frozen API must be reviewed first; no ambient maintenance reacquisition. |
| Parent integration | main | Manifest/export-map fixture changes, VENDOR/docs and cross-fork acceptance after owned handoffs. No partial transport declared complete. |

The initial two writers are independent: packaging works against the unchanged
baseline export graph, and the IPC module has real fixture peers rather than
unimplemented launch adapters. Parent adds the new export only after the module
exists, rebuilds the complete graph and verifies consumer identity across actual
public/bundled and compiled entry points. The saved unsafe three-writer draft is
superseded, not a fallback.

## Acceptance and reporting

Test actual launch dispatch and adapter consumption, not only envelope helpers.
Include negative parent/sibling/maintenance/policy paths, spoofed cwd/audience,
stale/replayed replies, canceled/disposed work, and unsupported runners. Add real
external-worktree preflight/edit-test/review-integration/dirty-preserving cleanup
coverage when the launch substrate supports it. Do not call fixture/mock tests
OS enforcement, installed-runtime acceptance, or authenticated Git verification.

Record exact commands, failures, review dispositions and residual limits here
as work progresses. IPC/packaging primitives are integrated below; actual launch/permission wiring
and production runtime acceptance remain pending. No agent deployment occurred.

## Component candidate review (workflow 185d028d-d008-4fad-b2c1-a57eefa3395d)

Both original writers and fresh reviewers completed. Candidates remain in their
owned worktrees; the parent has read the actual new implementation modules and
packaging diffs, not just handoffs. Parent independently reproduced the initial
**26 IPC tests + typecheck** and **33 packaging fixtures + artifact verification**
passing. Passing tests do not discharge the source-proven missing negatives.
Reports are session artifacts under this workflow's `authority-components/`.

Accepted fixes before either component is integrated:

| Component | Finding / disposition |
|---|---|
| IPC | P1 sync `decide()` throw escapes the parent EventEmitter callback; P1 unbounded, abort-ignoring `prepare()` can hang launch. Fix both and exercise real-process negatives. |
| IPC | Parent additionally found concurrent prepares before `prepared` is assigned; missing disposal after invalid provider payload/consumers; and channel loss while preparing. Make preparation single-attempt, bounded, cancellable and cleanup late-returned leases. |
| IPC | FIFO replay eviction contradicts lifetime replay protection. Bound total accepted ids per lease and fail closed on exhaustion, never forget an old id while retaining authority. Bound wire ids too. |
| IPC | Child cancellation/timeouts/client disposal currently do not tell the parent. Add authenticated cancel/release messages so the parent aborts the corresponding pending human/reviewer operation and disposes the provider. |
| IPC | Return the live lease from the required consumer's `claimChildAuthority`; reject requests before all consumers acknowledge, and reject `awaitLease()` after revocation/failure. Cross-check grant/revoke audiences. |
| IPC | `defer` must not cross the wire as an unfinished approval. Parent `decide()` owns reviewer+human completion; terminal outcomes are allow/deny/unavailable/cancelled. Use explicit, bounded approval-friendly defaults and short overrides in tests. |
| IPC | Production runner factory must capture the real process IPC endpoint, not accept a model-reconstructible fake peer. Trusted provider injection is host code authority, not proof that arbitrary same-process code is safe; document this boundary honestly. |
| Packaging | P1 early preflight blocks aligned future upgrades against an old install. Preflight validates fork/build readiness; strict installed-version/dependency/layout validation belongs after package installation, before deployment writes. |
| Packaging | P2 build-wrapper race and symlink refusals need tests. Parent additionally found target-directory symlinks are followed by the JS mirror, and source symlinks can fail after deleting target entries. Prevalidate source/managed target trees; preserve the legitimate package-root pnpm symlink only. |
| Packaging | In-place copies/manifests can mutate shared hardlink inodes. Use exclusive temporary siblings plus atomic rename, with failure cleanup and scratch hardlink/symlink regressions. |
| Packaging | Stamp source and artifact contents, reject unexpected root files, scan compiled runtime URLs as well as bundle URLs, and detect output tampering/mixing. This is consistency checking, not trust against hostile same-user writers. |
| Packaging | Plan all listed forks before any writes so a later validation refusal cannot overwrite earlier forks. IO failures are still not a multi-directory transaction; do not claim otherwise. |

The same sole writers received bounded fix packets in the same worktrees, then
fresh read-only targeted reviews. Both follow-up reviews returned **OK with
notes**, not executed-test claims; parent verification and integration follow.

## Accepted primitives (workflow e1c748f0-a52e-4cf3-8ebb-ac7410ed88e8)

Parent read both fix handoffs, both fresh reviews and actual implementation, then
copied only the completed lane-owned paths into main. No completed worker was
rerun. Parent closed the residual findings directly as integration owner:

- Dispose malformed provider returns when they have a usable disposer (invalid
  decide/signal), with counter regressions; late/invalid payload disposal retained.
- State the distinct prepare/child-await clocks: default 30s prepare + 35s child
  lease arrival leaves 5s startup slack, not an unconditional timing guarantee.
  Launch must reach prepare promptly or pass explicit paired bounds.
- Hold the forged-cancel test's decision behind a gate; positively observe the
  forged message while review is pending, so the audience negative is not vacuous.
- Parent additionally found whole-lease disposal left provider resources until
  child exit. An audience-bound reverse revoke now releases the provider even
  while the process remains alive; real-process test asserts this before exit.
- Guard installed manifest/root files (content/mode/absence) as well as managed
  trees before overwriting; drift fixtures preserve all target bytes. Diagnostics
  now name the actual installed path rather than a fictional build `(installed)`.
- Add the public manifest export/fixture and actual post-build cross-graph tests.
  The same versioned global ALS and provider slot are observed by bundled and
  compiled imports, not just source module aliases. Only one runner client is
  supported; consumer ids are a subset of required extension ids. Trusted code
  injection is host authority, not arbitrary privileged-extension containment.

### Parent verification

On Node `v26.6.0`, main checkout:

| Command | Result |
|---|---|
| `npm run typecheck` in `forks/pi-subagents` | pass |
| `node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test --test-concurrency=4 test/unit/child-authority*.test.ts` in fork | 47 passed |
| `just check` (shell/config + deployment fixtures) | 69 passed |
| `node scripts/build-subagents.mjs` | pass; unchanged upstream builder, 382 inputs / 17 exports / 328 compiled modules / 762 artifact files |
| `node --test forks/pi-subagents/test/build/child-authority.test.mjs` | 3 passed, both ALS directions + shared provider |
| `npm --prefix forks/pi-subagents run test:unit` | sandbox failed (process inspection, sockets/TCP; watcher pressure). Exact command rerun with reviewed inline host approval: **4,187 pass / 17 skip / 0 fail**, 4,204 tests / 437 suites |
| `find forks/pi-sbx/src forks/pi-guardian/src -type l` | empty |

Ignored logs under `.local/round-2-subagents/parent-*`; the host result does **not**
prove sandboxed fixture success. The intermediate packaging run initially failed
one old diagnostic regex after the parent changed path labels; updated assertion,
then all 69 fixtures passed. Source and fixture checks do not certify live deploy,
SRT containment or authenticated Git. Guardian's Node 26 headless crash remains
an independent open gate.

### Lane gate after acceptance

IPC and packaging component writers are finished. Parent owns the integrated
manifest, docs, build test and repairs. Next, provision isolated launch and
permission-adapter lanes against this frozen API, with exclusive file lists and
an explicit policy-payload contract before writing. No production caller, pi-sbx
provider/consumer, real Guardian/human decision route or first-prompt gate exists
in this commit; those remain todo #22, followed by child/OS/Git acceptance.
The next staged ownership board and binding caller/provider obligations are in
[round-2-authority-wiring.md](round-2-authority-wiring.md).

