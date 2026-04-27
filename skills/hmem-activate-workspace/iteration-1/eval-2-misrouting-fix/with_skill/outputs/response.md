# hmem-activate Skill Simulation: Returning to P0048

## Task Context
- **Current state**: P0054 is currently active (user briefly loaded it for research)
- **User intent**: Return to P0048 (the primary working project)
- **Date**: 2026-04-25

## STEP 1: Note the currently active project

Before calling `load_project`, I would check the active project indicator in tool responses.

**Current state from task description:**
- **OLD_PROJECT**: P0054 (currently active)
- **OLD_O**: O0054 (corresponding O-entry for P0054)
- **TARGET_PROJECT**: P0048 (user wants to return to this)
- **TARGET_O**: O0048 (corresponding O-entry for P0048)

## STEP 2: Activate the target project

**MCP call I would make:**
```
load_project(id="P0048")
```

This returns the full P0048 briefing (Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas) and marks P0048 as the active project.

## STEP 3: Check for misrouted exchanges

**Condition check**: P0054 ≠ P0048 ✓ — This means we need to check for misrouted exchanges.

**What I'm looking for:**
- Session nodes in O0054 created today (2026-04-25)
- These exchanges might discuss P0048 topics, not P0054 topics
- Such exchanges would be "misrouted" — logged to the wrong O-entry during the brief project switch

**MCP call I would make:**
```
read_memory(id="O0054")
```

**Expected analysis:**
1. Retrieve O0054 structure (all L2 sessions and their L3 batches and L4 exchanges)
2. Filter for nodes with today's timestamp (2026-04-25)
3. Read each exchange's content to determine if it discusses:
   - **P0054 topics** → belongs in O0054 (legitimate)
   - **P0048 topics** → belongs in O0048 (misrouted, needs moving)

**Example misrouting detection:**
- An exchange titled "hmem cache behavior" under O0054.3.2 that discusses P0048 (hmem project) would be misrouted
- An exchange about "P0054's protocol design" would legitimately belong to O0054

**If misrouted exchanges are found:**

I would collect their node IDs at the batch level (L3) and call:
```
move_nodes(node_ids: ["O0054.3"], target_o_id: "O0048")
```

**Scenario A: No misrouting detected**
- O0054 has no exchanges created today, OR
- All today's exchanges in O0054 legitimately discuss P0054
- **Action**: Skip the move step

**Scenario B: Misrouting detected**
- Example: O0054.3 (session batch created during brief P0054 load) contains exchanges about hmem issues
- **Action**: Move O0054.3 to O0048

## STEP 4: Confirm

**Output I would provide to the user:**

```
Activated: P0048 <hmem project name>
O-entry routing: O0048
Misrouted exchanges moved: [depends on Step 3 analysis]
```

**Concrete examples of confirmations:**

**If no misrouting:**
```
Activated: P0048 hmem — Hierarchical memory system for Claude Code
O-entry routing: O0048
Misrouted exchanges moved: none
```

**If misrouting found (e.g., 1 batch moved):**
```
Activated: P0048 hmem — Hierarchical memory system for Claude Code
O-entry routing: O0048
Misrouted exchanges moved: 1 batch (O0054.3 → O0048)
```

## Key Differences from Without Skill

**Without the skill:** User would manually notice the routing issue or it would go undetected, leaving context scattered across O0054 when it should be in O0048.

**With the skill:** Automatic detection and correction of misrouted exchanges, ensuring all context for this session is consolidated in the correct O-entry (O0048) going forward.
