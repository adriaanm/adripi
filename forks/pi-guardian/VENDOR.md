# pi-guardian (vendored fork)

This directory is a self-contained fork of
[`andersonbcdefg/pi-guardian`](https://github.com/andersonbcdefg/pi-guardian),
vendored so `adripi` can be cloned and installed on another machine without a
second local-only Git remote.

- Upstream commit: `c8d688a46c2dd6c7f3e5e92b60cac6a2983c4cf6`
- Upstream version: `0.2.0`
- License: Apache-2.0 (see `LICENSE` and `LICENSES/`)

Everything in `src/`, `test/`, `prompts/`, `package.json`, `tsconfig.json`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml` is upstream 0.2.0. The functional
deltas are listed below; nothing else is modified.

## Local changes

1. `src/types.ts` — `GuardianConfig` carries `reviewerExtensions`.
2. `src/config.ts` — accepts `reviewer.extensions`, validates non-empty strings,
   and resolves only path-shaped entries against the agent directory. Any
   `scheme:` specifier (`npm:`, `git:`, `github:`, `http(s):`, `ssh:`, `builtin:`,
   `file:`, …) keeps Pi's own meaning; `C:\…` is still treated as a path.
3. `src/sidecar.ts` — appends each configured entry as an explicit `--extension`
   argument after `--no-extensions`, so the reviewer sidecar can reach a model
   that is only available through a provider extension (Neuralwatt), without
   duplicating models into `models.json`.
4. `src/sidecar.ts` — when guardian runs inside a `pi-subagents` child runner,
   spawn the Pi CLI instead of relaunching the runner bootstrap with Pi flags.
   The child bootstrap expects a config path or stdin, not `--mode`, so the old
   behaviour failed with `readFileSync('--mode')` and guardian failed closed.
   `PI_SUBAGENT_PI_BINARY` overrides the binary.
5. `src/index.ts` — a failed-closed review is reported as a review failure, not
   as a risk denial, and the distinction is driven by the review's `failure`
   value rather than by matching a rationale prefix (a reviewer model could
   quote the prefix). `denialReason` is exported for that test.
6. `test/fork-reviewer-extensions.test.ts` — coverage for 1-5, including every
   non-path specifier, the `PI_SUBAGENT_RUNNER_CONFIG` branch, and both denial
   wordings.
7. `test/state.test.ts` — one-line fixture change (`reviewerExtensions: []`),
   required because 1 makes the field non-optional under strict `tsc`.
8. `src/sandbox/{types,rules,broker,review}.ts` — the sandbox exception broker:
   `Symbol.for` slot published at `session_start`, request validation, always-deny
   classes (credentials, the agent directory, secret writes, repo config and
   HEAD), `sandboxExceptions.{allow,defer,deny}` `surface:pattern` rules,
   reviewer prompt with scope narrowing, durable audit entries, and a denial
   breaker. Built-in command restrictions are a reviewer-side backstop; pi-sbx
   owns executable eligibility and host dispatch. Host execution is full-host
   authority, not a credential jail.
9. `src/sandbox/rules.ts` parses network endpoints instead of dropping their
   port: `host:443` authorizes only port 443, while `host` and `host:*` cover
   every port. Port-specific deny/defer rules overlap an all-port request but
   cannot authorize it. Command arguments remain case-sensitive. Broker target
   admission rejects wildcard/URL/relative-path/control-character requests before
   any rule or reviewer. Filesystem rules match the root itself as well as its
   descendants, resolve relative patterns against request cwd, and include real
   path/deepest-existing-ancestor aliases; `**/…` also anchors at filesystem root.
   These repair F4 and the deterministic target-admission portion of F11.
   `test/sandbox-broker.test.ts` covers distinct ports, all-port restriction
   precedence, rejected shapes, directory roots, aliases and case-sensitive args.
10. `test/sandbox-{broker,review}.test.ts` — decision order, scope narrowing,
    breaker, request validation, and rule precedence.
11. `src/{types,config,permissions}.ts` — `permissions.agentDirWriteProjects`:
    absolute project roots whose sessions may maintain the agent directory
    (that is how this repo installs and repairs the profile it ships). It lifts
    it lifts `Edit(<agentDir>/**)` and decides the maintenance file-tool calls in
    the rule engine; `auth.json` and `guardian-sessions/**` stay write-denied, and
    every user deny still applies. `install.sh` adds this repo's own root; delete
    the entry to revoke.
12. `src/project-policy.ts` + `src/sandbox/{rules,broker}.ts` — per-project
    Guardian policy at `<workspace>/.pi/guardian.json`, holding only
    `sandboxExceptions` (`allow`/`defer`/`deny`). It is applied only when its
    content hash is approved (asked once with a UI, recorded in
    `<agentDir>/guardian-project-trust.json`), so a subagent inherits the
    parent's approval but an edited or unauthored file stays inert. Layered
    evaluation: global hard denies and `defer`s win, then project deny/defer,
    then project allow, then global allow. Command rules also accept `prefix:*`
    (with a space boundary) as "this command with any arguments". Guardian also
    denies agent writes to `<workspace>/.pi/**` as a backstop to pi-sbx's
    mandatory deny-write.
13. `src/project-policy.ts` + `src/index.ts` — snapshot-bound standing saves
    repair F5: appending one approved rule must not approve unrelated existing
    entries. `persistProjectRule(cwd, rule, { agentDir, approved })` refuses
    unapproved/changed/newly appeared/removed/wrong-path content and symlinked or
    escaping policy directories/files. Parse/hash share one read; exclusive 0600
    temporary files, fsync and atomic rename avoid partial policy/trust files.
    The `Symbol.for("pi-guardian:project-policy")` service exposes `prepareRule`,
    capturing the trusted snapshot **before** the sandbox's human save prompt;
    its commit closure is bound to that rule/base and refuses a disposed session.
    Only returned bytes/rules are trusted/applied — no post-write re-read. Both
    service disposal and the consumer's prepare-before-prompt order are tested.
    Separate processes are not locked, so simultaneous external saves may lose
    an update; this is not protection from hostile same-user filesystem races.
    Tests cover primitive negative cases and the actual registered service via
    pi-sbx's consumer (`test/project-policy-service.test.ts`).
14. `src/permissions.ts` — `write`/`edit` calls are matched on their target
    `path` only. Scanning the payload made a document that merely *mentions* a
    protected path (a README explaining the sandbox, say) un-editable, which
    blocked legitimate maintenance twice. Shells, codemode, MCP and extension
    inputs keep the literal scan.

Upstream 0.2.0 already covers the rest of what the 0.1.0 fork needed: the
deterministic `permissions.allow` / `permissions.deny` rule family (evaluated
before any reviewer call), `tool_search` exemption, and the durable assessment
record fields (`source`, `rule`). The fork no longer patches anything those
replace.

## Deploy

`install.sh` installs `pi-guardian@0.1.0` from npm (the newest *published*
version) and then rsyncs `forks/pi-guardian/src/` over the managed package's
`src/`. Upstream 0.2.0 is only on git; this fork carries its source plus the
deltas below. Both versions declare the same runtime dependencies (none) and the
same host peers, so the npm install supplies the wiring and the vendored source
supplies the behaviour. When upstream publishes 0.2.0, re-pin `packages.txt`.

## Update upstream

1. Check out the new upstream version.
2. Reapply or reconcile **all** local changes above, including the broker,
   maintenance rules and snapshot-bound project-policy persistence. Consult the
   [product review](../../docs/review/recommendations.md) for integration gaps and
   acceptance criteria; the original changes 1-5 are no longer the whole fork.
3. Keep `test/fork-reviewer-extensions.test.ts` (adapt fixtures if upstream
   changed `GuardianConfig`).
4. `pnpm install --ignore-scripts --frozen-lockfile && pnpm check && node --test`.
5. Update the version in `packages.txt` and the upstream commit here.
6. Run `./install.sh` to deploy.
