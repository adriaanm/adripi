# Product requirements: a safe setup that its agents can actually use

Working requirements, informed by the operator's direction and this setup's own
implementation session. This complements the [as-built guide](product.md) and
[review](review/recommendations.md); it is not a claim these requirements already
pass. Update the evidence as rounds land.

## Product direction and authorized maintenance

The operator explicitly requires **one way of doing each thing**, in both
implementation and model-facing APIs, across the extensions bundled here. Treat
the bundle as one product, not independently reasonable extensions whose
interfaces happen to conflict.

The operator also explicitly authorizes the current privileged setup-development
session to evolve agent configuration. Legitimate in-scope edits to agent
configuration, installed setup sources and policy templates must not be denied
merely because they are configuration changes. This is not permission to read
credentials, rewrite audit evidence, disable guards to get past a denial, or
silently deploy/restart. Maintenance authority must be explicit and visible,
not something the reviewer has to infer from a filename or repeated persuasion.

## Operator decisions after round 1

These answers set the next design direction; they do not change the round-1
as-built contract or authorize another implementation wave or live deployment.

| Decision | Direction | Interpretation / boundary |
|---|---|---|
| D1 — Unified tool authorization | The operator said, "let's unify by having a Bash tool among the other tools." | Working interpretation, **to confirm**: Bash is a peer of Read/Write/Edit in one permission mechanism, not the sole route through which other tools must escalate. Do not add a second Bash tool or a competing compatibility API. Exact schema/UX is not yet chosen. |
| D2 — Parent-first delegation | Delegation goes through the parent, which may pass on its own authorizations. | A parent can delegate authority it actually holds, bounded to the child task; an agent's free-form approval text is not a new grant. Child requests go to the parent first. Requests beyond its held/delegable authority require the appropriate human decision; global/non-delegable protections still win. |
| D3 — Standing workspace roots | Standing roots are sufficient; this repository has special agent-configuration modification authority. The agent configuration directory could be modeled as a workspace. | Model it as an additional **authorized maintenance root**, not a globally writable directory for every project. The operator wrote `~/.pi/agents`; this installation currently uses `~/.pi/agent` (the configured `agentDir`). Confirm that path interpretation before any policy migration. Credential and audit exclusions remain, even inside an authorized workspace. No extra per-session maintainer-mode requirement. |
| D4 — Daily Git and worktrees | Daily Git and worktrees are key to subagent flows. | Prioritize their complete parent/child workflow and recovery over adding unrelated escape routes. Prompt/latency budgets remain unspecified; measure them rather than inventing thresholds. |

### First end-to-end acceptance scenarios

These are proposed acceptance gates implementing D2–D4, not claims that they
already pass:

1. **Daily Git:** local status/diff/branch/stage/commit works inside the normal
   workspace boundary. Authenticated fetch/pull/push uses the one tool-permission
   contract and existing appropriate standing authorization. The parent can
   delegate the covered scope to an assigned child without asking the human to
   re-authorize the same capability. An unapproved command/repository remains
   blocked or takes the parent-first approval path; credentials are never handed
   to the model as readable files.
2. **Subagent worktree lifecycle:** parent provisions an isolated worktree,
   conveys its bounded workspace/Git authority, and verifies file-tool/bash
   writes, scratch and dependencies before the child's first model call. Include
   a worktree outside the original checkout. The child edits/tests in its own
   tree; the parent reviews/integrates; authorized cleanup preserves dirty work
   on failure. An unrelated sibling sentinel remains protected. Missing authority
   produces a real actionable parent request, not a phantom waiting notice.
3. **Maintenance boundary within that flow:** this repository can use its
   explicitly authorized agent-config root; an ordinary repository cannot gain
   it by declaring another workspace. A delegated child receives only the
   applicable subset, with source and scope visible. Credential/audit protections
   and workspace-policy self-protection survive both root and delegation handling.

For each scenario record authorization source, child scope, permission prompts,
reviewer latency, setup/recovery calls and result. Passing helper tests or having
an approved parent launch is not sufficient evidence.

## Observed dogfooding evidence

These are operational observations, not the workers' private reasoning and not
an OS security certification. The initial implementation workflow was
`717ec43a`; it was paused before acceptance. Owned partial patches were captured.
Recovery workflow `fd5f5cb7` uses the same model and subagent protocol in separate
worktrees inside the existing writable workspace. No permission profile was
widened to recover.

