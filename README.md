# adripi

My portable Pi coding-agent setup: standard package list, configs, and a
local fork of `@erichll/pi-sandbox` with permanent host-IPC approvals.

## Layout

- `packages.txt` — standard extensions installed from npm.
- `extensions/pi-sandbox/` — fork of `@erichll/pi-sandbox@0.27.0`; `FORK.md`
  records the delta. `install.sh` installs the upstream package and overlays
  this `src/` tree, so upstream dependencies and peer wiring stay intact.
- `patches/` — the incremental diffs, for review or upstreaming.
- `config/` — shareable permission/auto-review configs and a project sandbox
  policy example.
- `install.sh` — installs packages, overlays the fork, and installs missing
  global configs without overwriting existing files.

## Install on a machine

```sh
git clone <this repo> ~/g/adripi
cd ~/g/adripi
./install.sh
```

Then:

1. Set the reviewer model in
   `~/.pi/agent/extensions/pi-auto-review/config.json`.
2. Copy `config/pi-sandbox.project.example.json` to the project's
   `.pi/extensions/pi-sandbox/config.json` and adjust its absolute paths,
   domains, and host-IPC prefixes.
3. Restart Pi (extensions and config are loaded at registration).

## Fork

`extensions/pi-sandbox` is based on `@erichll/pi-sandbox@0.27.0`
(Apache-2.0; upstream `LICENSE`/`NOTICE` retained). It adds:

- `hostIPC.allowCommandPrefixes` for permanent host execution;
- an **Always allow "<prefix>" for this project** approval choice;
- `.pi/extensions/pi-sandbox/approvals.json` persistence, loaded at startup
  and added to the sandbox `denyWrite` set.

The two current permanent prefixes are `just ios-bindings-test` and
`just ios-device-logs`; everything else still prompts once.

## Updating the fork

`patches/` and `extensions/pi-sandbox/` must move together. After changing the
fork, regenerate the incremental patch against
`upstream@0.27.0 + patches/pi-sandbox-allow.patch`, then re-run `install.sh`.
