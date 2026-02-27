# Changelog

## 2.3.0 (2026-02-27)

### Token Optimization

- **Compact child IDs:** Child nodes render as `.7` instead of `P0029.7` — strips the root prefix. Saves ~5 tokens per child across all render paths (renderChildren, renderChildrenExpanded, renderEntry, formatTitlesOnly, linked entries).
- **Child dates:** Child nodes show their date (MM-DD) only when it differs from the parent entry. Same-day children omit the date entirely.
- **`update_memory` content optional:** Toggling flags no longer requires repeating the entry text. `update_memory(id='P0001', secret=true)` just works — `content` parameter is now optional in both the MCP schema and `updateNode()`.

### New Features

- **Links + obsolete on sub-nodes:** `memory_nodes` table now has `links TEXT` and `obsolete INTEGER` columns. `addLink()`, `resolveObsoleteChain()`, and `updateNode()` all support compound node IDs. Obsolete chain following works for nodes in `read()`.
- **Hot nodes:** `fetchMostReferencedNodes()` shows the top-10 most-accessed sub-nodes with breadcrumb paths in bulk reads ("Frequently Referenced Nodes" section).
- **`[*]` Active marker** (root entries only): When any entry in a prefix has `active=true`, only active entries get expansion slots — but non-active entries still show as compact titles.
- **`[s]` Secret marker** (root entries + sub-nodes): Secret entries/nodes are excluded from `export_memory`.
- **`export_memory` tool:** Text export of all non-secret entries and nodes.
- **`show_important` parameter:** Returns all favorites + top-20 most-accessed entries, bypassing session cache.
- **`focus` parameter:** Force-expand a specific entry ID in bulk reads.
- **Favorite breadcrumbs:** Expanded entries with favorited sub-nodes show `[♥ path]` lines with the breadcrumb trail.
- **Reminder hint:** Bulk reads append a tip about `[♥]`/`[-]` markers and `/hmem-self-curate`.
- **`nodeMarkers()`:** Unified markers for sub-nodes: `[♥]`, `[!]` (obsolete), `[s]` (secret).

### Curation

- **`fix_agent_memory`:** Node branch now passes all flags (obsolete, favorite, secret) through to `updateNode()`. Content is optional — flags-only updates work without reading existing content first.
- **`read_agent_memory`:** Shows `[*]` and `[s]` markers.

---

## 2.2.1 (2026-02-26)

### New Features

- **Bulk read modes:** `discover` (newest-heavy, default for first read) and `essentials` (importance-heavy, auto-selected after context compression).
- **Session cache overhaul:** Fibonacci decay `[5,3,2,1,0]` with `suppressedIds` passed via ReadOptions. `reset_memory_cache` tool to clear the cache.
- **`[-]` Irrelevant marker** (root entries only): Hidden from bulk reads, no correction entry needed.
- **`expand` parameter:** `read_memory(id='P0029', expand=true, depth=3)` deep-dives with full node content.
- **Favorites on sub-nodes:** DB migration for `memory_nodes.favorite`. Favorited sub-nodes promote the root entry in bulk reads.
- **Link counts:** Links section shows `(+N obsolete hidden)` / `(+N irrelevant hidden)` counts.
- **`/hmem-self-curate` skill:** Systematic self-review workflow.

### Fixes

- Obsolete entries removed from default bulk read (only shown with `show_obsolete=true`).
- Access backfill: `expandedIds.has()` filter prevents overlap between newest and access slots.

---

## 2.2.0 (2026-02-25)

### New Features

- **Title system:** `title` column in both `memories` and `memory_nodes` tables. Auto-extracted with word-boundary truncation (`maxTitleChars: 50`). Explicit titles via first line of content.
- **`titles_only` parameter:** Compact table-of-contents view — ID + date + title per entry.
- **Time-weighted access scoring:** `access_count / age_in_hours` for smarter expansion in bulk reads.
- **Token counter:** `estimate/count/format` for output size awareness.

### Breaking Changes

- `bump_memory` tool removed (replaced by automatic access tracking).
- V1 bulk-read algorithm (`recentDepthTiers`) removed entirely.

### Cleanup

- ~538 lines of dead code removed.
- `hmem-save` moved from npm package to user-config skill.
- `maxTitleChars` default: 30 → 50.

---

## 2.1.0 (2026-02-24)

### Changes

- Period parameter `"4h"` is now symmetric (±Nh) when no sign prefix is used.
- `[♥]` `[★]` markers visible in non-curator output.
- `bump_memory` tool removed.
- V1 bulk-read (`recentDepthTiers`) removed.
- Skills cleanup: `hmem-config` + `hmem-setup` consolidated.
- CLAUDE.md updated: F-prefix → H/R/N prefixes.

---

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
