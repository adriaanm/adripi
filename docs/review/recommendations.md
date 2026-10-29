# Review: towards a convenient, safe Pi sandbox and Guardian

Reviewed repository baseline: `2e86f45`. Deliverables:
[as-built product guide](../product.md), this assessment, and a
[verification record](verification.md) with archived, non-executing probes.
No runtime fixes or live-policy changes are part of this review.

## Verdict

**Keep the architecture; consolidate the capability implementation before adding
more escape routes.** The normal workspace/sandbox/reviewer experience is a
credible foundation. The local additions solve real problems: scratch space,
provider-aware review, useful error messages, additive grants and familiar inline
escalation. But several intended invariants are not consistently implemented
across those additions. It is not yet defensible to claim one exact,
command-scoped, fully auditable escalation path, or Claude/Codex-equivalent
containment across all Pi tools and children.

The most valuable next step is not another policy prompt. It is one capability
state machine shared by the separate exception tool, inline parameters, legacy
host flag and network callback.

### How to read priorities

- **P1:** repair before relying on the affected safety boundary in normal use.
- **P2:** next iteration for reliable, understandable daily operation.
- **Decision:** requirements/trade-offs that need the operator, not an invented
  implementation requirement.

A P1 here does **not** assert an unreviewed remote exploit. Guardian/human
approval often still gates the action. The problem is that approval can confer
more than the declared deterministic boundary, or be applied to the wrong thing.

Evidence labels: **Reproduced** means a mocked extension/pure-helper probe;
**Source-confirmed** means the code path is present but no OS attack was run;
**Unverified integration** means stronger assurance needs a live test.

## Findings and recommended acceptance criteria

### F1 — P1: host escalation paths enforce different contracts

**Reproduced** (probes 1, 2 and 6).

`pi-sbx/src/index.ts:574–615, 850–869` routes inline/legacy host execution through
`runOutsideSandbox`, but only the separate exception tool calls
`hostCommandRefusal`. A harmless two-line command rejected by that validator
reaches mocked local execution through inline escalation after broker approval.
Guardian's command rules do not reject a bare newline as such.

Conversely, a separate approved host-command grant is consumed before checking
`allowUnsandboxedCommands`, so `false` blocks inline host execution but not the
separate-tool route. This is a real policy inconsistency.

The validator itself is only a shape filter: it accepts absolute shell paths
and other interpreters. Single-command syntax cannot make an arbitrary executable
safe. The standing-prefix planner does not receive the current command, so it
cannot check that a proposal is a true prefix of the approved action; it also
uses a bare-word denylist that does not cover all executable spellings.

**Recommend:** a single pre-review host eligibility/policy gate used by every
route. Decide whether host execution is an arbitrary explicitly approved escape
(as in a general escalation model) or a restricted credential/service capability.
Either can be coherent; current documentation describes the latter while code
sometimes behaves like the former. Bind prefix proposals to the parsed command,
canonical executable policy, arguments and cwd; explain downstream helpers.

**Accept when:** all routes produce the same result for disabled host execution,
newlines, wrappers/absolute shells, interpreters, redirects and substitutions;
unrelated prefix proposals cannot be saved. Tests must distinguish syntactic
eligibility, approval and actual execution.

### F2 — P1: scoped grants are shared mutable session state

**Reproduced** (probe 4); broader lifetime effects are **source-confirmed**.

`pi-sbx/src/index.ts:618–667, 910–928` temporarily adds per-command paths to the
session-wide runtime profile. While one scoped command is held open, a second
ordinary command sees its added allow-write path. Pi supports parallel tool
calls, so "for this command only" is not the implemented boundary.

Separate once grants are also active before their intended consumer starts and
expire on another tool's result, not a reserved consumer ID. An unrelated or
nested call can expire them, while overlapping calls can observe them. Rollback
can also conflict with a concurrent grant of the same target. Stopping a grant
from appearing in future policy does not necessarily revoke a profile already
installed in a running child process.

**Recommend:** command-bound capability leases and immutable per-execution policy
snapshots. If SRT's singleton manager cannot safely represent concurrent profiles,
serialize capability-changing executions as a first containment measure. Include
file tools and nested calls in that design, not just bash. Define treatment of
background descendants explicitly.

**Accept when:** concurrent A cannot use B's lease; unrelated/nested results do
not consume it; cancellation, partial approval, exceptions and rollback preserve
pre-existing grants; background descendants have an explicit lifetime policy.

### F3 — P2: separate network-once grants expire before use

**Reproduced** (probe 3).

