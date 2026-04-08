# O-Entry Refactoring: Project-Bound 5-Level Session Hierarchy

**Date:** 2026-03-31
**Status:** Approved
**Affects:** hmem-store.ts, cli-log-exchange.ts, cli-checkpoint.ts, cli-init.ts, mcp-server.ts

## Problem

Current O-entries are flat (L2 -> L4 -> L5), created per session, and loosely associated with projects via `links`. This causes:

- Mini O-entry pollution (new O per project switch, even for 1-exchange sessions)
- No session grouping within a project
- No batch summaries for efficient context loading
- Unreliable O-exchange display in `load_project`
- L3 level completely unused

## Solution

Bind each O-entry permanently to a P-entry by matching sequence numbers (O0048 <-> P0048). Use all 5 levels for a clean hierarchy: Session -> Batch -> Exchange -> Raw Messages.

## 1. New O-Entry Structure

```
O0048 (L1, memories table, links: ["P0048"])
+-- Session A (L2, depth=2) -- "2026-03-31 Refactoring O-entries"
|   +-- Batch 1 (L3, depth=3) -- body: Rolling Summary (Haiku)
|   |   +-- Exchange 1 (L4, depth=4) -- title: topic (Haiku)
|   |   |   +-- User msg (L5, depth=5, seq=1)
|   |   |   +-- Agent msg (L5, depth=5, seq=2)
|   |   +-- Exchange 2 (L4, depth=4)
|   |   |   +-- User (L5, seq=1)
|   |   |   +-- Agent (L5, seq=2)
|   |   +-- ... (max N exchanges per batch, N = checkpointInterval)
|   +-- Batch 2 (L3, depth=3) -- Rolling Summary incl. Batch 1
|   |   +-- ...
|   +-- [Session summary written to L2 body, async on next session start]
+-- Session B (L2, depth=2)
|   +-- ...
```

### Key Principles

- **O number = P number**, always. O0048 belongs to P0048.
- **No `active` flag on O-entries.** O is derived from the active P.
- **P0000** exists as "Non-Project". O0000 is the catch-all.
- Each Claude Code session gets its own L2 node.
- Batches (L3) rotate automatically when full.

### Context Loading Granularity

| Level | What you get |
|-------|-------------|
| L2 bodies | Session summaries across all sessions |
| L3 bodies | Batch-level rolling summaries |
| L4 titles | Exchange topic index |
| L5 nodes | Raw user + agent messages, searchable |

## 2. Session & Batch Management

### Session Detection

The Stop hook receives `transcript_path` in stdin JSON. Each Claude Code session has a unique transcript path. Tracking via temp file:

```
/tmp/.hmem_session_<hmem_path_hash>.json
{
  "transcript_path": "/home/bbbee/.claude/projects/.../abc123.jsonl",
  "session_l2_id": "O0048.3",
  "batch_l3_id": "O0048.3.2",
  "exchange_count": 3
}
```

### Flow Per Exchange (Stop Hook)

```
1. Determine active P -> P0048 -> O0048
2. Read session state from temp file
3. Compare transcript_path:
   - Same -> same session, continue to 4
   - Different -> new session:
     a) Create new L2 node (O0048.N)
     b) Create new L3 batch (O0048.N.1)
     c) Update temp file
4. Check exchange_count in current batch:
   - < checkpointInterval -> append exchange
   - >= checkpointInterval -> new L3 batch, then append
5. Create L4 exchange with L5.1 (user) + L5.2 (agent)
6. Update temp file (exchange_count++)
7. If batch just became full -> spawn Haiku checkpoint
```

### Edge Cases

- **O0048 does not exist yet**: Auto-created with `links: ["P0048"]`.
- **No active P**: Falls back to O0000 (P0000 "Non-Project").
- **Temp file missing/corrupt**: Treated as new session (safe default).

## 3. Hook Changes

### 3a: Stop Hook (cli-log-exchange.ts)

**Before:** `getActiveO()` -> `appendExchange(oId, user, agent)` (flat L2->L4->L5)

**After:**

```
1. resolveProjectO()                    // P0048 -> O0048
2. resolveSession(oId, transcriptPath)  // L2 session find/create
3. resolveBatch(sessionId)              // L3 batch find/create
4. appendExchange(batchId, user, agent) // L4 exchange + L5.1 user + L5.2 agent
5. triggerCheckpoint()                  // if batch full -> spawn Haiku
```

