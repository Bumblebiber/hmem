---
name: hmem-read
description: Load your long-term memory. Call this skill at session start or after context reset.
---

# ACTION REQUIRED: Call read_memory() NOW

When this skill is invoked, you MUST immediately call the MCP tool `read_memory` with no arguments.
Do NOT just read this document — execute the tool call.

```
read_memory()
```

This returns your memories **grouped by category** with smart expansion:
- **Expanded entries** (newest, most-accessed, favorites): show all L2 children + links
- **Non-expanded entries**: show latest child + `[+N more → ID]` hint
- **Obsolete entries**: top 3 "biggest mistakes" shown with `[!]` marker, rest hidden

If the tool `read_memory` is not available, tell the user:
"read_memory tool not found. Run `hmem init` to configure the MCP server."

---

## After loading — flag obviously outdated entries

Scan the L1 summaries for entries that are clearly no longer valid today:

- Decisions describing something as "planned" or "not yet implemented" that has since been done
- Error patterns for bugs that are fully resolved and superseded by a better approach
- Project notes describing a state that no longer exists

Mark them obsolete with a correction reference:

```
# Step 1: Write the correction first
write_memory(prefix="E", content="Correct approach is XYZ\n\tDetails...")  # → E0076

# Step 2: Mark the old entry obsolete with [✓ID] tag
update_memory(id="E0023", content="Wrong approach — see [✓E0076]", obsolete=true)
```

**Rule:** Marking obsolete requires a `[✓ID]` correction reference in the content. Write the correction first, then mark the old entry. The system enforces this and creates bidirectional links automatically.

**Exception:** If the entry is just stale (no correction needed), the curator can bypass this rule.

---

## Lazy Loading Protocol (for subsequent reads)

After the initial `read_memory()`, use these patterns to drill deeper:

```
# Filter by category
read_memory(prefix="E")          # only errors
read_memory(store="company")     # shared company knowledge

# Expand a root entry → shows L2 children
read_memory(id="E0042")

# Expand an L2 node → shows L3 children
read_memory(id="E0042.2")

# Expand further (rarely needed)
read_memory(id="E0042.2.1")
```

**Rule: depth parameter is only useful for listings (max 3), not for ID queries.**

```
read_memory(depth=2)             # all entries with L2 children
read_memory(prefix="L", depth=2) # all lessons with details
```

---

## Time-Based Search

Find entries created around a specific time or near another entry:

```
# Entries created around 14:30 today (±2h window)
read_memory(time="14:30")

# Entries near a specific date + time
read_memory(time="14:30", date="2026-02-20")

# Custom window: only 1 hour before
read_memory(time="14:30", period="-1h")

# Entries created around the same time as P0001
read_memory(time_around="P0001")
read_memory(time_around="P0001", period="+2h")  # only after P0001
```

---

## Bumping Access Count

Signal that an entry is important by bumping its access count. Frequently-accessed entries get expanded treatment in bulk reads.

```
bump_memory(id="L0045")         # +1 access
bump_memory(id="L0045", increment=3)  # +3 access
```

---

## Search

```
search_memory(query="Node.js startup crash")
search_memory(query="auth token", scope="memories")
```

---

## Show All Obsolete Entries

By default, bulk reads hide most obsolete entries (top 3 by access count shown). To see all:

```
read_memory(show_obsolete=true)
```

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| `read_memory(id="E0042", depth=3)` | `read_memory(id="E0042.2")` — branch by branch |
| Load everything without purpose | Check L1 first, then expand selectively |
| Read .hmem file directly | Always use MCP tools — it's a SQLite binary |
| Just display this skill text | **Call read_memory() immediately** |
| `update_memory(id="X", obsolete=true)` without `[✓ID]` | Write correction first, then mark obsolete with `[✓ID]` tag |
