# adripi

Portable Pi setup: an OS sandbox, a semantic reviewer for tool calls, and a
diff-review sidekick. Workspaces are read+write; credentials and security
configuration are denied; the agent cannot widen its own permissions.

## Stack

| Layer | Package | Role |
|---|---|---|
| OS boundary | [`pi-perm`](https://www.npmjs.com/package/pi-perm) | Workspace/network profile; bash under `srt` |
| Semantic gate | `pi-guardian` (vendored fork) | Reviews every non-exempt tool call with `neuralwatt/nw-flash` |
| Diff review | [`@georgedong32/pi-review`](https://www.npmjs.com/package/@georgedong32/pi-review) | Bug, security, rules, history, and comment reviewers |
| Review workers | [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | Isolated reviewer children |

Provider: Neuralwatt, using the `@aliou/pi-neuralwatt` extension. The guardian
sidecar loads that package explicitly; no duplicated `models.json` and no
hardcoded model prices.

See [`docs/architecture.md`](docs/architecture.md) for the call flow.

## Requirements

- Pi 1.4+ (`pi --version`)
- `pnpm`, `node`, `git`, `rsync`
- macOS or Linux
- Network access for package install and the first reviewer-sidecar run
- A Neuralwatt account/key

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
4. deploys the vendored guardian fork over the npm-managed `pi-guardian`
5. seeds the portable configs in [`config/`](config) without overwriting
   existing user files

If `srt` is installed but not on `PATH`:

```fish
fish_add_path (pnpm bin -g)
```

```sh
export PATH="$(pnpm bin -g):$PATH"   # bash/zsh
```

## Sign in

```sh
pi
```

Then:

```text
/login
```

Choose Neuralwatt. The guardian sidecar and `pi-review` reuse the stored
credential. No API key needs to be committed to this repo.

## Verify

```text
/guardian status      # reviewer: neuralwatt/nw-flash
/pi-perm              # active profile: workspace
bash true             # first reviewed call may install the npm reviewer extension
/review --lite        # inside a git repository
```

The first reviewed tool call after install may take a few seconds while the
reviewer sidecar installs/caches `npm:@aliou/pi-neuralwatt@0.18.0` under
`~/.pi/agent/tmp/extensions/`.

## Configuration

`install.sh` copies these only if the destination does not exist. Edit the live
copies, not the templates.

| Template | Live path | Purpose |
|---|---|---|
| `config/guardian.json` | `~/.pi/agent/guardian.json` | Reviewer model, explicit reviewer extensions, exemptions |
| `config/guardian-policy.md` | `~/.pi/agent/guardian-policy.md` | Semantic allow/deny policy |
| `config/pi-perm.config.json` | `~/.pi/agent/extensions/pi-perm/config.json` | Workspace, filesystem, network, SRT policy |
| `config/pi-review.json` | `~/.pi/agent/pi-review.json` | Review gate and reviewer models |

### Guardian config

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

`reviewer.extensions` is only supported by the vendored guardian fork. It
accepts local paths and package sources (`npm:...`). The sidecar still runs
with `--no-tools` and `--no-extensions`; only the listed package extensions
load. The Neuralwatt package declares its provider and two quota helpers; none
of them add tools.

### Allow another directory

Workspace roots are read+write. Add another repository with an absolute subpath
table in `pi-perm.config.json`:

```json
"/Users/you/g/other-repo": {
  ".": "write"
}
```

Use exact absolute paths. Do not add a home-directory-wide or wildcard grant.
See [`config/README.md`](config/README.md).

### Why JSON for pi-perm

`pi-perm@0.1.8` rejects nested TOML filesystem tables (null-prototype
`smol-toml` tables fail its plain-object check). The JSON profile works. If an
old `config.toml` exists, `install.sh` moves it to `config.toml.bak` before
installing `config.json`.

## Layout

```text
adripi/
  install.sh
  packages.txt              # pinned npm packages
  forks.txt                 # npm package -> vendored fork
  config/                   # portable config templates
  docs/architecture.md
  forks/pi-guardian/        # vendored fork; reviewer.extensions patch
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
- The guardian sidecar sends the retained transcript and exact action to
  Neuralwatt. Read `guardian-policy.md` and keep secrets out of the transcript.

## Retired

The previous `pi-permission-system` + `pi-auto-review` + `pi-sandbox` stack and
the `pi-behave` bundle are no longer part of this setup. Their submodules,
project sandbox config, and documentation were removed. This repo now installs
only the `pi-perm` + `pi-guardian` + `pi-review` stack.

## Maintenance

```sh
just check    # bash -n + config template validation
just install  # run install.sh
just commit   # check, stage, commit
```
