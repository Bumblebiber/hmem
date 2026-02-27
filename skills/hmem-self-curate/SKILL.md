---
name: hmem-self-curate
description: Curate your own memory. Systematically review entries — mark obsolete, irrelevant, or favorite. Run periodically to keep memory clean.
---

# Self-Curation: Review Your Own Memory

You are curating **your own** memory — not another agent's. You know best which entries are still relevant. Use your regular tools: `read_memory`, `update_memory`, `write_memory`.

---

## Step 1 — Load overview

```
read_memory(titles_only=true)
```

This gives you every entry as a compact line: `ID date [flags] title`. Scan the full list before acting.

---

## Step 2 — Identify candidates

Work through the list prefix by prefix. For each entry, decide:

| Decision | Action |
|----------|--------|
| Still valid and useful | Skip (no action needed) |
| Important reference I need every session | `update_memory(id="X", content="...", favorite=true)` |
| Outdated — a better entry exists | Mark obsolete (see Step 3) |
| Just noise — not wrong, but irrelevant | `update_memory(id="X", content="...", irrelevant=true)` |
| L1 wording is vague or misleading | `update_memory(id="X", content="Better wording")` |
| Sub-node has valuable reference info | `update_memory(id="X.N", content="...", favorite=true)` |

**Drill into entries** before judging: `read_memory(id="L0042")` to see L2 children. An entry with a weak L1 may have valuable detail underneath.

---

## Step 3 — Marking obsolete

Obsolete requires a correction reference. Two patterns:

**Pattern A: Replacement exists already**
Find the existing entry that supersedes it, then mark:
```
update_memory(id="E0023", content="Wrong approach — see [✓E0076]", obsolete=true)
```

**Pattern B: No replacement exists yet**
Write the correction first, then mark:
```
write_memory(prefix="L", content="Correct approach is XYZ\n\tDetails...")  # -> L0090
update_memory(id="L0042", content="Superseded — see [✓L0090]", obsolete=true)
```

**Pattern C: Just stale, no correction needed**
If the entry is simply outdated with no replacement (e.g., a task that's done, a project note about a past state), mark it irrelevant instead:
```
update_memory(id="T0005", content="...", irrelevant=true)
```

---

## Step 4 — Consolidate duplicates

Look for entries that cover the same topic (common with P entries). Merge them:

1. Pick the **keeper** (the more complete one)
2. Copy unique info from the duplicate into the keeper:
   ```
   append_memory(id="P0029", content="Session from duplicate entry\n\tDetail carried over")
   ```
3. Mark the duplicate irrelevant:
   ```
   update_memory(id="P0031", content="Merged into P0029", irrelevant=true)
   ```

You cannot delete entries yourself (only the curator can). Marking irrelevant hides them from bulk reads, which is the same practical effect.

---

## Step 5 — Favorite audit

Check your current favorites: look for `[♥]` markers in the title listing.

- **Too many favorites?** If more than ~10% of entries are favorites, they lose their purpose. Demote the less important ones: `update_memory(id="X", content="...", favorite=false)`
- **Missing favorites?** Reference entries you always need (API endpoints, key architecture decisions, frequently-used patterns) should be favorited.
- **Sub-node favorites:** If a specific L2/L3 detail is the real reference (not the whole entry), favorite the sub-node: `update_memory(id="L0042.2", content="...", favorite=true)`

---

## Guidelines

- **Work in batches.** Don't try to curate 100+ entries in one session. Focus on one or two prefixes per run.
- **Read before marking.** Always `read_memory(id=X)` to see L2 children before marking obsolete/irrelevant. The L1 might be weak but the detail valuable.
- **Preserve learning value.** Error entries (E) and lessons (L) that describe *why* something failed are valuable even if the bug is fixed. Only mark obsolete if the root cause analysis is wrong.
- **When in doubt, skip.** You can always curate again later. False irrelevant/obsolete is harder to undo than leaving an entry alone.
- **Update stale L1 text.** If an entry's summary doesn't match its content anymore, rewrite it. A clear L1 is the most impactful improvement you can make.

---

## Quick reference

| Tool | When |
|------|------|
| `read_memory(titles_only=true)` | Get full overview |
| `read_memory(titles_only=true, prefix="L")` | Focus on one category |
| `read_memory(id="L0042")` | Drill into entry before judging |
| `update_memory(id, content, favorite=true)` | Mark as always-show reference |
| `update_memory(id, content, irrelevant=true)` | Hide from bulk reads (noise) |
| `update_memory(id, content, obsolete=true)` | Mark as wrong (needs [✓ID]) |
| `append_memory(id, content)` | Merge info from duplicate |
| `read_memory(show_obsolete=true)` | Review already-obsolete entries |
