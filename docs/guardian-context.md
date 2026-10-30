# Guardian context: prune before summarizing

## Status and operator direction

This is a **source investigation and proposed implementation contract**, not a
shipped compaction feature. Todo #25 takes priority over the paused, uncommitted
child-authority wiring. The operator wants aggressive context reduction for fast
Guardian responses and specifically requested our own pre-compaction pruning,
preserving user directives while filtering repetitive decisions. Separate cost
reporting remains todo #24.

The operator manually compacted a linked reviewer successfully in another
session. This session also reached approximately 1,054,733 prompt tokens against
a 1,048,576-token context limit, blocking even a todo update, and the operator
then explicitly disabled Guardian here. No agent action changed the live toggle,
configuration, reviewer JSONL, deployment or runtime. Manual recovery is evidence
of usability, not an end-to-end test of automatic recovery.

## What the current code actually does

- `forks/pi-guardian/src/sidecar.ts` starts **one short-lived JSON-print process
  per review/format retry**, with the same persisted reviewer session UUID. There
  is no Guardian-specific context budget, pruning or compaction protocol. Generic
  Pi settings/behavior can affect the subprocess; we have not established which
  setting or runtime behavior caused this particular overflow.
- `src/index.ts` pre-launches up to `maxParallelReviews` speculative tool reviews.
  The first review bootstraps before fanout, but later processes can open the
  same reviewer session concurrently. The README explicitly describes following
  the latest leaf instead of merging siblings. The sandbox broker uses this same
  reviewer conversation but does not go through the tool-review slot queue.
- Tool prompts repeat fixed denies, trust instructions, transcript and the exact
  action. Format retries add more turns. Sandbox-exception reviews deliberately
  send a **full bounded transcript**, not a delta, and do not advance the parent
  tool-review cursor. Simply shortening assistant verdicts misses much of the
  repeated input.
- `src/transcript.ts` separates user/assistant/tool provenance but selects entries
  newest-first against shared character limits. User entries can be omitted or
  truncated. A pruner cannot use that already-bounded text as its only source of
  user directives. `src/prompt.ts` uses textual trust labels; parsing those labels
  back out of untrusted message bodies would not establish provenance.
- `src/state.ts` owns the stable reviewer link, generation, denial streak and
  parent transcript cursor. Pruning/compaction must not reset any of them or
  advance the cursor merely because history was shortened. Existing fixed rules
  remain authoritative outside the reviewer; this work adds no permission store.

## Supported Pi mechanisms and probes

The installed Pi 1.4.0 compaction/extensions/session-format docs and the Guardian
1.0.0 development SDK expose the necessary building blocks:

1. `SessionManager.buildSessionProjection()` supplies canonical, branch-relative
   model context with source-entry provenance.
2. Append-only `context_edit` entries can omit or replace earlier message
   contributions. Original entries, usage and audit history remain stored.
3. `turn_end` / `agent_before_settle` support proposed context-edit/custom-message
   entries at a validated lifecycle boundary. An extension context's session
   manager is **read-only**: do not cast around it to call mutators directly.
4. Pi compaction prepares its input from that canonical projection. A transient
   `context` hook filter alone would shrink one review but still leave repeated
   material for subsequent compaction. Use canonical edits for persistent pruning.
5. Use supported `AgentSession.compact()` / lifecycle integration for actual
   summarization, not a new summarizer or handwritten JSONL/checkpoint rewriting.
   The `ctx.compact()` callback example is useful reference, but is **not proof**
   that an asynchronous compaction completes before a JSON-print sidecar exits.
   Check and test the real process/lifecycle before choosing that binding.

Research probes: `docs/review/guardian-pruning-probes.test.mjs`.

```sh
node --experimental-strip-types --test docs/review/guardian-pruning-probes.test.mjs
# Optionally set GUARDIAN_PROBE_SDK_ROOT to an existing Pi package root.
```

**Five probes pass with both existing SDK 1.0.0 and installed SDK 1.4.0**, Node
26.6.0. They use synthetic in-memory sessions and no AgentSession, provider,
credentials or real reviewer audit. They show:

- omitting fixture-associated old allow exchanges shrinks projected content by
  more than 80%, leaving the fixture's directives, denial and two recent pairs;
- the original serialized entries stay identical and a second pruning pass adds
  no redundant edits;
- actual compaction preparation excludes the omitted input;
- selecting a sibling/pre-edit branch can bypass the edits or omit a denial;
- today's bounded parent renderer can omit an old explicit user restriction.

These are **mechanism/counterexample probes**, not a production classifier,
security acceptance, latency benchmark or evidence of model judgment quality.
The probe imports internal `prepareCompaction` only to inspect preparation; that
is not a proposed production dependency on an internal SDK export.

## Proposed retention contract

### 1. Parent-owned, provenance-bearing evidence

Prepare one structured review envelope for both tool and sandbox reviews. Supply
user directives independently of the bounded assistant/tool transcript, from the
same actual parent active-branch snapshot used to prepare the review:

- ordered source session/entry IDs and exact user text, including restrictions,
  reversals and current task intent;
- source IDs, action identity and rationale for relevant prior denials, plus
  unresolved failures/safety evidence and pending review identities;
- bounded, explicitly untrusted recent task evidence;
- the exact current action, including nested parent-call evidence, unchanged;
- generation, parent cursor and schema/version association.

