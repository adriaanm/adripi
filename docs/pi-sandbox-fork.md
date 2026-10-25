# pi-sandbox fork notes

Local fork: `forks/erichll-pi-packages`, branch `personal`.
Upstream base: `pi-auto-review-v0.27.2` (commit `14f3b6c`), which ships
`pi-sandbox@0.27.0` and `pi-auto-review@0.27.2`.
`packages.txt` pins those npm versions; `install.sh` deploys
`packages/pi-sandbox/src/` over the managed install.

Useful diff:

```sh
cd forks/erichll-pi-packages
git diff pi-sandbox-v0.27.0..personal -- packages/pi-sandbox
```

## Deltas over upstream

1. `hostIPC.allowCommandPrefixes` (optional): command prefixes that run on the
   host without a one-shot approval. Prefix matching is exact-prefix plus
   whitespace/end, so `just ios-device` does not match `just ios-device-logs`.
2. Host-IPC preflight prompts offer
   **Always allow "<prefix>" for this project**.
3. That choice is appended to `.pi/extensions/pi-sandbox/approvals.json`,
   loaded at registration and merged into `allowCommandPrefixes`.
4. `.pi/extensions/pi-sandbox/` is added to the sandbox `denyWrite` list so a
   sandboxed command cannot grant itself host execution.
5. `filesystem.allowUserTemp` (default `true`): on macOS the current user's
   private confstr temp and cache directories (`DARWIN_USER_TEMP_DIR`,
   `DARWIN_USER_CACHE_DIR`, both `/var` and `/private/var` spellings) are added
   to `allowRead`/`allowWrite`. `xcodebuild`, Swift/Clang and similar tools
   query confstr directly instead of honouring the command's `TMPDIR`, so
   without this they fail with `Operation not permitted` under `/var/folders`.
   Only the per-user directories are granted; the shared `/tmp` root and other
   users' folders stay read-only. Set `false` to restore upstream behaviour.
6. `sandbox_escalate` tool: one reviewed, one-shot side-step. With `paths`, the
   exact command is re-run **inside** the sandbox with those literal paths
   added to read/write for that run only. Without `paths`, the command is
   re-run on the **host** (requires `hostIPC.mode: "ask"`). Both modes go
   through the same pi-auto-review boundary broker as host-IPC; a defer asks
   the human once, and a denial is final. Local guards reject `/`, home or
   workspace ancestors, globs, and protected config/credential paths before
   review; pi-auto-review's protected-write hard deny still applies.
7. Sandboxed Bash prints a hint pointing at `sandbox_escalate` when a command
   fails with `Operation not permitted`.

The command still runs **outside the OS sandbox** when allowed by item 1 or 6.
A permanent approval is a policy decision, not a weaker sandbox.

## Host execution defaults

`config/pi-sandbox.project.example.json` currently permanently approves
`just ios-bindings-test` and `just ios-device-logs`, and sends
`just ios-build-check` / `just ios-interptest` (plus the device/simulator
prefixes) through review-only preflight.

## Related fork

`forks/gotgenes-pi-packages` (branch `personal`) is the
`@gotgenes/pi-permission-system@41.0.0` base. It has no local commits yet; the
personal policy lives in `config/pi-permission-system.json`.
