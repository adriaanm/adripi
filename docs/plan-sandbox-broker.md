# Plan: guardian-mediated sandbox exceptions

Status: **approved, not started.** This document is the design record and the
progress tracker for replacing `pi-perm` with a sandbox layer whose every
escalation is decided by `pi-guardian` or, when the reviewer defers, by the
human.

## 1. Why

Two findings from the current stack, both verified by running it:

1. **`pi-perm`'s SRT wrapper is malformed.** `core/srt.ts:99` emits
   `srt --settings <file> <raw command>`. `srt` takes argv (`Usage: srt
   [options] [command] [command...]`, with `-c <command>` for a shell string),
   so only the first statement of a compound command is sandboxed and the rest
   runs in the parent shell. Observed in this session:

   | Command | Result |
   |---|---|
   | `touch ~/.gradle/x` | `Operation not permitted` (sandboxed) |
   | `true; touch ~/.gradle/x` | succeeds (second statement outside the sandbox) |
   | `for u in …; do …; done` | `/bin/bash: syntax error` inside `srt --settings … for u in …` |
   | `curl -sS …` | `Error: S does not exist` — srt's CLI parsed `-sS` as `-s S` |
   | `cd /path; pwd` | `cd` only affected the srt child |

   Consequence: the OS boundary is absent for most real bash calls, `cd` and
   `$VAR` do not behave, and SRT denials surface as bare `EPERM` with no
   approval path. `:danger-full-access` is also unusable: it maps
   `domains: {"*": "allow"}` to `allowedDomains: ["*"]`, which SRT rejects, so
   every wrapped call aborts before running.

2. **`pi-guardian` and `pi-perm` are independent gates with no shared state.**
   Guardian's `src/` contains no reference to sandbox, SRT, or permissions. The
   reviewer sees the pre-wrap command, cannot know whether the sandbox will
   permit it, and has no way to grant anything. Conversely a user approval in
   `pi-perm` cannot stop guardian from denying the same call afterwards.

A survey of ten SRT-based Pi extensions (Pi's bundled example, `pi-sbx`,
`pi-permission-modes`, `pi-sandbox` (carderne), `pi-claude-sandbox`,
`@oddsjam/pi-sandbox`, `@sysid/pi-sandbox`, `@ikuradon/pi-guardian`,
`@erichll/pi-sandbox` + `pi-auto-review`, `pi-playpen`, `pi-os-guard`) found
exactly one with a reviewer seam — `@erichll`'s broker — and none that lets the
model *ask* for an exception before acting.

## 2. Goal and non-goals

**Goal.** One OS boundary, one reviewer, one decision path:

- the model can call a tool to request a sandbox exception, with a reason;
- every exception request is reviewed by guardian, or escalated to the human
  when guardian defers;
- an approved exception widens the sandbox for exactly what was approved and
  the command re-runs **inside** the sandbox;
- hard-deny classes (credentials, Pi security configuration, `.git/hooks`)
  never reach the reviewer and cannot be granted;
- the human remains the only source of persistence ("forever").

**Non-goals.** Windows support; replacing `pi-review`; subagent sandboxing in
the first iteration (candidate follow-up, see §9); a second model judge
(`pi-auto-review` stays out); dynamic grants for `read` outside the static
policy.

## 3. Requirements

| Id | Requirement |
|---|---|
| R1 | Bash runs in SRT as a whole command string, never argv-spliced by a CLI |
| R2 | A model-callable `request_sandbox_exception` tool exists, one target per call, `reason` required |
| R3 | Every exception request goes to guardian first; `defer` routes to the human prompt |
| R4 | Approved exceptions widen the sandbox for that run/session and re-run sandboxed; a host retry is human-only and explicit |
| R5 | Deterministic guardian rules deny credential/config paths before any model call |
| R6 | Scopes: `once` (single call), `session` (in-memory overlay), `forever` (human-only, persisted) |
| R7 | Every request, verdict, grant and consumption is auditable from guardian's side |
| R8 | The old stack keeps working until the swap phase lands |
| R9 | A per-session scratchpad is writable inside the sandbox without any exception, and its path is advertised to the model |

