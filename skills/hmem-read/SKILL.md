---
name: hmem-read
description: >
  Load long-term memory from hmem. Use when:
  - User types /hmem-read or says "load memory", "check your memory", "what do you remember",
    "show me the project", "continue where we left off", "was weißt du über..."
  - Starting work and you have no L1 summaries in context yet
  - After /compact or context reset, to reload knowledge
  - Before any significant work to anchor yourself with prior context
  - User asks about a specific project, error, or topic visible in L1 summaries
  - User says "pick up where we left off", "what were we working on", "resume",
    "Woran haben wir gearbeitet", "Was war der letzte Stand"
  Calls read_memory() or load_project() immediately. Also covers all read_memory query
  patterns: search, prefix filter, context_for, stale detection, find_related,
  memory_stats, memory_health.
---

# Load Memory — Choose Your Path

When this skill is invoked, pick the right path and execute a tool call immediately.
Do NOT just read this document — act.

If `read_memory` is not available, tell the user:
"read_memory tool not found. Run `hmem init` to configure the MCP server."

**Announcements:** If `read_memory` or `hmem-sync pull` shows urgent announcements
(yellow warnings at the top), act on them **immediately** before doing anything else.
These are broadcast messages from the user or another device — typically config changes,
server migrations, or breaking updates that must be handled first.

---

## Path A: Start Working on a Project (primary workflow)

Use `load_project` as the single entry point. It activates the project, returns the full
briefing (L2 content + L3 titles), and shows recent O-entries with full L4/L5 user/agent
exchanges — so you see exactly what happened in previous sessions, not just titles.

- **User mentioned a project** → load it directly:
  ```
  load_project(id="P0037")
  ```
  This replaces the old pattern of `update_memory(active=true)` + `read_memory()`.
  One call gives you everything: project structure, open tasks, and recent session history.

- **Unclear which project** → list projects first, then load:
  ```
  read_memory(titles_only=true, prefix="P")   # ~200 tokens overview
  ```
  Then ask the user or pick the most relevant one, and call `load_project(id="P00XX")`.

- **New project** → create it first, then load:
  ```
  write_memory(prefix="P", content="New project: ...")   # → P00XX
  load_project(id="P00XX")
  ```

- **No specific project** → load everything:
  ```
  read_memory()   # full bulk read, all projects
  ```

### What load_project returns

The response includes:
- **L2 content + L3 titles** — the complete project briefing (~700 tokens)
- **Recent O-entries with full exchanges** — configurable via `recentOEntries` in config
  (default: 10). Each O-entry contains the actual L4/L5 user/agent messages, not just
  summaries. This is your continuity — read them to understand where the last session
  left off.

### Why load_project over read_memory

`read_memory()` shows a cross-project overview optimized for breadth. `load_project`
goes deep on one project — it activates it, filters related entries, and includes session
history. Use `load_project` when you know which project to work on; use `read_memory`
when you need orientation across all projects.

## Path B: After Context Compression (/compact)

You still have the recent conversation — you do not need the newest entries again.
Load the long-term knowledge that was lost during compression:

```
read_memory(mode="essentials")
```

Essentials mode prioritizes favorites, most-accessed, and pinned entries over newest.
This is your "recover what matters" call — rules, decisions, error patterns, key references.

For a specific project's full context:
```
read_memory(context_for="P0029")
```

## Path C: User Asks About a Specific Topic

When the user asks about something visible in your L1 summaries:

```
# "Was weißt du über das hmem Projekt?"
read_memory(context_for="P0029")

# "Tell me about that Heimdall error"
read_memory(context_for="E0090")
```

`context_for` loads the entry expanded + all related entries (via links and weighted tag
scoring) in a single call. Raise `min_tag_score` for fewer results:

```
read_memory(context_for="P0029", min_tag_score=7)   # stricter — only strong matches
```

---

## Bulk Read Design

`read_memory()` shows **current context** — newest entries, most-accessed favorites, open
tasks. It is not a full dump. Older entries with low access_count are intentionally omitted.

**Expanded entries** (newest, most-accessed, favorites): show L2 children + links.
**Non-expanded entries**: latest child + `[+N more → ID]` hint.
**Active-prefix filtering**: entries in active projects get full expansion, others title-only.

**For older or broader knowledge:**

```
read_memory(titles_only=true, prefix="L")   # all lesson titles as table of contents
read_memory(search="SQLite corruption")      # semantic search
read_memory(tag="#sqlite")                   # hashtag filter
```

