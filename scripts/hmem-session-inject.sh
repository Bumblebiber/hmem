#!/usr/bin/env bash
# SessionStart hook — injects hmem-using-hmem skill content into every session.
# Mirrors the Superpowers plugin pattern: shell script outputs additionalContext JSON.
#
# Setup (add to ~/.claude/settings.json hooks.SessionStart):
#   "command": "bash $(npm root -g)/hmem-mcp/scripts/hmem-session-inject.sh"
#
# Or copy to a stable path first:
#   cp $(npm root -g)/hmem-mcp/scripts/hmem-session-inject.sh ~/.claude/hooks/
#   "command": "bash ~/.claude/hooks/hmem-session-inject.sh"

set -euo pipefail

# Skill path is relative to this script (works from npm global or local dev)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_PATH="${SCRIPT_DIR}/../skills/hmem-using-hmem/SKILL.md"

content=$(cat "$SKILL_PATH" 2>/dev/null) || exit 0

escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

escaped=$(escape_for_json "$content")
context="<important-reminder>\n${escaped}\n</important-reminder>"

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$context"
