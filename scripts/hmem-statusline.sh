#!/bin/bash
# hmem statusline for Claude Code (installed by hmem init)
# Shows: context window bar with token count + active hmem project
input=$(cat)

# Context window: show used tokens as e.g. "30k" and a color bar
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
input_tokens=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // empty')

if [ -n "$used_pct" ]; then
  used_int=$(printf '%.0f' "$used_pct")
  filled=$(( used_int * 20 / 100 ))
  empty=$(( 20 - filled ))
  bar=""
  for i in $(seq 1 $filled); do bar="${bar}#"; done
  for i in $(seq 1 $empty); do bar="${bar}-"; done
  if [ "$used_int" -ge 80 ]; then
    color='\033[01;31m'
  elif [ "$used_int" -ge 50 ]; then
    color='\033[01;33m'
  else
    color='\033[01;32m'
  fi
  # Calculate total context tokens (input + cache_creation + cache_read)
  cache_create=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
  cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
  total_ctx=$(( ${input_tokens:-0} + ${cache_create:-0} + ${cache_read:-0} ))
  if [ "$total_ctx" -gt 0 ] 2>/dev/null; then
    tok_k=$(echo "$total_ctx" | awk '{printf "%.0fk", $1/1000}')
  else
    tok_k="${used_int}%"
  fi
  ctx_part="${color}[${bar}]\033[00m \033[00;37m${tok_k}\033[00m"
else
  ctx_part=""
fi

# Active hmem project — cached for 30 seconds
CACHE_FILE="/tmp/.hmem_active_project_cache"
NOW=$(date +%s)
PROJECT_STR=""

if [ -f "$CACHE_FILE" ]; then
  cache_ts=$(head -1 "$CACHE_FILE")
  age=$(( NOW - cache_ts ))
  if [ "$age" -lt 30 ]; then
    PROJECT_STR=$(tail -n +2 "$CACHE_FILE")
  fi
fi

if [ -z "$PROJECT_STR" ]; then
  # Find hmem database (auto-detect from Agents/ directory)
  HMEM_DB=""
  HMEM_DIR="${HMEM_PROJECT_DIR:-$HOME/.hmem}"
  if [ -n "$HMEM_AGENT_ID" ]; then
    DB_CANDIDATE="$HMEM_DIR/Agents/$HMEM_AGENT_ID/$HMEM_AGENT_ID.hmem"
    [ -f "$DB_CANDIDATE" ] && HMEM_DB="$DB_CANDIDATE"
  fi
  if [ -z "$HMEM_DB" ]; then
    for DB in "$HMEM_DIR"/Agents/*/*.hmem; do
      [ -f "$DB" ] && HMEM_DB="$DB" && break
    done
  fi
  if [ -n "$HMEM_DB" ]; then
    PROJECT_STR=$(node -e "
      try {
        const Database = require('better-sqlite3');
        const db = new Database('$HMEM_DB', { readonly: true });
        // Try active=1 first, fallback to most recently updated P-entry
        let row = db.prepare(\"SELECT id, title FROM memories WHERE prefix='P' AND active=1 LIMIT 1\").get();
        if (!row) {
          row = db.prepare(\"SELECT id, title FROM memories WHERE prefix='P' AND obsolete!=1 AND irrelevant!=1 ORDER BY updated_at DESC LIMIT 1\").get();
        }
        db.close();
        if (row) {
          const name = row.title.split('|')[0].trim();
          process.stdout.write(row.id + ' ' + name);
        }
      } catch(e) {}
    " 2>/dev/null)
  fi
  printf '%s\n%s\n' "$NOW" "$PROJECT_STR" > "$CACHE_FILE"
fi

# Compose output
parts=()
[ -n "$ctx_part" ] && parts+=("$ctx_part")
if [ -n "$PROJECT_STR" ]; then
  parts+=("\033[00;36m${PROJECT_STR}\033[00m")
else
  parts+=("\033[00;90mno project\033[00m")
fi

out=""
for part in "${parts[@]}"; do
  [ -n "$out" ] && out="${out}  \033[00;90m|\033[00m  "
  out="${out}${part}"
done

[ -n "$out" ] && printf "%b" "$out"
