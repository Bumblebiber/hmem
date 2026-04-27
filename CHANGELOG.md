# Changelog

## 7.0.0 — 2026-04-27

### Breaking Changes

- **Two-server split** — the daily-use server (`hmem`) now ships 11 tools only. The 11 maintenance/destructive tools (`update_many`, `reset_memory_cache`, `export_memory`, `import_memory`, `memory_stats`, `memory_health`, `tag_bulk`, `tag_rename`, `move_memory`, `rename_id`, `move_nodes`) have moved to a separate `hmem-curate` binary. Add `hmem-curate` to your `.mcp.json` and activate it only when running `/hmem-curate` or `/hmem-migrate-o`. See the upgrade steps in `/hmem-update`.

### Added

- **`read_project()` MCP tool** — load another project's context (Overview, Codebase titles, Usage, Context, Requirements titles, Roadmap titles) without activating it or routing exchanges to its O-entry. Intended for cross-project reference while working on a different project.

- **`set_active_device()` MCP tool** — registers the current machine's I-entry ID in `~/.hmem/active-device`. Called automatically on the first message of a new session if no device file exists.

- **Device tracking in statusline** — the statusline now shows the active device name (I-entry title) as the first segment, e.g. `Strato Server | P0048 hmem-mcp | …`. Shows `identify device` in gray if `set_active_device` has not been called yet. Create an I-entry for each machine, then call `set_active_device({ id: "I00XX" })` once per device.

- **Rate limits in statusline** — Claude Max subscribers see live 5-hour and weekly usage percentages: `5h: 34% / w: 17%`. Color-coded green/yellow/red. No configuration required — data comes from Claude Code automatically.

- **`hmem setup-hook` CLI command** — registers the `SessionStart` hook that injects the `hmem-using-hmem` meta-skill at every session start. Idempotent, safe to re-run.

- **hmem-using-hmem meta-skill** — session-start injection of dispatch and memory habits. Mirrors Superpowers' `using-superpowers` pattern. Teaches the agent when to use `hmem-dispatch`, `hmem-recall`, `hmem-write`, `hmem-new-project`, etc.

- **`checkpointPolicy` enforcement in `append_memory`** — schema sections can now carry `"checkpointPolicy": "readonly"` (no automated appends) or `"checkpointPolicy": "pointer"` (only `[E0124]`-style entry references allowed). Enforced for all callers, not just checkpoint agents.

- **Auto-scaffold from config schema** — `write_memory` now creates all defined schema sections as empty L2 nodes immediately on entry creation, for every prefix that has a schema in `hmem.config.json` (except `E`, which keeps its own scaffold logic). The response shows the full section list: `Schema: .1 Specs, .2 OS, …`.

- **load_project onboarding hints** — when no I-entries exist (or none are active), and when no A-entries exist, `load_project` now appends contextual hints pointing the agent to create infrastructure and app entries.

### Changed

- **`hmem-new-project` skill trigger sharpened** — the trigger description now more explicitly fires when a new project needs to be created, reducing missed activations in parallel sessions.

## 6.6.4 — 2026-04-23

### Added
- **`hmem delete <id>` CLI command** — removes a memory entry by ID with confirmation prompt.

## 6.6.3 — 2026-04-18

