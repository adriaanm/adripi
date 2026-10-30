# Guardian context: prune before summarizing

## Status and scope

Source implementation of todo #25, following the operator's request for
aggressive context reduction focused on user directives rather than repetitive
review decisions. No deployment, live configuration/session edit, restart,
provider/model change or guard toggle was performed. The human had disabled
Guardian after its reviewer overflowed approximately 1,054,733 prompt tokens
against a 1,048,576-token limit. The paused, dirty child-authority wiring is a
separate, unaccepted change; no workers own either tree now.

The initial research/design is preserved at `61d3e9b`. Its five synthetic SDK
probes pass with existing SDK 1.0.0 and installed SDK 1.4.0; they are not production
acceptance tests. The implementation uses a supported **owned SDK session**,
not an extension-context cast, raw JSONL rewrite, new permission store or alternate
model fallback.

## One implementation, one durable writer

`src/sidecar.ts` retains the existing Pi executable selection and explicit provider
extension allowlist. It starts a **tool-free JSON-print CLI bootstrap with
`--no-session`**, explicitly loading `src/managed-reviewer.ts`. Its internal
command creates the SDK reviewer. The CLI never sends an ordinary review prompt
to its own model or becomes a second writer of the reviewer UUID.

The managed runner:

1. exclusively locks `.guardian-<UUID>.lock` in the configured audit directory;
2. opens the exact existing reviewer UUID, or creates it if absent, refusing
   ambiguous identities;
3. loads only configured provider extensions, with no tools, skills, prompt
   templates, themes or ambient project context;
4. selects the configured reviewer model **after** provider binding and refuses
   fallback to another model;
5. owns an in-memory settings manager: generic automatic compaction and retries
   are disabled **only in that owned SDK instance**, because this controller
   explicitly manages budgets and structured-output retries. No live settings
   file or Guardian switch is changed;
6. performs pruning, optional summarization and review, then disposes the SDK
   before emitting a nonce-bound terminal result through Pi's native entry event.

A per-UUID parent queue covers **all** `requestGuardianAssessment` callers,
including sandbox reviews and format retries. `maxParallelReviews` still caps
speculative tool-review scheduling, but one UUID has only one durable writer.
Queue time counts toward its deadline. Parent evidence (including new user
restrictions, denials and tool warnings), session identity, config and reviewer
generation are revalidated at queue admission, after the process closes and at
consumption. A changed snapshot blocks rather than accepting an obsolete allow;
a stale action cannot roll back a newer generation or advance its cursor. On timeout/abort, the queue retains
ownership until process close, including TERM/KILL cleanup. A second independent
process is refused by the exclusive lock. Normal/TERM process exit releases its
own lock; SIGKILL or a crash can leave a stale lock requiring human investigation.
Never remove a lock while its owner is running, and never automatically steal it.

Serialization fixes the earlier sibling-leaf loss of denial evidence. It can also
reduce batch throughput; smaller-context latency benefits are not established by
text-size or helper tests.

## Provenance and retention

`src/transcript.ts` extracts **all ordered user text on the actual parent active
branch before character limits or transcript-cursor slicing**. Directive text
and source entry IDs travel separately from the bounded assistant/tool evidence.
A delta cannot omit an old restriction from this directive set. Tools/assistant
messages cannot mint directives by writing a textual “trusted user” label. The
trust boundary is canonical SDK user-message roles and trusted installed
extensions, not hardware attestation: SDK 1.0 does not persist interactive/RPC/
extension input-source metadata on each message. A trusted extension that
synthesizes user-role entries is inside that boundary.

`src/reviewer-context.ts` frames the current review as `guardian-review-v1` JSON:

- `directives`: ordered, source-ID-bearing user text;
- `evidence`: bounded, explicitly untrusted parent context with source IDs;
- `denials`: parent audit denials/failures;
- `action`: the exact action, including nested-call evidence;
- `request`: small review instructions and evidence omission/truncation counts,
  **not another copy of the transcript or action**;
- parent session and policy identity.

The runtime appends protocol/framing instructions to the configured policy, so
existing custom policy files need no live edit to understand this framing.
Policies/templates also document it. Only the current envelope's directives
establish user authorization. Historical verdicts, summaries, labels and action
text do not. These are model evidence semantics, **not a formal prompt-injection
proof or a deterministic authorization cache**.

Completed valid exchanges receive code-owned metadata binding request/response
entry IDs and a digest of the exact envelope. Pruning operates on canonical
active-branch contributions, not all sibling branches. It:

- deduplicates copied evidence by source ID **and content**, keeping conflicting
  content rather than silently trusting an ID collision;
- removes routine allow verdicts and duplicated request boilerplate only after
  their novel actions/reviewer notes are retained as untrusted task evidence,
  retaining a short recent-decision tail (review is not execution proof);
- preserves denied exact actions/rationales, distinct-action negatives, parent
  denies and unresolved malformed/error records outside any lossy summary;
- pins **complete** unknown legacy, malformed, partial, edited or unassociated
  canonical material outside lossy summarization. It cannot prove that material's
  directive/safety evidence was accounted for; an old apparent allow is not enough;
