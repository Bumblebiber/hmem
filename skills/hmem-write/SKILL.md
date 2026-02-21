---
name: hmem-write
description: How to write long-term memories. Follow these rules whenever you call write_memory.
---

# How to use write_memory

When you need to save a lesson, error, decision, or project insight to long-term memory,
call the MCP tool `write_memory` following these rules.

If the tool `write_memory` is not available, tell the user:
"write_memory tool not found. Run `hmem init` to configure the MCP server."

---

## Syntax

```
write_memory(
  prefix: "E",
  content: "L1 sentence — concise, understandable without context\n\tL2 detail (1 tab)\n\t\tL3 detail (2 tabs)\n\t\t\tL4 raw data (3 tabs — rarely needed)"
)
```

**Indentation:** 1 tab = 1 level. Alternatively: 2 or 4 spaces per level (auto-detected).
**IDs and timestamps** are assigned automatically — never write them yourself.

---

## Prefixes

| Prefix | Category | When to use |
|--------|----------|-------------|
| **P** | Project | Project experiences, summaries |
| **L** | Lesson | Lessons learned, best practices |
| **E** | Error | Bugs, errors + their fix |
| **D** | Decision | Architecture decisions with reasoning |
| **T** | Task | Task notes, work progress |
| **M** | Milestone | Key milestones, releases |
| **S** | Skill | Skills, processes, how-to guides |
| **F** | Favorite | Frequently needed reference info |

---

## L1 Quality Rule

- **One complete, informative sentence** — ~15–20 tokens
- Must be understandable without any context
- Not "Fixed a bug" — instead "SQLite connection failed due to wrong path in .mcp.json"

---

## Company Knowledge (requires AL+ role)

```
write_memory(
  prefix: "S",
  store: "company",
  min_role: "worker",
  content: "..."
)
```

---

## When to save?

**Mandatory before terminating.** Only save what is still valuable in 6 months.

| Save | Don't save |
|------|-----------|
| New root cause + fix | Routine actions without learning value |
| Insight that changes future work | What's already in the codebase |
| Architecture decision + reasoning | Temporary debugging notes |
| Unexpected tool/API behavior | What's in the documentation |

One `write_memory` call per category — entire hierarchy in one `content` string.

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| L1 too short: "Fixed bug" | Full sentence with root cause |
| Mixed spaces and tabs | Stay consistent — either tabs or spaces |
| Everything flat, no indentation | Use hierarchy — L2/L3 for details |
| Save trivial things | Quality over quantity |
| Forget to write_memory | Always call BEFORE setting Status: Completed |
