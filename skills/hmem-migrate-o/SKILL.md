---
name: hmem-migrate-o
description: >
  Migrate O-entries to the new project-bound 5-level structure (v5.3+).
  Each O-entry gets permanently bound to its P-entry by matching sequence numbers (O0048 <-> P0048).
  Run this once after updating to v5.3. Use when the user says "migrate O-entries", "O-Eintraege migrieren",
  "hmem migrate", or when hmem-update detects that the O-entry structure needs migration.
  Also use proactively if you notice O-entries are still using the old flat format (L2->L4->L5 without L3 batches).
---

# /hmem-migrate-o — O-Entry Migration to Project-Bound Structure

This is a one-time migration from the old flat O-entry format to the new 5-level hierarchy where each O-entry is permanently bound to a P-entry (O0048 belongs to P0048).

## What Changes

**Before (old format):**
- New O-entry created per session, loosely linked via `links` field
- Flat structure: L2 (exchange) -> L4 (user msg) -> L5 (agent msg)
- `active` flag on O-entries to track current session

**After (new format):**
- One O-entry per project, ID matches P-entry (O0048 <-> P0048)
- 5-level hierarchy: L2 (session) -> L3 (batch) -> L4 (exchange) -> L5 (user/agent)
- No `active` flag needed — O is derived from the active P
- P0000/O0000 exist as "Non-Project" catch-all

---

## Step 1: Pre-Migration Check

Understand what you're working with before changing anything.

```bash
hmem --version   # must be >= 5.3.0
```

Then use `read_memory()` to see current O-entries. Check:
- How many O-entries exist?
- Which P-entries are they linked to?
- Are any O-entries already using the new format (have L3 depth=3 nodes)?

If the version is too old, run `/hmem-update` first.

## Step 2: Backup

Create a backup of the hmem database before migrating. This is critical — the migration rewrites entry IDs.

```bash
# Find the active hmem file
HMEM_FILE=$(find ~/.hmem -name "*.hmem" -not -path "*/Agents/*" | head -1)
echo "Backing up: $HMEM_FILE"
cp "$HMEM_FILE" "${HMEM_FILE}.pre-migration-backup"

# Also backup agent-specific hmem files
find ~/.hmem/Agents -name "*.hmem" -exec sh -c 'cp "$1" "$1.pre-migration-backup"' _ {} \;
```

Verify backups exist before continuing.

## Step 3: Run Migration

The migration script handles everything:

```bash
hmem migrate-o-entries
```

This will:
1. Create P0000 "Non-Project" and O0000 catch-all if they don't exist
2. For each existing O-entry:
   - Find its linked P-entry via the `links` JSON field
   - Rename it to match the P-entry's sequence number (e.g., O0042 linked to P0048 becomes O0048)
   - Handle ID conflicts by moving blockers to temporary IDs (O9XXX range)
   - Tag all migrated entries with `#legacy`
3. Tag unlinked O-entries as `#legacy` (they'll go to O0000 eventually)
4. Clear all `active` flags from O-entries

**Read the output carefully.** The script reports every rename and conflict. Example output:
```
=== hmem O-Entry Migration ===

Found 105 O-entries to process.

  O0001 -> O0048 (P0048 hmem-mcp)
  O0020 -> O0051 (P0051 BookCast)
  O0168 -> O0043 (P0043 EasySAP)
  O0002 -> #legacy (conflict for O0048)
  O0173 -> #legacy (no P-link)

Migration plan: 3 renames, 102 legacy tags.
```

## Step 4: Verify

After migration, verify the structure is correct:

```
read_memory()                    # Should show O-entries with correct IDs
read_memory(id="O0048")          # Should exist if P0048 exists
load_project(id="P0048")         # Should load without errors
```

Also check:
- The statusline still shows project + exchange counter
- New exchanges land in the correct O-entry (send a test message)

```bash
echo '{}' | hmem statusline     # Should show project info
```

## Step 5: Post-Migration Cleanup

The migration tags old O-entries as `#legacy`. These still use the old flat format but are readable via dual-format support. Options:

1. **Keep for now** — they don't hurt anything, just take space
2. **Mark irrelevant** — `update_memory(id="O0042", irrelevant=true)` for entries you don't need
3. **Delete later** — run `/hmem-self-curate` to review and clean up `#legacy` entries
4. **Auto-purge** — irrelevant entries older than 30 days are automatically deleted

Recommendation: keep them for a week to make sure everything works, then curate.

## Step 6: Remove Backup (after verification)

Once you're confident the migration worked:

```bash
find ~/.hmem -name "*.pre-migration-backup" -exec rm {} \;
```

## Troubleshooting

**Migration failed mid-way:** Restore from backup and retry.
```bash
cp "${HMEM_FILE}.pre-migration-backup" "$HMEM_FILE"
```

**O-entry has wrong project:** Use `move_nodes` to relocate sessions/exchanges:
```
move_nodes(node_ids=["O0048.3"], target_o_id="O0051")
```

**Statusline shows wrong count:** The statusline cache refreshes every 30s. Wait or:
```bash
rm /tmp/.hmem_statusline_cache
```

**New exchanges still use old format:** Make sure `cli-log-exchange.ts` is the updated version (v5.3+). Run `hmem --version` to confirm.

## Notes

- This migration is idempotent — running it twice won't break anything (already-correct entries are skipped)
- The migration only reassigns IDs and tags; it does NOT restructure internal node hierarchy
- Old `#legacy` entries are readable via dual-format support in `getOEntryExchanges()`
- New exchanges automatically use the 5-level format via the rewritten Stop hook