## 4. Design

### 4.1 Shape

```text
model tool call                SRT violation trap
      │                                │
      └────────► broker.review(req) ◄──┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  hard-deny rule   guardian review   defer
  (no model call)        │              │
        │           allow │ deny       ▼
        └───────────────►│◄──────── human prompt
                         ▼
              widen run/session policy
                         ▼
              re-run inside the sandbox
```

### 4.2 Broker contract

Defined in the guardian fork, consumed by the sandbox fork. No dependency on
`pi-auto-review`; the vocabulary is borrowed from its
`integrations/sandbox.ts`, the implementation is ours.

```ts
export type SandboxSurface = "command" | "network" | "read" | "write";

export type SandboxExceptionRequest = {
  id: string;
  origin: "tool" | "trap";        // model-asked vs SRT-blocked
  surface: SandboxSurface;
  target: string;                 // exact command | host:port | absolute path
  scope: "once" | "session";      // the model may ask; policy may downgrade
  reason?: string;                // required when origin === "tool"
  cwd: string;
  command?: string;               // origin === "trap"
  violation?: string;             // origin === "trap", SRT violation text
};

export type SandboxExceptionDecision =
  | { kind: "allow"; scope: "once" | "session"; review: { rationale: string } }
  | { kind: "deny"; reason: string; review: { rationale: string } }
  | { kind: "defer" };

export interface SandboxBrokerService {
  review(request: SandboxExceptionRequest): Promise<SandboxExceptionDecision>;
}
```