**New store methods:**

- `resolveProjectO(projectSeq: number): string` -- find/create O with matching number
- `resolveSession(oId: string, transcriptPath: string): string` -- session tracking via temp file
- `resolveBatch(sessionId: string, batchSize: number): string` -- find current batch, create new if full
- `appendExchange()` rewritten: creates L4 + 2x L5 (was L2 + L4 + L5)

### 3b: SessionStart Hook (cli-init.ts / context-inject)

New behavior: checks if the last session (last L2 node in active O) has a summary (L2 body). If not, spawns Haiku async to write it.

```
1. Load O0048
2. Find last L2 node
3. Does L2 node have a body beyond its title?
   - Yes -> nothing to do
   - No -> spawn "hmem summarize-session O0048.3" (async, detached)
```

### 3c: Checkpoint (cli-checkpoint.ts)

**Before:** Haiku gets all exchanges since last checkpoint, writes L/D/E + checkpoint summary as L2 node.

**After:** Haiku gets:

- The just-completed batch's exchanges (L5 raw data)
- The previous batch's rolling summary (L3 body)
- All P-entry titles (via `list_projects`, ~20 tokens per project)

**Haiku tasks:**

1. Write rolling summary into current L3 batch body (`update_memory`)
2. Title each exchange (L4 nodes)
3. Write relevant insights as standalone entries (L, D, E, R, C, ... -- any prefix)
   - Link to current batch: `links: ["O0048.7.3"]`
4. Check: do all exchanges belong to P0048?
   - If not: `move_nodes(node_ids: [...], target_o_id: "O00XX")`
5. Title the session L2 node (if still generic)
6. Tag exchanges (see Exchange Tags below)

## 4. MCP Server Changes

### 4a: load_project Enhancement

`load_project(P0048)` now also loads from O0048:

```
--- Last Session ---
O0048.7 "2026-03-31 O-Entry Refactoring"
  [Summary] Large restructuring of O-entries planned. 5-level hierarchy...

  USER: Ich moechte jetzt ein grosses Refactoring...
  AGENT: Gutes Konzept. Lass mich die Architektur...
  USER: Bin mit deinem Strukturvorschlag einverstanden...
  AGENT: Gut, ich plane das durch...
  (5 most recent exchanges, #irrelevant skipped, #skill-dialog title-only)
```

Logic:
1. Find O-entry with same seq as P (O0048 for P0048)
2. Load last L2 node (session)
3. Show L2 body as session summary (if present)
4. Find last L3 batch -> show rolling summary
5. Load 5 most recent L4 exchanges -> show L5 raw data (truncated)

### 4b: New MCP Tools

**`list_projects`** -- for Haiku checkpoint:
```
Returns: [{id: "P0000", title: "Non-Project"}, {id: "P0048", title: "hmem-mcp"}, ...]
```
Only active, non-obsolete P-entries. No body, no children. ~20 tokens per project.

**`move_nodes`** -- for Haiku project corrections:
```
move_nodes(
  node_ids: ["O0000.3.2"],    // L2, L3, or L4 nodes
  target_o_id: "O0048"         // target project O
)
```
- Detects depth automatically (L2 = whole session, L3 = whole batch, L4 = single exchange)
- Sorts chronologically by `created_at`
- Rewrites IDs (node + all children + tags + FTS)
- Cleans up empty parent nodes

### 4c: read_memory for O-Entries

Hierarchical drill-down:
- `read_memory()` -> all O-entries title-only (as before)
- `read_memory(id="O0048")` -> sessions (L2) with dates + exchange count
- `read_memory(id="O0048.3")` -> batches (L3) with summaries
- `read_memory(id="O0048.3.2")` -> exchanges (L4) with titles
- `read_memory(id="O0048.3.2.1")` -> exchange detail (L5 user + agent)

## 5. Exchange Tags

Haiku assigns these on L4 nodes during checkpoint:

| Tag | Meaning | In Rolling Summary? | In load_project? |
|-----|---------|---------------------|-------------------|
| `#skill-dialog` | Skill output (brainstorming, TDD, etc.) | Title + result only | Title only |
| `#irrelevant` | No value (greetings, "ok", typo corrections) | No | Skipped |
| `#checkpoint-summary` | Haiku-written summary (on L3) | -- | Normal |
| `#planning` | Design/architecture discussion | Title + decisions | Title only |
| `#debugging` | Bug hunting/fixing | Only if fix found | Title only |
| `#admin` | Setup, config, infra -- no feature content | No | Title only |
| `#meta` | Discussion about tooling/memory/config, not actual project work | Title + decisions | Title only |

