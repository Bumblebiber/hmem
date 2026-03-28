---
name: hmem-wipe
description: >
  Flush conversation context to hmem and prepare for /clear. Use when:
  - User types /wipe
  - Context threshold warning appears (100k tokens)
  - User says "context aufräumen", "clear machen", "wipe"
  Saves the current session, then instructs user to /clear for re-injection.
---

# Wipe — Save & Clear Context

You MUST follow these steps in order:

## Step 1: Save pending knowledge

Save any unsaved insights from this session:
- New lessons learned → `write_memory(prefix="L", ...)`
- Project progress → `append_memory(id="P00XX.7", ...)` (Protocol node)
- Decisions made → `write_memory(prefix="D", ...)`
- Errors encountered → `write_memory(prefix="E", ...)`

Skip if you already saved recently (last checkpoint < 5 messages ago).

## Step 2: Title O-entries

Run the title script in the background — it spawns Haiku to title untitled O-entries:

```bash
/home/bbbee/.claude/hooks/hmem-title-o-entries.sh &
```

## Step 3: Tell the user

Reply with exactly:

> Wissen gesichert, O-Titles werden im Hintergrund erstellt. Tippe jetzt `/clear` — der Hook injiziert automatisch den komprimierten Kontext.

Do NOT attempt to run /clear yourself — it's a built-in CLI command only the user can execute.

## What happens after /clear

The `SessionStart[clear]` hook automatically:
1. Resets the MCP session cache
2. Injects the last 20 conversation messages from the transcript
3. Injects the active project briefing (overview expanded)
4. Injects recent O-entry titles + rules

The agent then has full context to continue working.
