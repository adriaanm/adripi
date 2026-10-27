# adripi

Portable Pi setup: an OS sandbox, a semantic reviewer for tool calls, and a
diff-review sidekick. Workspaces are read+write; credentials and security
configuration are denied; the agent cannot widen its own permissions, and every
sandbox exception is reviewed by the semantic gate (or by you, when it defers).

## Stack

| Layer | Package | Role |
|---|---|---|
| OS boundary | `pi-sbx` (vendored fork) | Bash under `@anthropic-ai/sandbox-runtime`; session scratchpad; reviewed exceptions |
| Semantic gate | `pi-guardian` (vendored fork) | Reviews every non-exempt tool call, and brokers every sandbox exception |
| Diff review | [`@georgedong32/pi-review`](https://www.npmjs.com/package/@georgedong32/pi-review) | Bug, security, rules, history, and comment reviewers |
| Review workers | [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | Isolated reviewer children |

The sandbox and review configuration are provider-independent. See
[Configure a provider](#configure-a-provider) for choosing the reviewer model.

See [`docs/architecture.md`](docs/architecture.md) for the call flow.

## Requirements

- Pi 1.4+ (`pi --version`)
- `pnpm`, `node`, `git`, `rsync`
- macOS or Linux
- Network access for package install
- Credentials for your chosen model provider

## Install

```sh
git clone <this-repo> ~/g/adripi
cd ~/g/adripi
./install.sh
```

`install.sh`:

1. sets `npmCommand` to `pnpm` in `~/.pi/agent/settings.json`
2. installs `@anthropic-ai/sandbox-runtime` globally if `srt` is missing
3. installs the pinned packages in [`packages.txt`](packages.txt)
4. deploys the vendored `pi-guardian` and `pi-sbx` forks over their npm installs
5. seeds the portable configs in [`config/`](config) without overwriting
   existing user files

If `srt` is installed but not on `PATH`:

```fish
fish_add_path (pnpm bin -g)
```

```sh
export PATH="$(pnpm bin -g):$PATH"   # bash/zsh
```

## Configure a provider

Authenticate with Pi first:

```text
/login
```

Choose your provider. Then set the reviewer model in
`~/.pi/agent/guardian.json`:

```json
{
  "reviewer": {
    "model": "<provider>/<model>",
    "extensions": []
  }
}
```

Set `reviewer.extensions` only when the model is provided by a Pi extension.
For a built-in provider, or a provider defined in `models.json`, leave it empty.
The extension must be available to the reviewer sidecar; package sources are
accepted:

```json
"extensions": ["npm:@scope/provider-extension@1.2.3"]
```

The `pi-review` reviewer models in `~/.pi/agent/pi-review.json` must also be
reachable through the authenticated provider. Replace the model IDs in that
file with models your provider exposes.

### Why the vendored guardian is needed for extension-provided models

Upstream `pi-guardian` runs its reviewer sidecar with `--no-extensions` and
`--no-tools`. That is the right default: the reviewer must not load arbitrary
extensions or call tools. But it also means a provider supplied only by a Pi
extension is not registered in the sidecar, so `reviewer.model` cannot resolve.

The vendored fork adds `reviewer.extensions`. Pi still loads explicitly listed
`--extension` paths when `--no-extensions` is set, so the sidecar can load only
the provider extension while keeping `--no-tools` and keeping every
auto-discovered extension disabled.

Use the vendored guardian whenever the reviewer model is reached through an
extension. For a built-in provider, or one defined directly in `models.json`,
`reviewer.extensions` can be empty.

The fork also handles `pi-subagents` child sessions. Those children run through
a Node runner bootstrap, not the Pi CLI. When guardian detects that runner, it
spawns the `pi` executable for the reviewer sidecar instead of relaunching the
bootstrap with Pi flags. A failed-closed review now reports that the review
failed rather than presenting it as a risk judgement.

### Neuralwatt example

The templates in this repository currently use this configuration. It is a
working example, not a requirement. If you use Neuralwatt, the provider is
supplied by the `@aliou/pi-neuralwatt` extension:

```json
{
  "enabled": true,
  "reviewer": {
    "model": "neuralwatt/nw-flash",
    "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"],
    "thinking": "low",
    "timeoutMs": 90000,
    "maxAttempts": 3
  },
  "exemptTools": ["read", "grep", "find", "ls"],
  "policyPath": "~/.pi/agent/guardian-policy.md"
}
```

The npm coordinate is resolved by the reviewer sidecar and cached under
`~/.pi/agent/tmp/extensions/`; the first reviewed call may take a few seconds.
The package declares its provider and two quota helpers; none of them add
tools. The sidecar still runs with `--no-tools`.

The default `pi-review.json` also uses Neuralwatt models. Replace those IDs if
you use a different provider.

## Verify

```text
/guardian status      # prints the configured reviewer model
/sandbox              # sandbox state and effective policy
bash true             # a reviewed call; must be allowed inside the sandbox
/review --lite        # inside a git repository
```

## Configuration

`install.sh` copies these only if the destination does not exist. Edit the live
copies, not the templates.

| Template | Live path | Purpose |
|---|---|---|
| `config/guardian.json` | `~/.pi/agent/guardian.json` | Reviewer model, explicit reviewer extensions, exemptions |
| `config/guardian-policy.md` | `~/.pi/agent/guardian-policy.md` | Semantic allow/deny policy |
| `config/sandbox.json` | `~/.pi/agent/extensions/sandbox.json` | Filesystem, network and command policy for the OS sandbox |
| `config/pi-review.json` | `~/.pi/agent/pi-review.json` | Review gate and reviewer models |

### Guardian config

```json
{
  "enabled": true,
  "reviewer": {
    "model": "<provider>/<model>",
    "extensions": [],
    "thinking": "low",
    "timeoutMs": 90000,
    "maxAttempts": 3
  },
  "exemptTools": ["read", "grep", "find", "ls"],
  "policyPath": "~/.pi/agent/guardian-policy.md"
}
```

`reviewer.extensions` accepts local paths and package sources (`npm:...`). The
sidecar runs with `--no-tools` and `--no-extensions`; only the listed package
extensions load.

### Paths outside the project

Project writes run inside the sandbox with no prompt; each session also gets a
private scratch directory (`PI_SANDBOX_SCRATCH`). Anything else is a reviewed
exception: the agent calls `request_sandbox_exception` with one target and a
reason, `pi-guardian` decides, and you are asked only when it defers. Grants
last for one command (`once`) or the session, in memory only.

To make a path permanently writable, add it to `filesystem.allowWrite` in
`sandbox.json` yourself; for a host, add it to `network.allowedDomains`. Prefer
narrow entries. See [`config/README.md`](config/README.md) and
[`docs/plan-sandbox-broker.md`](docs/plan-sandbox-broker.md).

## Layout

```text
adripi/
  install.sh
  packages.txt              # pinned npm packages
  forks.txt                 # npm package -> vendored fork
  config/                   # portable config templates
  docs/architecture.md
  forks/pi-guardian/        # vendored fork; reviewer.extensions + sandbox broker
  forks/pi-sbx/             # vendored fork; scratchpad, broker client, exception tool
  scripts/
    check-configs.mjs
    set-npm-command.mjs
```

## Updating

Packages are pinned. To update:

1. bump the version in `packages.txt`
2. run `./install.sh`
3. test `/guardian status`, a reviewed `bash` call, and `/review --lite`

The guardian fork is vendored from upstream
`andersonbcdefg/pi-guardian@49f28fc` (0.1.0). See
[`forks/pi-guardian/VENDOR.md`](forks/pi-guardian/VENDOR.md) for the patch and
the upstream-update procedure.

## Security notes

- `pi-perm` is the OS boundary. `pi-guardian` is a semantic gate, not a
  sandbox replacement.
- Guardian failures are fail-closed denials.
- The agent must not edit permission, guardian, reviewer, or sandbox config to
  bypass a denial. Human recovery paths are `/guardian` and explicit config
  edits.
- `pi-review` is advisory code review; it does not replace the guardian or the
  sandbox.
- The guardian sidecar sends the retained transcript and exact action to the
  configured provider. Read `guardian-policy.md` and keep secrets out of the
  transcript.

## Maintenance

```sh
just check    # bash -n + config template validation
just install  # run install.sh
just commit   # check, stage, commit
```
