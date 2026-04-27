---
name: hmem-using-hmem
description: Meta-skill that establishes how and when to use hmem skills. Loaded at session start. Defines mandatory habits for memory, dispatch, and lookup operations.
---

# Using hmem Skills

## The Rule

**Before searching, looking up, or exploring anything — dispatch via `hmem-dispatch`. Before responding to the user about something you had to find — dispatch first, synthesize after.**

This is not optional. A 3-line grep dispatched is better than a slow main-context search that pollutes the conversation.

## Skill Decision Table

| When you want to... | Use |
|---------------------|-----|
| Find a file, function, or code pattern | `hmem-dispatch` |
| Check if a plan, spec, or doc exists | `hmem-dispatch` |
| Answer "does X exist?" or "find Y" | `hmem-dispatch` |
| Search hmem for past decisions/lessons | `hmem-recall` |
| Run 2+ independent tasks at once | `hmem-dispatch` (multiple agents) |
| Store a new insight, lesson, or decision | `hmem-write` |
| Load project context at session start | `hmem-session-start` |
| Load context for a specific topic | `hmem-context` |
| **Create a new project (P-entry) in hmem** | **`hmem-new-project`** |
| Start curation / cleanup of memory | `hmem-curate` |
| Migrate O-entries to new format | `hmem-migrate-o` |

## Red Flags

These thoughts mean STOP — dispatch instead:

| Thought | Reality |
|---------|---------|
| "I'll just grep this quickly" | Dispatch it. Main context stays clean. |
| "Let me run find real fast" | Dispatch it. |
| "It's only one Bash call" | If it's exploratory → dispatch. |
| "This is too small to dispatch" | Dispatching 2-line tasks is fine and fast. |
| "I need to check the codebase first" | Dispatch the check. |
| "Let me read this file to see what's there" | Dispatch it. You only need the result. |
| "I'll search memory quickly myself" | Use `hmem-recall` instead. |
| "I remember how this works" | Skills evolve. Invoke the skill. |
| "I'll write the P-entry manually with write_memory" | Use `hmem-new-project`. It handles schema, O-entry linking, and section setup. |

## Mandatory Habits

1. **Search = Dispatch.** Any "find", "check", "does X exist", "what does file Y contain" → `hmem-dispatch`.
2. **Memory = Tools.** Write insights via `write_memory`. Never rely on conversation history alone.
3. **Skills override instinct.** If a skill exists for the task, use it — even if you think you remember how it works.
4. **New project = `hmem-new-project`.** Never create P-entries manually — the skill handles schema, sections, and O-entry linking.
5. **Code navigation = Codebase node first.** Before editing or tracing any function: check `read_memory(id="P00XX.2")` for documented signatures. If not found, dispatch an Explore agent — never explore the filesystem directly in main context. Update the Codebase node with what you find.
