# adripi: the product as built

This is the current product contract, not a proposal for feature parity with
Claude Code or Codex. It describes repository revision `2e86f45`; the accompanying
[review](review/recommendations.md) identifies where the implementation falls
short of its intended guarantees. Evidence and limits are in
[review/verification.md](review/verification.md).

## 1. Purpose and intended experience

`adripi` installs a safety-oriented Pi environment, rather than an application.
The aim is autonomous, low-friction coding inside a useful boundary, with a
familiar escalation path when the task genuinely needs more access:

1. Work normally in the workspace, without prompting for every file operation.
2. Run shell commands inside an OS sandbox.
3. Have a separate model judge non-exempt actions against the user's intent.
4. Request narrowly scoped access instead of disabling protection to get unstuck.
5. Let the human decide what becomes a standing permission.

The product borrows Claude-style permission rules and Codex-shaped escalation
parameters. Those are useful interface choices, not evidence of equivalent
security or complete compatibility with either product.

### What is already good

- One bash owner and one semantic reviewer, rather than competing permission
  extensions.
- The entire shell command is wrapped by the vetted SRT substrate.
- Normal project writes and private scratch space need no exception.
- Explicit read/write/network/host-command exception vocabulary.
- Reviewer errors are distinguished from substantive risk denials and block
  execution rather than silently permitting it.
- Review context labels the user, assistant and tool evidence differently.
- Human-confirmed standing rules and a content-hash trust record.
- Provider extension support without loading every extension into the reviewer.

## 2. Scope and trust model

### Trusted computing base

The Pi host process, installed extensions, their dependency graph, the OS sandbox
runtime, and the human-owned global configuration are trusted. Extensions run in
Pi's host process; they are not contained merely because the bash tool is.
Guardian is an additional judgement layer, not a substitute for the OS boundary.
Its configured model provider receives retained conversation material and actions.

The review takes the vetted upstream extensions as the baseline. Its findings
concern local modifications, shipped configuration, installation, guidance and
integration claims; it is not a re-audit of upstream packages or SRT.

### Coverage is not uniform across tools

| Execution surface | As-built protection |
|---|---|
| Agent `bash` | Guardian tool gate, then the replacement bash tool chooses sandboxed or host execution |
| `read`, `write`, `edit`, `grep`, `find`, `ls` | In-process pi-sbx file-policy gate; Guardian fixed rules, then exemption or semantic review |
| Other extension/MCP tools | Guardian fixed rules and semantic review unless exempt; **not automatically OS-sandboxed by pi-sbx** |
| Calls made through Pi's nested-tool API | Tool hooks apply; Guardian carries parent-action evidence |
| Extension-internal I/O/process creation | Trusted extension implementation; not routed through bash just by being an extension |
| Human `!`/`!!` shell input | pi-sbx `user_bash` hook; not the normal Guardian agent-tool gate |
| Guardian reviewer | Separate Pi process, no built-in tools or automatic resources; explicit provider extensions remain trusted executable code |
| Subagent/external CLI workers | Depends on their actual launch and extension configuration; not certified by this repo's current tests |
| `/review` | Advisory diff review, not an execution authorization gate |

A parent subagent call being approved is not proof that every child action is
contained. Nor do proxy environment variables alone establish OS sandbox
inheritance. The historical plan's stronger inheritance claim is unverified.

### Things this product does not promise

- A read-isolated workspace. Reads are broadly open outside explicit denied
  stores; project `.env` files are write-denied by the template, not generally
  read-denied.
- Protection for every possible secret. Named stores and selected environment
  variable names are covered, not all credentials a developer machine might
  contain. Readable transcripts/configuration can themselves contain sensitive
  information.
- An exfiltration-proof network. Allowed GitHub and registry hosts are useful
  multi-tenant services, not a definition of safe data flow. Other host-process
  network tools do not inherit the bash proxy boundary automatically.
- A contained host exception. It runs the selected process tree with host
  privileges, including access to host credentials and services.
- A compromised-extension defence, Windows support, or proven Linux/macOS parity.

## 3. Components and action flow

