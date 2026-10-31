# Review verification and evidence limits

Baseline: `2e86f45` (`sandbox: persist a proposed prefix_rule as a project
permission`). This review changes documentation/evidence only. It does not deploy,
restart Pi, change policy, make network Git calls, or repair the findings.

This is a **historical baseline**. Later explicitly authorized Linux/arm64
Node24.22.2 VM verification passes all **178 current Guardian tests**, including
real CLI/HTTP headless with zero skips; see
[the compatible-runtime record](../guardian-container-verification.md). That does
not retroactively make the Node26 baseline green or certify deployed behavior.

## Method and scope

- Read the installer, package pins, templates, architecture/design records,
  vendoring deltas, local implementation and relevant tests.
- Used repository history to distinguish local additions from vetted upstream
  behavior. No upstream security re-audit or upstream network fetch was needed.
- Checked Pi's extension contracts for event order, parallel execution, trusted
  extension code and nested-tool dispatch.
- Ran existing checks and added a disposable mocked integration harness for the
  local seams. Commands in that harness never execute; the SRT manager is mocked.
- Compared repository and installed fork entry-point hashes. Did not inspect
  credentials or run live sandbox escape probes.

The [archived product guide](../product-baseline.md) describes this baseline;
[round 1](../round-1.md) holds later evidence and the
[current product guide](../product.md) describes the changed source. The
[recommendations](recommendations.md) deliberately distinguish reproduced
behavior, source-confirmed problems and integrations still needing verification.

## Existing checks

Environment observed: macOS, Node `v26.6.0`.

| Check | Result |
|---|---|
| `just check` | Pass: shell syntax and template checks |
| `cd forks/pi-sbx && npx vitest run` | Pass: 18 files, 95 tests, without the review probes staged |
| `cd forks/pi-sbx && npx tsc --noEmit` | Pass |
| `cd forks/pi-guardian && npm test` | **Not green:** 73 pass; `headless.test.ts` aborts in Node's native callback/libuv code |
| `cd forks/pi-guardian && npm run check` | Pass, run independently after `npm test` stopped its command chain |
| Guardian tests excluding `headless.test.ts` | Pass: 73 tests |
| Disposable review harness | Pass: 11 probes confirm current contract gaps, not repaired guarantees |

The native failure is the one already recorded in `AGENTS.md`:
`node::InternalCallbackScope::Close`, assertion
`(env_->execution_async_id()) == (0)`. This review reproduced that signature;
it did not independently establish its upstream root cause or run an alternate
Node version. Do not report the full Guardian suite as passing. Re-run it on a
supported compatible Node before treating the headless integration as verified.
No runtime source was modified, so there is no new-fix-versus-clean-baseline
claim attached to that failure.

The exclusion run was:

```sh
cd forks/pi-guardian
node --test $(find test -name '*.test.ts' ! -name headless.test.ts | sort)
```

## Reproducing the review probes

The archived source is [contract-probes.test.ts](contract-probes.test.ts).
Its imports deliberately assume a temporary location in the sandbox fork's test
directory, where Vitest and both forks' dependencies resolve. From the repository
root, with the existing fork development dependencies installed:

```sh
cp docs/review/contract-probes.test.ts forks/pi-sbx/test/review-probes.test.ts
(cd forks/pi-sbx && npx vitest run test/review-probes.test.ts)
rm forks/pi-sbx/test/review-probes.test.ts
```

Remove the staged file even if the command fails. Do not commit it as part of the
normal regression suite: its assertions capture baseline counterexamples and
should fail after the corresponding repairs. Convert each to an assertion of
the desired invariant as that fix is made.

The harness mocks bash execution, SRT operations and scratch lifecycle. It uses
and removes disposable project-local fixtures for configuration/trust data. It
neither executes the sample shell strings nor asks a live reviewer to approve
anything. Mock approval isolates post-decision enforcement from model judgement;
it is not a claim that the real reviewer would approve every sample.

