#!/usr/bin/env bash
# hmem-startup.sh — Hermes pre_llm_call hook
# Session-Start: minimal — sync + inject hmem-session-start skill directive.
# All heavy lifting (H-entries, projects, pinned expansion, greeting) is in the skill.
# Checkpoint reminders + long-session warnings on subsequent turns.
#
# Requires: jq, hmem (global npm)

set -euo pipefail

export HMEM_PATH="${HMEM_PATH:-/home/bbbee/.hmem/Agents/DEVELOPER/DEVELOPER.hmem}"
export HMEM_PROJECT_DIR="${HMEM_PROJECT_DIR:-/home/bbbee/.hmem/Agents/DEVELOPER}"

payload="$(cat -)"

session_id=$(echo "$payload" | jq -r '.session_id // "unknown"')
is_first=$(echo "$payload" | jq -r '.extra.is_first_turn // false')
platform=$(echo "$payload" | jq -r '.extra.platform // "cli"')
parent_uuid=$(echo "$payload" | jq -r '.parentUuid // empty')

# --- Subagent: silent pass-through ---
if [[ -n "$parent_uuid" ]]; then
    printf '{}\n'
    exit 0
fi

# --- Session ID cache for statusline ---
cache_dir="${HMEM_PROJECT_DIR}"
mkdir -p "$cache_dir"
echo "{\"session_id\":\"$session_id\"}" > "${cache_dir}/.session-cache"

# ============================================================
# FIRST TURN: pre-inject all stable context — no more
# expensive MCP read_memory(mode='essentials') roundtrip.
# hmem hook-startup does H-entries, projects, device, sync —
# everything the session-start skill needed from STEP 0.
# ============================================================
if [[ "$is_first" == "true" ]]; then
    # Sync-Pull (3s timeout, silent)
    if command -v hmem &>/dev/null; then
        timeout 3 hmem sync pull </dev/null >/dev/null 2>/dev/null || true
    fi

    # Pre-injected context from hmem hook-startup.
    # Must pipe a minimal payload on stdin — parent script already
    # consumed its own stdin with cat - earlier.
    pre_context=""
    if command -v hmem &>/dev/null; then
        hmem_raw=$(echo "{\"session_id\":\"$session_id\"}" | HMEM_PATH="$HMEM_PATH" timeout 5 hmem hook-startup 2>/dev/null || true)
        pre_context=$(echo "$hmem_raw" | grep '^{' | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null || true)
    fi

    # Directive: skill handles STEPS 1-6, STEP 0 is SKIPPED
    directive="IMPORTANT: This is the first message of a new session.

Session context is PRE-INJECTED above — H-entries, projects, device info, sync status, infrastructure, checkpoint status. Do NOT call read_memory(mode='essentials') — the data is already in your context.

Load the hmem-session-start skill (skill_view(name='hmem-session-start')) and follow its instructions STARTING FROM STEP 1 (project activation). STEP 0 (read_memory essentials) is SKIPPED.
The skill handles: project activation, pending git work, Next Steps, greeting, O-entry routing — do not skip any step."

    combined="${pre_context}

${directive}"

    jq -n --arg ctx "$combined" '{context: $ctx}'
    exit 0
fi

# ============================================================
# SUBSEQUENT TURNS: checkpoint reminders + long-session warnings
# ============================================================
counter_file="/tmp/hermes-hmem-counter-${session_id}"

turn_count=1
if [[ -f "$counter_file" ]]; then
    turn_count=$(($(cat "$counter_file") + 1))
fi
echo "$turn_count" > "$counter_file"

# Config lesen
checkpoint_interval=20
checkpoint_mode="remind"  # default: remind (hmem hook-startup says so)
hmem_config="${HMEM_PROJECT_DIR}/hmem.config.json"
if [[ -f "$hmem_config" ]]; then
    interval_from_config=$(jq -r '.memory.checkpointInterval // empty' "$hmem_config" 2>/dev/null)
    if [[ -n "$interval_from_config" && "$interval_from_config" -gt 0 ]]; then
        checkpoint_interval="$interval_from_config"
    fi
    mode_from_config=$(jq -r '.memory.checkpointMode // empty' "$hmem_config" 2>/dev/null)
    if [[ -n "$mode_from_config" ]]; then
        checkpoint_mode="$mode_from_config"
    fi
fi

# Checkpoint Reminder — nur wenn mode=remind (nicht auto)
if [[ "$checkpoint_mode" == "remind" && $(( turn_count % checkpoint_interval )) -eq 0 ]]; then
    reminder="📝 Checkpoint fällig (Turn $turn_count). Wichtige Erkenntnisse mit write_memory speichern."
    jq -n --arg ctx "$reminder" '{context: $ctx}'

# Long-Session Warning (ab 60 Turns, alle 5)
elif [[ "$turn_count" -ge 60 && $(( turn_count % 5 )) -eq 0 ]]; then
    warning="⚠️ Lange Session (Turn $turn_count). /wipe zum Speichern, dann /clear für frischen Kontext."
    jq -n --arg ctx "$warning" '{context: $ctx}'

else
    printf '{}\n'
fi

exit 0
