---
name: hmem-curate
description: Curate hmem memory — your own or a foreign .hmem file. Systematically review entries, mark obsolete/irrelevant/favorite, fix titles, consolidate duplicates. Use when asked to "aufräumen", "clean up memory", "curate", "Speicher bereinigen", "tidy up", or when memory_health() shows issues.
---

# hmem Curation

## Prerequisite: Activate hmem-curate MCP Server

Curation tools (`memory_health`, `memory_stats`, `update_many`, `tag_bulk`, `tag_rename`,
`move_memory`, `rename_id`, `move_nodes`, `export_memory`, `import_memory`, `reset_memory_cache`)
are in the **separate `hmem-curate` MCP server** — not in the daily `hmem` server.

Before starting curation, tell the user:

> "I need the hmem-curate MCP server to be active. Please run `/mcp` and enable **hmem-curate**,
> then come back to continue."

Wait for confirmation before proceeding. Once the tools are available, continue with Step 0 below.

Curate hmem memory — mark obsolete/irrelevant/favorite, fix titles, consolidate duplicates, fix broken links.

**Two modes:**
- **Self-curation** (default): you curate your own memory. No extra params.
- **Foreign-file curation**: pass `hmem_path=/absolute/path/to/file.hmem` to `read_memory`, `update_memory`, `memory_health`, `find_related`. Sync and session cache are disabled. All updates land in that file.

---

## Step 0: Health Check First

```
memory_health()                  # own store
memory_health(hmem_path="...")   # foreign file
```

Shows:
- **Broken links** — entries with refs to deleted IDs
- **Orphaned entries** — roots with no sub-nodes (likely draft stubs)
- **Stale favorites/pinned** — not accessed in >60 days (demote or verify)
- **Broken obsolete chains** — `[✓ID]` pointing to deleted entries

Useful before starting:
```
memory_stats()
read_memory(stale_days=60)                   # stale entries in own store
read_memory(stale_days=60, hmem_path="...")  # same, foreign file
```

---

## Workflow: Prefix by Prefix

Work one prefix at a time. Load all entries of a prefix with full depth:

```
read_memory(prefix="P", show_all=true)
read_memory(prefix="P", show_all=true, hmem_path="...")
```

`show_all=true` bypasses the bulk-read algorithm and session cache — every entry is expanded with L2+L3 children visible. Review the output directly.

**Order:** Start with the prefix with the most entries (usually P), then L, E, D, etc.

If context overflows mid-prefix, continue with the remaining entries — memory survives compression.

---

## For Each Entry: Decide and Act

| Decision | Action |
|----------|--------|
| Still valid and useful | Skip |
| Important reference (every session) | `update_memory(id="X", content="...", favorite=true)` |
| Outdated — a better entry exists | Mark obsolete (see below) |
| Just noise — not wrong, but irrelevant | `update_memory(id="X", content="...", irrelevant=true)` |
| Title vague or misleading | `update_memory(id="X", content="Better wording")` |
| Sub-node has valuable reference info | `update_memory(id="X.N", content="...", favorite=true)` |

Add `hmem_path="..."` to every call when curating a foreign file.

---

## Marking Obsolete

Obsolete requires a correction reference. Three patterns:

**A: Replacement exists already**
```
update_memory(id="E0023", content="Wrong approach — see [✓E0076]", obsolete=true)
```

**B: No replacement exists yet**
```
write_memory(prefix="L", content="Correct approach is XYZ\n\tDetails...")  # -> L0090
update_memory(id="L0042", content="Superseded — see [✓L0090]", obsolete=true)
```

**C: Just stale, no correction needed**
```
update_memory(id="T0005", content="...", irrelevant=true)
```

Foreign file: curator may mark obsolete without `[✓ID]` for stale entries where no correction exists.

---

## Consolidate Duplicates

1. Pick the **keeper** (more complete, usually older)
2. Copy unique info: `append_memory(id="P0029", content="Carry-over\n\tDetail")`
3. Mark duplicate obsolete: `update_memory(id="P0031", content="Merged into [✓P0029]", obsolete=true)`

**Fragmented P-entries (same project, multiple entries):** same workflow. One P per project.

---

## Links — Cross-References

When two entries have a clear causal/contextual relationship (e.g. a P and the L/E entries that resulted from it), add links at **both** so drill-down resolves them:

```
update_memory(id="P0001", content="...", links=["L0023", "E0009"])
update_memory(id="L0023", content="...", links=["P0001"])
```

Don't over-link — only where navigation benefits.

---

## Title/Body Quality

Every node has a **title** (short, ~50 chars) and optional **body** (blank line separator). During curation:

**Root entries (L1):**
- Auto-title truncated/meaningless? Rewrite with explicit title + body:
  ```
  update_memory(id="L0042", content="Clear title\n\nDetailed L1 body that was too long for a title")
  ```

