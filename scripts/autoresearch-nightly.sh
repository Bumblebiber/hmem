#!/bin/bash
# Autoresearch Nightly — optimizes hmem checkpoint prompts
# Run via cron: 0 2 * * 0 /home/bbbee/projects/hmem/scripts/autoresearch-nightly.sh
#
# What it does:
# 1. Creates a fresh branch from main
# 2. Runs autoresearch with a defined goal + metric
# 3. Results logged to autoresearch-results.tsv
# 4. If improvements found: pushes branch, creates PR
# 5. Sends Telegram notification

set -euo pipefail

REPO_DIR="$HOME/projects/hmem"
BRANCH="autoresearch/$(date +%Y%m%d)"
LOG_FILE="/tmp/autoresearch-$(date +%Y%m%d).log"
MAX_ITERATIONS=10
BUDGET_TIMEOUT=600  # 10 min max

cd "$REPO_DIR"

# Ensure clean state
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree not clean, aborting" | tee "$LOG_FILE"
  exit 1
fi

# Create branch
git checkout main
git pull --ff-only
git checkout -b "$BRANCH"

# Run autoresearch with claude -p
# Goal: Improve checkpoint summary quality
# Metric: Token ratio (summary tokens / exchange tokens) — lower is better while maintaining info
# Verify: Run test-checkpoint.js which scores summary quality

claude -p \
  --model sonnet \
  --allowedTools "Bash Read Write Edit Grep Glob" \
  --dangerously-skip-permissions \
  --max-tokens 50000 \
  <<EOF 2>&1 | tee "$LOG_FILE"

/autoresearch

Goal: Improve the Haiku checkpoint summary prompt in src/cli-checkpoint.ts to produce more informative, concise summaries.

Scope: Only modify the prompt string in cli-checkpoint.ts (lines 115-190). Do not change any other code.

Metric: Run 'npx tsc --noEmit' to verify no compile errors. Then manually score: shorter prompt = better (fewer tokens), but must still produce quality summaries.

Direction: lower_is_better (fewer prompt tokens while maintaining quality)

Verify: npx tsc --noEmit && node -e "const fs=require('fs'); const src=fs.readFileSync('src/cli-checkpoint.ts','utf8'); const match=src.match(/const prompt = \\\`([\\s\\S]*?)\\\`;/); console.log('Prompt tokens:', Math.round(match[1].length/4)); if(match[1].length/4 > 2000) { process.exit(1); }"

Iterations: $MAX_ITERATIONS
EOF

# Check if any changes were made
if [[ -z "$(git diff main..HEAD --stat)" ]]; then
  echo "No improvements found" | tee -a "$LOG_FILE"
  git checkout main
  git branch -D "$BRANCH"
  exit 0
fi

# Push and create PR
git push -u origin "$BRANCH"
gh pr create \
  --title "autoresearch: optimize checkpoint prompt ($(date +%Y-%m-%d))" \
  --body "Automated optimization by autoresearch nightly run.

## Changes
$(git log main..HEAD --oneline)

## Results
$(cat autoresearch-results.tsv 2>/dev/null || echo 'No results file')

## Review
Please review the prompt changes in \`src/cli-checkpoint.ts\` before merging."

echo "PR created, switching back to main"
git checkout main
