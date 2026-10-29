# adripi: the product as built

This is the source contract after [implementation round 1](round-1.md), not a
claim of Claude/Codex parity or proof about a running installation. The original
review of `2e86f45` is preserved in [product-baseline.md](product-baseline.md),
[findings](review/recommendations.md) and [evidence](review/verification.md).
[Product requirements](product-requirements.md) records the dogfooding failures
and decisions still needing an operator interview.

**Deployment status:** this round changes repository source and templates only.
No installation, live-policy mutation, restart or push was performed. Pi normally
loads the deployed copies, not these working-tree files.

## 1. Purpose and trust boundary

`adripi` installs and maintains a safety-oriented Pi coding environment:

1. Normal workspace work and private scratch need no exception.
2. Agent bash runs inside SRT by default.
3. Guardian reviews non-exempt tools against the retained conversation.
4. A required exception travels with the action, rather than opening a session
   window or asking for a reusable host-execution token.
5. The human chooses which narrow rules become standing project permissions.

The Pi process, installed extensions, dependencies, human-owned configuration and
OS sandbox runtime are trusted. Guardian is a judgement layer, not the OS
boundary. Its provider receives retained conversation material and actions.
This round reviews local integration, not upstream SRT internals as a whole.

### Coverage

| Surface | Protection |
|---|---|
| Agent `bash` | Guardian tool gate, then pi-sbx's single serialized dispatcher: normal SRT, scoped SRT or approved host execution |
| Native `read`, `write`, `edit`, `grep`, `find`, `ls` | In-process baseline file policy; Guardian fixed rules, then exemption or semantic review |
| Other extension/MCP tools | Applicable Guardian hooks, but not automatically OS-sandboxed by pi-sbx |
| Nested-tool API | Applicable tool hooks; Guardian includes parent-action evidence |
| Extension-internal I/O/process creation | Trusted extension implementation; not routed through bash automatically |
| Human `!`/`!!` input | pi-sbx user-bash hook; active sandbox executions share the queue, not the normal agent tool-review gate |
| Guardian reviewer | Separate Pi process without built-in tools or automatic resources; explicitly enabled provider extensions remain trusted code |
| Subagent/external CLI worker | Depends on actual launch, cwd, extension loading and inherited authority; not certified by approving the parent call |
| `/review` | Advisory diff review, not execution authority |

This is not a read-isolated workspace, an exfiltration-proof network, a
compromised-extension defence, Windows support or proven macOS/Linux parity.
Named credential stores and selected environment variables are protected, not
all possible secrets. Readable transcripts/configuration can contain sensitive
material. Allowed package hosts are multi-tenant services, not safe-data-flow
proof. A host exception grants the process tree host credentials and services;
it is **not a credential jail**.

## 2. One model-facing escalation API

Only the bash action requests model-driven filesystem/host exceptions:

```ts
bash({
  command: "go build ./...",
  sandbox_permissions: "with_additional_permissions",
  justification: "Use the build cache needed by this build?",
  additional_permissions: {
    file_system: { write: ["~/.cache/go-build"] }
  }
})

bash({
  command: "git push -u origin main",
  sandbox_permissions: "require_escalated",
  justification: "Push the branch you asked me to publish?",
  prefix_rule: ["git", "push"] // optional human standing-rule proposal
})
```

`command` and optional `timeout` remain the ordinary bash inputs.
`sandbox_permissions` defaults to `use_default`. Nondefault modes require a
justification; stray escalation fields, unknown keys and malformed combinations
are rejected. `additional_permissions` supports only filesystem read/write
arrays of exact absolute or `~/…` paths. Wildcards and control characters are
not request targets. There is no global network-enable switch.

`request_sandbox_exception` is no longer registered.
`dangerouslyDisableSandbox` is rejected explicitly, even when false, rather
than silently ignored. Host/session/next-command grant stores and their expiry
routes were removed. Native file tools retain their baseline policy: use a
scoped bash action when outside-policy filesystem work is necessary.

### Dispatch and isolation

```text
bash -> canonical parameter/plan validation -> serialized dispatch
       normal -> SRT baseline
       scoped -> decide every target -> install copied runtime layer
                 -> execute -> restore baseline in finally
       host   -> host-enabled + executable/shape/prefix admission
                 -> decide exact command -> execute reviewed string once

exception decision -> Guardian target admission -> restrictions/standing rules
                   -> reviewer -> allow / deny / real defer to human
```

All requested paths must be approved before runtime mutation. Partial approval
runs nothing. Temporary paths never enter `config` or `sessionConfig`, which
native file tools read. Other bash work, including active human shell execution,
and runtime-setting changes wait until rollback. Cancellation is checked before
execution and propagated to human prompts. Queue closure rejects pending work
and waits for the active command's cleanup before resetting the controller.
If baseline restoration itself fails, later dispatch fails closed and the
controller is reset.

Serialization does **not** prove that background descendants, inherited sockets
or long-lived external processes lose authority when the foreground command
ends. Those remain explicit containment requirements.

### Host admission

Host escalation honors `allowUnsandboxedCommands` and checks one plain command:
no chaining, redirection, substitution, unquoted glob/brace expansion, control
characters, environment-assignment heads, interpreters or known wrappers.
`prefix_rule` must describe a literal prefix of this command, not another one.
This rejects known general-code execution shapes; it does not classify every
executable's capabilities or resolve every executable alias. Package managers,
container CLIs and command-specific code execution still need a broader policy
decision. Guardian remains responsible for semantic authorization.

The reviewed trimmed string is the executed string. Approval applies to that
call only; a subsequent plain bash call is sandboxed. Even the configured
`failIfUnavailable: false` fallback uses this same host gate/review, rather than
automatically executing arbitrary commands locally. The shipped template fails
closed on unavailable SRT.