**Tags are hidden by default** — use `read_memory(curator=true)` to see hashtags on entries.

Repeated bulk reads without a goal yield little new information after 3-4 iterations — use
targeted search or a prefix overview instead.

---

## Title vs. Body (v5.1+)

Every node has a **title** (short navigation label) and an optional **body** (detail shown on drill-down). This affects what you see in different read modes:

| Mode | Shows |
|------|-------|
| `titles_only=true` | Title only — compact table of contents |
| Default (by ID) | Title + body for requested node, children as title-only |
| `expand=true` | Title + body recursively for all nodes |
| Bulk reads | Title only for L1, expanded entries show L2 titles |

Entries with a blank line between title and body have explicit title/body separation. Older entries without separation show auto-extracted titles (~50 chars) — the full text is still accessible on drill-down.

---

## Lazy Loading Protocol (subsequent reads)

After the initial load, drill deeper with these patterns:

```
read_memory(prefix="E")           # only errors
read_memory(store="company")      # shared company knowledge
read_memory(id="E0042")           # expand root → shows L2 children
read_memory(id="E0042.2")         # expand L2 → shows L3 children
read_memory(id="E0042.2.1")       # expand further (rarely needed)
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

## Time-Based Search

Find entries created around a specific time or near another entry:

```
read_memory(time="14:30")                        # ±2h window around 14:30 today
read_memory(time="14:30", date="2026-02-20")     # specific date + time
read_memory(time="14:30", period="-1h")           # custom window: only 1h before
read_memory(time_around="P0001")                  # entries created near P0001
read_memory(time_around="P0001", period="+2h")    # only after P0001
```

---

## Search

```
search_memory(query="Node.js startup crash")
search_memory(query="auth token", scope="memories")
```

---

## Original Context History (O-prefix)

O-entries store raw session context with progressive summarization. They are created
**automatically** by the Stop hook — every user/agent exchange is recorded as an O-entry
without manual intervention. When you switch projects, a new O-entry is started
automatically (project-based O-entries).

O-entries are hidden from bulk reads but searchable. Use them when you need the original
reasoning behind a decision or the full conversation that led to an entry:

```
read_memory(prefix="O")                                    # browse recent context
read_memory(search="why did we choose per-node scoring")   # search across raw context
read_memory(id="O0042", expand=true)                       # drill into specific entry
```

O-entries are linked to curated entries (P/L/D/E) via tags, so `context_for` will
surface relevant O-entries when their tags match.

**v5 checkpoint integration:** When `checkpointMode` is set to `"auto"`, a Haiku subagent
reads recent O-entry exchanges at configurable intervals and automatically extracts
L/D/E entries + writes a rolling checkpoint summary (`[CP]` node tagged `#checkpoint-summary`).

**What `load_project` shows:** For the latest O-entry, it displays:
1. The most recent checkpoint summary (if available)
2. Only raw exchanges AFTER the summary (minimum 5 exchanges guaranteed)
3. Skill-dialog exchanges (brainstorming, TDD, etc.) are filtered out automatically

This keeps `load_project` compact even for long sessions. To see the full unfiltered
history, use `read_memory(id="O0042", expand=true)`.

The `recentOEntries` config parameter (default: 10) controls how many recent O-entries
`load_project` includes.

---

## Show All Obsolete Entries

By default, bulk reads hide most obsolete entries (top 3 by access count shown). To see all:

```
read_memory(show_obsolete=true)
```

---

## Stale Detection

Find entries not accessed in a while — useful for curation:

```
read_memory(stale_days=30)                # sorted oldest-access first
read_memory(stale_days=60, prefix="L")    # only stale lessons
```

---

## Memory Stats

Quick overview of your memory health:

```
memory_stats()                    # personal store
memory_stats(store="company")     # company store
```

Output includes: total entries by prefix, total nodes, favorites count, pinned count,
unique hashtags, stale count (>30d), oldest entry, and top 5 most-accessed entries.

---

## Find Related

Find entries similar to a given entry via FTS5 keyword matching — spots potential
duplicates or thematic connections:

```
find_related(id="P0029")            # up to 5 similar entries
find_related(id="L0042", limit=10)
```

Returns title-only list with overlapping keywords (different from `relatedEntries` in
ID reads which uses shared tags).

---

## Memory Health Audit

