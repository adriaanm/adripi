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

echo "adripi: close any running Pi before installing; this rewrites its settings"
echo "== pnpm"
node scripts/set-npm-command.mjs "$PI_AGENT_DIR"

echo "== sandbox runtime"
if ! command -v srt >/dev/null 2>&1; then
  # Only install when nothing is on PATH; never downgrade a newer global install.
  if pnpm ls -g --depth 0 @anthropic-ai/sandbox-runtime >/dev/null 2>&1; then
    echo "   sandbox-runtime is installed globally but srt is not on PATH"
  else
    pnpm add -g @anthropic-ai/sandbox-runtime@0.0.81
  fi
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
    echo "   note: npm has $pkg@$installed_version, fork is $fork_version" >&2
    echo "         (a vendored fork may carry newer upstream source; see VENDOR.md)" >&2
  fi
done < forks.txt

echo "== config"
# pi-perm is retired: the OS boundary is the vendored pi-sbx fork plus the
# guardian sandbox broker. Remove the package if an older install still has it.
pi remove npm:pi-perm >/dev/null 2>&1 || true
# A stale settings entry can outlive the package (pi remove needs it in the npm
# project); drop it directly so the retired extension cannot load.
if node - "$PI_AGENT_DIR/settings.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(settings.packages)) process.exit(1);
const before = settings.packages.length;
settings.packages = settings.packages.filter((entry) => !/^npm:pi-perm(@|$)/.test(entry));
if (settings.packages.length === before) process.exit(1);
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
then
  echo "   removed pi-perm from settings.json"
fi
if [ -d "$PI_AGENT_DIR/extensions/pi-perm" ]; then
  # Keep the data (audit log, old profile) but move it out of the discovery path
  # so the retired extension cannot load or fight pi-sbx for the bash tool.
  retired="$PI_AGENT_DIR/extensions/pi-perm.retired"
  if [ -e "$retired" ]; then retired="$retired.$(date +%s)"; fi
  mv "$PI_AGENT_DIR/extensions/pi-perm" "$retired"
  echo "   retired old pi-perm data to $retired"
fi

mkdir -p "$PI_AGENT_DIR/extensions"
if [ ! -f "$PI_AGENT_DIR/extensions/sandbox.json" ]; then
  cp config/sandbox.json "$PI_AGENT_DIR/extensions/sandbox.json"
  echo "   installed extensions/sandbox.json"
else
  echo "   kept existing extensions/sandbox.json"
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

echo "== agent-dir write grant"
# This repo maintains the live profile it installs, so its own workspace is
# allowed to write the agent dir (see config/README.md, "agentDirWriteProjects").
# Running install.sh is the human decision that grants it; the agent cannot.
REPO_ROOT="$(pwd -P)"
node - "$PI_AGENT_DIR" "$REPO_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [agentDir, repoRoot] = process.argv.slice(2);
const grant = (list, value) => [...new Set([...(Array.isArray(list) ? list : []), value])];
function update(file, mutate, describe) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.log(`   skipped ${file} (missing or unreadable)`);
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify(mutate(config), null, 2)}\n`);
  console.log(`   ${describe}`);
}
update(
  path.join(agentDir, "extensions", "sandbox.json"),
  (config) => ({ ...config, agentDirWriteProjects: grant(config.agentDirWriteProjects, repoRoot) }),
  `extensions/sandbox.json: agentDirWriteProjects += ${repoRoot}`,
);
update(
  path.join(agentDir, "guardian.json"),
  (config) => {
    const permissions = config.permissions && typeof config.permissions === "object" ? config.permissions : {};
    return { ...config, permissions: { ...permissions, agentDirWriteProjects: grant(permissions.agentDirWriteProjects, repoRoot) } };
  },
  `guardian.json: permissions.agentDirWriteProjects += ${repoRoot}`,
);
NODE

cat <<'NOTE'

== sign in
Start Pi and run `/login`, then choose the provider you want to use for the
reviewer and pi-review. They use the same stored credential.

== verify
  /guardian status      # prints the configured reviewer model
  /sandbox              # sandbox state and effective policy
  bash true             # a reviewed call; must be allowed inside the sandbox

== sandbox policy
The OS boundary is the vendored pi-sbx fork. Project writes are allowed; the
hidden temp root is not, and each session gets a private scratch directory
(PI_SANDBOX_SCRATCH). Paths outside the project need a reviewed exception: the
agent calls request_sandbox_exception, guardian decides, and you are asked when
guardian defers. See config/README.md and docs/plan-sandbox-broker.md.

This install also grants THIS repository write access to the agent dir
(agentDirWriteProjects in both configs), so sessions here can maintain Pi's and
Guardian's own profile. That is a real privilege: a session in this workspace
can change what Pi and Guardian load next. Credentials (auth.json) and
Guardian's session transcripts stay denied. Remove the path from both files to
revoke it.

== done
Restart Pi after installing or updating extensions.
NOTE
