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
  and added to the sandbox `denyWrite` set;
- `filesystem.allowUserTemp` (default on): the current macOS user's private
  temp/cache dirs are writable, so `xcodebuild`/Swift/Clang caches work;
- `sandbox_escalate`: a model-facing, reviewed one-shot side-step. `paths`
  grants those literal paths to one sandboxed re-run; omitting `paths` asks
  for host execution. Both are decided by pi-auto-review (or the human on
  defer), never by the sandbox itself.

The two current permanent prefixes are `just ios-bindings-test` and
`just ios-device-logs`; everything else still prompts once. `just ios-build-check`
and `just ios-interptest` are in the project example's review-only preflight
list, so they run on the host after auto-review rather than failing on
`/var/folders` cache writes.

## Updating the fork

`patches/` and `extensions/pi-sandbox/` must move together. After changing the
fork, regenerate the incremental patch against
`upstream@0.27.0 + patches/pi-sandbox-allow.patch +
patches/pi-sandbox-permanent-approvals.patch`, then re-run `install.sh`.

## Sandbox side-steps

When a sandboxed command fails with `Operation not permitted` for a benign
build/tool cache, the agent can call `sandbox_escalate` instead of changing
policy:

- `paths: ["/absolute/cache/dir"]` re-runs the exact command sandboxed with
  those paths readable+writable **for that run only**;
- no `paths` requests a one-shot host run (requires `hostIPC.mode: "ask"`).

Both modes are reviewed by pi-auto-review; a defer prompts the human, and a
denial is final. Nothing is persisted. Prefer the path mode: it keeps the
network and filesystem sandbox in place.

The permission policy allows the tool (`sandbox_escalate: allow`) so the
boundary review is the single gate. Outside the working tree it also allows
`external_directory_write` under `/var/folders/*`, `/private/var/folders/*`,
`~/Library/Caches/*` and `~/Library/Developer/Xcode/*`, so the path argument
reaches the escalation review instead of prompting twice.

## Maintain

```sh
just check    # bash -n install.sh
just commit   # stage and commit the current setup
```
