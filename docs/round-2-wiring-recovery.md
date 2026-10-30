# Guarded wiring: first candidate review and bounded recovery

The binding contract remains [the wiring lane board](round-2-authority-wiring.md),
including the guarded-mode amendment at `807712a`. **Historical checkpoint:**
the first candidates were not accepted or integrated when this recovery was
commissioned. The terminal correction runs and parent repairs are now accepted
at the source-only launcher/provider gate; see the
[current verification and downstream payload handoff](round-2-wiring-acceptance.md).
The findings below remain the failure-mode history, not current active writers
or unresolved claims about the repaired source. Production child consumers
remain separate required work.

## Evidence and ownership

Workflow `bbaf33f2-179d-40b2-8e05-17d89d5f24c0` is terminal. Launch writer
`c90014e4-e550-4923-8e12-05dab286dfea` timed out at 1,800,000 ms; its process
terminal was observed. Its one steering request failed before consumption, so
implementation of `807712a` cannot be inferred. Provider writer
`06b41a33-3cf0-4764-b5c5-20439f1a0e61` completed and its process terminal was
observed. Both fresh read-only reviews completed. No writer remains active in
either lane at recovery admission.

Parent inspected actual partial/new files, both reviews and saved logs. The
launch candidate (eight files, patch, status, base and logs) is preserved under
`.local/round-2/recovery-launch-c90014e4`; the provider candidate (five files,
patch/status and archive) under `.local/round-2/recovery-provider-06b41a33`.
Existing launch logs show 67 passing async part-3 tests, and 13 single-execution
failures involving restricted process inspection or loopback binding. These are
not evidence of a green affected suite. Parent independently executed:

- launch focused file: **19 pass / 0 fail**; a trailing `async spawn failed:
  write EPIPE` diagnostic still needs investigation rather than suppression;
- provider focused files: **46 pass / 0 fail**.

Logs are `.local/round-2-subagents/{launch,provider}-triage-tests.log`. These
passing candidate tests do not cover the blockers below. An initial parent log
redirection used the wrong relative directory and did not run tests; the
subsequent successful invocation used the actual absolute project log path.

## Parent arbitration: release blockers

1. **Nested launch escape.** Runner consumption is local/ALS-scoped while launch
   activation sees only provider/required-extension registration. A guarded
   runner must reject nested foreground and background launches even outside the
   extension-load ALS callback, after revocation and before placement mutation.
   Capture a process-lifetime code-only refusal latch when the actual runner IPC
   requires admission. It grants nothing, never resets into bare mode and is not
   a model/config/env permission store. Test actual nested dispatch, not just a
   helper input. Inherited depth 1 already means a child launching another child.
2. **Wrapper producer mismatch.** Production stores `launcher: {name, argv}`;
   checking only strings leaves the refusal dead. Reject a configured wrapper
   before spawn/provider preparation and assert no wrapper side effects.
3. **Refusal is too late.** `spawnRunner` checks after `executeAsyncSingle` and
   `executeAsyncChain` create async dirs/fanout descriptors/build progress. Move
   guarded placement admission ahead of those writes and machine/worktree setup;
   keep a final defensive spawn gate. Cover foreground chains/parallel/dynamic,
   workflows, schedule-origin execution, retained/nested and external placement
   at their actual entry points, not only the single foreground path. Refusing
   the entire guarded workflow/scheduled execution is acceptable for this first
   milestone. Do not run workflow script/host steps before refusing it.
4. **Child ceiling is ignored by parent decisions.** Auto-allow requires BOTH
   the immutable prepared child ceiling and the current parent baseline.
   Parent-held maintenance, broad temp, sibling and session scratch roots must
   not silently return. Outside the delegated ceiling, use actual Guardian plus
   explicit human one-action admission even if the parent holds the target or
   the reviewer allows it. Mandatory/configured exclusions still win first.
   Preserve original-cwd anchoring and lexical/canonical checks. Exercise a real
   granted maintenance baseline, not only one where agentDir is already denied.
5. **Guard intent is published after fallible startup.** Registered pi-sbx
   `session_start` currently awaits queue draining, scratch creation, project
   approval and config/runtime initialization before publication. Extension-file
   resolution can also throw before either provider or registration exists.
   Publish unavailable intent synchronously before the first await and before
   extension resolution can fail; unavailable/missing consumers/config/SRT must
   leave a failing guard, not a bare session. Resolve valid required paths and
   register them before any successful prepare. Never replace another owner.
   A missing host identity cannot create authority; launch must refuse unknown
   identity. Do not dispose live-session registration during policy/toggle
   failure or duplicate initialization. Terminal release follows quiescence.

The launch review's `OK with notes` verdict is overridden: its nested escape and
wrapper findings, plus late-mutation admission, block acceptance. The provider
review's blocking ceiling finding is accepted. Worker/helper green evidence
cannot waive any of these.

## Other findings and binding choices

