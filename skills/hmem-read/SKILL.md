---
name: hmem-read
description: "Load long-term memory from hmem. Use when: user types /hmem-read or says 'load memory', 'check your memory', 'what do you remember', 'show me the project', 'continue where we left off', 'was weisst du ueber...'; starting work with no L1 summaries in context; after /compact or context reset to reload knowledge; before significant work to anchor with prior context; user asks about a specific project, error, or topic visible in L1 summaries; user says 'pick up where we left off', 'resume', 'Woran haben wir gearbeitet'. Calls read_memory() or load_project() immediately. Also covers search, prefix filter, context_for, stale detection, find_related, memory_stats, memory_health."
---

# Load Memory — Choose Your Path

When this skill is invoked, pick the right path and execute a tool call immediately.
Do NOT just read this document — act.

If `read_memory` is not available, tell the user:
"read_memory tool not found. Run `hmem init` to configure the MCP server."

**Announcements:** If `read_memory` or `hmem-sync pull` shows urgent announcements
(yellow warnings at the top), act on them **immediately** before doing anything else.

---

## Path A: Start Working on a Project (primary workflow)

Use `load_project` as the single entry point. It activates the project, returns the full
briefing (L2 content + L3 titles), and shows recent O-entries with full L4/L5 user/agent
exchanges.

- **User mentioned a project** — load it directly:
  ```
  load_project(id="P0037")
  ```

- **Unclear which project** — list projects first, then load:
  ```
  read_memory(titles_only=true, prefix="P")   # ~200 tokens overview
  ```
  Then ask the user or pick the most relevant one, and call `load_project(id="P00XX")`.

- **New project** — create it first, then load:
  ```
  write_memory(prefix="P", content="New project: ...")   # creates P00XX
  load_project(id="P00XX")
  ```

- **No specific project** — load everything:
  ```
  read_memory()   # full bulk read, all projects
  ```

### What load_project Returns

- **L2 content + L3 titles** — the complete project briefing (~700 tokens)
- **Recent O-entries with full exchanges** — configurable via `recentOEntries` in config
  (default: 10). Each O-entry contains the actual L4/L5 user/agent messages.

## Path B: After Context Compression (/compact)

You still have the recent conversation — load the long-term knowledge lost during compression:

```
read_memory(mode="essentials")
```

Essentials mode prioritizes favorites, most-accessed, and pinned entries over newest.

For a specific project's full context:
```
read_memory(context_for="P0029")
```

## Path C: User Asks About a Specific Topic

When the user asks about something visible in L1 summaries:

```
read_memory(context_for="P0029")     # project context + all related entries
read_memory(context_for="E0090")     # error context + related
```

`context_for` loads the entry expanded + all related entries (via links and weighted tag
scoring) in a single call. Raise `min_tag_score` for fewer results:

```
read_memory(context_for="P0029", min_tag_score=7)   # stricter — only strong matches
```

---

## Bulk Read Design

`read_memory()` shows **current context** — newest entries, most-accessed favorites, open
tasks. Not a full dump. Older entries with low access_count are intentionally omitted.

- **Expanded entries** (newest, most-accessed, favorites): show L2 children + links
- **Non-expanded entries**: latest child + `[+N more -> ID]` hint
- **Active-prefix filtering**: entries in active projects get full expansion, others title-only

**For older or broader knowledge:**

```
read_memory(titles_only=true, prefix="L")   # all lesson titles as table of contents
read_memory(search="SQLite corruption")      # semantic search
read_memory(tag="#sqlite")                   # hashtag filter
```

Tags are hidden by default — use `read_memory(curator=true)` to see hashtags on entries.

---

## Lazy Loading Protocol (subsequent reads)

After the initial load, drill deeper with these patterns:

```
read_memory(prefix="E")           # only errors
read_memory(store="company")      # shared company knowledge
read_memory(id="E0042")           # expand root -> shows L2 children
read_memory(id="E0042.2")         # expand L2 -> shows L3 children
```

**Compact table of contents:**

```
read_memory(titles_only=true)                # all entries, one line each
read_memory(titles_only=true, prefix="L")    # only lessons
```

