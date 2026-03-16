---
name: hmem-read
description: >
  Load long-term memory from hmem. Use when:
  - User types /hmem-read or says "load memory", "check your memory", "was weißt du über..."
  - Starting work and you have no L1 summaries in context yet
  - After /compact or context reset, to reload knowledge
  - Before any significant work to anchor yourself with prior context
  - User asks about a specific project, error, or topic visible in L1 summaries
  Calls read_memory() immediately. Also covers all read_memory query patterns:
  search, prefix filter, context_for, stale detection, find_related, memory_stats, memory_health.
---

# Load Memory — Choose Your Path

When this skill is invoked, pick the right path based on your situation.
Do NOT just read this document — execute a tool call immediately.

If the tool `read_memory` is not available, tell the user:
"read_memory tool not found. Run `hmem init` to configure the MCP server."

---

## Path A: Fresh Session Start (no context yet)

Start by seeing what projects exist, then focus:

```
# Step 1: Quick project overview (~200 tokens)
read_memory(titles_only=true, prefix="P")
```

This shows all projects as one-liners. Then:

- **If the user mentioned a project** → activate it and load full context:
  ```
  update_memory(id="P0037", active=true)     # mark project as active
  read_memory()                                # bulk read, filtered by active project
  ```

- **If working on a new project** → create it first, then read:
  ```
  write_memory(prefix="P", content="New project: ...", tags=["#project-name"])
  update_memory(id="P00XX", active=true)
  read_memory()
  ```

- **If unclear what to work on** → load everything:
  ```
  read_memory()                                # full bulk read, all projects
  ```

The bulk read returns memories **grouped by category** with smart expansion:
- **Expanded entries** (newest, most-accessed, favorites): show L2 children + links
- **Non-expanded entries**: latest child + `[+N more → ID]` hint
- **Active-prefix filtering**: entries in active projects get full expansion, others title-only

## Path B: After Context Compression (/compact)

You still have the recent conversation in memory — you don't need the newest entries again.
Load the long-term knowledge that was lost during compression:

```
read_memory(mode="essentials")
```

Essentials mode prioritizes favorites, most-accessed, and pinned entries over newest.
This is your "recover what matters" call — rules, decisions, error patterns, key references.

If you need a specific project's full context:
```
read_memory(context_for="P0029")
```

## Path C: User Asks About a Specific Topic

When the user asks about something you can see in your L1 summaries:

```
# User: "Was weißt du über das hmem Projekt?"
read_memory(context_for="P0029")

# User: "Tell me about that Heimdall error"
read_memory(context_for="E0090")
```

`context_for` loads the entry expanded + all related entries (via links and weighted tag scoring)
in a single call. The `min_tag_score` parameter controls strictness (default: 5). Raise for fewer results:

```
read_memory(context_for="P0029", min_tag_score=7)  # stricter — only strong matches
```

---

## After loading — proactive cleanup

Only on the **first read of a session** (not after every read). Scan L1 summaries and flag:

- **Wrong** → write correction first, then `update_memory(id="E0023", content="Wrong — see [✓E0076]", obsolete=true)`
- **Noise** → `update_memory(id="T0005", irrelevant=true)` or `update_many(ids=["T0005", "T0012"], irrelevant=true)`
- **Important** → `update_memory(id="S0001", favorite=true)`

For a thorough review, use the `/hmem-self-curate` skill.

---

## Bulk Read Design Intent

`read_memory()` shows **current context** — newest entries, most-accessed favorites, open tasks. It is not a full dump. Older entries with low access_count are intentionally omitted.

**For older or broader knowledge:**

```
# All lesson titles as table of contents (one line per entry)
read_memory(titles_only=true, prefix="L")

# Semantic search
read_memory(search="SQLite corruption")

# Hashtag filter
read_memory(tag="#sqlite")
```

**Tags are hidden by default** — hashtags are only shown when `curator=true` is set. This saves tokens in normal reads. Use `read_memory(curator=true)` when you need to see or verify tags on entries.

Repeated bulk reads without a goal yield little new information after 3–4 iterations — use targeted search or a prefix overview instead.

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

**Compact table of contents:**

```
read_memory(titles_only=true)              # all entries as compact ID + date + title listing
read_memory(titles_only=true, prefix="L")  # only lessons
```

V2 selection still applies (only newest + most-accessed + favorites shown), but without L2 children or links — just one line per entry with `(N)` child count hints.

**Rule: depth parameter is useful for listings (max 4), not for ID queries.**

```
read_memory(depth=2)             # all entries with L2 children
read_memory(prefix="L", depth=2) # all lessons with details
read_memory(depth=4)             # deep dive — L2+L3+L4 (use sparingly, large output)
```

For L5 detail, drill into a specific node ID instead of using depth.

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

## Stale Detection

Find entries you haven't accessed in a while — useful for curation:

```
# Entries not accessed in 30 days (sorted oldest-access first)
read_memory(stale_days=30)

# Filter: only stale lessons
read_memory(stale_days=60, prefix="L")
```

---

## Original Context History (O-prefix)

O-entries store raw session context with progressive summarization (created by `flush_context`).
They are hidden from bulk reads but searchable — use when you need the original reasoning
behind a decision or the full conversation that led to an entry:

```
# Browse recent context entries
read_memory(prefix="O")

# Search across raw context
read_memory(search="why did we choose per-node scoring")

# Drill into a specific context entry (L1→L2→L5 linear chain)
read_memory(id="O0042", expand=true)
```

O-entries are linked to curated entries (P/L/D/E) via tags, so `context_for` will
surface relevant O-entries when their tags match.

---

## Memory Stats

Quick overview of your memory health:

```
memory_stats()                   # personal store
memory_stats(store="company")    # company store
```

Output includes: total entries by prefix, total nodes, favorites count, pinned count, unique hashtags, stale count (>30d), oldest entry, and top 5 most-accessed entries.

---

## Find Related

Find entries similar to a given entry via FTS5 keyword matching — useful to spot potential duplicates or discover thematic connections:

```
find_related(id="P0029")          # up to 5 similar entries
find_related(id="L0042", limit=10)
```

Returns title-only list of entries with overlapping keywords (different from `relatedEntries` in ID reads which uses shared tags).

---

## Memory Health Audit

Check your memory for structural issues before/after curation:

```
memory_health()                   # personal store
memory_health(store="company")
```

Checks:
- **Broken links** — links pointing to deleted entries
- **Orphaned entries** — root entries with no sub-nodes (never expanded)
- **Stale favorites/pinned** — not accessed in >60 days
- **Broken obsolete chains** — `[✓ID]` pointing to non-existent entries
- **Tag orphans** — `memory_tags` rows with no matching entry/node

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| `read_memory()` after /compact | `read_memory(mode="essentials")` — you already have recent context |
| Blind bulk read at session start | `read_memory(titles_only=true, prefix="P")` first → pick project → `read_memory()` |
| `read_memory(id="E0042", depth=3)` | `read_memory(id="E0042.2")` — branch by branch |
| Load everything without purpose | Check L1 first, then expand selectively |
| Read .hmem file directly | Always use MCP tools — it's a SQLite binary |
| Just display this skill text | **Call a read_memory variant immediately** |
| `update_memory(id="X", obsolete=true)` without `[✓ID]` | Write correction first, then mark obsolete with `[✓ID]` tag |
| Repeated `read_memory()` to find old entries | `read_memory(titles_only=true, prefix="L")` or `read_memory(search="...")` |
