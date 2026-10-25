# config

Templates installed by `install.sh` into `~/.pi/agent`. Existing files are kept,
so you can customize them on each machine.

- `guardian.json` — semantic reviewer settings. The included template uses
  `neuralwatt/nw-flash` and loads the Neuralwatt provider extension in the
  reviewer sidecar. For another provider, replace `reviewer.model` and set
  `reviewer.extensions` only if the provider comes from a Pi extension.
- `guardian-policy.md` — the reviewer policy. Workspace-local work is allowed,
  credentials and security configuration are denied, and uncertainty fails
  closed.
- `pi-perm.config.json` — the OS sandbox profile. `:workspace_roots` is the
  active project; `.git`, `.codex`, and `.agents` are read-only; `.env` files,
  `.git/hooks`, and the usual dangerous shell prefixes are denied.
- `pi-review.json` — the diff-review gate and reviewer models. The included
  template uses Neuralwatt models; replace them with models available from your
  provider.

## Allowing another directory

`pi-perm` treats workspaces as read+write and other directories as external
grants. To make a second repository writable on this machine, add an absolute
subpath table under `permissions.workspace.filesystem`:

```json
"/Users/you/g/other-repo": {
  ".": "write"
}
```

Use an absolute path. Do not add a wildcard or a home-directory-wide grant.

## Why JSON, not TOML

`pi-perm@0.1.8` parses TOML with `smol-toml`, whose nested tables have a null
prototype. Its validator only accepts plain `Object.prototype` objects, so
nested TOML filesystem tables are rejected at startup. The JSON form works.

## Guardian reviewer extensions

The vendored guardian fork adds `reviewer.extensions`. Only the entries in that
array are loaded by the reviewer sidecar. The sidecar still uses `--no-tools`
and `--no-extensions`; it cannot call tools and no other user/project extension
is loaded.

Use this when the reviewer provider is supplied by a Pi extension, for example:

```json
"reviewer": {
  "model": "neuralwatt/nw-flash",
  "extensions": ["npm:@aliou/pi-neuralwatt@0.18.0"]
}
```

For a built-in provider, or a provider defined in `models.json`, leave
`reviewer.extensions` empty.
