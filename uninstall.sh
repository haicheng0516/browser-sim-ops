#!/bin/sh
set -eu
SRC=$(cd "$(dirname "$0")" && pwd -P)
for dir in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" "${CODEX_SKILLS_DIR:-$HOME/.agents/skills}" "${CODEX_HOME:-$HOME/.codex}/skills"; do
  dest=$dir/browser-sim-ops
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$SRC" ]; then
    rm "$dest"
    echo "unlinked: $dest"
  fi
done
echo "Local leases, locks and evidence are retained. Stop owned resources before removing state."