```text
agent tool call
  -> Pi tool hooks
       -> pi-sbx file gate for the named built-in file tools
       -> Guardian fixed permission rules; otherwise semantic review
  -> tool implementation
       bash -> sandbox / approved host route / configured exclusion
       file tool -> normal Pi file operation after policy checks
       other tool -> its own trusted implementation

exception inside a tool or network callback
  -> Guardian broker: validate -> deny/defer/allow rules -> reviewer
  -> allow: sandbox grant or host route
  -> deny: no execution through that request
  -> defer: UI decision, or supported supervisor path
```

Tool hooks compose in registration order; the two policy checks are not a
universal OS-sandbox-then-review pipeline. Guardian can review a command before
it encounters an OS denial. An inline escalation generally has a normal tool
review **and** an exception review. The separately registered
`request_sandbox_exception` is exempt in the template to avoid that double review.

### Guardian's ordinary tool gate

- Built-in/user deny rules win over allow rules.
- Unmatched actions go to a separate Pi reviewer using a four-field assessment:
  risk, authorization, outcome and rationale.
- Malformed assessments, timeouts and sidecar failures become denials.
- Ordinary reviews use retained transcript deltas and a durable reviewer session;
  sandbox-exception reviews use a bounded full retained transcript so the user's
  authorization is not hidden behind the ordinary-review cursor.
- "Full" does not mean unlimited: per-entry, total-character and recent-entry
  bounds still apply.
- Defaults are 90 seconds per assessment across up to three format attempts,
  four parallel ordinary reviews and a three-denial breaker. The template keeps
  the timeout/attempt defaults and selects `neuralwatt/nw-flash`.

The template exempts `read`, `grep`, `find`, `ls`, and
`request_sandbox_exception`; fixed denies and the sandbox file gate still apply.
`tool_search` is an upstream default exemption, but supplying this template's
`exemptTools` replaces that default list, so it is not exempt here.

### Reviewer sidecar

The fork adds explicit `reviewer.extensions` for extension-provided models, and
uses the Pi executable rather than relaunching a subagent bootstrap with CLI
flags. Sidecar flags suppress tools, automatically discovered extensions,
skills, context files, prompt templates and themes. An allowlisted provider
extension still executes trusted host code; `--no-tools` is not an OS jail for
that extension.

## 4. Effective sandbox policy

### Filesystem and scratch

The shipped global template allows workspace writes, but deliberately replaces
upstream's shared-temp write default. Each session creates a private temp
subdirectory, exposes it to sandboxed bash as `PI_SANDBOX_SCRATCH`, adds it to
effective policy, and attempts to remove it on shutdown. Startup also sweeps
matching directories older than 24 hours. That sweep is age-based, not a proof
that a directory's owner session is dead.

