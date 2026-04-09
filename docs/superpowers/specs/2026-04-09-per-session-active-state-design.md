# Per-Session Active Project State

**Date:** 2026-04-09
**Status:** Draft — pending implementation plan
**Related bugs:** Cross-session active-flag contamination, O0000 silent fallback, statusline stale cache, CWD-discovery drift

## Problem

The `active` project flag is a single global field on the `memories` table. Any Claude Code session that calls `load_project(X)` flips it for **every** other concurrent session. This breaks three consumers:

1. **`cli-statusline.ts`** reads `memories.active=1` directly (`cli-statusline.ts:107`). Session A shows Session B's project.
2. **`cli-log-exchange.ts`** calls `store.getActiveProject()` (`cli-log-exchange.ts:189`) — if it returns another session's project, Session A's exchanges are appended to the wrong O-entry. If it returns `null`, `projectSeq=0` silently writes to `O0000` with no warning.
3. **Checkpoint spawning** inherits `HMEM_ACTIVE_PROJECT` from whichever session most recently touched the DB.

Three amplifiers make this worse:

- **Global statusline cache** (`/tmp/.hmem_statusline_cache`, `cli-statusline.ts:42`) — 30 s TTL shared across all sessions.
- **Statusline fallback** (`cli-statusline.ts:109-111`) — when no project is active, guesses "most recently updated P-entry" instead of showing "no project".
- **CWD-based `HMEM_PATH` resolution** (`hmem-store.ts:4979`) — Stop-hooks spawned without `HMEM_PATH` env fall back to CWD discovery, potentially opening a different `.hmem` file than the MCP server uses.

The v6.0.3 in-process `activeProjectId` variable fixes this only within the long-lived MCP-server process. Short-lived CLI hooks (log-exchange, statusline, checkpoint) never see that variable and always fall back to the shared DB flag.

**User-observable symptoms:** Exchanges logged to `O0000` despite statusline showing an active project. Statusline showing a different project than the session is actually working on. No diagnostic trail to reconstruct what happened.

## Goals

1. Active-project state is **per-session**, not global. Parallel sessions cannot contaminate each other.
2. Every hook and CLI process resolves the same `hmem_path` as its owning session — no CWD drift.
3. Any fallback to `O0000` or "no active project" is **loud** and logged.
4. Full observability: a diagnostic log records every log-exchange decision with enough context to reconstruct post-hoc what project an exchange was written to and why.
5. Backward compatibility: sessions started before the fix (no marker file) keep working via a fallback path.

## Non-goals

- Auto-migration of already-misrouted exchanges from `O0000` or wrong projects. Deferred; manual review in Phase 1.
- A second-line Haiku cross-check agent. Deferred to Phase 2 after Phase 1 is verified in production.
- Deprecating the `memories.active` column. It remains as a compatibility mirror.

## Architecture

### 1. Session marker files

Directory: `~/.hmem/sessions/`
Filename: `<session_id>.json`
Content:

```json
{
  "sessionId": "abc-123",
  "projectId": "P0048",
  "hmemPath": "/home/bbbee/.hmem/memory.hmem",
  "updatedAt": "2026-04-09T12:34:56Z",
  "pid": 12345
}
```

**Writers:**
- `load_project` MCP tool — writes marker when activating a project.
- `cli-hook-startup.ts` (SessionStart hook) — creates empty marker with `projectId: null`, `hmemPath` resolved once from env/CWD.
- `write_memory` / `append_memory` / `update_memory` on any P-entry — updates marker (auto-activation path, matches current behaviour).

**Readers:**
- `cli-statusline.ts` — reads marker by `session_id` from stdin JSON.
- `cli-log-exchange.ts` — reads marker by `session_id` from stdin JSON.
- `cli-checkpoint.ts` — reads marker by `HMEM_SESSION_ID` env var.

**Cleanup:** SessionStart-hook purges marker files older than 7 days on each invocation.

### 2. Session-ID propagation

Claude Code passes `session_id` in the stdin JSON of every hook (SessionStart, Stop, PreToolUse, Statusline, etc.). We rely on that as the source of truth.

