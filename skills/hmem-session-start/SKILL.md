---
name: hmem-session-start
description: Load project context at session start via load_project. Includes recent O-Entry summaries automatically. Run at the beginning of every Cortex session.
---

# hmem-session-start

## TRIGGER
Run at the beginning of any session where a Cortex project is active.

## STEP 1: Activate project

Call load_project with the working project ID:

load_project(id: "P00XX")

Replace P00XX with the actual project ID (e.g., P0048).

load_project returns the project brief, recent O-Entry summaries, rules, and lessons.
Do NOT call read_memory separately. load_project is the only activation action.

## STEP 2: O-Entry routing check

**This step is critical.** Every `load_project` call changes which O-entry receives session exchanges. If you called `load_project` on any project other than your working project — even briefly, even for administrative reasons (reconcile, curation, migration) — those exchanges were misrouted to the wrong O-entry.

After activating, check for misrouted exchanges:

```
read_memory(id: "O00XX")   ← the working project's O-entry (same seq as P00XX)
```

Look at the most recent batch. If exchanges are missing that you know happened (e.g. earlier in this session), they landed in another project's O-entry.

**To find them:** check O-entries for any other project you called `load_project` on during this session. Look for nodes created today with content matching your session.

**To fix:**
```
move_nodes(node_ids: ["O00YY.Z"], target_o_id: "O00XX")
```

Move the misrouted session/batch node to the correct O-entry.

**Rule:** Never call `load_project` on a secondary project without immediately re-calling it on your working project. Routing follows the last `load_project` call — always return control explicitly.

## OUTPUT

After both steps, output exactly:

[CORTEX READY]
Project: <name from load_project>
Context loaded. Ready.
[/CORTEX READY]

Then wait for the user's first message.
