# Round 2 continuation: trusted child authority

## Authorization and boundary

The operator answered **“yes, go”** to a narrowly scoped `pi-subagents` fork for
host-only, launch-bound child authority and real bounded parent-first approval.
This accepts a third vendored component and its maintenance burden. It does not
authorize deployment, editing live policy, restarting Pi, pushing, reading
credentials/audit data, or a change of runner to bypass a refusal.

The source delivery at `bc0fd37` / `96ad852` remains separate. Full Guardian
headless validation is still blocked by the reproduced Node 26 assertion. The
installed sandbox remains older than those commits; tests here cannot certify
the running installation.

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
as work progresses. No new runtime behavior has been implemented or deployed.