Slot: `globalThis[Symbol.for("pi-guardian:sandbox-broker")]`, published by
guardian at `session_start`, disposed at `session_shutdown`, with a
`publish` that throws on double-publish (same discipline as
`pi-auto-review`'s broker slot, minus the dependency).

### 4.3 Model tool

```ts
request_sandbox_exception({
  surface: "command" | "network" | "read" | "write",
  target: string,
  scope: "once" | "session",
  reason: string,
})
```

Deliberate limits:

- no `forever` from the model;
- one target per call (no wildcard grants);
- `read` requests are accepted only for paths the static policy already
  abstracted (see §4.6), otherwise they are denied with an explanation;
- the tool result states the decision and, on deny, instructs the model not to
  rephrase or retry the same target.

### 4.4 Decision order

1. **Hard deny** (always-deny classes plus `sandboxExceptions.deny`): credential
   stores, `~/.pi/agent/**`, `.env`/key/pem writes, `.git/hooks`. Never reaches
   the reviewer, never grantable, explains why.
2. **Defer** (`sandboxExceptions.defer`): classes you have named as the human's
   own call. No reviewer, no grant — the sandbox shows its prompt.
3. **Policy allow** (`sandboxExceptions.allow`): no request needed; the tool
   returns "already permitted" so the model learns the boundary.
4. **Reviewer** (guardian sidecar): reuse the durable reviewer conversation and
   the parent transcript; return `allow` (scope may only narrow), or `deny`
   (with a reason). The standard four-field assessment is used unchanged, so
   `defer` is never a model decision.
5. **Human** (defer above, or the sandbox's fallback when no broker is
   published): the sandbox prompt; no UI means deny.
6. **Breaker**: consecutive exception denials in one session stop further asks
   without another reviewer call (mirrors `maxConsecutiveDenials`).

### 4.5 Widen-and-rerun, not host-retry

`@erichll/pi-sandbox` reacts to a trap with a one-shot grant and re-runs the
command **on the host, outside the sandbox** (documented: "the first sandboxed
attempt may already have had partial side effects"). We do the opposite:

- `write` → add the exact path to that run's `allowWrite`;
- `network` → add `host:port` to that run's `allowedDomains`;
- `command` → add the exact command to the session exclusion list (this is the
  one case that runs unsandboxed, and it is human-only).

Rationale: an exception must never silently downgrade the whole command out of
the sandbox, and a partial-effects retry is worse than a policy widening. The
per-command override hook already exists in the chosen substrate
(`wrapWithSandbox(command, undefined, writeGlobOverride, …)`).

### 4.6 Security invariants

- The model cannot grant itself anything: every decision is made outside the
  tool call, by guardian or the human.
- NO grant is issued for a request that a hard-deny rule matches, regardless of
  reviewer opinion.
- Grants are bound to the exact target and scope; `once` grants are single-use,
  keyed by request id, and expire with the run.
- A failed or malformed reviewer response is a denial (existing fail-closed
  behaviour), never a `defer`-to-allow.
- An unavailable sandbox still prompts before running bash (substrate
  behaviour) — exceptions cannot be used to bypass a missing sandbox.

### 4.8 Scratchpad (policy, not an exception)

The agent needs somewhere to put temporary files that does not cost a reviewed
exception. Each session gets one directory under the host temp tree
(`pi-sbx-scratch-*`), created at `session_start` and added to the effective
runtime profile's `allowRead`/`allowWrite` only — never to the persisted config.
The path is exported to sandboxed commands as `PI_SANDBOX_SCRATCH`, named in the
bash tool's prompt guidelines, removed at `session_shutdown`, and stale
directories are swept by age (24 h) on the next start.

Properties: nothing else under the temp root becomes writable; the profile is
recomputed per reload from the user's layer plus the scratch dir, so a config
reload cannot persist or widen the grant; and an exception is never needed for
scratch work, which keeps the reviewer focused on real boundary crossings.

### 4.7 Audit

Guardian appends an assessment record for every request (`origin`, `surface`,
`target`, `scope`, `verdict`, `rule`, `rationale`, `grantId`), reusing the
existing durable-entry mechanism so requests survive resume but never enter the
parent model's context. The sandbox side logs consumption of `once` grants.

## 5. Components

### 5.1 `forks/pi-guardian` (ours)

| File | Purpose |
|---|---|
| `src/index.ts` | rebase to 0.2.0; keep `reviewer.extensions`; publish/dispose the broker; track the latest ctx for reviews |
| `src/sandbox/types.ts` | broker contract (`SandboxExceptionRequest` / `Decision` / `Rules`), durable entry name |
| `src/sandbox/rules.ts` | `surface:pattern` rules, always-deny classes (credentials, agent dir, secret writes), allow/defer/deny precedence |
| `src/sandbox/broker.ts` | `Symbol.for` slot, request validation, decision mapping, scope narrowing, audit rows, denial breaker |
| `src/sandbox/review.ts` | reviewer prompt + `sandboxOutcomeFromAssessment` (scope narrows, never widens) |
| `prompts/guardian-policy.md` | sandbox-exception clause: trusted-user authorization only, credentials/security config denied, ambiguous → deny |
| `test/sandbox-{broker,review}.test.ts` | allow/deny/defer/hard-deny/breaker, no reviewer call on hard deny, prompt contract, scope narrowing |

### 5.2 `forks/pi-sbx` (new vendored fork; base `pi-sbx@0.1.3`)

Chosen substrate because it wraps correctly, tags every command with an id,
annotates violations (including the macOS settle window), keeps a session
config layer, and isolates escalation in one module.

| File | Purpose |
|---|---|
| `src/scratch.ts` | **done** — session scratchpad (`withScratchpad`, create, sweep, `PI_SANDBOX_SCRATCH`) |
| `src/broker.ts` | client, human fallback, `defer` routing |
| `src/index.ts` | register `request_sandbox_exception`; route `prompts.requestUnsandboxed` / `requestNetwork` through the broker; widen-and-rerun on traps |
| `src/prompts.ts` | human prompt kept, only reached via `defer` |
| `src/config.ts` | session-scope overlays for granted paths/hosts |
| `test/broker.test.ts` | tool → guardian allow/deny/defer; trap → reroute; no-grant-on-hard-deny |

### 5.3 Repository wiring

- `forks.txt`: add `pi-sbx|forks/pi-sbx`.
- `install.sh`: install `pi-sbx` from npm, then rsync the fork's `src/`.
- `packages.txt`: drop `pi-perm`, add `pi-sbx`.
- `config/`: replace `pi-perm.config.json` with a sandbox template
  (`extensions/pi-sandbox/config.json` or the fork's config shape), seeded
  without overwriting.
- `scripts/check-configs.mjs`: validate the sandbox template and assert
  `pi-perm` is gone.
- `docs/architecture.md`: rewrite layers 1 and 2 once the swap lands.
- `README.md`: stack table edit.

## 6. Alternatives considered

| Option | Why not |
|---|---|
| Keep `pi-perm`, patch `wrapCommandWithSrt` to use `-c` | Fixes the wrapper but leaves two independent gates and no exception channel; still no model-requested exceptions |
| Fork `pi-permission-modes` | 1651-line dispatcher monolith, weekly releases, zero seam; rebase tax dominates the ~150 LOC of glue |
| `@erichll/pi-sandbox` with `pi-auto-review` | The broker seam is right, but `pi-auto-review` is a second model judge with its own dialogs and `/auto-review` commands; and its trap flow retries on the host |
| `@erichll/pi-sandbox` with guardian publishing its broker | No fork needed in principle, but the published 0.28.1 statically imports `@erichll/pi-auto-review/broker` at load (`Cannot find module` without it), so "inert dependency" reuse means installing that pair anyway; its interface is theirs, grants are one-shot host retries, and there is no model-facing request tool |
| Write the SRT layer from scratch | Rebuilds per-command ids, violation annotation, macOS settle handling, policy assembly and tests that `pi-sbx` already has; revisit only if the fork proves unstable |
| `pi-sbx` as-is, guardian as a passive reviewer | No escalation channel: an SRT denial stays a dead end |

Borrowed ideas: `@erichll`'s request/grant vocabulary and its hard-deny stance;
`@ikuradon/pi-guardian`'s reviewer-on-violation; `pi-sbx`'s per-command ids and
scoped config overlay.

## 7. Risks

| Risk | Mitigation |
|---|---|
| macOS Seatbelt path unproven in `pi-sbx` for our use | Phase W2 is a spike; abort criteria: violation traps or per-command overrides do not fire on darwin |
| Rebase tax on two vendored forks | Both patches stay small (guardian ~110 lines inherited; sandbox patch confined to `broker.ts`, `index.ts`, `config.ts`); record the patch set in `VENDOR.md` |
| Reviewer latency on a blocked connection | Network trap review happens inside the command's lifetime; keep reviewer timeout below the command timeout, and let `defer` fall through to the human |
| Model spams exception requests | Breaker + deny reasons that forbid rephrasing + audit |
| Temptation to widen the static policy later | Widen-and-rerun only touches the run, never the persisted policy; `forever` stays human-only |
| Two approvals (guardian + human) feel like double friction | `defer` only for genuinely ambiguous cases; guardian `allow` proceeds without a prompt |

## 8. Verification

**Spike (W2).** On macOS, with the substrate installed and guardian's broker
published:

1. benign command → runs sandboxed, no prompt, no broker call;
2. `touch ~/.ssh/x` → trap → guardian denies (hard deny), model told not to retry;
3. `touch ~/.gradle/x` with `~/.gradle` absent from policy → model calls
   `request_sandbox_exception` → guardian allows `once` → command re-runs
   **inside** SRT with the widened write set → succeeds;
4. `curl https://registry.npmjs.org` → network trap → guardian allows
   `host:port` for the run → succeeds; an unlisted host still fails;
5. guardian `defer` case → human prompt appears, deny path stays denied;
6. `forever` scope is refused when requested by the model, offered only by the
   human prompt.
7. Scratchpad: `printf hi > "$PI_SANDBOX_SCRATCH/p" && cat "$PI_SANDBOX_SCRATCH/p"`
   succeeds inside the sandbox with no prompt; a write to the host temp root
   outside the scratch dir still fails; the directory is gone after shutdown.

**Matrix** is recorded per phase; each phase's exit criteria are listed in §9.

### Spike results (W2, macOS)

Run in isolation with `pi -ne -e npm:@aliou/pi-neuralwatt -e npm:pi-sbx ...` so
only the substrate and the provider are loaded (no `pi-perm`, no other packages):

| Probe | Result |
|---|---|
| `touch ./sbx-probe-in-project && echo PROJECT-OK` | `PROJECT-OK` — compound command ran **inside** the sandbox as one unit |
| `touch ~/.gradle/.sbx-probe` | `Operation not permitted` from the sandbox, reported to the model as a sandbox restriction with an explicit escalation offer |
| `echo GUARDIAN-SBX-OK` with the guardian fork loaded too | allowed, executed; guardian's sidecar reached `neuralwatt/deepseek-v4.1-flash` through `reviewer.extensions`, confirming the 0.2.0 rebase works in a live session |

Conclusions: seatbelt wrapping, violation reporting and guardian's tool review
all work on darwin; `pi-sbx` and guardian coexist (one bash owner, one
reviewer). Anti-conclusion: `@erichll/pi-sandbox@0.28.1` fails to load without
`@erichll/pi-auto-review` present, so its "seam without the extension" story
only holds after a fork that inlines the adapter.

## 9. Worklist

- [x] **W1 — Guardian 0.2.0 rebase.** Port `reviewer.extensions` and the
  subagents child-runner detection onto upstream 0.2.0. Exit: `node --test`
  green, the sidecar still reaches the neuralwatt reviewer, and the fork's patch
  set is recorded in `VENDOR.md`.
- [x] **W2 — Substrate spike (macOS).** Verified per-command wrapping,
  violation reporting, in/out-of-project writes, and coexistence with the
  guardian fork (§8). Session config overlay and the per-run `allowWrite`
  override are exercised in W4, where the broker client lands.
- [x] **W3 — Guardian broker.** `src/sandbox/{types,rules,broker,review}.ts`,
  slot publish/dispose, `sandboxExceptions.{allow,defer,deny}` config, policy
  clause, audit entries, tests. Exit: 62 tests green, no reviewer call on hard
  deny, breaker covered, scope can only narrow.
- [ ] **W4 — Sandbox fork.** `forks/pi-sbx` with `src/broker.ts`,
  `request_sandbox_exception`, reroute of the two prompt sites, widen-and-rerun
  on traps, session overlays. Exit: §8 steps 1-5 pass end to end with guardian
  driving. Landed so far: session scratchpad (§4.8) verified on macOS, and the
  fork's devDeps fixed so `pnpm typecheck`/`pnpm test` run (44 tests green).
- [ ] **W5 — Swap.** `packages.txt` / `forks.txt` / `install.sh` /
  `config/` / `check-configs.mjs` updated; `pi-perm` removed from
  `~/.pi/agent/settings.json`; fresh-session smoke on this machine. Exit:
  `just check` green and a new session runs with no `srt-settings.json` errors.
- [ ] **W6 — Docs.** `docs/architecture.md` layers 1-2 rewritten, README stack
  table updated, this plan's status set to "implemented".
- [ ] **W7 — Follow-ups (separate decisions).** Subagent sandboxing provider;
  whether `~/.gradle` and package caches belong in the static template;
  whether `defer` should ever be skippable per-project.

## 10. Open questions

1. Should the human prompt remain the *only* source of `forever` grants, or may
   guardian persist a rule when the transcript shows an explicit standing user
   instruction? (Current design: human only.)
2. Do we want a `/sandbox` inspection command in the sandbox fork showing
   active session grants and pending requests? (Recommended; cheap.)
3. Should exception requests be exempt from guardian's normal `tool_call`
   review to avoid double review? (Current design: yes — the broker review is
   the review for that tool call.)