Human `--no-sandbox`, `/sandbox off` and disabled policy remain explicitly unsafe
controls, not model escalation routes. They do not promise a contained shell;
mandatory native policy-file protections still apply.

## 3. Network and human decisions

Static SRT network policy is checked first. Off-list destinations use the common
Guardian broker for **that connection**, with `scope: "once"`. No network token
or session allowlist entry is created. Repeated off-list connections require
repeated decisions unless a standing rule applies. Long-lived connection
containment is not certified by this callback contract.

- `network:example.test:443` matches only port 443.
- Bare `example.test` and `example.test:*` mean all ports.
- An all-port request cannot be authorized by a numeric-port allow rule; a
  numeric-port deny/defer still restricts that broader request.
- Requests reject wildcard hosts, URLs, userinfo, paths and unusable ports;
  IPv6 targets are bracketed. Command arguments are case-sensitive.
- Filesystem restrictions include protected directory roots, descendants and
  canonical/deepest-existing-ancestor aliases. `**/…` patterns also anchor at
  filesystem root; relative rule paths use the request cwd.

One `HumanChannel` serializes defer prompts and optional standing-rule questions
for command, read, write and network surfaces. A real Guardian `defer` may ask
an interactive human. Missing or failed Guardian denies instead of skipping its
hard restrictions. In print/JSON/headless mode, no supported human channel means
no execution, with an actionable explanation. The broken nested call to
model-only `contact_supervisor` is removed. A parent `ALLOW` token is not treated
as proof of human authority. A real child approval transport remains unbuilt.

## 4. Policy layers and persistence

| State | Location / lifetime |
|---|---|
| Global sandbox policy | `<agentDir>/extensions/sandbox.json` |
| Project sandbox policy | `<workspace>/.pi/sandbox.json`, human-approved at load |
| Human session settings | In-memory sandbox settings layer |
| Scoped filesystem override | Copied SRT profile for one serialized execution only |
| Guardian reviewer/global exception rules | `<agentDir>/guardian.json` |
| Standing project exception rules | `<workspace>/.pi/guardian.json` |
| Project-policy trust | Exact content hash in `<agentDir>/guardian-project-trust.json` |
| Audit | Guardian status, assessment and exception entries plus reviewer transcripts |

Allow lists (`network.allowedDomains`, `network.allowUnixSockets`,
`filesystem.allowRead`, `filesystem.allowWrite`) union above the user's global
layer. Defaults → global still replaces; deny lists and other arrays replace.
Writes need an allow root; lifting a deny is insufficient. Unix sockets require
appropriate socket-directory read/write grants as well as network permission.
See [config](../config/README.md) for the concrete settings.

### One standing-permission store

Guardian owns standing exceptions, using `surface:pattern` rules. A command
prefix such as `command:git push:*` has a space boundary and does not match
`git pusher`. Global hard denies and defers win; then project deny/defer,
project allow, global allow, reviewer. A project can pre-authorize, never loosen
a global restriction. Only `sandboxExceptions` is accepted in project policy.

The sandbox asks Guardian's service to **prepare** a proposed rule before the
save prompt. The prepared closure captures that rule and the current trusted
policy snapshot, including approved absence. After a human yes, it commits only
against that snapshot. Invalid, unapproved, changed, newly appeared, removed or
wrong-path content is refused. Symlinked `.pi` directories/policy files and
escaping policy directories are refused. Parse/hash share one read; exclusive
0600 temporary files, fsync and atomic rename avoid partial policy/trust files.
Guardian trusts and applies only the returned bytes/rules, never a post-write
re-read. Prepared saves from a disposed service cannot commit.

There is no file lock across processes: simultaneous external writers can still
lose an update, and this is not a hostile same-user filesystem-race defence.
Trust remains hash-bound; atomic writes are not a filesystem transaction with
the trust record.

`excludedCommands` and its UI/persistence routes are retired. Nonempty legacy
lists fail closed with migration instructions; an empty old list is accepted.
No fallback writes sandbox policy when Guardian's persistence service is absent.
A standing rule pre-authorizes an **explicit exception request**; it does not
reroute plain commands onto the host.

### Maintenance authority

`agentDirWriteProjects` in the human-owned global sandbox and Guardian profiles
allows listed workspaces to maintain the agent directory. The installer grants
this repository. This deliberately lets its sessions change what Pi loads next.
Only `<agentDir>/auth.json` is read-denied there; it and Guardian's audit sessions
stay write-denied even to maintainers. Workspace `.pi` remains mandatory
deny-write. This is legitimate maintenance authority, not a policy-bypass
workaround. Existing live configs are normally preserved by installation.

## 5. Verification, deployment and remaining work

Round 1 tests exercise registered tool dispatch, concurrent commands versus native
file policy, partial approval, cancellation, rollback failure, setting changes,
network decisions, and Guardian's actual service through the sandbox consumer.
They are wiring/helper tests, not nested OS-sandbox proof. The archived baseline
counterexamples must be run against their original revision, not used as current
positive regression tests after API retirement.

The full Guardian headless test still has the separately documented Node 26
native libuv assertion. Compatible-Node headless verification, live installed
schema freshness and actual OS-level smoke tests remain open. The original
review's broader lifecycle reconciliation, correlated consume/revoke audit,
child/MCP/extension containment and background-process lifetime are not certified
by this round. Full broker-toggle/session-policy lifecycle correctness is also
not claimed merely because prepared saves now have a disposer.

Deploy only as a separate human step: run `./install.sh`, inspect kept live
configs for retired exclusions, fully quit and restart Pi, then verify the
loaded schema, sandbox execution and negative cases. An in-place reload is not
sufficient evidence. This round stops for a recap and operator interview before
another improvement wave.
