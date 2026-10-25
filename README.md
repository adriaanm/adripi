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

`filesystem.allowUserTemp` (default on) already grants the current macOS user's
private temp/cache dirs, so `xcodebuild`/Swift/Clang caches work without an
escalation. The permission policy allows `sandbox_escalate` so the boundary
review is the single gate, and allows `external_directory_write` under
`/var/folders/*`, `~/Library/Caches/*`, and `~/Library/Developer/Xcode/*` so a
path grant does not prompt twice.

## Maintain

```sh
just check    # bash -n install.sh + config JSON validation
just install  # ./install.sh
just forks    # submodule branch/status
just update   # fetch upstream into the fork clones
just commit   # stage and commit the current setup
```