**Child nodes (L2+):**
- Dense content? Split into title + body:
  ```
  update_memory(id="L0003.2", content="Short node title\n\nDetailed explanation")
  ```

**Rewrite when:** auto-title is truncated mid-word, node has >200 chars crammed in one line, content is valuable but unscannable.
**Don't rewrite when:** title is already clear, or entry has low access count and marginal value.

---

## P-Entry Standard-Schema (R0009)

P-entries follow the standard L2 structure:
`.1 Overview`, `.2 Codebase`, `.3 Usage`, `.4 Context`, `.5 Deployment`, `.6 Bugs`, `.7 Protocol`, `.8 Open tasks`, `.9 Ideas`

Check P-entries during curation:
- **Missing section:** `append_memory(id="P00XX", content="\tOverview\n\t\tCurrent state: ...")`
- **Wrong order:** Restructure — order is fixed per R0009
- **Empty section:** OK to omit, but content must be in the right section if present
- **L1 body:** One-line project summary: `Name | Status | Stack | Description`

---

## O-Entries (Session Logs)

O-entries accumulate via the Stop hook. They're excluded from bulk reads by default — **leave them alone**. Focus curation time on L, E, D, P.

**Special tagged nodes — do not modify:**
- `#checkpoint-summary` — auto-generated `[CP]` summaries
- `#skill-dialog` — skill activation exchanges

**Exception — old O-entries with bad titles/missing tags:**
- `update_memory(id="O0042", content="Descriptive session title")`
- `update_memory(id="O0042", content="...", tags=["#session", "#release"])`

---

## Bulk Operations

For large-scale changes across many entries:

| Tool | Purpose |
|------|---------|
| `update_many(updates=[...])` | Batch flag updates across multiple IDs |
| `tag_bulk(ids=[...], add_tags=[...], remove_tags=[...])` | Add/remove tags across many entries |
| `tag_rename(old_tag, new_tag)` | Rename a tag globally |

(These operate on your own store only — for foreign files, iterate manually with `update_memory(hmem_path=...)`.)

---

## Relocate Misplaced Nodes

`move_memory` cuts and re-inserts a sub-node under a new parent, rewriting all IDs + links + `[✓ID]` refs.

```
move_memory(source_id="P0029.15", target_parent_id="L0074")
move_memory(source_id="P0029.15", target_parent_id="P0029.20")
```

**Constraints:** source must be a sub-node (not root); cannot move into own subtree. Operates on own store only.

---

## Favorite Audit

- **Too many?** >10% favorites → demote less important: `update_memory(id="X", content="...", favorite=false)`
- **Missing?** Reference entries (API endpoints, key decisions, patterns) should be favorites.
- **Sub-node better than root?** Favorite the sub-node instead.

---

## Stale Entries

Entries older than 1 month with `access_count = 0`: mark obsolete.

```
update_memory(id="L0042", obsolete=true)
```

**Exception:** unique lessons or error patterns with no equivalent — keep even if never accessed.

The V2 algorithm uses time-weighted scoring (`access_count / log2(age_in_days + 2)`) — old+low-access entries naturally sink; old+high-access stay visible.

---

## Limits

| Store | Max entries | Action when over |
|-------|-------------|-----------------|
| Personal | 300 | Triage: duplicates → low-access old → generic lessons |
| Company | 200 | Same |

**Triage order:** exact duplicates → stale (access=0, >1 month) → fragmented P entries → borderline.

---

## Quick Reference

| Tool | When |
|------|------|
| `memory_health()` | **Start here** — broken links, orphans, stale favorites |
| `memory_stats()` | Overview before starting |
| `read_memory(stale_days=60)` | Prime curation targets |
| `read_memory(prefix="X", show_all=true)` | Load entire prefix |
| `update_memory(id, content, favorite=true)` | Always-show reference |
| `update_memory(id, content, irrelevant=true)` | Hide from bulk reads |
| `update_memory(id, content, obsolete=true)` | Mark wrong (needs [✓ID]) |
| `append_memory(id, content)` | Merge info into keeper |
| `move_memory(source_id, target_parent_id)` | Relocate misplaced sub-node |
| `update_many(updates=[...])` | Batch flag updates |
| `tag_bulk / tag_rename` | Tag maintenance |
| `read_memory(show_obsolete=true)` | Review already-obsolete |
| `find_related(id)` | Discover connections / spot duplicates |

All four read/update/health/find tools accept `hmem_path="..."` for foreign-file curation.

---

## Rules

- Never invent or fabricate memories.
- Prefer fix/consolidate/mark-obsolete over deletion. Obsolete entries are hidden from bulk reads anyway.
- **When in doubt, skip.** False obsolete/irrelevant is harder to undo than leaving an entry alone.
- **Preserve learning value.** E (errors) and L (lessons) about *why* something failed stay valuable even after the bug is fixed — only mark obsolete if the analysis is wrong.
- **One prefix per batch.** Don't try all 200+ entries at once.
