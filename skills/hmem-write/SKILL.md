---
name: hmem-write
description: How to write long-term memories. Follow these rules whenever you call write_memory.
---

# How to use write_memory

When you need to save a lesson, error, decision, or project insight to long-term memory,
call the MCP tool `write_memory` following these rules.

If the tool `write_memory` is not available:
1. Tell the user: "write_memory tool not found. Please reconnect the MCP server (in Claude Code: `/mcp`, in other tools: restart the tool)."
2. **NEVER write directly to the .hmem SQLite file via shell commands.** The database has WAL journaling, integrity checks, and tree-structure logic that raw SQL INSERT will bypass — causing corruption or data loss.

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
| **F** | Favorite | Frequently needed reference info (always loaded with L2 detail) |
| **N** | Navigator | Code pointers — where something lives in the codebase |

### N — Navigator (Code Pointers)

Use `N` to save a pointer to a specific file, function, or code location so you don't have to search for it next session.

```
write_memory(
  prefix="N",
  content="Link-Auflösung beim read_memory-Aufruf
	src/hmem-store.ts ~line 269 — read() method, ID branch
	Guard: resolveLinks !== false prevents circular refs
	Introduced in v1.4.0",
  links=["E0069"]
)
```

**L1:** What it is — one sentence describing the concept/feature
**L2:** Exact file path + line range + function/method name
**L3:** Context, caveats, related patterns
**Links:** Related entries (errors, decisions, lessons)

Update an `N` entry whenever code moves or the logic changes — stale pointers are worse than none.

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

**Custom prefixes:** Additional prefixes can be added in `hmem.config.json` under the `"prefixes"` key (e.g. `"R": "Research"`).

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| L1 too short: "Fixed bug" | Full sentence with root cause |
| Mixed spaces and tabs | Stay consistent — either tabs or spaces |
| Everything flat, no indentation | Use hierarchy — L2/L3 for details |
| Save trivial things | Quality over quantity |
| Forget to write_memory | Always call BEFORE setting Status: Completed |
| Write to .hmem via sqlite3/SQL | ONLY use `write_memory` MCP tool — never raw SQL |
| MCP unavailable → skip saving | Reconnect MCP first (`/mcp` or restart tool) |
