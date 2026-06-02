#!/usr/bin/env bash
# o9k-log-exchange.sh — Hermes post_llm_call hook → TIM session_log
# Logs each user+assistant exchange to TIM session.
# Supports route_exchanges_to for sessions that live in TIM but not on local disk.
# Requires: jq, node
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"
user_msg=$(printf '%s' "$payload" | jq -r '.extra.user_message // empty')
agent_msg=$(printf '%s' "$payload" | jq -r '.extra.assistant_response // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')

# Guards
[[ -z "$user_msg" || -z "$agent_msg" ]] && exit 0
[[ ${#user_msg} -lt 2 || ${#agent_msg} -lt 2 ]] && exit 0
[[ "$user_msg" == "Generate a concise one-line title"* ]] && exit 0

# ── Resolve session ID ──
session_id=""

# 1. Try local .tim-project (walk up from cwd)
local_session=$(node -e "
  const fs = require('fs');
  const path = require('path');
  let dir = '$cwd';
  while (true) {
    const p = path.join(dir, '.tim-project');
    if (fs.existsSync(p)) {
      const m = JSON.parse(fs.readFileSync(p,'utf8'));
      process.stdout.write(m.session || '');
      break;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
" 2>/dev/null || true)

if [[ -n "$local_session" ]]; then
  session_id="$local_session"
fi

# 2. Fallback: global route_exchanges_to → sessions map
if [[ -z "$session_id" && -f "$HOME/.tim-project" ]]; then
  route=$(jq -r '.route_exchanges_to // empty' "$HOME/.tim-project" 2>/dev/null || true)
  if [[ -n "$route" ]]; then
    session_id=$(jq -r ".sessions[\"$route\"] // empty" "$HOME/.tim-project" 2>/dev/null || true)
  fi
fi

[[ -z "$session_id" ]] && exit 0

# Log exchange via TIM CLI
node "$TIM_CLI" hook log \
  --session "$session_id" \
  --user "$user_msg" \
  --agent "$agent_msg" 2>/dev/null || true

exit 0
