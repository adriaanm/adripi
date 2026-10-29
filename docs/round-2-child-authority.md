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

## Acceptance and reporting

Test actual launch dispatch and adapter consumption, not only envelope helpers.
Include negative parent/sibling/maintenance/policy paths, spoofed cwd/audience,
stale/replayed replies, canceled/disposed work, and unsupported runners. Add real
external-worktree preflight/edit-test/review-integration/dirty-preserving cleanup
coverage when the launch substrate supports it. Do not call fixture/mock tests
OS enforcement, installed-runtime acceptance, or authenticated Git verification.

Record exact commands, failures, review dispositions and residual limits here
as work progresses. No new runtime behavior has been implemented or deployed.
