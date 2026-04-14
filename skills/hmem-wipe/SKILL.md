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

## Step 2: Update Next Steps

Before clearing context, ensure the active project's "Next Steps" section is up to date.
This is critical for session handoff — after /clear, the next session (or restored context)
needs to know what to work on next.

1. Find the "Next Steps" section: `read_memory(id="P00XX")` at depth 2 to list L2 children,
   then identify the "Next Steps" node by title (seq may vary per project).
2. Review current content: `read_memory(id="P00XX.N")` where N is the Next Steps seq.
3. Update with current priorities: `write_memory(id="P00XX.N", content="...")` with:
   - What was being worked on
   - What's done vs. still open
   - Immediate next actions for the next session
   - Any blockers or decisions pending
4. Mark completed steps as irrelevant: `update_memory(id="P00XX.N.M", irrelevant=true)` for
   each L3 child under Next Steps that has been fully completed. This keeps the section clean
   for the next session — irrelevant nodes are hidden from `load_project` output.

Skip if Next Steps is already current (updated within the last few exchanges).

## Step 3: Tell the user to /clear

O-entries are auto-logged by the Stop hook — every exchange is already saved
to the active project's O-entry. No need to manually create O-entries or call
`flush_context` for conversation history.

Reply with exactly:

> Context ready for clear. Type `/clear` — the SessionStart hook will automatically restore your project context.

Do NOT attempt to run /clear yourself — it is a built-in CLI command only the user can execute.

## What happens after /clear

Context is restored **automatically** by the `SessionStart[clear]` hook — no
agent action needed after /clear. Do **NOT** call `load_project` or `read_memory`
during or after this skill; the next session's first UserPromptSubmit hook will
trigger the normal hmem-read flow with a verified active project ID.

The hook:
1. Resets the MCP session cache
2. Injects recent conversation exchanges from the project's O-entry transcript
3. Injects the active project briefing (overview expanded)
4. Injects recent O-entry titles + rules

## Why this flow works

- **O-entries are covered.** The Stop hook logs every exchange to the active
  project's O-entry. Wipe does not need to handle conversation history.
- **Checkpoints are covered (auto mode).** The Haiku subagent extracts knowledge
  every 20 exchanges. Wipe only needs to catch the tail end, if anything.
- **Context restoration is covered.** The SessionStart[clear] hook handles
  re-injection automatically. The agent just needs the user to type /clear.
