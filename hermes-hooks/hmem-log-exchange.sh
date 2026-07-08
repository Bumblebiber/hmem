#!/usr/bin/env bash
# hmem-log-exchange.sh — Hermes post_llm_call hook
# Liest das Hook-JSON von stdin, transformiert es ins hmem-log-exchange Format,
# und schreibt den Exchange in den aktiven O-Entry.
#
# Requires: jq, hmem (global npm), HMEM_PATH + HMEM_PROJECT_DIR

set -euo pipefail

# Env defaults (hardcoded für Strato-Server)
export HMEM_PATH="${HMEM_PATH:-/home/bbbee/.hmem/Agents/DEVELOPER/DEVELOPER.hmem}"
export HMEM_PROJECT_DIR="${HMEM_PROJECT_DIR:-/home/bbbee/.hmem/Agents/DEVELOPER}"

# Lese Hook-Payload von stdin
payload="$(cat -)"

# Extrahiere user_message und assistant_response aus dem Hook-JSON
user_msg=$(echo "$payload" | jq -r '.extra.user_message // empty')
agent_msg=$(echo "$payload" | jq -r '.extra.assistant_response // empty')
session_id=$(echo "$payload" | jq -r '.session_id // empty')

# Guard: keine leeren Exchanges loggen
if [[ -z "$user_msg" || -z "$agent_msg" ]]; then
    exit 0
fi

# Guard: zu kurz
if [[ ${#user_msg} -lt 2 || ${#agent_msg} -lt 2 ]]; then
    exit 0
fi

# Guard: interne Hook-Prompts
if [[ "$user_msg" == "Generate a concise one-line title"* ]]; then
    exit 0
fi

# Transformiere ins hmem log-exchange Direct-Mode Format
log_input=$(jq -n \
    --arg user "$user_msg" \
    --arg agent "$agent_msg" \
    --arg sid "$session_id" \
    '{last_user_message: $user, last_assistant_message: $agent, session_id: $sid}')

# Pipe an hmem log-exchange
echo "$log_input" | hmem log-exchange 2>/dev/null

exit 0
