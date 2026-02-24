# Changelog

## 2.0.0 (2026-02-24)

### Breaking Changes

- **V2 Bulk-Read is now default.** `read_memory()` returns grouped output by prefix category instead of flat chronological listing. The old V1 algorithm is still available when `recentDepthTiers` is explicitly passed.
- **Obsolete enforcement:** Marking an entry obsolete (`obsolete=true`) now requires a `[✓ID]` correction reference in the content (e.g. `"see [✓E0076]"`). The system rejects the call without it. Curator tools (`fix_agent_memory`) bypass this requirement.
- **Abstract header entries (X0000):** Each prefix category now has an auto-created header entry with `seq=0` (e.g. `P0000`, `L0000`). These are used as group headers in bulk reads and are hidden from normal queries via `seq > 0` filters.

### New Features

- **Grouped output:** Bulk reads group entries by prefix category with human-readable headers (e.g. "Lessons learned and best practices (12 entries)").
- **Smart expansion:** Newest entries, most-accessed entries, and favorites are fully expanded (all L2 children + links shown). Other entries show only the latest child with a `[+N more → ID]` hint.
- **Obsolete filtering:** Only the top N obsolete entries (by access count, "biggest mistakes") are shown in bulk reads. The rest are hidden with a summary line. Use `show_obsolete=true` to see all.
- **Payload stripping:** Non-curator output uses compact markers: `[!]` instead of `[⚠ OBSOLETE]`, no `[♥]`/`[★]` markers.
- **`bump_memory` tool:** Manually increase an entry's access count to boost its visibility in bulk reads. Supports custom increment.
- **Bubble-up access tracking:** `append_memory` automatically bumps the parent entry's and root entry's access count.
- **Time-based search:** New `time`, `period`, and `time_around` parameters for finding entries created around a specific time or near another entry.
- **Bidirectional auto-linking:** When marking an entry obsolete with `[✓ID]`, the system automatically creates links in both directions (old ↔ new).
- **Access count transfer:** When marking obsolete with `[✓ID]`, the old entry's access count is transferred to the correction entry, and the obsolete entry is reset to 0.

### Config Additions

- `prefixDescriptions` — Human-readable descriptions for each prefix category, used as group headers.
- `bulkReadV2.topAccessCount` (default: 3) — Number of most-accessed entries to expand.
- `bulkReadV2.topNewestCount` (default: 5) — Number of newest entries to expand.
- `bulkReadV2.topObsoleteCount` (default: 3) — Number of obsolete entries to keep visible.

### Security

- **SQL hardening (standalone):** `buildRoleFilter()` now uses parameterized queries instead of string interpolation.
- **WAL checkpoint:** `close()` now runs `PRAGMA wal_checkpoint(TRUNCATE)` for clean shutdown.

### Skills Updated

- `hmem-read` — Documents grouped output, time search, bump_memory, show_obsolete.
- `hmem-write` — Documents `[✓ID]` obsolete workflow, bump_memory, bubble-up.
- `hmem-curate` — Documents curator bypass, V2 output format, access count transfer.
- `hmem-config` — Documents new `prefixDescriptions` and `bulkReadV2` parameters.
- `hmem-save` — Updated prefix list (F removed, N added).

---

## 1.6.7 (2026-02-24)

- Fix: correct `mcpName` case (Bumblebiber, not bumblebiber)

## 1.6.6 (2026-02-24)

- CI: add MCP Registry publish workflow (OIDC)

## 1.6.5 (2026-02-24)

- Docs: add skill file guidance for MCP Registry users
- Fix: server.json description

## 1.6.4 (2026-02-24)

- Feat: add MCP Registry server.json + mcpName for ownership verification

## 1.6.3 (2026-02-24)

- Fix: 3 issues from Gemini code review (N+1 queries, role filter, export)

## 1.6.2 (2026-02-23)

- Feat: company store removed from public docs
- Rename: FIRMENWISSEN → company

## 1.6.1 (2026-02-23)

- Fix: HMEM_AGENT_ID bug (instance ID vs template name)

## 1.6.0 (2026-02-23)

- Feat: obsolete entries hidden from bulk reads
- Feat: favorite flag replaces F prefix
