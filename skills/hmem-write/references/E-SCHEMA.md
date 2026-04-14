# E-Entry Schema (Auto-Scaffolded)

E-entries have a **pre-built structure** — just provide a title and short description, the server creates the rest.

## Creating an E-Entry

```
write_memory(prefix="E", content="hmem sync bug on v1.0.1\n\nConnection fails when HMEM_PATH contains spaces", tags=["#hmem", "#sync", "#path"])
```

This auto-creates:
- **.1 Analysis** (your description goes here automatically)
- **.2 Possible fixes**
- **.3 Fixing attempts**
- **.4 Solution**
- **.5 Cause**
- **.6 Key Learnings**

Plus `#open` tag. Fill in the nodes as you debug with `append_memory`/`update_memory`. The response shows **similar E/D entries by tag overlap** — check them before reinventing the wheel. When solved, replace `#open` with `#solved` and fill .4 + .5 + .6.

E-entries are **not shown in bulk reads** — they surface automatically via tag overlap when you create new E/D entries. Solved bugs are knowledge, not clutter.

## Marking Entries as Favorites

Mark any entry as a favorite to ensure it always appears with its L2 detail in bulk reads (alongside a `[heart]` marker). Use this for reference info you need to see every session — API endpoints, key decisions, frequently looked-up patterns.

```
write_memory(prefix="D", content="...", favorite=true)           # set at creation
update_memory(id="D0010", content="...", favorite=true)          # set on existing
update_memory(id="D0010", content="...", favorite=false)         # clear
```

Favorites are **not** a prefix — they are a flag on any entry regardless of category.
Use sparingly: if everything is a favorite, nothing is. Prefer high-value reference entries over fleeting notes.

## Marking Entries as Obsolete

When an entry is outdated — superseded by a newer approach, a fixed bug, or changed architecture — do **not** delete it. Mark it as obsolete with a correction reference:

```
# Step 1: Write the correction FIRST
write_memory(prefix="E", content="Correct approach is XYZ\n\tDetails...")  # -> E0076

# Step 2: Mark old entry obsolete — MUST include [checkmark-ID] tag
update_memory(id="E0023", content="Wrong approach — see [checkmark-E0076]", obsolete=true)
```

**The `[checkmark-ID]` tag is enforced.** The system will reject `obsolete=true` without a correction reference. This ensures every obsolete entry points to its replacement. The system also creates **bidirectional links** automatically (E0023<->E0076).

The entry stays in memory with a `[!]` marker. Past errors still carry learning value. The curator may eventually prune it, but that is their decision.

**Shortcut for stale entries:** If no correction exists (entry is just old/irrelevant, not wrong), only the curator can mark it obsolete without `[checkmark-ID]`.
