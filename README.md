# adripi

My portable Pi coding-agent setup: pinned packages, permission/sandbox configs,
and local forks of the security extensions.

## Layout

- `packages.txt` — npm packages installed by `pi install`. The forked packages
  are listed here too, so Pi installs their dependencies and host-peer wiring.
- `forks.txt` — `<package>|<fork directory>` pairs. After the npm install,
  `install.sh` deploys each fork's `src/` over the matching managed package.
- `forks/` — git submodules of the upstream monorepos, checked out on a
  `personal` branch:
  - `erichll/pi-packages` — `pi-sandbox` + `pi-auto-review`
  - `gotgenes/pi-packages` — `pi-permission-system`
  - `andersonbcdefg/pi-guardian` — reviewer sidecar extension allowlist
- `config/` — shareable permission, auto-review, and project sandbox configs.
- `docs/pi-sandbox-fork.md` — the personal delta on top of upstream.
- `install.sh` — submodules, packages, fork deployment, global configs.
- `justfile` — `check`, `install`, `forks`, `update`, `commit`.

## Why the fork is deployed over the npm install

`pi install ./local-package` loads a package in place and leaves its dependency
tree to you. That breaks the security stack's wiring: `pi-sandbox` imports
`@erichll/pi-auto-review`, and `pi-auto-review` imports
`@gotgenes/pi-permission-system`, both of which resolve from Pi's managed npm
tree. A local checkout would need its own production dependency install, and
its host peers would be a second physical copy.

So the npm package stays the dependency/peer anchor, and `install.sh` rsyncs
the fork's `src/` over it. The fork clone is still the source of truth: changes
are normal commits on `personal`, there are no hand-maintained patch files, and
`install.sh` re-deploys after every change. `rsync --delete` also removes files
the fork drops, unlike the old copy overlay.

## Install on a machine

```sh
git clone <this repo> ~/g/adripi
cd ~/g/adripi
git submodule update --init --recursive
./install.sh
```

Then:

1. Set the reviewer model in
   `~/.pi/agent/extensions/pi-auto-review/config.json`.
2. Copy `config/pi-sandbox.project.example.json` to the project's
   `.pi/extensions/pi-sandbox/config.json` and adjust its absolute paths,
   domains, and host-IPC prefixes.
3. Restart Pi (extensions and config are loaded at registration).

**Local-only for now:** the submodules point at commits on the local
`personal` branches that are not pushed anywhere. A fresh clone can only
initialize them after the forks exist on a remote. Until then, this repo is
portable by copying `forks/` along with it, or by publishing the forks (below).

## Editing a fork

```sh
cd forks/erichll-pi-packages
git switch personal
# edit packages/pi-sandbox/src/... or packages/pi-auto-review/src/...
git add -A && git commit -m "..."
cd ../..
./install.sh                 # deploy the new source into Pi's managed tree
git add forks/erichll-pi-packages
git commit -m "fork: ..."    # record the new submodule commit
```

`just forks` shows each submodule's branch, pending changes, and HEAD.

## Updating upstream

```sh
just update                          # fetch tags/commits into every fork
cd forks/erichll-pi-packages
git rebase pi-sandbox-v0.28.1 personal
# re-pin packages.txt to the version that tag ships, then:
cd ../.. && ./install.sh
```

The submodule records one commit for the whole monorepo. `pi-sandbox` and
`pi-auto-review` share it, so pin `packages.txt` to the versions that commit
contains. The current base is `pi-auto-review-v0.27.2`, which ships
`pi-sandbox@0.27.0` and `pi-auto-review@0.27.2`.

## Publishing the forks

When you want GitHub forks:

```sh
# in each fork submodule
git remote add mine git@github.com:<you>/pi-packages.git
git push -u mine personal

# in adripi
git submodule set-url forks/erichll-pi-packages https://github.com/<you>/pi-packages
git submodule set-url forks/gotgenes-pi-packages https://github.com/<you>/pi-packages
git add .gitmodules && git commit -m "forks: point submodules at my forks"
```

Then a fresh checkout can `git submodule update --init` the pushed commits.

## Guardian reviewer extensions

The `pi-guardian` fork adds `reviewer.extensions` to `guardian.json`.
Entries are passed to the reviewer sidecar as explicit `--extension` arguments
while the sidecar keeps `--no-tools` and `--no-extensions`. Package sources
are supported, so the Neuralwatt provider can be named by coordinate instead
of by a machine-specific path:

```json
"reviewer": {
  "model": "neuralwatt/nw-flash",
  "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"]
}
```

Only listed extensions load; Pi's discovery of all other user/project
extensions stays disabled. This is intended for provider-only extensions.

## Sandbox side-steps

There are two reviewed tools, both decided by pi-auto-review (or the human on
defer):

- `sandbox_escalate` re-runs one exact command. With `paths`, the re-run stays
  inside the sandbox with those paths readable+writable for that run only;
  without `paths`, the command runs on the host (requires `hostIPC.mode:
  "ask"`).
- `sandbox_request_access` adds an exact path to the sandbox policy **for the
  rest of the session**, covering both sandboxed Bash and the write/edit
  tools. Use it for an authorized work area such as a new repository outside
  the workspace. A human can choose "always allow for this project", which is
  the only way the grant is persisted (`approvals.json`). The agent cannot
  persist a grant on its own.

`/sandbox-grants` lists session and persisted path grants;
`/sandbox-grants revoke <path>` drops a session grant. A denial is final and
nothing changes. Prefer the path-grant modes: they keep the network and
filesystem sandbox in place.

The built-in `write` and `edit` tools are now guarded by the same write policy
as the sandbox, so they cannot rewrite security configuration or secrets the
OS sandbox protects from Bash. This is a policy check in the Pi process, not a
kernel boundary; reads remain governed by the permission system's path gate.

## Maintain

```sh
just check    # bash -n install.sh + config JSON validation
just install  # ./install.sh
just forks    # submodule branch/status
just update   # fetch upstream into the fork clones
just commit   # stage and commit the current setup
```
