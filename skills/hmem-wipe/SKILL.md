---
name: hmem-wipe
description: >
  Prepare for /clear by optionally saving high-value knowledge. Use when:
  - User types /wipe
  - Context threshold warning appears (100k tokens)
  - User says "context aufräumen", "clear machen", "wipe"
  Handles pre-clear cleanup, then instructs user to /clear for automatic context restoration.
---

# Wipe — Prepare & Clear Context

Follow these steps in order.

## Step 1: Optionally save high-value knowledge

Check `checkpointMode` in hmem.config.json to decide what to do:

### checkpointMode: "auto"

The Haiku subagent already extracts L/D/E entries every 20 exchanges automatically.
Skip manual writes unless you have **specific high-value knowledge** that:
- Was discovered in the last few exchanges (too recent for the last auto-checkpoint)
- Is critical enough that losing it would cost significant rework
- Is NOT already covered by a recent auto-checkpoint

If nothing qualifies, proceed directly to Step 2.

### checkpointMode: "remind"

Manually save unsaved insights from this project context:
- New lessons learned: `write_memory(prefix="L", ...)`
- Project progress: `append_memory(id="P00XX.7", ...)` (Protocol node)
- Decisions made: `write_memory(prefix="D", ...)`
- Errors encountered: `write_memory(prefix="E", ...)`

Skip if the last checkpoint was fewer than 5 messages ago.

### Why gate on checkpointMode?

Redundant writes waste tokens and create duplicates that clutter memory.
Auto-checkpoints already call `read_memory` to deduplicate before writing —
manual writes during wipe bypass that check and risk creating noise.

## Step 2: Tell the user to /clear

O-entries are auto-logged by the Stop hook — every exchange is already saved
to the active project's O-entry. No need to manually create O-entries or call
`flush_context` for conversation history.

Reply with exactly:

> Context ready for clear. Type `/clear` — the SessionStart hook will automatically restore your project context.

Do NOT attempt to run /clear yourself — it is a built-in CLI command only the user can execute.

## What happens after /clear

The `SessionStart[clear]` hook automatically:
1. Resets the MCP session cache
2. Injects recent conversation exchanges from the project's O-entry transcript
3. Injects the active project briefing (overview expanded)
4. Injects recent O-entry titles + rules

The agent then calls `load_project` and has full context to continue working.
No manual restoration needed.

## Why this flow works

- **O-entries are covered.** The Stop hook logs every exchange to the active
  project's O-entry. Wipe does not need to handle conversation history.
- **Checkpoints are covered (auto mode).** The Haiku subagent extracts knowledge
  every 20 exchanges. Wipe only needs to catch the tail end, if anything.
- **Context restoration is covered.** The SessionStart[clear] hook handles
  re-injection automatically. The agent just needs the user to type /clear.