- never treats a prior allow as standing permission or a later allow as erasing
  a prior denial. Current user directives may change authorization; fixed rules
  remain authoritative.

Directives are re-supplied verbatim for each review and are also retained in
checkpoint details. They are never passed to the lossy task-evidence summarizer.
The exact current action and directive set are re-supplied on every format retry;
there is no “same action” reference that might point into pruned history.

## Deterministic checkpoint first, Pi summarization second

The owned public `SessionManager` permits a supported append-only
`appendCompaction(..., firstKeptEntryId: null, ...)` checkpoint. This is the
pruning operation: older raw entries remain intact in the same audit tree, but
their repeated model contributions are replaced by the reduced, typed checkpoint.
It avoids an important lifecycle trap: an extension's session manager is
read-only, and asynchronous `ctx.compact()` callbacks do not by themselves prove
completion before a short-lived JSON-print process exits.

If reduced task evidence still exceeds the target, the runner calls Pi's existing
`generateSummaryWithUsage`, through the **same configured model's ModelRuntime**
with explicit output bounds, cancellation and the stable session ID. Only
untrusted task evidence/previous task summary enters this call. Exact protected
denial records and user directives stay outside it. Empty, aborted,
length-limited, failed or ineffective summaries block the review. Summary usage
is stored once on the checkpoint, not added again to a parent tool result.
Separate Guardian cost presentation is now implemented in source; see
[Guardian-only accounting](guardian-costs.md). Per-attempt records include failed
summaries; successful checkpoints link that already-counted record rather than
adding its cost twice. This is not a live savings benchmark.

No cursor, denial streak, reviewer generation, standing rule or baseline
permission changes merely because pruning occurs. Only the normal successful
parent review advances its existing cursor. Sandbox reviews retain their existing
no-cursor-advance behavior.

## Budgets and recovery

`reviewer.context` has code defaults, also shown in the new-install template:

| Setting | Default | Meaning |
|---|---:|---|
| `maxTokens` | 32768 | Maximum estimated context admission, additionally capped by model headroom |
| `targetTokens` | 8192 | Target retained history after reduction |
| `pruneAfter` | 8 | Completed visible exchanges before another pruning pass |
| `maxDirectiveChars` | 128000 | Protected directive serialization ceiling; excess denies, never truncates |

All values are positive safe integers; target must be below maximum. Initial
reduction, periodic pruning and soft pressure around twice the target provide
hysteresis. Protected evidence may exceed the **soft** target, never the hard
admission limit; this floor does not force another checkpoint after every call. UTF-8 bytes/3
is a heuristic, not an exact provider tokenizer. Admission includes current input,
policy, advertised output allowance and extra margin. A small model or a large
incoming action may require tighter/adjusted budgets; character admission does
not guarantee token fit.

Protected evidence too large for the available budget fails closed. Likewise, a
large legacy history that cannot safely fit summarization headroom requires human
recovery of **that exact linked reviewer session**. No reset, new session, silent
history discard, alternate model, automatic stale-lock removal or repeated
unsafe overflow attempts. Defaults apply to existing config files without merging
or writing them. Live policy/setting changes and installation are separate human
actions.

## Verification and remaining gates

- Guardian typecheck: pass.
- **150 non-headless tests pass**, including actual SDK projection and summary
  calls using a credential-free native faux provider, persistent-UUID factory
  restore, and a **real CLI → internal command → SDK → terminal-result** test.
- Negative tests cover lost/truncated directive regression, forged trust labels,
  distinct denials, mismatched metadata, format retry, prior-success/provider
  errors, cancellation, length/incomplete/ineffective summary, protected/input/
  legacy/small-model headroom, invalid config, nonce mismatch/duplicate results,
  locks, confirmed process-close serialization, queued/running parent restriction/
  denial/tool-warning changes and generation rollback. A large-resume fixture
  reduces the **actual provider request** by over 80% before its first request,
  with no summary call and no raw-audit deletion. That is a size fixture, not a
  live-provider latency/cost benchmark.
- The 20 managed-review tests also pass against the already-installed SDK 1.4.0
  using an isolated source copy and its own native faux provider, on the same
  Node26 runtime. No package installation, dependency switch or HTTP-headless
  bypass. Evidence: `.local/guardian-context/sdk14.log`.
- Full `npm test` was run: **150 pass, one existing HTTP headless test fails by
  Node26's native libuv assertion** `env_->execution_async_id() == 0`. Evidence:
  `.local/guardian-context/full-test.log`. No alternate runtime was installed or
  silently selected. Todo #4 remains the compatible-runtime gate; full runtime
  acceptance is not claimed.

The earlier mechanism probes remain in
`docs/review/guardian-pruning-probes.test.mjs`. The implementation tests live in
`forks/pi-guardian/test/{managed-reviewer,context-config,sidecar,transcript}.test.ts`
and the registered Guardian/broker suites. They do not establish live-provider
latency, cost savings, a restarted installation or OS/production-child containment.
