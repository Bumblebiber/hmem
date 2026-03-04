---
name: hmem-self-curate
description: Curate your own memory. Systematically review entries — mark obsolete, irrelevant, or favorite. Run periodically to keep memory clean.
---

# Self-Curation: Review Your Own Memory

You are curating **your own** memory. You know best which entries are still relevant.

---

## Step 0: Health Check First

Before diving in, run an audit to get a prioritized list of issues:

```
memory_health()
```

This instantly shows:
- **Broken links** — fix or remove them first (high impact, easy to miss manually)
- **Orphaned entries** — root entries with no sub-nodes (likely draft stubs)
- **Stale favorites/pinned** — favorites not accessed in >60 days (demote or verify)
- **Broken obsolete chains** — `[✓ID]` pointing to deleted entries

Also useful before starting:
```
memory_stats()          # overview: how many entries per prefix, stale count, etc.
read_memory(stale_days=60)  # entries not touched in 60 days — prime curation candidates
```

---

## Workflow: Prefix by Prefix

Work through one prefix at a time. Load all entries of a prefix with full depth:

```
read_memory(prefix="P", show_all=true)
```

This bypasses V2 selection and session cache — every entry is expanded with L2+L3 children visible. Review each entry in the output directly — no need to drill into individual entries.

**Order:** Start with the prefix that has the most entries (usually P), then move to L, E, D, etc.

If context overflows mid-prefix, continue with the remaining entries — your memory survives compression.

---

## For Each Entry: Decide and Act

| Decision | Action |
|----------|--------|
| Still valid and useful | Skip (no action needed) |
| Important reference I need every session | `update_memory(id="X", content="...", favorite=true)` |
| Outdated — a better entry exists | Mark obsolete (see below) |
| Just noise — not wrong, but irrelevant | `update_memory(id="X", content="...", irrelevant=true)` |
| L1 wording is vague or misleading | `update_memory(id="X", content="Better wording")` |
| Sub-node has valuable reference info | `update_memory(id="X.N", content="...", favorite=true)` |

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
If the entry is simply outdated with no replacement (e.g., a finished task, a past state):
```
update_memory(id="T0005", content="...", irrelevant=true)
```

---

## Consolidate Duplicates

Look for entries covering the same topic (common with P entries). Merge them:

1. Pick the **keeper** (the more complete one)
2. Copy unique info from the duplicate: `append_memory(id="P0029", content="Session from duplicate\n\tDetail carried over")`
3. **Delete** the duplicate: `delete_agent_memory(agent_name="YOUR_NAME", entry_id="P0031")`

**Delete, don't mark irrelevant.** Irrelevant duplicates still show up with `show_all=true` and flood the context on future curation runs. True duplicates (entire content exists in the keeper) must be deleted to keep the memory clean.

---

## Relocate Misplaced Nodes

When a sub-node belongs under a different root or parent, use `move_memory` to cut and re-insert it. All IDs, links, and `[✓ID]` content references are updated automatically.

```
# Move P0029.15 to become a child of L0074
move_memory(source_id="P0029.15", target_parent_id="L0074")
# → P0029.15 (+ all children) become L0074.N (new seq under L0074)

# Move within the same root: P0029.15 → under P0029.20
move_memory(source_id="P0029.15", target_parent_id="P0029.20")
# → becomes P0029.20.N with all children re-keyed
```

**Constraints:**
- `source_id` must be a sub-node — cannot move root entries
- Cannot move a node into its own subtree
- Curator variant: `move_agent_memory(agent_name="THOR", source_id="...", target_parent_id="...")`

---

## Favorite Audit

Check `[♥]` markers in the output.

- **Too many?** If >10% are favorites, demote less important ones: `update_memory(id="X", content="...", favorite=false)`
- **Missing?** Reference entries you always need (API endpoints, key decisions, patterns) should be favorited.
- **Sub-nodes:** If a specific L2/L3 is the real reference, favorite the sub-node instead.

---

## Guidelines

- **One prefix per batch.** Don't try all 200+ entries at once — focus on one prefix per `show_all` call.
- **Preserve learning value.** Error entries (E) and lessons (L) about *why* something failed are valuable even if the bug is fixed. Only mark obsolete if the analysis is wrong.
- **When in doubt, skip.** False irrelevant/obsolete is harder to undo than leaving an entry alone.
- **Update stale L1 text.** A clear L1 is the most impactful improvement you can make.

---

## Quick Reference

| Tool | When |
|------|------|
| `memory_health()` | **Start here** — broken links, orphans, stale favorites |
| `memory_stats()` | Overview before starting |
| `read_memory(stale_days=60)` | Prime curation targets |
| `read_memory(prefix="X", show_all=true)` | Load entire prefix for review |
| `update_memory(id, content, favorite=true)` | Mark as always-show reference |
| `update_memory(id, content, irrelevant=true)` | Hide from bulk reads (noise) |
| `update_memory(id, content, obsolete=true)` | Mark as wrong (needs [✓ID]) |
| `append_memory(id, content)` | Merge info into keeper |
| `move_memory(source_id, target_parent_id)` | Relocate misplaced sub-node (updates all refs) |
| `delete_agent_memory(agent_name, entry_id)` | Delete true duplicates |
| `read_memory(show_obsolete=true, prefix="X")` | Review already-obsolete entries |
