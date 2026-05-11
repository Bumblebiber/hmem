---
name: o9k-using-hmem
description: Meta-skill that establishes how and when to use hmem skills. Loaded at session start. Defines mandatory habits for memory, dispatch, and lookup operations.
---

# Using hmem Skills

## The Rule

**Before searching, looking up, or exploring anything — dispatch via `o9k-dispatch`. Before responding to the user about something you had to find — dispatch first, synthesize after.**

This is not optional. A 3-line grep dispatched is better than a slow main-context search that pollutes the conversation.

## Skill Decision Table

| When you want to... | Use |
|---------------------|-----|
| Find a file, function, or code pattern | `o9k-dispatch` |
| Check if a plan, spec, or doc exists | `o9k-dispatch` |
| Answer "does X exist?" or "find Y" | `o9k-dispatch` |
| Search hmem for past decisions/lessons | `o9k-recall` |
| Run 2+ independent tasks at once | `o9k-dispatch` (multiple agents) |
| Store a new insight, lesson, or decision | `o9k-write` |
| Load project context at session start | `o9k-session-start` |
| Load context for a specific topic | `o9k-context` |
| **Create a new project (P-entry) in hmem** | **`o9k-new-project`** |
| Start curation / cleanup of memory | `o9k-curate` |
| Migrate O-entries to new format | `o9k-migrate-o` |

## Targeted vs. Exploratory

Not all Bash calls need dispatching. The key distinction:

| Type | Characteristics | Action |
|------|----------------|--------|
| **Targeted** | Known path/pattern, single command, result ≤3 lines | Run directly |
| **Exploratory** | Open-ended, multiple locations, result unknown | Dispatch |

**Targeted (OK to run directly):** `find /home/username -name "settings.json" -path "*claude*"` — one known location, one expected result.

**Exploratory (must dispatch):** `grep -r "functionName" ~/projects/` across repos, or "where is X defined?" without knowing which file.

When in doubt: if you'd be surprised by the output → dispatch it.

## Red Flags

These thoughts mean STOP — dispatch instead:

| Thought | Reality |
|---------|---------|
| "I'll just grep this quickly" | Is it exploratory? Dispatch. Is it one targeted command with predictable output? Run it. |
| "Let me run find real fast" | Known path + expected result → OK. Unknown territory → dispatch. |
| "It's only one Bash call" | Targeted (≤3 lines expected) → fine. Exploratory → dispatch. |
| "This is too small to dispatch" | Dispatching 2-line tasks is fine and fast. |
| "I need to check the codebase first" | Dispatch the check. |
| "Let me read this file to see what's there" | Dispatch it. You only need the result. |
| "I'll search memory quickly myself" | Use `o9k-recall` instead. |
| "I remember how this works" | Skills evolve. Invoke the skill. |
| "I'll write the P-entry manually with write_memory" | Use `o9k-new-project`. It handles schema, O-entry linking, and section setup. |

## MANDATORY — DO NOT

Hard stops, not guidelines:

| DO NOT | Instead |
|--------|---------|
| Read `~/.hmem/*.hmem` directly | Use `read_memory()`, `search_memory()`, or `/o9k-read` |
| Create O-entries manually | O-entries are auto-managed by Haiku — use `/o9k-session-start` (R0022) |
| Write to memory during an active task | Finish the task first, then write |
| Call `search_memory` twice in one turn | Batch into one call, or use `o9k-recall` |
| Create P-entries with `write_memory` | Use `o9k-new-project` — schema + O-entry linking auto-handled |
| Call `load_project` mid-session without routing | Always use `/o9k-activate` — it handles exchange misrouting |

## Mandatory Habits

1. **Search = Dispatch — unless targeted.** Exploratory searches ("find", "where is X", "what does file Y contain") → `o9k-dispatch`. Single targeted command with a predictable result (≤3 lines) → run directly.
2. **Memory = Tools.** Write insights via `write_memory`. Never rely on conversation history alone.
3. **Skills override instinct.** If a skill exists for the task, use it — even if you think you remember how it works.
4. **New project = `o9k-new-project`.** Never create P-entries manually — the skill handles schema, sections, and O-entry linking.
5. **Code navigation = Codebase node first.** Before editing or tracing any function: check `read_memory(id="P00XX.2")` for documented signatures. If not found, dispatch an Explore agent — never explore the filesystem directly in main context. Update the Codebase node with what you find.