Check memory for structural issues before/after curation:

```
memory_health()                    # personal store
memory_health(store="company")
```

Checks: broken links, orphaned entries, stale favorites/pinned, broken obsolete chains,
tag orphans.

---

## Adapt Communication to User Skill Level

After loading memory, check H-prefix entries for **User Skill Assessments** (e.g. H0010).
These contain 1-10 scores per subtopic — adapt your language accordingly:

- **1-4**: Explain concepts, avoid jargon, use analogies
- **5-6**: Brief explanations, some jargon OK
- **7-8**: Direct technical language, skip basics
- **9-10**: Peer-level discussion, challenge assumptions

If no skill assessment exists yet, create one based on the user's vocabulary and questions
(see hmem-write skill for the H-prefix convention).

---

## After Loading — Proactive Curation

Your memory is your brain. If something is wrong, stale, or noisy — fix it NOW, don't list
problems for later. This applies after `load_project` AND after `read_memory`.

### Scan the load_project output

Every time you receive a `load_project` response, scan it for issues and fix them
immediately — before responding to the user. The load_project output IS the briefing
that every future session gets. If it contains noise, every future session starts with
noise. Treat it like your own resume: if something doesn't belong, remove it.

**What to look for and how to fix it:**

| Problem | Example | Action |
|---------|---------|--------|
| Resolved/done bugs | `.6.2 E0101: O-entry root title never updated` (fixed months ago) | `update_memory(id="P0048.6.2", content="...", irrelevant=true)` |
| Old protocol entries | `.7.32 - windowsHide: true on all child_process spawns` (fragment, not a session) | `update_memory(id="P0048.7.32", content="...", irrelevant=true)` |
| Stale version info | Overview says "v5.3.1" but current is v6.0.0 | `update_memory(id="P0048.1.1", content="Current state: v6.0.0 on npm...")` |
| Duplicate sections | `.10 Bugs (duplicate of .6)` | `update_memory(id="P0048.10", content="...", irrelevant=true)` |
| Completed open tasks | `.8.2 ✓ DONE: O-Entry Session History Injection` | Should be auto-filtered; if not, mark irrelevant |
| Wrong project's exchanges | O-entry exchanges from P0052 appearing in P0048 | Use `move_nodes` (see below) |
| Stale env/config references | Still references `HMEM_PROJECT_DIR` instead of `HMEM_PATH` | Update the node content |

Use `update_many` when marking multiple entries irrelevant in one go:
```
update_many(ids=["P0048.7.32", "P0048.6.2", "P0048.6.5"], irrelevant=true)
```

### Fix misplaced O-entries with move_nodes

When exchanges or session nodes land in the wrong O-entry (e.g. project confusion during
a session), move them to the correct location:

```
move_nodes(source_ids=["O0048.3.1.5", "O0048.3.1.6"], target_parent="O0052.1.1")
```

This preserves the exchange content while fixing the tree structure. Don't delete
misplaced entries — move them to where they belong.

### Scan bulk read output (read_memory)

After any `read_memory()` call, scan for:

- **Wrong facts** → write correction first, then mark obsolete with `[✓ID]`:
  ```
  write_memory(prefix="E", content="Correct fix is...") → E0076
  update_memory(id="E0042", content="Wrong — see [✓E0076]", obsolete=true)
  ```
- **Noise/irrelevant** → `update_memory(id="T0005", content="...", irrelevant=true)`
- **Important discoveries** → `update_memory(id="S0001", content="...", favorite=true)`

### When NOT to curate

- Don't curate after every single `read_memory` call — only on the first bulk read
  of a session and after `load_project`
- Don't curate during time-critical tasks (the user is waiting for a bug fix, not curation)
- Don't mark entries irrelevant if you're unsure — ask the user first

For a thorough deep-clean, use the `/hmem-self-curate` skill.

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
| `update_memory(id="X", obsolete=true)` without `[✓ID]` | Write correction first, then mark obsolete with `[✓ID]` tag |
| Repeated `read_memory()` to find old entries | `read_memory(titles_only=true, prefix="L")` or `read_memory(search="...")` |
| Listing noise without fixing it | Fix it NOW: `update_memory(id, content, irrelevant=true)` |
| Deleting misplaced O-entries | Move them: `move_nodes(source_ids=[...], target_parent="O00XX.Y")` |
| Manually creating O-entries | O-entries are auto-logged by the Stop hook — do not create them manually |