- Refuse proposed workspaces inside the configured agentDir or parent private
  session scratch (including aliases). They are not launch authority merely
  because a maintainer parent can write there. This does not ban a separately
  held ordinary external worktree. Broad temp roots are not copied; workspace
  proposals still undergo baseline/deny checks.
- Required extension paths must be canonical actual files. A missing Guardian
  entrypoint leaves unavailable guard intent and cannot reopen bare launch.
- Audit protection retains existing operation semantics: auth/credential reads
  stay denied; auth/audit writes stay denied. This stage does not introduce a
  new audit-read deny or inspect audit contents. The earlier general phrase
  "audit data" was not a new blanket read policy.
- V1 network payload may deliberately route every child connection through the
  real parent decision route. Do not claim this reproduces parent static network
  policy locally or call it production network containment. Carrying/enforcing
  static network state is an explicit child-consumer design gate before that
  milestone, not an implicit permissive default.
- Correct human-vs-Guardian denial attribution. Prepare network standing-rule
  snapshots lazily only once a defer actually reaches the human, still BEFORE
  the prompt and using the existing trusted snapshot service. No new store.
- Keep production default prepare/arrival bounds at 30s/35s; clocks start at
  different events, so this is only startup slack. No clock-tuning model option.
  Reach preparation promptly. Test cancellation/prepare failure and actual
  process termination; dispose an already-bound lease if factory loading fails.
- Clean up fixture naming/unused imports and the trailing EPIPE cause without
  masking errors. Controlled consumer acknowledgments remain fixtures only.
  Retries must not silently reuse already-claimed readiness as a new session:
  explicitly refuse unsupported guarded retries or document/prove a safe path.

## Correction-pass parent checks (not acceptance)

Continuation workflow `9e5d1102-dfe6-4573-80f9-bc294c8a648b` resumes the original
owners. Provider correction `d9eca61c-6311-422c-a201-ac05d2e13cfd` completed;
launch continuation `6e886ac1-9bac-4027-954f-63b3b0a0ff8c` is the active sole
launch writer at this checkpoint. Fresh reviews are sequenced after both
handoffs. No candidate has been integrated.

Parent independently reproduced the corrected provider's **22 files / 200
passing tests** and passing typecheck. A separate no-write authorization probe
still fails: a target in `ceiling.denyWrite` but not in the loosened current
parent deny list reaches reviewer and human, then returns `allow`. The shared
`authorizePathAction` checks the ceiling's mandatory locks but applies
`pathGrantFeasibility` only to the current parent policy. A prepared configured
write denial must remain final, not become an action-local missing-allow-root
request. Reproducer and output are
`.local/round-2-subagents/probe-corrected-ceiling.{ts,log}`; both reviewer and
human were called once. This remains a **blocking defect** despite the green
suite. Check ceiling feasibility before review as well as parent feasibility,
and add the missing loosened-parent regression before acceptance.

Also still requiring lifecycle inspection: same-session `session_start` sets
`sessionStarted = false` without immediately revoking existing leases; failure
before `reloadConfig` can leave an already-running child's lease signal live.
`session_shutdown` currently removes guard intent before awaiting queue closure.
Verify actual revocation/closing admission rather than accepting the handoff's
claim that all quiescence belongs to another component. These are open parent
findings, not claimed tested fixes.

Launch owner asked for an existing broad-suite assertion update. Parent approved
ONLY the test block at `test/integration/async-execution.part-3.test.ts` originally
named "workflow children keep the mandatory extensions admitted with the workflow
after the host disposes its registration". Its expected earlier missing-provider
refusal may change, but its name/comments/assertions must reflect whether child
discovery/disposal is actually reached. This is not permission for unrelated
integration-suite edits. Supervisor request
`6bb34a71-10fc-4974-aefc-edbdc8ecbb5f` received that bounded reply.

## Correction lanes and handoff gate

Resume the SAME retained native nw-flash writers in their original isolated
worktrees, preserving their model/tool contract and sole ownership. Launch owns
only its original launch files/tests. Provider owns its original files/tests;
its boundary is additionally extended to `forks/pi-sbx/src/path-authorizer.ts`
and `test/path-authorizer.test.ts` ONLY if needed to express explicit
one-action human admission in the existing shared authorizer rather than
keeping duplicate child path-decision machinery. Preserve parent defaults;
no second public API/store and no child consumers. Ask before any other new
production file. Neither writer edits main docs/manifests, commits, deploys,
changes dependencies, delegates, switches runners/models or reads credentials
or audit contents.

Obtain durable corrected handoffs and fresh targeted read-only reviews against
`807712a` AND this recovery record before integration. Writers run focused
regressions/typechecks and affected tests with exact logs; parent runs final
full suites/build/composition after handoffs. Sandbox-caused fixture failures
are reported precisely; any host rerun needs an explicit reviewed request and
is not OS containment proof. Do not spend the correction pass rerunning the
whole product or restarting already completed implementation from scratch.

Native completion wakes the parent. On timeout/failure, stop, preserve changes
and runtime state, and reassess; no duplicate writer or alternate runner.