`pi-sbx/src/index.ts:874–877, 910–918` adds a network token, then clears the entire
set on every `tool_result`, including the granting tool's own result. A following
connection no longer has the promised token. Plain-host versus `host:port` keys
also need one normalization rule.

**Recommend:** put network tokens in the same lease store, preserving them past
the granting call and consuming them only for the approved destination/event.

**Accept when:** grant -> granting result -> one matching connection succeeds;
the second connection needs a new decision; unrelated connections cannot consume
or broaden it. Cover bare host, explicit port, any-port and IPv6 spellings.

### F4 — P1: an explicit network port rule authorizes other ports

**Reproduced** (probe 7).

`pi-guardian/src/sandbox/rules.ts:167–199` strips ports from both rule and target
spellings. Thus `allow: ["network:example.test:443"]` also allows
`example.test:8443`. Deny/defer rules are similarly overbroad. Portless/all-port
rules are useful, but a port-specific allow must not silently become all ports.
This arose in the local attempt to support equivalent host spellings.

**Recommend:** parse host and optional port independently. Bare host / `:*` means
any port; a numeric rule matches only that numeric port. Normalize case on host
names, not arbitrary command arguments. Define IPv6 separately from suffix
stripping.

**Accept when:** 443 allows 443 and not 8443; deny/defer are equally precise;
any-port and portless rules retain their documented behavior.

### F5 — P1: saving a narrow standing rule can approve unrelated policy

**Reproduced** (probe 8); file-write hazards are **source-confirmed**.

`pi-guardian/src/project-policy.ts:76–161` reads an existing policy whether or
not its content is trusted. The project-policy service in `src/index.ts:299–306`
appends the newly approved rule, trusts the resulting **whole file**, and adopts
all its rules. A repository can already contain an unapproved allow entry; a
human approving only "save git push" can thereby approve that other entry too.

The new writer also lacks the sandbox config writer's symlink/containment and
atomic-write protections. Parse and hash use separate reads. Those are important
because this service writes policy with host authority. Concurrent read-modify-
write operations can lose rules or trust updates.

**Recommend:** persist against an approved snapshot, or show and approve the
complete resulting diff when the existing file is untrusted/changed. Bind the
approval to exact bytes and path. Use a mutation queue, single-read parse/hash,
containment checks, symlink rejection and atomic replacement. Apply rules only
from the snapshot whose trust was recorded.

**Accept when:** saving A cannot activate unapproved B; changes during a prompt
invalidate approval; symlinked policy directories/files are rejected; concurrent
saves preserve entries and approved hashes. Test the service, not just append and
hash helpers separately.

### F6 — P2: Guardian mode and broker lifetime can disagree

**Reproduced** (probes 10 and 11).

`pi-guardian/src/index.ts:354–388, 407–460, 546–568` publishes the broker at
startup but does not reconcile it on `/guardian on|off`. Starting disabled and
then enabling leaves no broker; disabling an enabled Guardian leaves its broker
active. The project-policy disposer is assigned but never invoked at shutdown,
leaving a host-policy service closure published after session teardown.

A missing broker deliberately falls back to the human path, which is not the
same authority state as a failed review. UI mode labels therefore cannot stand
in for broker health.

**Recommend:** one explicit lifecycle reconciler with idempotent publish/dispose
for both services; mode changes should transition it immediately. Choose and
document whether turning Guardian off disables the broker or leaves a named
exception-only policy service running.

**Accept when:** startup enabled/disabled, both toggle directions, shutdown,
restart/reload and failed initialization have tested service/state matrices;
shutdown leaves no project-policy writer reachable.

### F7 — P2: headless escalation and recovery are inconsistent

**Reproduced** for inline host defer (probe 5); remaining items
**source-confirmed**.

Separate/scoped-path exceptions use the supervisor helper, but inline host and
network callback defers use a UI-only coordinator. A headless child with a
working supervisor channel is denied on the inline host route without asking.
The typed `ALLOW` token is evidence of a parent-agent reply, not cryptographic
proof of a human decision; the parser accepts lines beginning with that token
and defaults missing scope to session. The instruction to ask the human is the
current human-authority boundary.

The exception denial breaker becomes sticky after three consecutive denials:
every later request is rejected before a rule allow/reviewer can reset it,
including for a different target. A new user turn does not reset it.

**Recommend:** one UI/RPC/headless decision adapter, exact structured decision
syntax, requested-scope upper bounds, and a request-bound approval channel if
human-only authority is a hard requirement. Reset/acknowledge the breaker through
a deliberate user recovery action rather than requiring mysterious restarts.

