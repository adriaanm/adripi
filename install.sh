#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v pi >/dev/null 2>&1; then
  echo "adripi: the pi CLI is not on PATH" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "adripi: git is required to check out the extension forks" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "adripi: rsync is required to deploy the extension forks" >&2
  exit 1
fi

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
NPM_ROOT="$PI_AGENT_DIR/npm/node_modules"

echo "== forks"
# On this machine the personal commits exist only locally, so a fresh clone of
# adripi cannot initialize these submodules until the forks are pushed. Where
# the checkout already exists this is a no-op.
git submodule update --init --recursive

echo "== standard packages"
while IFS= read -r pkg; do
  case "$pkg" in
    ""|"#"*) continue ;;
  esac
  pi install "$pkg"
done < packages.txt

echo "== fork source"
# Install from npm first (dependencies + host peer wiring), then replace the
# package source with the fork. --delete removes files the fork dropped.
while IFS='|' read -r pkg dir; do
  case "$pkg" in
    ""|"#"*) continue ;;
  esac
  target="$NPM_ROOT/$pkg"
  src="$dir/src"
  if [ ! -f "$target/package.json" ]; then
    echo "adripi: $pkg is not installed under $NPM_ROOT" >&2
    echo "        list it in packages.txt so pi installs its dependencies" >&2
    exit 1
  fi
  if [ ! -d "$src" ]; then
    echo "adripi: missing fork source at $src" >&2
    exit 1
  fi
  rsync -a --delete "$src/" "$target/src/"
  installed_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$target/package.json" | head -n 1)"
  fork_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dir/package.json" | head -n 1)"
  echo "   deployed $pkg <- $dir"
  if [ -n "$installed_version" ] && [ -n "$fork_version" ] &&
     [ "$installed_version" != "$fork_version" ]; then
    echo "   warning: npm has $pkg@$installed_version, fork is $fork_version" >&2
    echo "            re-pin packages.txt or rebase the fork on the newer tag" >&2
  fi
done < forks.txt

echo "== global config (existing files are kept)"
mkdir -p "$HOME/.pi/agent/extensions/pi-permission-system" \
         "$HOME/.pi/agent/extensions/pi-auto-review"
if [ ! -f "$HOME/.pi/agent/extensions/pi-permission-system/config.json" ]; then
  cp config/pi-permission-system.json \
     "$HOME/.pi/agent/extensions/pi-permission-system/config.json"
  echo "   installed pi-permission-system config"
else
  echo "   kept existing pi-permission-system config; compare with config/pi-permission-system.json"
fi
if [ ! -f "$HOME/.pi/agent/extensions/pi-auto-review/config.json" ]; then
  cp config/pi-auto-review.example.json \
     "$HOME/.pi/agent/extensions/pi-auto-review/config.json"
  echo "   installed pi-auto-review example; set its model"
else
  echo "   kept existing pi-auto-review config; compare with config/pi-auto-review.example.json"
fi

cat <<'NOTE'

== project policy
Copy config/pi-sandbox.project.example.json to
<project>/.pi/extensions/pi-sandbox/config.json and adjust paths/prefixes.
The file is read when Pi starts, not hot-reloaded.

== done
Restart Pi. After changing a fork, commit it inside the submodule and re-run
install.sh to deploy the new source.
NOTE
