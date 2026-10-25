#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

die() {
  echo "adripi: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

need pi
need pnpm
need node
need rsync

export PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
NPM_ROOT="$PI_AGENT_DIR/npm/node_modules"

echo "== pnpm"
node scripts/set-npm-command.mjs "$PI_AGENT_DIR"

echo "== sandbox runtime"
if ! command -v srt >/dev/null 2>&1; then
  pnpm add -g @anthropic-ai/sandbox-runtime@0.0.81
fi
if ! command -v srt >/dev/null 2>&1; then
  PNPM_BIN="$(pnpm bin -g)"
  cat <<EOF
adripi: srt is installed but not on PATH.
Add it before starting Pi:
  fish:      fish_add_path $PNPM_BIN
  bash/zsh:  export PATH="$PNPM_BIN:\$PATH"
EOF
fi

echo "== packages"
while IFS= read -r pkg; do
  case "$pkg" in
    ""|"#"*) continue ;;
  esac
  pi install "$pkg"
done < packages.txt

echo "== fork source"
while IFS='|' read -r pkg dir; do
  case "$pkg" in
    ""|"#"*) continue ;;
  esac
  target="$NPM_ROOT/$pkg"
  src="$dir/src"
  [ -f "$target/package.json" ] || die "$pkg is not installed under $NPM_ROOT"
  [ -d "$src" ] || die "missing fork source at $src"
  rsync -a --delete "$src/" "$target/src/"
  installed_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$target/package.json" | head -n 1)"
  fork_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dir/package.json" | head -n 1)"
  echo "   deployed $pkg <- $dir"
  if [ -n "$installed_version" ] && [ -n "$fork_version" ] &&
     [ "$installed_version" != "$fork_version" ]; then
    echo "   warning: npm has $pkg@$installed_version, fork is $fork_version" >&2
    echo "            re-pin packages.txt or update the vendored fork" >&2
  fi
done < forks.txt

echo "== config"
PI_PERM_DIR="$PI_AGENT_DIR/extensions/pi-perm"
mkdir -p "$PI_PERM_DIR"

# pi-perm 0.1.8 rejects nested TOML tables because smol-toml tables have a null
# prototype. Its loader prefers config.toml over config.json, so retire any
# TOML file before installing the JSON profile.
if [ -f "$PI_PERM_DIR/config.toml" ]; then
  mv "$PI_PERM_DIR/config.toml" "$PI_PERM_DIR/config.toml.bak"
  echo "   moved pi-perm config.toml to config.toml.bak"
fi
if [ ! -f "$PI_PERM_DIR/config.json" ]; then
  cp config/pi-perm.config.json "$PI_PERM_DIR/config.json"
  echo "   installed pi-perm config.json"
else
  echo "   kept existing pi-perm config.json"
fi

if [ ! -f "$PI_AGENT_DIR/guardian.json" ]; then
  cp config/guardian.json "$PI_AGENT_DIR/guardian.json"
  echo "   installed guardian.json"
else
  echo "   kept existing guardian.json"
fi
if [ ! -f "$PI_AGENT_DIR/guardian-policy.md" ]; then
  cp config/guardian-policy.md "$PI_AGENT_DIR/guardian-policy.md"
  echo "   installed guardian-policy.md"
else
  echo "   kept existing guardian-policy.md"
fi
if [ ! -f "$PI_AGENT_DIR/pi-review.json" ]; then
  cp config/pi-review.json "$PI_AGENT_DIR/pi-review.json"
  echo "   installed pi-review.json"
else
  echo "   kept existing pi-review.json"
fi

cat <<'NOTE'

== sign in
Start Pi and run `/login`, then choose the provider you want to use for the
reviewer and pi-review. They use the same stored credential.

== verify
  /guardian status      # prints the configured reviewer model
  /pi-perm              # active profile: workspace
  bash true             # a reviewed call; must be allowed
  /review --lite        # in a git repository

== project directories
Workspace roots are read+write. To authorize another directory, add an
absolute subpath table in ~/.pi/agent/extensions/pi-perm/config.json; see
config/README.md.

== done
Restart Pi after installing or updating extensions.
NOTE