**Accept when:** identical decisions/scopes result across routes and modes;
non-decision prose cannot approve; explicit new authorization can recover without
allowing the model to evade a denial.

### F8 — P2: the audit records decisions, not complete grant lifecycles

**Source-confirmed.**

Guardian's broker records allow/deny/defer plus `grantId` in session metadata.
The sandbox's pending arrays, host store and overlays do not retain that ID, and
there are no corresponding grant-applied/consumed/revoked records. A defer audit
does not record the subsequent human outcome; a broker allow may be followed by
runtime validation refusal. Historical docs claim stronger consumption auditing
than the code implements.

**Recommend:** a correlated capability ledger and a read-only status surface:
request -> decision -> human outcome if any -> applied/refused -> consumer ->
expired/revoked. Include cwd, actual scope, authority and execution mode; avoid
secret values. Distinguish audit integrity from audit confidentiality.

**Accept when:** each exercised once/denied/deferred/failed path is explainable
from one request ID, including whether anything actually ran on the host.

### F9 — P2: deployed behavior and the model-visible contract can drift

**Observed/source-confirmed; root cause of the active-schema mismatch unverified.**

In this review, installed fork entry-point hashes matched the repo but the
active bash declaration exposed only `command`, `timeout` and
`dangerouslyDisableSandbox`, not the new inline fields. The system guidance can
therefore instruct a model to supply arguments its actual tool schema lacks.
A full restart is a good recovery instruction, not a compatibility test.

Other deployment risks are local to this setup:

- Existing live policy files are kept, so new safety defaults are not migrations.
- Fork manifests and bundled prompts are not deployed, only `src/`.
- Tests resolve SRT 0.0.74, while install may install global `srt` 0.0.81 or keep
  another already-present CLI. The imported package dependency is the relevant
  runtime for the fork, not merely the command on PATH.
- Pi SDK dev versions differ between the forks and the advertised Pi 1.4 host.
- Installer `PI_AGENT_DIR` is not Pi SDK's `PI_CODING_AGENT_DIR`; a custom install
  needs one consistent directory contract.
- Both templates carry the author's absolute maintenance root in addition to
  the root that the installer merges, which is not a portable least-privilege
  default.

**Recommend:** a `doctor`/installation manifest that reports imported package
versions, fork source hashes, loaded tool schema, active broker/services, policy
sources/trust and effective modes. Add explicit migration previews rather than
silently overwrite human config. Pin/test the actual supported SDK/runtime/Node
matrix; fail install if the target agent directories disagree.

**Accept when:** a fresh install and upgrade fixture expose the expected schema
and enforcement; source/config/runtime drift is visible before work begins.

### F10 — P1 assurance gap: tool and child containment is not demonstrated

**Unverified integration**, not an upstream vulnerability finding.

The repo's local sandbox replaces bash and gates named file tools. Other tools
can perform host I/O, and child runners launch outside that bash implementation
unless their integration arranges otherwise. Existing docs alternately say
subagent sandboxing is deferred and that children inherit the parent's profile.
Neither a parent-call review nor inherited network environment proves that.
The local supervisor/runner fixes are useful, but do not establish containment.

**Recommend:** inventory installed tool execution surfaces, with explicit
containment class and approval authority. For each child launch mode (native,
async, external CLI, worktree), verify loaded guards or a real inherited OS
boundary. Declare unsupported modes or block unsafe launches until verified.
Do not re-audit vetted packages wholesale to do this; test the integration seam.

**Accept when:** a sentinel outside the workspace cannot be modified through
normal child work or a nested alternate tool, unless the same deliberate host
capability authorizes it. Test with disposable non-secret fixtures from a fresh
human-started session.

### F11 — P2: validation and guidance promise narrower capabilities than code

**Reproduced** for wildcard acceptance (probe 9); remaining items
**source-confirmed**.

The separate tool says "one exact target, no wildcards", but broker validation
checks strings/enums/reason rather than surface-specific target shape. A
wildcard network target is accepted as a grant in the probe. The inline path
planner similarly accepts glob-shaped absolute paths. Guardian exception path
matching is lexical/home-expanded, unlike canonical file-tool checks; it also
needs directory-root and alias tests for "never grantable" classes.

Guidance says reads are everything except provider credentials, then separately
lists additional credential directories. It treats DNS/auth failures as sandbox
signals although those also have ordinary causes. Trap hints advertise the older
two-call workflow while the newer prompt prefers inline escalation. Static tool
guidelines are built before scratch creation, whereas the system section later
knows the actual scratch path. These are small individually but accumulate into
model hesitation, redundant requests and retries.