**Tagging logic:**
- Checks L5 content for skill markers (`"Base directory for this skill:"`) -> `#skill-dialog`
- Short exchanges (<50 chars user + agent) without substance -> `#irrelevant`
- Pattern recognition for debug loops, config changes, planning conversations

**Impact on rolling summary (L3 body):**
- `#irrelevant` exchanges are completely ignored
- `#skill-dialog`, `#planning`, `#debugging`, `#admin` -> only result/decision flows in
- Untagged exchanges -> fully included

## 6. Migration

### Strategy: Pragmatic, Not Perfect

Old O-entries will likely be deleted after curation. No internal restructuring.

### Phase 1: Preparation
1. Create P0000 "Non-Project" (if not exists)
2. Create O0000 (catch-all)

### Phase 2: O-Entry ID Reassignment
For each existing O-entry:
1. Check `links` field -> which P-entry is linked?
2. Calculate target ID: P0048 -> O0048
3. Three cases:
   - **ID already correct** (O0048 belongs to P0048) -> nothing to do
   - **ID must be swapped** (O0048 belongs to P0012) -> `rename_id` to temp ID, then assign target
   - **No P-link** -> move to O0000
4. Tag all renamed O-entries with `#legacy`

### Phase 3: Dual-Format Read Support
Legacy O-entries keep their flat structure (L2->L4->L5). New exchanges use 5-level structure.

**Detection:** If an L2 node has direct L4 children (depth=4, parent=L2) -> legacy format. If L2 only has L3 children -> new format.

### Migration CLI Command
`hmem migrate-o-entries`:
```
1. Load all O-entries
2. Calculate P-assignments
3. Resolve ID conflicts (rename_id in transaction)
4. Tag #legacy
5. Report: "O0042 -> O0048 (P0048 hmem-mcp), O0003 -> O0000 (no project)"
```

## 7. Data Flow Diagram

```
User Message + Agent Response
        |
        v
  [Stop Hook: cli-log-exchange.ts]
        |
        +-- resolveProjectO() -- P0048 -> O0048
        +-- resolveSession()  -- transcript_path tracking
        +-- resolveBatch()    -- L3, rotate if full
        +-- appendExchange()  -- L4 + L5.1 + L5.2
        |
        +-- if batch full:
              |
              v
        [Haiku Checkpoint: cli-checkpoint.ts]
              |
              +-- Read batch L5 exchanges
              +-- Read previous L3 rolling summary
              +-- Read all P-titles (list_projects)
              |
              +-- Write L3 rolling summary
              +-- Title L4 exchanges
              +-- Write L/D/E/R/C/... entries (linked to L3)
              +-- Check project assignment -> move_nodes if wrong
              +-- Tag exchanges (#skill-dialog, #irrelevant, ...)
              +-- Title L2 session (if generic)

  [SessionStart Hook: cli-init.ts]
        |
        +-- Last session has summary?
              No -> spawn async: Haiku summarizes session (L2 body)
```

## 8. Affected Files

| File | Changes |
|------|---------|
| `src/hmem-store.ts` | New: `resolveProjectO()`, `resolveSession()`, `resolveBatch()`. Rewrite: `appendExchange()`. Remove: `getActiveO()`, `getActiveOId()`. Update: `getOEntryExchanges()`, `appendCheckpointSummary()` (-> L3 update), dual-format read support |
| `src/cli-log-exchange.ts` | Rewrite exchange flow: 5-step pipeline instead of flat append. Temp file session tracking. |
| `src/cli-checkpoint.ts` | Batch-based checkpoint. New prompt with P-titles, rolling summary context. `list_projects` tool call. Exchange tagging. |
| `src/cli-init.ts` | Session summary check + async Haiku spawn on start |
| `src/mcp-server.ts` | New tools: `list_projects`, `move_nodes`. Enhanced `load_project` with O-context. Updated `read_memory` rendering for 5-level O hierarchy. |
| `src/cli.ts` | New CLI commands: `migrate-o-entries`, `summarize-session` |
| `src/cli-statusline.ts` | Update exchange counting (L4 children of L3 batch, not L2 children of root) |