| ID | What happened | Product impact |
|---|---|---|
| E1 | Native managed worktrees were created under `/Users/adriaan/g/worktrees/adripi`, but workers' sandboxed bash could not create their dependency links/fixtures there. | The harness launched writers into an environment that could not perform the assigned work. Git isolation and sandbox scope were not coordinated. |
| E2 | Inline escalation attempted nested execution of `contact_supervisor` and returned `Tool contact_supervisor not found`. That tool is model-only, not nested-callable. | The advertised approval path was unusable exactly when needed; a listed tool was mistaken for an available internal service. |
| E3 | Attention notices said a worker was waiting for a supervisor reply, but `subagent_supervisor pending` had no request. | The parent was told to answer a question that did not exist. Tool activity was mistaken for a successfully routed request. |
| E4 | In the affected worktrees, a file-tool write succeeded where a bash write failed. The parent stopped the workers rather than accepting tool substitution as a recovery. | File-tool and OS policy appeared inconsistent. The agent was drawn into probing which tool would work rather than following a clear authorization contract. Root cause still needs an integration test. |
| E5 | Setup troubleshooting consumed dozens of tool calls before the parent paused the workers. | A cheap/fast worker does not make a broken environment cheap to use. Costs include attention, repeated context, elapsed time and confidence—not only model price. |
| E6 | Recovery required the parent to inspect logs/handoffs, preserve partial patches, provision separate in-workspace worktrees and link dependencies. | Recovery depended on implementation knowledge and manual orchestration that the harness should normally own. |
| E7 | Earlier review found installed entry-point hashes matching the repo while the active parent bash declaration omitted the inline parameters. Workers later exposed those parameters. | Matching source files do not prove a consistent active API. Different session surfaces can present different contracts; the cause is not yet established. |
| E8 | The operator had to remind Guardian that setup maintenance is the purpose of this privileged session. | Task authority must be conveyed structurally to the reviewer, not only as a broad policy saying security configuration is forbidden. |

## Requirements and acceptance tests

### PR1 — One action, one escalation contract

**Requirement:** expose one canonical permission mechanism for actions across
tools, with Bash as a peer rather than a privileged sole escalation route
(working interpretation D1, awaiting confirmation). Tool schemas, prompt
examples, errors, standing-rule storage and human UI must agree. Do not retain
competing model-facing aliases or a second persistence fallback.

**Acceptance:** enumerate loaded tools/schemas for parent and supported children.
Only the canonical route is advertised. Every prompt example validates against
that exact schema. Removed parameters are rejected before execution with a clear
migration explanation, not silently ignored.

**Evidence:** E2, E7; round 1 consolidates bash escalation. Cross-tool ergonomics
still requires evaluation, particularly filesystem operations outside the static
native-file-tool policy.

### PR2 — A writer launch must have a usable workspace

**Requirement:** worktree provisioning, writable roots, dependency setup, scratch
space and maintenance authority must be planned together before the first model
call. A managed worktree is not ready merely because `git worktree add` worked.

**Acceptance:** a disposable child preflight can write/read/delete a normal
fixture in its assigned worktree, use private scratch and resolve development
dependencies. An unauthorized sibling sentinel remains unwritable. Failure
blocks the launch with a useful parent-facing report rather than spending worker
turns discovering it. Cover worktrees outside the parent root, not only the
current in-workspace recovery layout.

**Evidence:** E1, E5, E6. Do not solve this by blanket allowlisting the host's
entire worktree directory or inheriting all parent privileges into arbitrary
children.

### PR3 — Approval transport is a real service, not a tool-name assumption

**Requirement:** all routes use one supported decision adapter. Child permission
requests go to the parent first (D2). The parent may pass on authorizations it
actually holds, narrowed to the assigned work; a human is needed for authority
outside that scope or reserved to the human. Whether a tool is visible to a
model is separate from whether host code may invoke it. Use a supported,
request-bound transport, not `executeTool()` on a model-only tool.

**Acceptance:** exercise UI, supported RPC and headless modes end to end. A
routed request has an ID and receives the exact authorized scope; absent channels
fail closed with an infrastructure/deferred explanation. A parent decision is backed by a verifiable authorization source and may only
narrow it; it cannot be treated as human consent merely because it emits an
`ALLOW` string. Test reuse of held authorizations without duplicate human asks,
and refusal/escalation for requests outside the parent's authority.
No test may mock an impossible nested tool call and call that integration proof.

**Evidence:** E2. Round 1 may provide consistent fail-closed headless behavior;
that is not equivalent to completing usable human escalation.

### PR4 — Attention notifications must correspond to actionable state

**Requirement:** distinguish "started a tool", "approval transport failed",
"request delivered", "waiting for reply" and "decision received". Only a
successfully delivered pending request can produce a waiting-for-reply notice.

**Acceptance:** a waiting notice's request ID appears in the parent's pending
list and has one reply action. A missing/forbidden supervisor tool instead
produces an infrastructure error with no phantom pending request. Expired,
answered and cancelled requests cannot keep generating waiting notices.

**Evidence:** E3. This spans the sandbox adapter and subagent control reporting;
fixing only one extension's error text is insufficient.

### PR5 — Equivalent effects have equivalent policy across supported tools

**Requirement:** ordinary file tools and sandboxed processes must share the same
canonical workspace/target interpretation. A denial must not invite the model to
try a less-protected tool, encoding, wrapper or execution surface.