Named credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`) are
read-denied by the template. Pi's `auth.json` is added to read denial by code.
The agent directory is normally write-protected; `.pi` in the current workspace
and relevant Git config/hooks receive mandatory write protection. The template
also denies `.env` and key/certificate-file writes. These have different
origins and strengths: a template deny is not the same as an immutable OS rule.

File-tool checks resolve targets/canonical ancestors and enforce the same
intended policy without executing file operations inside SRT. A recursive search
from a directory that could reach a denied file can be blocked wholesale.

### Maintenance workspace privilege

`install.sh` adds this repository's absolute root to two global lists:

- sandbox `agentDirWriteProjects`;
- Guardian `permissions.agentDirWriteProjects`.

Sessions under a listed root can maintain the installed agent directory.
Guardian directly allows eligible maintenance file-tool calls after fixed denies,
rather than asking a reviewer whose policy says not to edit safety settings.
`auth.json` and `guardian-sessions` remain write-protected, and the workspace's
own `.pi` directory remains protected.

This is an intentional **trusted-maintainer mode**, not evidence that the agent
can never change its own future safeguards. Such a session can edit deployed
extensions, global rules, trust records and settings. The protection claim for
ordinary workspaces does not hold against malicious work in this privileged one.
Remove the root from both global lists to revoke it. Other projects should not
receive this privilege merely to get a build working.

### Network

The template permits npm, GitHub, PyPI, Maven, Gradle and several supporting
hosts. Unlisted bash destinations use SRT's network callback, which consults the
broker; explicit deny rules still apply. A `host:*` grant is normalized to the
bare-host spelling that SRT accepts. A bare host means all ports.

Unix socket directories and loopback TCP are separate static capabilities:
`allowUnixSockets` grants bind and connect for those socket paths;
`allowLocalBinding` enables local TCP binding. Socket directory files may also
need ordinary read/write permissions.

## 5. Configuration and authority

| Source | Location | Authority/lifetime |
|---|---|---|
| Vendored source | `forks/pi-{sbx,guardian}` | Authoritative repository implementation; not loaded from here by normal Pi |
| Template defaults | `config/` | Fresh-install seeds, not live policy |
| Global sandbox | `<agentDir>/extensions/sandbox.json` | Human-owned profile; maintenance-project exception above |
| Global Guardian | `<agentDir>/guardian.json` and policy markdown | Reviewer, fixed rules, exception rules, maintenance roots |
| Project sandbox | `<cwd>/.pi/sandbox.json` | Applied after project approval/trust; may relax policy, not just tighten it |
| Project Guardian | `<cwd>/.pi/guardian.json` | Only `sandboxExceptions.{allow,defer,deny}`; exact content needs approval |
| Guardian trust store | `<agentDir>/guardian-project-trust.json` | Path-to-approved-content-hash map |
| Session overlays | Memory | Temporary grants and UI changes; not restart persistence |

Project lookup uses session **cwd**, not an automatic search for the Git root.
Launching from a subdirectory or managed worktree can therefore select different
policy files and trust paths.

Sandbox merge order is defaults -> global -> approved project -> session.
Above the global layer, read/write/network allow lists union; deny arrays and
other arrays replace. A trusted project can change non-mandatory denies,
`enabled`, fallback behavior and exclusions. Only maintenance-root authority is
read from the global layer alone. Therefore "project policy is additive" is true
of selected allow arrays, not a general tighten-only guarantee.

Guardian exception precedence is different:

1. Built-in/global deny.
2. Global defer.
3. Trusted project deny, then defer, then allow.
4. Global allow.
5. Reviewer.

Rule allows skip the **exception** review, not the ordinary tool gate. A session
scope granted by a reviewer requires high user authorization and non-high risk;
otherwise it narrows to once. Rule allows retain the requested scope. The model
does not return `defer`: it is a policy routing outcome in the production
review adapter.

## 6. Agent-facing workflows

### Normal work

Use ordinary `bash`, `read`, `write` and `edit`. Use project space or the private
scratch directory for temporary files. Local Git work should stay sandboxed.
Do not infer a sandbox failure from every build error or authentication failure.

### Inline escalation (implemented in repository source)

For a known sandbox path failure, the new interface carries the request and the
command together:

```json
{
  "command": "some-build-tool",
  "sandbox_permissions": "with_additional_permissions",
  "additional_permissions": { "file_system": { "write": ["/absolute/cache/path"] } },
  "justification": "May this build write its cache for this command?"
}
```

Each target is reviewed; accepted grants widen a shared in-memory profile, and a
`finally` block attempts rollback after execution. It is intended to be
command-scoped, but it is **not concurrency-isolated** today (review finding F2).
Global `network.enabled` escalation is refused; network access is per destination.

A host-only operation uses `sandbox_permissions: "require_escalated"` and a
justification; optional `prefix_rule: ["git", "push"]` proposes a standing rule.
The legacy `dangerouslyDisableSandbox` flag also requests broker-reviewed host
execution; it is not meant to be an unreviewed escape hatch.

### Separate exception tool

`request_sandbox_exception({surface, target, scope, reason})` requests a read or
write path, network destination, or exact host-command string. Scope is `once`
or `session`, not permanent. After a host grant the model reissues the approved
command unchanged. This is particularly useful for host credential helpers.

One-shot semantics currently differ:

| Grant route | Actual lifetime |
|---|---|
| Separate read/write once | Added immediately; removed at the next other `tool_result`, not bound to a designated consumer |
| Inline scoped read/write | Added before execution; rollback after that call; shared with concurrent calls |
| Separate host-command once | Until the next matching command consumes it, or shutdown; unrelated calls do not expire it |
| Separate network once | Intended next connection; currently cleared by the granting call's own result (F3) |
| Network callback once | Allows that callback's connection without adding a lasting session domain |
| Session grant | In-memory overlay, lost on extension-runtime replacement/restart |

There is no automatic replay of a command after a filesystem failure. Trap hints
help the model choose a reviewed next action; they are heuristics, not an
authoritative diagnosis of the failed syscall. A failed command can already
have partial side effects.

### Human decisions and standing permissions

- Separate exception defer: interactive UI offers session approval or denial.
  A headless tool call tries `contact_supervisor`, accepting a decision token.
- Inline scoped-path defer uses the same helper.
- Inline host defer and network callback defer use `PromptCoordinator`; without
  UI they deny rather than using the supervisor path (F7).
- Host UI can offer run once or a standing rule. A reviewer-approved inline
  command can separately offer "Save a standing permission?" for a prefix.
- Guardian persists accepted command rules in project Guardian policy and records
  trust. Without Guardian, command persistence falls back to sandbox exclusions,
  which run matching commands directly on the host without an exception request.
- "Always allow" in a network prompt writes project **sandbox** policy and adds
  an immediate session overlay, not a Guardian standing exception rule.

The rule owns a capability, not an immutable command implementation. `git`, `gh`,
`just` and other programs can execute configured helpers or mutable workspace
code. Human approval of host execution must account for that process tree.

## 7. Human controls, deployment and recovery

- `/sandbox` opens the policy/settings UI in TUI mode. `on`, `off`, `violations`,
  `exclude` and `unexclude` are available. Disabling sandboxing does not mean
  disabling Guardian; mandatory file-tool write protection remains.
- `/guardian status|on|off|toggle` controls the semantic gate. Bare `/guardian`
  toggles, so use `status` for inspection. Its broker lifecycle is currently not
  synchronized with toggles (F6); restart after changing modes when diagnosing it.
- No broker means the sandbox defers to its human fallback, not unconditional
  denial. Broker exceptions/reviewer failure deny. These are distinct states.
- The exception breaker is session-wide and, after tripping, has no normal
  request-path reset. The ordinary tool breaker is user-turn based.

Installation pins packages, rsyncs vendored `src/` over npm installations,
retires `pi-perm`, seeds absent configs and merges maintenance grants. It does
not generally migrate existing policy or deploy the fork's package manifest and
bundled prompt directory. Changing a template alone does not update a machine.

Run `./install.sh` with the human involved, then **fully quit and restart Pi**.
A source deployment or in-place reload is not proof that the active tool schema
and handlers match. This review found installed entry-point hashes matching the
repo while the active model-facing bash schema lacked the inline fields.
That proves a contract mismatch, not which layer caused it.

For recovery, inspect `/guardian status`, `/sandbox`, loaded tools and their
schemas, and the live files. Do not disable guards or edit project policy as an
agent workaround. There is not yet one authoritative "doctor" report combining
versions, source identity, modes, effective grants, broker health and policy
provenance.

## 8. Audit and current assurance

Guardian appends ordinary assessments/status/state and exception decisions to Pi
session entries, outside the model context. Reviewer transcripts are retained
under `guardian-sessions`. Exception records contain request/grant identifiers,
requested/granted scope, source, rule and rationale.

This is **decision auditing**, not yet a complete capability ledger: human
fallback answers, runtime application/refusal, consumption, rollback and expiry
are not all joined to those grant IDs. The sandbox grant stores do not carry the
broker grant ID through execution. Do not claim end-to-end consumption auditing.

The current automated evidence covers helper logic and selected extension
wiring. Historical macOS probes support the basic sandbox/scratch/exception
flow. The review adds mocked integration counterexamples, not an OS-level
penetration test. See the [verification record](review/verification.md) before
making stronger release claims.
