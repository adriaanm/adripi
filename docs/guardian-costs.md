# Guardian-only usage and cost reporting

## Reporting plan (before implementation)

Keep Guardian separate from Pi's parent/subagent usage totals: **never** insert
synthetic assistant/usage messages into the parent, modify its native statistics,
or sum a compaction's usage a second time. Show Guardian tokens and the known USD
estimate in its existing status widget; `/guardian costs` gives the review,
format-retry, summary and legacy breakdown. Persist custom accounting entries so
restore, checkpointing and a new reviewer generation cannot reset spending.

The owned managed reviewer supplies bounded, nonce-correlated cumulative snapshots
for its UUID. Count individual assistant responses (including format failures and
provider-error partial usage) and every summary provider attempt, including failed
or ineffective summaries. Record summary attempts independently before checkpoint
validation; link successful checkpoints to that record so they are not charged
again. Restore historical assistant/checkpoint usage without claiming to know
whether legacy responses were format retries.

The parent upserts the highest revision per reviewer UUID across its full session
entry tree, not merely the active branch. Duplicate/out-of-order reports cannot
add spending twice; model/policy generations accumulate rather than replace one
another. Telemetry is independent of authorization: a stale or denied verdict may
still cost money and never advances the review cursor through accounting.

Use reported SDK USD estimates, or explicit nonzero model token tariffs for new
calls. Absent/zero-only tariffs with zero reported cost are **unpriced**, not a
claim of free inference. Missing/invalid usage is **unreported**, not zero tokens
or dollars. Timeout/SIGKILL/no final telemetry leaves an explicit transport gap;
never fabricate a complete provider bill. These are SDK estimates, not an invoice,
and do not include subscription pricing or currency conversion.

No live configuration, session contents or Guardian toggle is changed by this
source work.

## Implemented source behavior

`src/usage.ts` owns the single accounting projection and formatting. Managed
reviewer custom records retain per-attempt totals and source assistant IDs;
successful summary checkpoints link their already-counted summary record.
The full SDK entry tree supplies cumulative snapshots, including sibling branches
and historical assistant/compaction/standalone usage entries in that reviewer.
Legacy responses are explicitly unclassified rather than guessed to be first
calls or retries. Older **inactive** reviewer generations predating telemetry are
labeled as lacking historical coverage, not assigned a zero bill or silently
opened for bulk retrospective migration.
Zero-filled SDK token placeholders are unknown even on successful responses,
not free. Token coverage and pricing coverage are independent: a known reported
USD amount is retained even when token usage is missing. Tiny positive estimates
show `<$0.0001` rather than rounding to a seemingly free `$0.0000`.

`sidecar.ts` accepts usage only with the request nonce and exact parent/reviewer
UUIDs, separately from the four-field authorization result. Duplicate or malformed
telemetry cannot establish approval. The parent records a pending transport
**before** launch and resolves it only with a correlated final report. Spawn,
timeout, missing telemetry and process-loss gaps remain explicit. If the parent
switches sessions during a review, late reports cannot write to the new session;
the original parent's pending record remains **pending/unreconciled** on restore.
A subsequent reviewer run can recover durable costs, but cannot fabricate a
provider bill for a call killed before its usage was saved.

`index.ts` observes both tool and sandbox-review paths, including speculative,
failed and stale reviews; fixed-rule actions do not create model charges. Its
parent records are `pi-guardian.usage` custom entries, invisible to native Pi
usage totals/model context. The existing status widget adds a Guardian-only line,
and `/guardian costs` prints the breakdown without changing the enabled flag,
configuration or model. With no UI the command emits `pi-guardian.cost-report` as
an extension custom entry. Costs persist even while Guardian is disabled.

The display is a **known USD estimate**, not a claim about subscription billing.
Zero/absent tariffs are explicitly unpriced; invalid/missing usage is unreported.
Known token totals can coexist with unknown monetary cost. Snapshots are fixed-
shape/bounded; counter overflow/invalid values cannot become a zero-cost success.
Accounting does not authorize tools, mutate review cursors or add standing grants.

## Verification (Node v26.6.0, no provider credentials/network)

- Guardian typecheck passes.
- Full `npm test`: **165 tests, 164 pass**. The only failure is the previously
  reproduced HTTP headless native Node26 assertion
  `(env_->execution_async_id()) == (0)`; not a telemetry regression or clearance.
- **27 managed-review/accounting tests pass against the already-installed SDK
  1.4**, in the isolated source fixture on the same Node runtime; no installation,
  dependency/runtime replacement or loaded-extension change.
- The actual CLI → managed SDK → native custom-entry → parent transport test
  verifies nonce/UUID-bound usage, while a second managed process restores the
  exact reviewer and reports two cumulative calls, not zero or three.
- Tests cover per-kind retries, failed/ineffective/aborted summaries, partial
  provider errors, linked checkpoint non-duplication, actual SDK sibling-branch
  accounting, multiple generations, duplicates/out-of-order snapshots, pending
  loss and malformed telemetry. Cost entries add no native parent usage or model
  messages. Registered Guardian tests verify `/guardian costs`, widget restoration
  and an unchanged toggle/config; stale/error verdicts retain costs without
  admitting actions.
- `just check` and `git diff --check` pass. Current ignored evidence is under
  `.local/goal-costs/`.

This is source/credential-free integration acceptance, not live deployed billing,
provider invoice reconciliation or a latency/cost-savings benchmark. Deployment,
compatible-runtime full HTTP headless and live performance acceptance remain
separate gates.
