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
**Warning:** A tab at the start of any line always means "go one level deeper" — it is structural, not content. If you need to store code or text that contains leading tabs, use spaces instead.
**IDs and timestamps** are assigned automatically — never write them yourself.

---

## Prefixes

| Prefix | Category | When to use |
|--------|----------|-------------|
| **P** | (P)roject | Project experiences, summaries |
| **L** | (L)esson | Lessons learned, best practices |
| **E** | (E)rror | Bugs, errors + their fix |
| **D** | (D)ecision | Architecture decisions with reasoning |
| **T** | (T)ask | Task notes, work progress |
| **M** | (M)ilestone | Key milestones, releases |
| **S** | (S)kill | Skills, processes, how-to guides |
| **N** | (N)avigator | Code pointers — where something lives in the codebase |
| **H** | (H)uman | Knowledge about the user — preferences, context, working style |
| **R** | (R)ule | User-defined rules and constraints — "always do X", "never do Y" |

**Custom prefixes:** If none of the above fit, you can use any single uppercase letter. To register it officially (so the system validates it), add it to `hmem.config.json` under `"prefixes"`:
```json
{ "prefixes": { "R": "Research" } }
```
Custom prefixes are merged with the defaults — they don't replace them. Without registering, the system will reject the prefix.

### Marking entries as favorites

Mark any entry as a favorite to ensure it always appears with its L2 detail in bulk reads (alongside a `[♥]` marker). Use this for reference info you need to see every session — API endpoints, key decisions, frequently looked-up patterns.

```
write_memory(prefix="D", content="...", favorite=true)           # set at creation
update_memory(id="D0010", content="...", favorite=true)          # set on existing
update_memory(id="D0010", content="...", favorite=false)         # clear
```

Favorites are **not** a prefix — they are a flag on any entry regardless of category.
Use sparingly: if everything is a favorite, nothing is. Prefer high-value reference entries over fleeting notes.

---

### Marking entries as obsolete

When you notice that an entry is outdated — superseded by a newer approach, a fixed bug, or changed architecture — do **not** delete it. Mark it as obsolete with a correction reference:

```
# Step 1: Write the correction FIRST
write_memory(prefix="E", content="Correct approach is XYZ\n\tDetails...")  # → E0076

# Step 2: Mark old entry obsolete — MUST include [✓ID] tag
update_memory(id="E0023", content="Wrong approach — see [✓E0076]", obsolete=true)
```

**The `[✓ID]` tag is enforced.** The system will reject `obsolete=true` without a correction reference. This ensures every obsolete entry points to its replacement. The system also creates **bidirectional links** automatically (E0023↔E0076).

The entry stays in memory with a `[!]` marker. Past errors still carry learning value ("we tried this and it failed because..."). The curator may eventually prune it, but that's their decision, not yours.

**Shortcut for stale entries:** If no correction exists (entry is just old/irrelevant, not wrong), only the curator can mark it obsolete without `[✓ID]`.

---

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

**Your responsibility:** Update your N entries whenever you notice code has moved or logic has changed. You don't need the curator for this — use `update_memory` directly. Stale pointers are worse than none. If you cannot verify whether the pointer is still valid, mark it obsolete: `update_memory(id="N0012", content="...", obsolete=true)`.

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

## Updating Existing Memories

Use `update_memory` and `append_memory` to modify entries without deleting and recreating them.

### update_memory — Fix outdated text

Updates the text of a single node. Children are **not** touched.

```
update_memory(id="L0003", content="Corrected L1 summary — new wording")
update_memory(id="L0003.2", content="Fixed L2 detail")
update_memory(id="D0010", content="New L1", links=["E0042"])  # also update links
```

Use when: the wording is wrong, outdated, or needs clarification.

### append_memory — Add detail to existing entry

Appends new child nodes under an existing root or node. Existing children are preserved.

Content indentation is **relative to the parent** — 0 tabs = direct child of `id`.

```
append_memory(
  id="L0003",
  content="New finding discovered later\n\tSub-detail about it"
)
# → adds L0003.N (L2) and L0003.N.1 (L3)

append_memory(
  id="L0003.2",
  content="Extra note under L0003.2"
)
# → adds L0003.2.M (L3)
```

Use when: you have new context to add without replacing what's there.

### When to use which

| Situation | Tool |
|-----------|------|
| L1 wording is wrong/outdated | `update_memory` |
| A sub-node has wrong detail | `update_memory` |
| You have new info to add | `append_memory` |
| Entry is completely wrong | curator: `delete_agent_memory` + `write_memory` |

---

## Bumping Access Count

Signal that an entry is important without modifying its content. Frequently-accessed entries get expanded treatment (all L2 children shown) in bulk reads.

```
bump_memory(id="L0045")              # +1 access
bump_memory(id="L0045", increment=3) # +3 access
```

**Automatic bubble-up:** When you `append_memory` to add children, the parent entry's access count is bumped automatically. No need to bump manually after appending.

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| L1 too short: "Fixed bug" | Full sentence with root cause |
| Tabs inside content text (e.g. code snippets) | Use spaces for indentation within content — tabs at line start always mean "go deeper in the hierarchy" |
| Mixed spaces and tabs for hierarchy | Stay consistent — either tabs or spaces as your depth marker |
| Everything flat, no indentation | Use hierarchy — L2/L3 for details |
| Save trivial things | Quality over quantity |
| Forget to write_memory | Always call BEFORE setting Status: Completed |
| Write to .hmem via sqlite3/SQL | ONLY use `write_memory` MCP tool — never raw SQL |
| MCP unavailable → skip saving | Reconnect MCP first (`/mcp` or restart tool) |
| `update_memory(id="X", obsolete=true)` without `[✓ID]` | Write correction first, then mark obsolete with `[✓E0076]` tag |