- **Hooks (SessionStart, Stop, Statusline):** extract `session_id` directly from stdin JSON.
- **MCP server:** SessionStart-hook exports `HMEM_SESSION_ID=<session_id>` into a session-env file (`~/.hmem/sessions/<session_id>.env`) that the MCP-server launch wrapper sources before spawning `hmem serve`. Alternative: the launch wrapper reads `session_id` from Claude Code's MCP launch context if available — to be confirmed during implementation.
- **Checkpoint child processes:** spawned by log-exchange with `HMEM_SESSION_ID` already set in `process.env` (log-exchange already has it from its own stdin).

### 3. `getActiveProject` refactor (`hmem-store.ts`)

New signature:

```ts
getActiveProject(sessionId?: string): MemoryRow | null
```

Resolution order:
1. If `sessionId` is given and `~/.hmem/sessions/<sessionId>.json` exists with a non-null `projectId` → load that P-entry from DB and return it.
2. If marker exists but `projectId` is null → fall through to DB flag (marker is initialized but not yet bound to a project — MCP cannot inject session ID so marker may stay at null even after `load_project` is called).
3. If no marker (legacy / pre-fix session) → fall back to old DB-flag query (`WHERE active=1 LIMIT 1`).
4. Otherwise → null.

All call sites updated to pass `sessionId` where available. The DB `memories.active` column stays as a compatibility mirror (updated alongside the marker file) so that external SQL queries and old tools keep working.

### 4. `HMEM_PATH` session anchor (deferred to follow-up)

**Status:** Not in Phase 1. The marker file still stores `hmemPath` (so the data is available), but `resolveEnvDefaults` is not changed in this spec. Current user workflow (starting `claude` from `~/bbbee`) does not trigger the CWD-discovery trap. Tracked as separate follow-up for users who start sessions from project directories containing `.hmem` files.

Original design (for reference):

`cli-env.ts#resolveEnvDefaults` gains a new Priority 0:

1. **Priority 0 (new):** If `HMEM_SESSION_ID` is set and marker file exists → use `marker.hmemPath`.
2. Priority 1: `HMEM_PATH` env var.
3. Priority 2: CWD discovery.
4. Priority 3: single-agent home dir.
5. Priority 4: `~/.hmem/memory.hmem` default.

The marker file's `hmemPath` is written once at SessionStart, from the same resolution logic — but after that, every hook in the same session gets the exact same answer regardless of its spawn CWD.

### 5. Statusline cache per-session

- `CACHE_FILE` changes from `/tmp/.hmem_statusline_cache` to `/tmp/.hmem_statusline_<session_id>.cache`.
- Fallback "most recently updated P-entry" (`cli-statusline.ts:109-111`) is **removed**. When no project is active for this session, statusline prints `no project` (gray).
- Cache cleanup: entries older than 24 h deleted on each statusline call (cheap, already touches `/tmp`).

### 6. Observability

Log file: `~/.hmem/diagnostics.log` (append-only JSON Lines, rotated to `.1` at 1 MB).

Every `cli-log-exchange.ts` call appends:

```json
{
  "ts": "2026-04-09T12:34:56Z",
  "op": "log-exchange",
  "sessionId": "abc-123",
  "hmemPath": "/home/bbbee/.hmem/memory.hmem",
  "activeProjectId": "P0048",
  "oId": "O0048",
  "batchId": "O0048.17.3",
  "markerSource": "session-marker" | "db-fallback" | "none"
}
```

**Loud failures** (additionally written to `console.error`, visible in hook output):
- `activeProjectId` is null → `[hmem] WARNING: no active project for session abc-123, writing to O0000`
- `markerSource === "db-fallback"` → `[hmem] WARNING: session abc-123 has no marker file, using legacy DB flag`
- `hmemPath` from marker differs from `resolveHmemPath()` → `[hmem] DRIFT: marker=X cwd-resolved=Y`

`cli-statusline.ts` writes a lighter entry (`op: "statusline"`) only when it hits the `no project` branch — otherwise it would spam on every refresh.

### 7. Phase 2 (deferred)

Haiku checkpoint-agent cross-checks the session-marker's `projectId` against the last few exchanges' `o_id` in DB. On drift:
- Reports to main agent via structured hook output.
- Optionally migrates misrouted exchanges into the correct O-entry.

Tracked separately, not in scope for this spec.

## Data flow

