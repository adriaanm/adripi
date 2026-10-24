# Fork notes

Base: `@erichll/pi-sandbox@0.27.0` (Apache-2.0). Upstream `LICENSE` and
`NOTICE` are retained in this directory.

Changes over upstream:

1. `hostIPC.allowCommandPrefixes` (optional): command prefixes that run on the
   host without a one-shot approval. Prefix matching is exact-prefix plus
   whitespace/end, so `just ios-device` does not match `just ios-device-logs`.
2. Host-IPC preflight prompts offer
   **Always allow "<prefix>" for this project**.
3. That choice is appended to `.pi/extensions/pi-sandbox/approvals.json`,
   loaded at registration and merged into `allowCommandPrefixes`.
4. `.pi/extensions/pi-sandbox/` is added to the sandbox `denyWrite` list so a
   sandboxed command cannot grant itself host execution.

The command still runs **outside the OS sandbox** when allowed. Keep the list
narrow and review new entries. A permanent approval is a policy decision, not a
weaker sandbox.

The incremental diff is `patches/pi-sandbox-permanent-approvals.patch`; the
pre-existing local knobs are `patches/pi-sandbox-allow.patch`.
