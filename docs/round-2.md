# Round 2: shared action authority and bounded delegation

## Authorization and delivery boundary

The operator answered **“go”** to the proposed second bounded round using
`neuralwatt/nw-flash` workers and parent review/integration. D1–D4 in
[product requirements](product-requirements.md) remain the contract. Source edits,
isolated implementation, tests, documentation and coherent local commits are in
scope. Deployment, live policy changes, restart and push are **not** in scope.

This is a multi-seam implementation, not a single-writer commission. The parent
owns design arbitration, integration, acceptance, documentation and commits.
Workers must not commit, deploy, change policy or delegate.

## Live preflight (before source changes)

- Parent `git status --short` was clean at `a552e9f`.
- Native write/edit/read and sandboxed Bash append/read succeeded on the same
  ignored `.local/round-2/live-smoke.txt` fixture. Ordinary local Git succeeded.
- Installed `pi-sbx/src/index.ts` is **older than round 1**, not just an uncertain
  in-memory reload: it imports the retired command-policy, supervisor-ask and
  overlay modules and exposes the retired parameter/exception routes. Its SHA-256
  is `f8e04a90eb47efc1e1e0da0ab6f22086b4075ca3a9e96b072ded59f4a45c23d5`;
  the checkout's is
  `6c885bd0d190678282f3d030f67395eb11c2a3a2beee79eae1a30e589eef0c1c`.
- The exposed tool declaration and injected guidance also advertise retired APIs.
  No escalation/credential probe was performed. Saved Guardian enabled values
  were not used as evidence of loaded status.
- Node is still `v26.6.0`. The known full Guardian headless crash remains open.

These checks establish a usable development workspace, **not** loaded round-1
acceptance. Do not claim runtime or child OS containment from source tests. A
later separately authorized deployment and full restart must precede live gates.

## Lane board — first source wave

| Lane | Exact decision and ownership | Isolation / authority | Focused gate and durable handoff | Independence |
|---|---|---|---|---|
| Action authorization | One action-bound path authorizer shared by Bash and native file gates. Own `forks/pi-sbx/src/`, its tests and VENDOR only. | `.local/round-2/action`; worker writes only this component in its detached tree. | Registered-dispatch/native-gate tests, Vitest, typecheck; report changed paths, API, negatives, residual risks. | Sandbox enforcement/UX adapter, separate from Guardian policy. |
| Guardian authority | Make trusted agent-directory maintenance authority consistent between ordinary file-tool rules and the exception broker, with canonical bounded root matching and hard exclusions. Own `forks/pi-guardian/src/`, its tests and VENDOR only. | `.local/round-2/guardian`; worker writes only this component in its detached tree. | Rules, broker and actual publisher tests, non-headless suite, typecheck; report authority sources and negatives. | Deterministic policy admission, not native-tool or child launch plumbing. |
| Delegation substrate | Identify the actual supported launch/transport seams, lifecycle, preflight and bounded-authority representation; recommend the smallest executable integration, or evidence the missing upstream seam. **Read-only**, no speculative transport implementation. | Parent checkout and installed readable `pi-subagents` APIs, no writes except managed report. | Source-cited handoff including foreground/background/worktree paths and exact APIs; never treat model-only supervisor text as authority. | Establishes the dependency before designing security-sensitive child wiring. |
| Parent integration | Review owned diffs and fresh reviews, arbitrate contracts, integrate only accepted files, add cross-extension negative gates and update product docs. | Main checkout, after handoffs only. | Both fork typechecks/suites, `just check`, diff checks and coherent commits. | Integration-only owner; no concurrent writes to worker trees. |

Workers use `neuralwatt/nw-flash`. Separate fresh read-only reviews inspect exact
candidate trees. All handoffs live under the workflow's managed artifacts. No
external worktree authority is fabricated: this wave uses the already writable
checkout's ignored `.local/round-2/` trees, not a claimed solution to PR2.

## Shared-action design constraints

- There is one action-bound path authorization decision function, using the
  existing Guardian broker and serialized human adapter. Bash installs a copied
  scoped OS profile; native tools enforce their own one-call target. Neither
  adapter mutates baseline/session permissions or creates a grant store.
- Native tools remain native; do not ask the model to rewrite a failed Edit as
  Bash, register duplicate tools, revive the exception tool or add schema aliases.
  A native operation requiring authority may request its exact path through the
  common service. An impossible grant is refused before prompting/execution.
- Mandatory policy/credential/audit exclusions win before any human request.
  Check canonical and lexical targets, read fallbacks, traversal, cancellation,
  parallel calls, disabled/invalid lifecycle and missing/failed Guardian.
- Maintenance comes only from trusted global `agentDirWriteProjects`. Align the
  exception broker with ordinary file-tool admission; don't let a project rule,
  cwd spelling or symlink self-assert maintenance. Keep configured `agentDir`,
  `auth.json`, audit and workspace `.pi` semantics explicit. Global/user denies
  and defers still win.
- Parent-first delegation requires a request-bound **host service**, bounded
  provenance and actual child enforcement. Neither `contact_supervisor` nested
  execution nor a free-form `ALLOW` string is a grant. Do not invent a dynamic
  launch callback that the installed package does not expose.

## Remaining round gates

The first wave is not the whole round. Before claiming D2–D4 complete, implement
and verify the selected real transport and launch-time scope propagation, then
exercise Git/worktree provisioning, preflight, edit/test/review/integration and
safe cleanup, including an external worktree and unrelated sibling negative.
Also check maintenance exclusions and scope narrowing across parent/children.
A missing supported substrate is a reported dependency/blocker, not permission
to silently add an unbounded side channel or assert that helper tests pass PR3.

Record source-test results, actual runtime results and blocked scenarios
separately. Source delivery must never imply installation or an OS certification.
