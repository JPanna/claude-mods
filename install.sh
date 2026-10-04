#!/usr/bin/env bash
# Copies every mod in plugins/ into ~/.claude/skills/, where Claude Code loads
# it in every session and every project. Run it from a clone of this repo:
#   git clone --depth 1 https://github.com/JPanna/claude-mods /tmp/claude-mods && bash /tmp/claude-mods/install.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
mkdir -p "$target"

for mod in "$here"/plugins/*/; do
  name="$(basename "$mod")"
  rm -rf "${target:?}/$name"
  cp -R "$mod" "$target/$name"
  echo "claude-mods: installed $name -> $target/$name"
done
