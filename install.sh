#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v pi >/dev/null 2>&1; then
  echo "adripi: the pi CLI is not on PATH" >&2
  exit 1
fi

echo "== standard packages"
while IFS= read -r pkg; do
  case "$pkg" in ""|\#*) continue ;; esac
  pi install "$pkg"
done < packages.txt

echo "== pi-sandbox fork overlay"
pkg="${PI_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/@erichll/pi-sandbox"
if [ ! -d "$pkg/src" ]; then
  echo "adripi: pi-sandbox is not installed at $pkg" >&2
  exit 1
fi
cp -R extensions/pi-sandbox/src/. "$pkg/src/"
echo "   overlaid $(find extensions/pi-sandbox/src -name '*.ts' | wc -l | tr -d ' ') source files"

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
Restart Pi. If you reinstall or update @erichll/pi-sandbox, re-run install.sh.
NOTE