### Added
- **Active-project footer on writes** — `write_memory`, `append_memory` and `update_memory` now append `Active project: P00XX …` to their response so the agent can re-anchor after context compression (GH #27).

## 6.6.2 — 2026-04-18

### Added
- **Default P/E section conventions** in built-in schemas — `sections[].description` now ships with guidance for checkpoint subagents, reducing wrong-node placement.

## 6.6.1 — 2026-04-18

### Added
- **Sub-node attribution in FTS search** — `read_memory` search results now surface which child node matched, not just the root.

## 6.6.0 — 2026-04-17

### Added
- **Configurable `globalLoad` injections for `load_project`** — replaces the hardcoded `R + C#universal` block with a per-item list in `hmem.config.json` (`memory.globalLoad`). Each item picks `prefix`, `loadDepth` (1–3) and an optional `tagFilter`. Falls back to the old defaults when unset.
- **CI matrix** — GitHub Actions now runs `typecheck → build → test` on Ubuntu / Windows / macOS × Node 20 / 22.
- **E2E MCP smoke test** — spawns `dist/mcp-server.js` and exercises the wire protocol via a real stdio client.

### Fixed
- **Version drift** — MCP handshake and upgrade-check both read from `package.json` now (were `"2.2.0"` and `"2.5.3"` respectively).
- **Hook CLIs hang on TTY** — `hmem log-exchange`, `startup-hook` and `context-inject` bail out cleanly when stdin is a terminal instead of a pipe.
- **`updateSkills()` on Windows** — resolved bundle path via `new URL().pathname` which produced a bogus leading `/` on Windows; now uses `fileURLToPath()`.

## 6.5.3 — 2026-04-16

### Fixed
- **Windows compatibility** for OpenCode plugin and `hmem init` — path handling and postinstall edge cases on Windows runners.

## 6.5.2 — 2026-04-15

### Fixed
- **Statusline shows wrong project after `/clear` or new session** — per-process active-project file resolution missed session boundary changes in some edge cases.

## 6.4.0 — 2026-04-15

### Fixed
- **Bash-intermediary layer in statusline and PPID bridge** — when the shell wrapping `claude` adds an intermediate bash process, the PPID chain was off by one; now walks the process tree.
- **Per-process active-project file** for session-isolated statusline — replaces the previous global marker file.

## 6.3.3 — 2026-04-14

### Docs
- Note in `hmem-update` skill about stale-skill pruning behavior introduced in 6.3.2.

## 6.3.2 — 2026-04-14

### Changed
- **Token-efficiency cleanup** — MCP tool count 29 → 21 (-824 lines). Removed dead code for single-agent setups:
  - Agent-memory subsystem: `read_agent_memory`, `fix_agent_memory`, `append_agent_memory`, `delete_agent_memory`, `get_audit_queue`, `mark_audited`.
  - `route_task` (deprecated), `reorder_sessions` (covered by `move_nodes`).
- **`hmem_path` param** added to 4 core tools for foreign-file curation: `read_memory`, `update_memory`, `find_related`, `memory_health`. Sync and session cache skipped in external mode.
- **Unified `hmem-curate`** skill (merged `hmem-self-curate`) — one workflow covers self-curation and foreign-file curation.
- **`updateSkills` prunes stale `hmem-*` skills** that are no longer bundled.

### Added
- **OpenCode plugin** support (#19).
- **`claude-mcp` registry detection** in `hmem init` (#18).

### Fixed
- GitHub issues #11, #12, #14, #15, #16, #20, #21, #23.

## 6.3.1 — 2026-04-10

### Fixed
- **Refresh PPID bridge on every message**, not just the first — stale bridge files no longer mislead the MCP server.
- **Intelligent exchange filtering** in `load_project` — previous/current O-entry exchanges are compressed and filtered by relevance before injection.
- **Compress exchange text** in `load_project` output to keep the briefing budget.

## 6.3.0 — 2026-04-10

### Added
- **Configurable per-prefix entry schemas** via `hmem.config.json` → `memory.schemas.*`. Each schema defines section order, per-section `loadDepth`, and optional `defaultChildren`.
- **Schema-driven `create_project` handler** — new P-entries use the schema from config.
- **Per-section `loadDepth`** in `load_project` rendering — each section controls how deep its children expand.
- **Auto-reconcile missing schema sections** on `load_project` — fills gaps without user action.
- **`hmem-wipe` marks completed Next Steps as irrelevant** — cleaner pre-`/clear` hygiene.

---

## 6.2.0 — 2026-04-09

### Fixed
- **Per-session active project state** — parallel Claude Code sessions no longer contaminate each other's active project. Each session now has its own marker file at `~/.hmem/sessions/<session_id>.json` and a PPID bridge file at `~/.hmem/sessions/ppid-<parent_pid>.json` so the MCP server can resolve session id without Claude Code env support. Fixes symptoms where exchanges were silently written to `O0000` or to a parallel session's O-entry.
- **Statusline cache** was global, causing two sessions to share the same cached project for 30 seconds. Now per-session.
- **Statusline no longer guesses** "most recently updated project" when nothing is active — shows `no project` instead.

### Added
- `~/.hmem/diagnostics.log` — JSONL log of every `log-exchange` call with active project resolution, rotated at 1 MB.
- Loud `console.error` warnings when log-exchange falls through to `O0000` or legacy DB flag.
- `src/session-state.ts` module with marker file R/W/purge and PPID bridge helpers.
- `src/diagnostics.ts` module with JSONL log writer and rotation.

### Deferred
- HMEM_PATH session anchor (CWD-discovery trap) — follow-up for users who start `claude` from project directories with `.hmem` files.
- Windows PPID bridge support — currently Linux/macOS only; Windows sessions fall through to legacy behavior.
- Haiku checkpoint cross-check agent — Phase 2.

---

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