**Recommend:** validate/canonicalize each surface once before reviewing it;
explicitly permit directory capabilities versus single-file capabilities and
all-port versus single-port capabilities. Generate one short model contract from
the active tool schema/mode, including maintenance privilege and available grant
routes. Explain ordinary vs policy vs reviewer-infrastructure failure distinctly.

**Accept when:** wildcard/relative/alias/root/port cases are deliberate, tested
choices; advertised never-grantable paths cannot slip to review under alternate
spellings; prompt examples all validate against the active schema.

## Recommended iteration plan

### Round 1 — unify authority and close deterministic mismatches

Address F1, F2, F4 and F5 first. Add registered-tool tests around the common
capability boundary, not more assertions about prompt wording. Repair F3 and F6
in the same capability/lifecycle work only if they remain coherent, separately
verified commits. Keep broad new standing permissions out until then.

**Exit:** identical host policy across routes, isolated once leases, exact
network port semantics, and no trust laundering on persistence.

### Round 2 — make failures understandable and approvals reusable

Address F7–F9 and F11: one decision adapter; explicit recovery; correlated
capability ledger; active-schema doctor; tested installation/migrations; one
concise agent contract. Use deterministic safe tool rules to reduce latency only
after deny/coverage tests, rather than exempting ever more tools by name.

**Exit:** a model can answer "where can I work, why was this denied, what should
I call next?" from the current prompt/tool result, without reading repository
implementation or asking the human to debug the harness.

### Round 3 — prove integration coverage and tune convenience

Resolve F10 with a supported tool/child matrix, fresh-session macOS/Linux tests,
and disposable negative sentinels. Measure reviewer latency, false-denial rate,
repeat exceptions per task and human prompts per successful workflow. Consider
human-reviewed project capability bundles for build caches, sockets, device
tools and Git only after those workflows are measured.

**Exit:** end-to-end scenarios pass with known authority boundaries, not just
helper suites. Establish a supported Node version; the current Node 26 headless
native crash remains a verification limitation, not a passing suite.

## Requirements to clarify before implementation

My proposed defaults are starting points for the next discussion, not changes
made by this review.

| Question | Suggested default / consequence |
|---|---|
| Is a host exception arbitrary execution after approval, or restricted to credential/service operations? | Restricted credential/service class by default; explicit human approval for general host execution. Do not claim syntax filtering alone makes it safe. |
| May Guardian authorize host execution without the human for this task? | Yes only for clearly authorized, narrowly defined classes; ambiguous authority goes to a real approval path, not habitual denial or blanket allow. |
| Can a parent agent approve a child's deferred request? | Not when policy says human-only; use a request-bound human approval. Parent delegation is a separate, explicit authority if desired. |
| Is every subagent/external CLI expected to have identical protection? | Yes for supported coding modes; otherwise visibly unsupported, never assumed inherited. |
| Is project sandbox config permitted to relax global settings? | Permit named capabilities after explicit review; keep hard safety invariants outside replaceable project arrays. Decide whether current full-profile trust is intentional. |
| Is automatic installer maintenance privilege acceptable? | Make it an explicit opt-in maintainer mode, prominently shown; ordinary installs should not acquire it accidentally. |
| Are workspace secrets and other session transcripts readable? | Preserve useful broad source reads, but state the data/privacy boundary and list additional local secret stores before claiming credential safety. |
| Is repo-local policy inherited by subdirectories/worktrees? | Prefer a clearly identified canonical workspace root with explicit worktree inheritance; cwd-only behavior is surprising. |
| What does once mean for host processes and background jobs? | One bound execution including descendants with a defined lifetime, not "until some result event". |
| What are latency and interruption targets? | Measure first; suggest routine reads stay deterministic, a normal build needs no avoidable approval, repeated approved project operations do not re-prompt. |

## Agent stakeholder perspective

The inline shape is the right direction: I should attach a narrow escalation to
the command that failed, receive an actionable result, and continue without a
separate permission bookkeeping turn. Familiar names help only if the schema,
implementation and guidance agree. I should never need to guess whether
"once" means a connection, the next tool result, a matching command later, or a
shared session window.

Likewise, "a denial is final" is valuable for preventing circumvention, but a
policy denial, a model's risk judgement and a broken reviewer are different
states. All should stop unsafe execution; only the first two should be described
as rejected access. Infrastructure failures need a human-readable repair path.
Safe autonomy comes from a predictable contract, not from teaching the model to
keep asking until a route works.