```
┌─────────────────┐
│ Claude Code     │
│ starts session  │
└────────┬────────┘
         │ stdin {session_id, ...}
         ▼
┌─────────────────────┐
│ SessionStart hook   │
│ cli-hook-startup.ts │
│ - resolve hmemPath  │
│ - write marker file │
│ - purge stale (7d)  │
└────────┬────────────┘
         │
         │  user calls load_project(P0048) via MCP
         ▼
┌─────────────────────┐
│ MCP server          │
│ - update marker     │ ──► ~/.hmem/sessions/abc-123.json
│ - mirror to DB.active│
└─────────────────────┘
         │
         │  user sends message, Stop-hook fires
         ▼
┌─────────────────────┐       ┌───────────────────────┐
│ Stop hook           │──────►│ ~/.hmem/sessions/     │
│ cli-log-exchange.ts │       │   abc-123.json        │
│ - read session_id   │◄──────│                       │
│ - read marker       │       └───────────────────────┘
│ - append to O0048   │
│ - diagnostics.log   │
└─────────────────────┘

Parallel: Claude Code Session B (session_id=xyz-789)
  writes to ~/.hmem/sessions/xyz-789.json — completely isolated.
```

## Error handling

- **Marker file write fails** (disk full, permission): `load_project` returns error to user, does not update in-memory state.
- **Marker file read fails** in hook: fall back to `db-fallback` path, log loud warning, continue.
- **Session-ID missing from hook stdin**: log warning, fall back to `db-fallback`, continue. (Should not happen; Claude Code always provides it.)
- **Marker's `hmemPath` points to non-existent file**: hook logs error and exits cleanly (no exchange written) rather than creating a new DB.
- **Concurrent writes to the same marker file**: last-write-wins is acceptable (single session, single writer per session in practice). No file locking needed.

## Testing

**Unit tests (`test/`):**
- `getActiveProject(sessionId)` returns marker's project.
- `getActiveProject(sessionId)` with no marker falls back to DB flag.
- `getActiveProject(sessionId)` with null projectId in marker falls through to DB flag.
- Stale marker cleanup removes files older than 7 d, keeps newer ones.
- `resolveEnvDefaults` Priority 0 beats all others when marker present.

**Integration tests:**
- Two parallel mock sessions, A loads P0048, B loads P0050. Verify A's log-exchange writes to O0048 and B's to O0050, simultaneously.
- Session without `load_project` call → log-exchange writes to O0000 AND emits loud warning to stderr AND diagnostics log.
- Statusline with session_id=A returns A's project even when session B was the most recent DB writer.

**E2E reproducer script:**
`test/e2e/parallel-sessions.sh` — spawns two hmem CLI processes with different `HMEM_SESSION_ID`, both call `load_project`, both call `log-exchange` with dummy transcripts, asserts correct O-entry targets.

**Regression:**
- Existing test suite must pass without modification.
- Legacy sessions (no marker) still log exchanges correctly via DB-fallback path.

## Migration

- **No DB schema change required.** `memories.active` stays; now a mirror, no longer source of truth.
- First run after upgrade: SessionStart-hook creates fresh marker files for new sessions. Existing in-flight sessions (at upgrade time) fall through to DB-fallback until next session restart. Acceptable.
- Stale marker cleanup runs on SessionStart, so old directories don't accumulate.

## Open questions

- **MCP server session-id injection:** **RESOLVED — NO.** Claude Code does NOT pass any session-identifying environment variable (`CLAUDE_SESSION_ID`, `ANTHROPIC_SESSION_ID`, `HMEM_SESSION_ID`, or similar) to MCP servers it launches. The MCP server config in `~/.mcp.json` uses a static `env` block (plain JSON, not templated), so no session ID can be injected at launch time. Confirmed by: (a) grepping `~/.claude/` finds no SESSION_ID references in MCP config paths, only in hook scripts; (b) the `.mcp.json` `env` block contains only static keys (`HMEM_PROJECT_DIR`, `HMEM_AGENT_ID`, `HMEM_SYNC_PASSPHRASE`). **Consequence:** `setActiveProject(id, process.env.HMEM_SESSION_ID)` inside `mcp-server.ts` will always be called with `HMEM_SESSION_ID=undefined`, so the MCP `load_project` tool can never write a session marker. The marker written by SessionStart (with `projectId: null`) will remain at null. This is why `getActiveProject` must treat a null-projectId marker as "fall through to DB flag" rather than "explicit no-project" — otherwise every `log-exchange` call would return null and write to `O0000`.
- **Statusline cache file cleanup cadence:** Per-call cleanup is fine but may be excessive. Alternative: cleanup only when SessionStart fires. Decide during implementation.
