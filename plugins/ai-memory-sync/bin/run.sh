#!/bin/sh
# Runs the ai-memory-sync CLI with whatever node is available, even under the minimal PATH
# that GUI apps (Cursor, Codex desktop) and git hooks provide.
DIR="$(cd "$(dirname "$0")" && pwd)"
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:/usr/bin:/bin"
export PATH
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for n in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/aliases/default/bin/node; do
    [ -x "$n" ] && NODE="$n"
  done
fi
if [ -z "$NODE" ]; then
  echo "ai-memory-sync: node >= 20 not found" >&2
  case "$1" in hook|codex-notify|clone-hook) exit 0 ;; *) exit 127 ;; esac
fi
exec "$NODE" "$DIR/ai-memory-sync.mjs" "$@"
