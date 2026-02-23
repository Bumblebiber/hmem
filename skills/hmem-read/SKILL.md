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

This returns your Level 1 memory summaries. Show them to the user.

If the tool `read_memory` is not available, tell the user:
"read_memory tool not found. Run `hmem init` to configure the MCP server."

---

## After loading — flag obviously outdated entries

Scan the L1 summaries for entries that are clearly no longer valid today:

- Decisions describing something as "planned" or "not yet implemented" that has since been done
- Error patterns for bugs that are fully resolved and superseded by a better approach
- Project notes describing a state that no longer exists

Mark them immediately — do not wait for curation:

```
update_memory(id="D0001", content="...", obsolete=true)
```

Obsolete entries are hidden from bulk reads and replaced by a summary line at the bottom. They remain searchable and accessible via `read_memory(id=X)`.

**Rule:** Only mark entries where the L1 clearly states something false or irrelevant today. When in doubt, leave it for curation.

---

## Lazy Loading Protocol (for subsequent reads)

After the initial `read_memory()`, use these patterns to drill deeper:

```
# Filter by category
read_memory(prefix="E")          # only errors

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

## Search

```
search_memory(query="Node.js startup crash")
search_memory(query="auth token", scope="memories")
```

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| `read_memory(id="E0042", depth=3)` | `read_memory(id="E0042.2")` — branch by branch |
| Load everything without purpose | Check L1 first, then expand selectively |
| Read .hmem file directly | Always use MCP tools — it's a SQLite binary |
| Just display this skill text | **Call read_memory() immediately** |
