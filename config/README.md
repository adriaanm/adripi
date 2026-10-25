# config

- `pi-permission-system.json` — the shareable permission/auto-review policy.
  `install.sh` copies it only when the destination is missing.
- `pi-auto-review.example.json` — reviewer settings. **Set `model`** to a
  provider/model your machine can reach (`"current"` uses the active session
  model). `install.sh` copies it only when the destination is missing.
- `pi-sandbox.project.example.json` — per-project sandbox policy. Copy it to
  `<project>/.pi/extensions/pi-sandbox/config.json` and adjust:
  - absolute `additionalAllowRead`/`additionalAllowWrite` paths;
  - `filesystem.allowUserTemp` (default `true`): writable per-user macOS
    temp/cache dirs;
  - `network.allowedDomains` and `allowUnixSockets` for local simulators;
  - `hostIPC.preflightCommandPrefixes` (one-shot, goes to auto-review before
    the sandbox) and `hostIPC.allowCommandPrefixes` (permanent host execution).
- `pi-sandbox.global.example.json` — optional global pi-sandbox policy.
  Replace `/ABSOLUTE/HOME` with your home directory. The Go and Xcode cache
  paths are needed for Sgola/iOS builds; drop them on machines that do not
  build those. The domain list covers Go modules, npm, GitHub and Homebrew;
  tighten or extend it for your own build graph.

`hostIPC.allowCommandPrefixes` runs a command **outside the OS sandbox** with
no prompt. Keep that list to exact, trusted prefixes.

`hostIPC.preflightCommandPrefixes` is the reviewed alternative: a matching
command goes to pi-auto-review (and to you only if the reviewer defers) before
it runs, and is not remembered. The project example routes
`just ios-build-check` and `just ios-interptest` that way.

## Sandbox side-steps

Build tools that insist on caches outside the workspace can hit
`Operation not permitted`. The agent can call pi-sandbox's `sandbox_escalate`
tool with the absolute path and a reason; pi-auto-review then decides whether
to re-run that exact command once with the path granted. Omitting `paths`
requests host execution instead (requires `hostIPC.mode: "ask"`). The
permission policy allows the tool so the boundary review is the only gate.
