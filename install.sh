#!/bin/sh
# Install links only; no download, simulator launch or global tool configuration.
set -eu
SRC=$(cd "$(dirname "$0")" && pwd -P)
NAME=browser-sim-ops
TARGET=${1:-all}
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills
LEGACY_CODEX_DIR=${CODEX_HOME:-$HOME/.codex}/skills
CODEX_DIR=${CODEX_SKILLS_DIR:-$HOME/.agents/skills}
# Preserve a previously installed Codex link; do not create duplicate discovery.
if [ -z "${CODEX_SKILLS_DIR:-}" ] && [ -L "$LEGACY_CODEX_DIR/$NAME" ] && [ "$(readlink "$LEGACY_CODEX_DIR/$NAME")" = "$SRC" ]; then
  CODEX_DIR=$LEGACY_CODEX_DIR
fi
check() {
  dest=$1/$NAME
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$SRC" ]; then return; fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "conflict: $dest already exists; nothing will be overwritten" >&2
    exit 1
  fi
}
link() {
  dest=$1/$NAME
  if [ -L "$dest" ]; then echo "already linked: $dest"; return; fi
  mkdir -p "$1"
  ln -s "$SRC" "$dest"
  [ -r "$dest/SKILL.md" ]
  echo "linked: $dest -> $SRC"
}
case "$TARGET" in
  claude) check "$CLAUDE_DIR"; link "$CLAUDE_DIR" ;;
  codex) check "$CODEX_DIR"; link "$CODEX_DIR" ;;
  all) check "$CLAUDE_DIR"; check "$CODEX_DIR"; link "$CLAUDE_DIR"; link "$CODEX_DIR" ;;
  *) echo "usage: $0 [claude|codex|all]" >&2; exit 2 ;;
esac
echo "Skill files installed. Open a new agent session to check discovery. Simulator dependencies have not been checked."
