---
name: hmem-activate
description: Activate a project mid-session via load_project, then check for and fix misrouted O-entry exchanges. Use whenever the user says "aktiviere Projekt X", "lade Projekt X", "load project X", "wechsel zu Projekt X", or switches project context during a session. ALSO use when you are about to call load_project mid-session for any reason — even if the user didn't explicitly ask to switch projects.
---

# hmem-activate

## TRIGGER
Use when the user switches to a different project mid-session.

## STEP 1: Note the currently active project

Before calling load_project, check which project is currently active. The active project is shown in every tool response as `Active project: PXXXX <name>`.

Note:
- **OLD_PROJECT**: currently active project ID (e.g. P0043) — or `none` if no project was active
- **OLD_O**: corresponding O-entry (same seq: P0043 → O0043) — if OLD_PROJECT = `none`, use **O0000** (catch-all for unattributed sessions)
- **TARGET_PROJECT**: the project the user wants to switch to
- **TARGET_O**: corresponding O-entry (e.g. P0048 → O0048)

## STEP 2: Activate the target project

```
load_project(id: "TARGET_PROJECT")
```

## STEP 3: Check for misrouted exchanges

If OLD_PROJECT ≠ TARGET_PROJECT, exchanges from this session may have been logged to OLD_O instead of TARGET_O.

Check OLD_O for today's exchanges:

```
read_memory(id: "OLD_O")
```

Look for session nodes created today (check timestamps). If you find exchanges that belong to the TARGET project's context — i.e. they discuss TARGET project topics, not OLD_PROJECT topics — they are misrouted.

**To move them:**
```
move_nodes(node_ids: ["OLD_O.X.Y"], target_o_id: "TARGET_O")
```

Move at the batch or session level (e.g. `O0043.3`), not exchange by exchange.

**If OLD_O has no today-exchanges, or all exchanges genuinely belong to OLD_PROJECT:** skip this step.

## STEP 3.5: Noise Check

Scan the load_project output:
- **>4k tokens** → invoke `hmem-curate` first
- **✓ DONE Roadmap items** → `update_memory(id, { irrelevant: true })`
- **Decommissioned / concept entries in Infrastructure** → `update_memory(id, { irrelevant: true })`

Fix immediately, do not defer.

## STEP 3.6: Schema Check

Scan the load_project output for schema mismatches and fix them immediately.

**`[-]` prefix sections** — orphaned nodes outside the current schema (e.g. `P0048.10 [-] Bugs (duplicate)`, `P0048.21 [-] Protocol (stale artifact)`):
```
update_memory(id="P00XX.YY", { irrelevant: true })
```
Mark every `[-]` section irrelevant. Do not skip, do not defer.

**Duplicate L2 sections** — two entries with the same section name (e.g. two `.6 Bugs` nodes) → mark the higher-numbered one irrelevant, keep the canonical one.

**Missing required sections** — auto-reconcile on the next `load_project` will add them automatically. No manual action needed unless you are actively working on that section right now.

## STEP 4: Confirm

Output:

```
Activated: TARGET_PROJECT <name>
O-entry routing: TARGET_O
Misrouted exchanges moved: <count or "none">
```