| Probe | Observed baseline behavior | Finding |
|---|---|---|
| 1. Inline host shape | A two-line echo/printf string rejected by standalone shape validation reaches mocked local execution via inline escalation | F1 |
| 2. Host disabled | A separate host grant still executes locally with `allowUnsandboxedCommands: false` | F1 |
| 3. Network once | Granting call's own result clears the token before a following network callback | F3 |
| 4. Concurrent scoped write | Second ordinary execution snapshots a path outside its simulated workspace added for a held-open first execution | F2 |
| 5. Headless host defer | Available supervisor channel is not called; UI-only path denies | F7 |
| 6. Prefix/shape planner | Planner can approve a prefix without seeing the command; validator accepts absolute shell and Python executable spellings | F1 |
| 7. Port rule | An allow rule for `example.test:443` also allows `example.test:8443` | F4 |
| 8. Trust on append | Appending a narrow rule and applying the service's trust update makes pre-existing unapproved entries trusted too | F5 |
| 9. Wildcard request | Explicit no-wildcards tool accepts `*.example.test` as a granted target with a mocked approval | F11 |
| 10. Enable after startup | Disabled startup followed by `/guardian on` leaves broker absent | F6 |
| 11. Disable and shutdown | `/guardian off` leaves broker published; shutdown removes broker but leaves project-policy service | F6 |

Probe 8 exercises the same helper sequence as the service (append, record whole
hash, reload rules), rather than the asynchronous UI prompt. Probes 1, 2, 3, 4,
5, 9, 10 and 11 exercise registered extension handlers with mocked host/runtime
operations. None establishes an actual OS escape or adversarial reviewer bypass.

## Deployment observations

Entry-point SHA-256 comparison showed:

```text
pi-sbx src/index.ts
f8e04a90eb47efc1e1e0da0ab6f22086b4075ca3a9e96b072ded59f4a45c23d5
  repository == installed source

pi-guardian src/index.ts
6c6a9cddb47bc9b14a834bc2e921a6d2dc1977f06cc0be37a4e1d14ef959c68b
  repository == installed source
```

Only those entry points were hash-compared, not the full deployed tree.
The active model-facing bash schema in this session nevertheless omitted
`sandbox_permissions`, `justification`, `prefix_rule` and
`additional_permissions`. The cause could be an older active runtime, schema
forwarding or another integration layer; matching source files cannot settle it.
No restart or reload was performed during review.

The sandbox fork's test-resolved imported SRT version was `0.0.74`. The installer
conditionally installs global CLI `0.0.81` only when needed; it does not establish
that the imported library in every installed environment has that version.
Pi SDK directory lookup in the tested dependency uses `PI_CODING_AGENT_DIR`;
`install.sh` uses `PI_AGENT_DIR`. Custom directory behavior needs a dedicated
installation fixture.

## Not verified here

- OS-level one-shot revocation, concurrent profile isolation or descendant
  lifetime on macOS/Linux. Nested SRT/sandbox-exec testing is not valid from this
  already-sandboxed session.
- Complete protection across subagents, external CLI providers, worktrees,
  extension-internal processes and arbitrary MCP/network tools.
- Live human/RPC approval UX, provider reliability, reviewer latency, false-denial
  rate or resistance to adversarial prompt injection.
- Symlink/race attacks on the new project-policy writer. Its missing protections
  are visible in source; tests used only ordinary disposable files.
- A complete secret inventory, egress prevention, or confidentiality of all
  readable agent-directory data.
- Fresh install/upgrade portability, custom agent-directory support, a full
  deployed-tree comparison, or active-runtime freshness after restart.

Historical macOS probes in the vendoring/design records are useful prior
observations, not fresh verification by this review. Proposed live tests should
use non-secret disposable sentinel files in a fresh human-started session, and
should be scoped as verification rather than attempts to circumvent the active
session's controls.
