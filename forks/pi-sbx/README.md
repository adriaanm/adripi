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

For local development, run `npm install` and start Pi with `pi -e .`. Remove or disable any other sandbox extension first; multiple extensions overriding `bash` or registering `--no-sandbox` conflict.

## Configuration

Configuration is merged in this order:

1. built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<cwd>/.pi/sandbox.json`

Nested objects merge; arrays replace the lower-priority array. Relative filesystem paths are resolved from the active session cwd. An existing configuration file with invalid JSON or schema is rejected rather than silently replaced by defaults.

A project config is repository-controlled and may weaken policy. It is applied only when the project has already passed Pi project trust, when you approve it interactively, or when non-interactive mode uses `--trust-sandbox-config`.

```json
{
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": true,
  "excludedCommands": [],
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

`failIfUnavailable` defaults to `true`. If the platform or dependencies cannot provide a sandbox, shell commands fail instead of silently running on the host. Set it to `false`, use `/sandbox off`, or start with `--no-sandbox` only when you intentionally accept host execution.

Mandatory protection for Pi's agent directory, sandbox policy files, project Pi resources, and Git config/hooks remains active for built-in `write`/`edit` even when the session sandbox is off.

### Environment credentials

Sandboxed commands do not receive Pi's `PI_SESSION_*` metadata. Common model and cloud provider credentials are removed using sandbox-runtime credential rules. Add custom secret variable names under `environment.deny`.

Credential files declared with either `deny` or `mask` mode are denied to Pi's built-in file tools because those in-process tools cannot reproduce sandbox-runtime's masked-file view.

This is not an exhaustive secret detector. Ordinary environment variables remain available to support build tools.

## Interactive approvals

Unknown network hosts show:

- Allow once
- Always allow the host in project config
- Deny

Concurrent requests for the same host share one prompt. All sandbox prompts are serialized.

The bash schema includes `dangerouslyDisableSandbox`. The model is instructed to use it only after explicit user direction or clear evidence of a sandbox-caused failure. Every request is denied in non-interactive mode and requires an interactive choice:

- Run once
- Always allow this exact command
- Deny

Set `allowUnsandboxedCommands: false` to disable this escape hatch.

## Excluded commands

`excludedCommands` is explicit pre-approval for host execution:

```json
{
  "excludedCommands": [
    "docker:*",
    "exact command && approved companion"
  ]
}
```

- A complete exact string approves that exact compound command.
- `docker:*` matches `docker` and its arguments.
- Other glob patterns use minimatch.
- For broad patterns, **every** leaf of a compound command must match. `docker:*` does not exempt `docker ps && curl evil.example`.
- Command substitutions, heredocs, process substitutions, malformed quoting, and other structures the conservative parser cannot verify remain sandboxed.

Exclusions are a convenience/pre-approval feature, not a separate security boundary.

## Commands and flags

- `/sandbox` — open the interactive tabbed settings for sandbox mode, network, filesystem, command exclusions, denied environment variables, advanced options/raw JSON, and the complete effective config (show effective status outside TUI mode). Press `S` to choose session, global, or project scope before editing; mandatory hardening rules are read-only.
- `/sandbox on|off` — session-only toggle
- `/reload` — reload Pi resources, including this extension and its sandbox configuration
- `/sandbox violations` — show recent captured violations
- `/sandbox exclude <pattern>` — persist a project exclusion
- `/sandbox unexclude <pattern>` — remove it
- `--no-sandbox` — explicit process-level shell bypass
- `--trust-sandbox-config` — allow project config in non-interactive mode

Linux/WSL violation telemetry is best effort; command output is authoritative. Existing write-glob matches are expanded to literal paths before each Linux command. Bubblewrap cannot block a match first created by that command, so this limitation is reported at startup.

## Development

```bash
npm test
npm run typecheck
pi -e . --help
```