**Acceptance:** a disposable path matrix checks read/write/edit/bash, nested
calls and supported children against the same authorized/unauthorized targets,
including symlinks, new files, subdirectories and worktrees. Explain intentional
differences explicitly, such as a separately approved full-host command.

**Evidence:** E4; actual root cause unverified. The vetted upstream components
remain the baseline, but their bundle integration is our responsibility.

### PR6 — Privileged-maintainer authority is explicit and bounded

**Requirement:** human-authorized standing workspace roots are sufficient (D3);
a separate per-session maintainer mode is not required. Model the agent-config
directory as an additional maintenance workspace available to this specially
authorized repository, not to arbitrary projects. Carry trusted, structured
maintenance authority to deterministic rules and the reviewer. In-scope agent
config changes are expected work, not presumptively malicious circumvention.
Supported delegated worktrees receive only the portion of that authority needed
for their assigned task; repository text alone cannot self-assert a root.

**Acceptance:** an authorized maintainer can edit a disposable agent-config
fixture without persuading Guardian repeatedly. An ordinary project cannot.
Credentials and audit writes remain denied. Parent and supported child status
show the maintenance grant's source and scope. Deployment/restart requirements
remain explicit; permission to edit does not itself cause deployment.

**Evidence:** E8 and the operator's explicit authorization. The existing
`agentDirWriteProjects` mechanism is a starting point, not complete propagation
or a complete user experience.

### PR7 — The active contract is inspectable without source archaeology

**Requirement:** one read-only health/status view identifies the active tool
schema and loaded implementation, broker/approval-channel health, imported
runtime versions, effective roots and grants, policy source/trust, and whether
deployed code differs from the running instance.

**Acceptance:** a deliberately stale runtime and mismatched child schema are
reported as mismatches. A version/hash comparison alone cannot report healthy
when the active tool declaration is wrong. The agent receives a short,
actionable summary rather than needing to read implementation logs.

**Evidence:** E6, E7; aligns with review F9's proposed doctor capability.

### PR8 — Errors name the failed layer and a safe next action

**Requirement:** distinguish OS policy denial, fixed rule denial, reviewer risk
denial, reviewer outage, invalid API input, unsupported approval transport and
unavailable dependencies. All unsafe actions stop, but infrastructure failure
must not be presented as the user's refusal or an unacceptable-risk judgement.

**Acceptance:** each failure class has a machine-readable code and concise
model/human text. A denied request does not trigger repeated rephrasing. A new
trusted authorization or repaired infrastructure has a defined recovery path;
the model does not have to guess which denial is final versus repairable.

**Evidence:** E2–E6. A profile/location change must never be used secretly to
achieve the same denied access; authorized recovery is explicit and auditable.

### PR9 — Recovery preserves work and keeps validation honest

**Requirement:** a failed worker can hand off a bounded partial diff and exact
validation state without losing work or treating that work as accepted. Retrying
should not duplicate completed work or quietly change model/execution mode.

**Acceptance:** interrupt a writer after one mutation. Capture its owned diff,
exclude probe files, show the failure and preserved worktree, retry under the
same declared protocol, and validate the actual candidate source. Parent accepts
only after review; relocation/copy-based test runs do not silently masquerade as
testing the original blocked environment.

**Evidence:** E6 and this round's recovery. Original and retry artifacts remain
evidence; no fix was inferred from a paused worker. Retry patches were later
personally reviewed/integrated; see [round 1](round-1.md) for source checks and
the unresolved full headless-suite failure.

### PR10 — Measure whether the setup gets out of the way

**Requirement:** track harness-caused failures separately from task failures.
Measure successful workflows rather than declaring ergonomics from helper tests.

**Acceptance:** for representative read/edit/test, cache write, authenticated
Git, worktree delegation and maintainer-config workflows, report: unnecessary
prompts, failed/repeated tool calls, setup time, reviewer latency, recovery turns
and whether human intervention was actually necessary. Agree numerical targets
with the operator after a working baseline; do not invent success thresholds.

**Evidence:** E5. Routine authorized coding should spend its effort on code,
not on reverse-engineering its harness.

## Remaining clarification before the next design

- Confirm D1: does "Bash among the other tools" mean a common authorization
  mechanism for Bash/Read/Write/Edit, rather than forcing file actions through
  bash? Tool naming alone is not the design; avoid registering a duplicate tool.
- Confirm the agent-config root spelling: configured `agentDir`
  (`~/.pi/agent` here), rather than a new `~/.pi/agents` directory.
- Decide the concrete parent/child transport and grant representation in design;
  the operator has selected parent-first delegation of held authority, not a
  particular protocol or indiscriminate inheritance of every privilege.
- Establish interruption/latency targets after measuring the Git/worktree
  scenarios. No numerical budgets were supplied.

These decisions do not authorize blanket policy widening, unannounced deployment
or another implementation wave. The full Guardian headless check remains open
independently of this interview.
