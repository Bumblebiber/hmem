# Simulated Response: Wrong Project Activated

## User Input
"wir haben das falsche Projekt aktiviert" (we activated the wrong project)

## Context
- **Currently active:** P0054 (MAIMO-RPG)
- **Should be active:** P0048 (hmem)

## Correct Response Flow

### 1. Acknowledge the Issue
The agent should recognize that the user is correct — the wrong project (P0054/MAIMO-RPG) is currently active when they need P0048 (hmem).

### 2. Take Corrective Action
Call `load_project(id="P0048")` to:
- Switch from MAIMO-RPG to hmem
- Retrieve the full project briefing (Overview, Codebase, Usage, Context, etc.)
- Mark P0048 as the new active project
- Deactivate P0054

### 3. Confirm and Brief
Respond with:
- Confirmation that the switch was successful
- Summary of P0048 context (Codebase, current tasks, recent work)
- Ready to assist with hmem-related work

## Implementation Details

**What NOT to do:**
- Do not ignore the user's feedback
- Do not continue working with P0054
- Do not require additional user input to confirm the switch

**What to do:**
- Immediately load P0048 with `load_project(id="P0048")`
- Provide full project context from the P-entry briefing
- Offer to help with the now-active hmem project

## Expected Outcome
- P0048 (hmem) is now the active project
- User has full context and can continue work on the correct project
- System is ready to assist with hmem-specific tasks