**Depth parameter** — useful for listings (max 4), not for ID queries:

```
read_memory(depth=2)              # all entries with L2 children
read_memory(prefix="L", depth=2)  # all lessons with details
read_memory(depth=4)              # deep dive L2+L3+L4 (large output, use sparingly)
```

For L5 detail, drill into a specific node ID instead of using depth.

---

## Search

```
search_memory(query="Node.js startup crash")
search_memory(query="auth token", scope="memories")
```

For time-based search patterns, see [references/TIME-SEARCH.md](references/TIME-SEARCH.md).

---

## Original Context History (O-prefix)

O-entries store raw session context with progressive summarization. They are created
**automatically** by the Stop hook — every user/agent exchange is recorded without manual
intervention. When projects are switched, a new O-entry starts automatically.

O-entries are hidden from bulk reads but searchable:

```
read_memory(prefix="O")                                    # browse recent context
read_memory(search="why did we choose per-node scoring")   # search across raw context
read_memory(id="O0042", expand=true)                       # drill into specific entry
```

O-entries are linked to curated entries (P/L/D/E) via tags, so `context_for` will
surface relevant O-entries when their tags match.

**v5 checkpoint integration:** When `checkpointMode` is `"auto"`, a Haiku subagent reads
recent O-entry exchanges at configurable intervals and automatically extracts L/D/E entries
+ writes a rolling checkpoint summary (`[CP]` node tagged `#checkpoint-summary`).

**What `load_project` shows:** For the latest O-entry, it displays:
1. The most recent checkpoint summary (if available)
2. Only raw exchanges AFTER the summary (minimum 5 exchanges guaranteed)
3. Skill-dialog exchanges (brainstorming, TDD, etc.) are filtered out automatically

The `recentOEntries` config parameter (default: 10) controls how many recent O-entries
`load_project` includes.

---

## Adapt Communication to User Skill Level

After loading memory, check H-prefix entries for **User Skill Assessments** (e.g. H0010).
These contain 1-10 scores per subtopic — adapt language accordingly:

- **1-4**: Explain concepts, avoid jargon, use analogies
- **5-6**: Brief explanations, some jargon OK
- **7-8**: Direct technical language, skip basics
- **9-10**: Peer-level discussion, challenge assumptions

If no skill assessment exists yet, create one based on the user's vocabulary and questions
(see hmem-write skill for the H-prefix convention).

---

## After Loading — Proactive Curation

Memory is the agent's brain. If something is wrong, stale, or noisy — fix it NOW.
This applies after `load_project` AND after `read_memory`.

Scan load_project output for resolved bugs, stale info, duplicates, and misplaced entries.
Fix immediately before responding to the user.

For detailed curation guidance and move_nodes usage, see [references/CURATION.md](references/CURATION.md).

For memory health audits, stats, stale detection, and find_related, see [references/HEALTH-AUDIT.md](references/HEALTH-AUDIT.md).

---

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| `read_memory()` after /compact | `read_memory(mode="essentials")` — you already have recent context |
| `update_memory(active=true)` + `read_memory()` | `load_project(id="P00XX")` — one call does both |
| Blind bulk read at session start | `read_memory(titles_only=true, prefix="P")` first, then `load_project` |
| `read_memory(id="E0042", depth=3)` | `read_memory(id="E0042.2")` — branch by branch |
| Load everything without purpose | Check L1 first, then expand selectively |
| Read .hmem file directly | Always use MCP tools — it is a SQLite binary |
| Just display this skill text | **Call a read_memory or load_project variant immediately** |
| `update_memory(id="X", obsolete=true)` without correction | Write correction first, then mark obsolete with `[ID]` tag |
| Repeated `read_memory()` to find old entries | `read_memory(titles_only=true, prefix="L")` or `read_memory(search="...")` |
| Listing noise without fixing it | Fix it NOW: `update_memory(id, content, irrelevant=true)` |
| Deleting misplaced O-entries | Move them: `move_nodes(source_ids=[...], target_parent="O00XX.Y")` |
| Manually creating O-entries | O-entries are auto-logged by the Stop hook — do not create them manually |
