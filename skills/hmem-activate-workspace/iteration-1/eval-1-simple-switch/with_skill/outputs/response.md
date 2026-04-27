# hmem-activate Skill Simulation: Aktiviere Projekt hmem

## Task Context
- User request: "aktiviere projekt hmem"
- Current active project: P0043 (EasySAP)
- Target project: P0048 (hmem)
- Skill file read: `/home/bbbee/projects/hmem/skills/hmem-activate/SKILL.md`

---

## STEP 1: Note the currently active project

Before calling `load_project()`, I note from the task context:

- **OLD_PROJECT**: P0043 (EasySAP)
- **OLD_O**: O0043 (corresponding O-entry for EasySAP session logging)
- **TARGET_PROJECT**: P0048 (hmem)
- **TARGET_O**: O0048 (corresponding O-entry for hmem session logging)

**Status**: OLD_PROJECT ≠ TARGET_PROJECT → Project switch detected. Will need to check for misrouted exchanges.

---

## STEP 2: Activate the target project

I would call:
```
load_project(id: "P0048")
```

**Simulation**: This MCP tool call would:
- Load the full P0048 entry (hmem project)
- Return L1 title + all L2 sections (Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas)
- Return L3 subsection titles under each L2
- Mark P0048 as `[*] active` in the session state
- Return response: `Active project: P0048 hmem`

**Expected output structure**:
```
Active project: P0048 hmem

P0048: hmem
[Project briefing with ~700 tokens of content across 9 L2 sections]
```

---

## STEP 3: Check for misrouted exchanges

**Decision point**: Has the user conducted any work on hmem (P0048 topics) while EasySAP (P0043) was the active project?

**What I would do**:

1. Call `read_memory(id: "O0043")` to fetch today's session and batch nodes from the EasySAP O-entry
2. Examine the timestamps on all O0043 child nodes (O0043.1, O0043.2, etc.) to identify exchanges created today (2026-04-25)
3. For each today-dated exchange, check the **content** to determine project context:
   - If the exchange discusses O0043/EasySAP topics → belongs in O0043, **keep it**
   - If the exchange discusses O0048/hmem topics → misrouted, **mark for move**

**Simulation of check logic**:

```
read_memory(id: "O0043")
```

**Result interpretation**:
- If O0043 has no children dated today → Output: `Misrouted exchanges moved: none`
- If O0043 has today-exchanges but all discuss EasySAP → Output: `Misrouted exchanges moved: none`
- If O0043 has today-exchanges that discuss hmem topics → They are misrouted
  - Identify the batch or session node IDs (e.g., O0043.3, O0043.3.1)
  - Call: `move_nodes(node_ids: ["O0043.3"], target_o_id: "O0048")`
  - Output: `Misrouted exchanges moved: 1` (or count of moved batches)

**In this simulation**: 
Without actually calling `read_memory(id: "O0043")`, I assume:
- The user has NOT been working on hmem topics while P0043 was active
- Or any exchanges that exist were legitimately about EasySAP
- Therefore: **No misrouted exchanges found**

---

## STEP 4: Confirm

**Final output that would be displayed to user**:

```
Activated: P0048 hmem
O-entry routing: O0048
Misrouted exchanges moved: none
```

---

## Summary of Simulation

### What the skill does:
1. **Identifies the project switch**: P0043 (EasySAP) → P0048 (hmem)
2. **Loads target project context**: Activates P0048 and returns full briefing (~700 tokens)
3. **Checks for routing errors**: Examines O0043 for today's exchanges to see if any belong to O0048
4. **Corrects misrouted data**: Uses `move_nodes()` to relocate misrouted session/batch nodes if found
5. **Confirms success**: Reports final state and count of corrections

### MCP tools that would be invoked (in order):
1. `load_project(id: "P0048")` — Activate hmem
2. `read_memory(id: "O0043")` — Check for misrouted exchanges
3. `move_nodes(...)` — If misrouted exchanges found (hypothetical, not executed in simulation)

### Key insight:
The skill ensures that **session context stays with the correct project O-entry**. When you switch projects mid-session, any notes/exchanges logged before the switch would be in the OLD_O entry. This skill detects and fixes that routing automatically.

---

## Note on This Simulation

**No MCP tools were actually invoked.** The simulation shows:
- What I would check and note (OLD_PROJECT, OLD_O, TARGET_PROJECT, TARGET_O)
- What MCP calls would be made and in what order
- How I would interpret the responses
- What the final user-facing output would be

If the skill were actually executed, the `read_memory(id: "O0043")` call would return real content, and I would examine today's timestamps to determine if any moves are needed.
