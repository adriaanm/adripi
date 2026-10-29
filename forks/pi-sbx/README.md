# pi-sbx

A hardened [Pi](https://github.com/earendil-works/pi) sandbox extension built on Pi's example sandbox and adapted from Claude Code's sandbox integration.

It uses `@anthropic-ai/sandbox-runtime` to isolate shell commands with `sandbox-exec` on macOS and bubblewrap on Linux/WSL2. It also adds an in-process policy gate for Pi's built-in file tools.

## Security boundary

- **OS-isolated:** the built-in `bash` tool and user `!` / `!!` commands.
- **Policy-gated in the Pi process:** `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- **Not covered:** third-party/custom tools, MCP/SDK tools, other extensions calling `pi.exec()`, or the Pi process itself.

The file-tool gate is defense in depth, not an OS boundary, and has normal user-space preflight/TOCTOU limitations. For untrusted unattended workloads, use Pi's Gondolin extension, a container, or a VM.

Allowed network domains are potential exfiltration channels. The defaults favor common package workflows; remove domains you do not need.

## Requirements

- Node.js 20.11 or newer
- macOS, or Linux/WSL2
- Linux/WSL2: `bubblewrap`, `socat`, and `ripgrep`

## Install

```bash
pi install npm:pi-sbx
```

This vendored fork is deployed with adripi's `install.sh` alongside Guardian;
`pi install npm:pi-sbx` alone installs upstream, not these changes. See
[VENDOR.md](VENDOR.md) and the [bundle contract](../../docs/product.md).
For local development, install dependencies and load this fork with Guardian.
Remove other bash sandbox owners; multiple overrides conflict.

## Configuration

Configuration is merged in this order:

1. built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<cwd>/.pi/sandbox.json`

Nested objects merge. Allow lists for network hosts/sockets and filesystem
reads/writes union above the global layer; other arrays and defaults → global
replace. Relative paths use session cwd. Invalid JSON/schema fails closed.

A project config is repository-controlled and may weaken policy. It is applied only when the project has already passed Pi project trust, when you approve it interactively, or when non-interactive mode uses `--trust-sandbox-config`.

```json
{
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": true,
  "environment": {
    "deny": ["MY_PRIVATE_TOKEN"]
  },
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws"],
    "allowRead": [],
    "allowWrite": ["."],
    "denyWrite": []
  }
}
```

All compatible sandbox-runtime fields are accepted and validated, including `credentials`, `ignoreViolations`, `enableWeakerNestedSandbox`, and `enableWeakerNetworkIsolation`.

### Secret files

The defaults do not classify project files as secrets by extension. Mandatory concrete paths protect Pi resources, sandbox policy, and Git config/hooks. Project-specific secret rules are opt-in because generating or editing `.env`, PEM, and key files is a legitimate development workflow.

To prevent commands and built-in file tools from reading existing secret files, add project-appropriate `denyRead` patterns:

```json
{
  "filesystem": {
    "denyRead": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Use `denyWrite` instead when the goal is only to prevent modification. A write deny does not prevent reading or exfiltration.

### Fail-closed behavior

`failIfUnavailable` defaults to `true`: unavailable sandbox means no execution.
Setting it false permits only the same eligible, reviewed host path as explicit
inline escalation, not automatic unsandboxed execution. `/sandbox off` and
`--no-sandbox` are explicit unsafe human controls.

Mandatory protection for Pi's agent directory, sandbox policy files, project Pi resources, and Git config/hooks remains active for built-in `write`/`edit` even when the session sandbox is off.

### Environment credentials

Sandboxed commands do not receive Pi's `PI_SESSION_*` metadata. Common model and cloud provider credentials are removed using sandbox-runtime credential rules. Add custom secret variable names under `environment.deny`.

Credential files declared with either `deny` or `mask` mode are denied to Pi's built-in file tools because those in-process tools cannot reproduce sandbox-runtime's masked-file view.

This is not an exhaustive secret detector. Ordinary environment variables remain available to support build tools.

## Escalation and approvals

The only model-facing API is on bash itself:

```ts
{ command: "go build ./...", sandbox_permissions: "with_additional_permissions",
  justification: "Use the required build cache?",
  additional_permissions: { file_system: { write: ["~/.cache/go-build"] } } }

{ command: "git push origin main", sandbox_permissions: "require_escalated",
  justification: "Publish the requested branch?", prefix_rule: ["git", "push"] }
```

All scoped targets are decided before installing a copied runtime profile for
one serialized execution. Native Read/Write/Edit use the same path authorizer,
but keep their own tool schemas and exact one-call enforcement: a grant never
mutates baseline or authorizes recursive traversal. Mandatory read/write locks
and configured deny-write entries are final; other read denies require a
strictly more-specific reviewed carve-out. Baseline restores in `finally`; failed rollback blocks future execution. Host eligibility,
host-enabled policy and prefix binding precede Guardian review. Host execution
is full-host authority, not a credential jail.

Unknown network hosts use the same Guardian contract per connection, with no
allowlist mutation. One UI adapter serializes real defers and standing-save
questions. Headless defer and missing/failed Guardian fail closed. No impossible
nested call to model-only `contact_supervisor` is attempted.

A human can approve saving a proposed narrow rule in Guardian's project policy.
Guardian prepares a trusted snapshot before the prompt and refuses stale or
unapproved policy on commit. There is no sandbox-policy fallback.

`request_sandbox_exception`, `dangerouslyDisableSandbox`, grant stores and
`excludedCommands` routes are retired. Nonempty legacy exclusion lists fail
configuration closed with migration instructions. Use trusted Guardian
`command:<prefix>:*` rules instead; plain bash remains sandboxed.
`allowUnsandboxedCommands: false` disables model host execution.

## Commands and flags

- `/sandbox` — open the interactive tabbed settings for sandbox mode, network, filesystem, denied environment variables, advanced options/raw JSON, and the complete effective config (show effective status outside TUI mode). Press `S` to choose session, global, or project scope before editing; mandatory hardening rules are read-only.
- `/sandbox on|off` — session-only toggle
- Extension deployment requires a full Pi quit/restart; `/reload` alone is not proof that the old handlers were replaced
- `/sandbox violations` — show recent captured violations
- `--no-sandbox` — explicit process-level shell bypass
- `--trust-sandbox-config` — allow project config in non-interactive mode

Linux/WSL violation telemetry is best effort; command output is authoritative. Existing write-glob matches are expanded to literal paths before each Linux command. Bubblewrap cannot block a match first created by that command, so this limitation is reported at startup.

## Development

```bash
npm test
npm run typecheck
pi -e . --help
```
