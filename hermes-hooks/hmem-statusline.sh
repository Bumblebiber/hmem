#!/usr/bin/env bash
# hmem-statusline.sh — hmem-Status für Hermes Statusbar
# Nutzt hmem statusline mit session_id-Cache vom hmem-startup.sh

set -euo pipefail

CACHE="$HOME/.hmem/Agents/DEVELOPER/.session-cache"
SESSION_ID=""

if [[ -f "$CACHE" ]]; then
    cache_age=$(($(date +%s) - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0)))
    if [[ "$cache_age" -lt 3600 ]]; then  # 1h TTL
        SESSION_ID=$(cat "$CACHE" | jq -r '.session_id // ""' 2>/dev/null || echo "")
    fi
fi

# hmem statusline aufrufen (session_id optional)
if [[ -n "$SESSION_ID" ]]; then
    status=$(echo "{\"session_id\":\"$SESSION_ID\"}" | hmem statusline 2>/dev/null || echo "")
else
    status=$(echo '{}' | hmem statusline 2>/dev/null || echo "")
fi

if [[ -z "$status" ]]; then
    echo '{}'
    exit 0
fi

# ANSI strippen und parsen
clean=$(echo "$status" | sed 's/\x1b\[[0-9;]*m//g')

# Format: "Device  |  Project → ONode  |  count/total"
device=$(echo "$clean" | awk -F'\\|' '{gsub(/^ +| +$/,"",$1); print $1}')
project_raw=$(echo "$clean" | awk -F'\\|' '{gsub(/^ +| +$/,"",$2); print $2}')
counter=$(echo "$clean" | awk -F'\\|' '{gsub(/^ +| +$/,"",$3); print $3}')

# O-Node aus Project extrahieren (falls → O0048.118)
o_node=""
project="$project_raw"
if echo "$project_raw" | grep -q "→"; then
    project=$(echo "$project_raw" | sed 's/ →.*//')
    o_node=$(echo "$project_raw" | grep -oP 'O\d+\.\d+' || echo "")
fi

# Device kürzen
if [[ ${#device} -gt 14 ]]; then
    device="${device:0:14}"
    device="${device% *}"
fi

jq -n \
    --arg device "$device" \
    --arg project "$project" \
    --arg o_node "$o_node" \
    --arg counter "$counter" \
    '{device: $device, project: $project, o_node: $o_node, counter: $counter}'
