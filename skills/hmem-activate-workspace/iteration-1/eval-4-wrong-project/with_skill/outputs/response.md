# hmem-activate Skill Response
## Scenario: Wrong Project Active (P0054 instead of P0048)

### STEP 1: Identify Currently Active Project

**User statement:** "wir haben das falsche Projekt aktiviert"
(Translation: "we have the wrong project activated")

**Current state (from tool responses):**
- Active project: P0054 MAIMO-RPG
- Corresponding O-entry: O0054

**Question to resolve:** Which project should actually be active?

#### Decision Point: Ask or Infer?

The user says "das falsche Projekt" (the wrong project), implying they know which one is correct, but they don't explicitly state it. However, context from CLAUDE.md indicates:

- User is Ben (Bumblebiber), working on multiple projects
- hmem (P0048) is mentioned as the working project in the skill scenario
- The user likely knows their current work context

**Approach:** 
1. **First attempt:** Infer from context. The scenario context explicitly states "The user is working on hmem (P0048)". Use this.
2. **If context unclear:** Ask the user "Which project should be active instead? (e.g., P0048 for hmem?)"

**Inferred target:** P0048 (hmem) — matches scenario context
- OLD_PROJECT: P0054 (MAIMO-RPG)
- OLD_O: O0054
- TARGET_PROJECT: P0048 (hmem)
- TARGET_O: O0048

---

### STEP 2: Activate Target Project

```
[SIMULATED CALL]
load_project(id: "P0048")

Response:
✓ Project loaded: P0048 hmem
  Overview: hmem — Hierarchical Memory System
  Active project now: P0048 hmem
```

**Result:** P0048 is now the active project, pointing to O0048 for session exchanges.

---

### STEP 3: Check for Misrouted Exchanges

Since we switched from P0054 → P0048 mid-session, we need to check if any exchanges logged to O0054 actually belong to P0048.

#### Read Old O-entry for Today

```
[SIMULATED CALL]
read_memory(id: "O0054")

Response:
O0054 — Session log for MAIMO-RPG (P0054)
├─ O0054.1 (Session: 2026-04-25 08:30)
│  └ Exchange: "User asked about MAIMO combat mechanics"
│  └ Timestamp: 2026-04-25 08:30:15
│  └ Content: Discussion of RPG attack roll system, character stats
│
├─ O0054.2 (Session: 2026-04-25 09:15)
│  └ Exchange: "User switched context to hmem"
│  └ Timestamp: 2026-04-25 09:15:42
│  └ Content: "How do I activate the right project?" — P0048 questions
│           : "O-entry routing was confusing" — hmem system discussion
│           : "Let me check the memory..." — testing memory navigation
│
├─ O0054.3 (Session: 2026-04-25 10:02)
│  └ Exchange: "Checking project activation flow"
│  └ Timestamp: 2026-04-25 10:02:18
│  └ Content: "What happens to routing when I switch mid-session?"
│           : Discussion of move_nodes, O-entry structure
│           : References to P0048 context, not P0054
```

#### Analyze for Misrouting

Exchanges to evaluate:
- **O0054.1**: "MAIMO combat mechanics" → **Belongs to P0054** ✓ (Correct routing, keep in place)
- **O0054.2**: "User switched context to hmem", "P0048 questions", "hmem system" → **Belongs to P0048** ✗ (Misrouted)
- **O0054.3**: "project activation flow", "P0048 context", "move_nodes" → **Belongs to P0048** ✗ (Misrouted)

**Misrouted exchanges identified:** O0054.2 and O0054.3 (should be in O0048, not O0054)

#### Move Misrouted Exchanges

Move at the batch/session level (not individual exchanges):

```
[SIMULATED CALL]
move_nodes(node_ids: ["O0054.2", "O0054.3"], target_o_id: "O0048")

Response:
✓ Moved 2 session nodes:
  - O0054.2 → O0048.12 (renumbered in target parent)
  - O0054.3 → O0048.13 (renumbered in target parent)
  
O0054 now contains: O0054.1 (MAIMO-RPG only)
O0048 now contains: O0048.1...O0048.11 [previous] + O0048.12 [moved from O0054.2] + O0048.13 [moved from O0054.3]
```

---

### STEP 4: Confirm

```
Activated: P0048 hmem
O-entry routing: O0048
Misrouted exchanges moved: 2 (O0054.2 and O0054.3)

Summary:
- Switched from P0054 (MAIMO-RPG) to P0048 (hmem)
- Found 2 session batches logged to wrong O-entry (O0054)
- Moved both batches to correct O-entry (O0048)
- O0054 now contains only authentic MAIMO-RPG discussions
- O0048 now contains all hmem work including recent switches
```

---

## Key Decisions Made by the Skill

### 1. **Identifying Target Project: Infer vs. Ask**
   - **Decision:** Infer from scenario context (user statement + CLAUDE.md context)
   - **Logic:** "das falsche Projekt" (the wrong project) + scenario says "working on hmem" = infer P0048
   - **Fallback:** If context were ambiguous, ask: "Which project should be active instead?"
   - **Implementation:** Check CLAUDE.md for active project hints, recent work, or ask if still ambiguous

### 2. **Detecting Misrouted Exchanges**
   - **Criterion:** Read OLD_O for today's exchanges and check if content discusses TARGET_PROJECT topics, not OLD_PROJECT
   - **Timestamp check:** Only flag exchanges created today (same session)
   - **Context matching:** Look for explicit project references, feature names, or topic switches
   - **O0054.2 example:** "switched context to hmem", "P0048 questions" → clearly belongs to hmem work

### 3. **Handling Ambiguous Exchanges**
   - **If mixed:** Don't move. Log note: "O0054.2 contains both MAIMO and hmem discussions — manual review recommended"
   - **If purely one project:** Move (as shown in step 3)
   - **If generic meta-discussion:** Check majority context; if still ambiguous, ask user

### 4. **Moving Exchanges: Granularity Level**
   - **Move at:** Session level (e.g., O0054.2, O0054.3) not individual exchanges
   - **Reason:** Exchanges are tightly linked within a session batch; splitting breaks context
   - **Tool:** move_nodes with multiple node_ids for efficiency

### 5. **Verifying Fix**
   - Confirm active project changed (load_project output shows new active)
   - Confirm O-entry routing changed (OLD_O has fewer nodes, TARGET_O has more)
   - Confirm moved exchanges are accessible in target (can read O0048.12, O0048.13)

---

## Edge Cases Handled

| Scenario | Handling |
|----------|----------|
| User doesn't specify target project | Ask: "Which project should be active?" |
| No misrouted exchanges found | Report: "Misrouted exchanges moved: none" |
| All exchanges genuinely belong to old project | Keep them; don't move |
| Mixed content (half old, half new project) | Flag for manual review; don't auto-move |
| Switching within same prefix (P0048→P0049) | Same process; move misrouted O-entries |
| Ambiguous project context in CLAUDE.md | Ask user to clarify before load_project |

---

## Summary

The skill successfully:
1. ✓ Identified wrong project (P0054) vs. correct project (P0048) through context inference
2. ✓ Determined that asking vs. inferring: **inferred** based on scenario + CLAUDE.md hints
3. ✓ Checked O0054 for misrouted exchanges (found 2)
4. ✓ Applied content-based heuristics to classify belonging (topic matching, explicit project refs)
5. ✓ Moved misrouted batches to correct O-entry at session level
6. ✓ Confirmed routing fix with activation summary

The user's work is now properly routed to the correct project, and earlier hmem-focused discussions that were accidentally logged to MAIMO-RPG are restored to their rightful O-entry.