Do not infer a user's authorization from assistant prose, a prior `allow`, a
model-produced summary or strings saying “trusted user”. Do not regex-scrape the
current free-form prompt to create a supposedly trusted ledger. Preserve text
quoting and order; identical directives in different task/turn contexts are not
necessarily interchangeable. An oversized protected directive set must be
explicitly handled (or fail closed), never silently truncated to meet a budget.
This envelope is evidence for existing review, **not new held/standing authority**.

### 2. Deterministic pruning first

Prune only **completed, code-associated** exchanges whose retained evidence has
been accounted for. Start with the clearly redundant parts:

- repeated policy/trust boilerplate already supplied for the current review;
- duplicate copies of parent evidence identified by source entry IDs/content;
- routine old allow verdicts, without turning an aggregate count into permission;
- old request/response wrappers after their directive, denial and novel evidence
  contributions have been retained elsewhere in the projection.

A completed `allow` by itself does **not** prove its whole request is redundant:
that request may contain a newly revoked authorization, an error or a security
warning. Account for those separately before pruning the pair. Keep a small
recent tail, but do not use “last N messages” as the sole retention rule. Unknown
legacy prompts, malformed/failed reviews, incomplete pairs and speculative
unconsumed reviews are ineligible until safely migrated or accounted for.

Keep earlier denials and their target/scope/reason even after later allows. Only
actual user evidence may change authorization, and it does not automatically
withdraw fixed restrictions. Do not coalesce different actions by command
prefix, tool name, path similarity or a model's “equivalent” label. Allows never
become an authorization cache. Retain unresolved safety evidence; exact duplicate
records may reference one copy only when provenance/ordering remain explicit.

### 3. Aggressive budget; summarization only for residual context

Aim for a small working history, not a fraction of a million-token model limit.
An initial **tuning proposal**, not a measured SLA: roughly 16k estimated tokens
of retained history, with pruning/compaction triggered around 32k and a short
recent tail. Include policy, directives, the incoming envelope, output and summary
headroom in admission; a single incoming review may itself exceed those history
targets under today's character limits. Characters/4 is an estimate, not an exact
or universally conservative tokenizer. Small models require tighter headroom.

Re-estimate after deterministic pruning. Skip the LLM compaction when pruning is
sufficient. Otherwise compact the residual task evidence with safety-focused
instructions, preserving/re-supplying the exact directive and denial evidence
outside any lossy summary. Check the projected result before allowing another
review. Failure, abortion, unavailable budget or ineffective compaction remains
fail closed. No reset/fork/model switch, silent omission of the active action or
unbounded retry to evade overflow. Use hysteresis/idempotence to avoid compacting
after every tiny review.

### 4. One writer per reviewer session

Pruning is branch-relative, so adding a pruner to the existing concurrent
same-UUID writers is unsafe. One coordinator must cover **all** users of
`requestGuardianAssessment`, including sandbox reviews and format retries, and
own admission, pruning, compaction and session write/exit. A timed-out process
must be confirmed terminal before releasing that ownership; today's sidecar
rejects promptly on timeout while termination may still be pending.

Prefer a single serialized durable reviewer writer for the initial integration.
Do not silently claim to preserve existing parallelism, or add independent
reviewer sessions without a separately reviewed merge/provenance contract.
Speculative preparation may still happen in parallel, but stale prepared
snapshots must not skip directives/denials committed before their admission.
Measure per-action and batch latency: smaller context may help, serialization
may hurt batch throughput, and neither effect is established by these probes.

### 5. Audit, compatibility and acceptance

Pruning changes future model projection, not raw audit, parent transcript cursor,
denial streak, generation or action binding. Require observable completion of the
trusted context manager before accepting a verdict: extension hook failures may
otherwise be logged while Pi continues. Preserve failure/help attribution and do
not accept earlier assistant text after a later failed turn/compaction.

Existing reviewer history has no typed pruning association. Migration must not
pretend arbitrary legacy prompt text has verified directive provenance. Rebuild
from actual parent branch/audit evidence where possible; retain unknown evidence
or refuse automatic migration when that cannot be done safely. Do not edit live
JSONL to retrofit metadata or discard a history simply because it is too large.

Required acceptance before claiming delivery:

- real registered reviewer lifecycle before the first provider request, including
  an already-large resumed history; actual pruning followed by actual compaction;
- provenance/injection/changed-authorization tests, old denies followed by allows,
  distinct-action negatives, malformed/failed/partial review retention;
- duplicate full sandbox transcript and format-retry coverage;
- simultaneous tool and broker reviews, cancellation/timeout/process termination,
  branch/restart/generation isolation, and no stale-leaf/cursor regression;
- explicit small-model/large-input/output headroom and failed/no-op compaction;
- separate input/output/cache/compaction usage, count/frequency and elapsed times,
  with no price or latency claim from text-size reduction alone;
- full non-headless suite/typecheck plus the existing compatible-runtime headless
  gate (Node 26's known native crash is still unresolved).

## Scope boundary

No implementation/deployment is certified by this record. The old wiring
candidates and parent repairs remain untouched and unaccepted. This investigation
uses no workers, new dependency, provider calls or live-session access. Source
implementation, tests and documentation are the next step; installation, live
configuration changes and restart remain separate human actions.
