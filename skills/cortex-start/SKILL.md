---
name: cortex-start
description: Load project context at session start via load_project. Includes recent O-Entry summaries automatically. Run at the beginning of every Cortex session.
---

# cortex-start

## TRIGGER
Run at the beginning of any session where a Cortex project is active.

## ACTION

Call load_project with the active project ID:

load_project(id: "P00XX")

Replace P00XX with the actual project ID (e.g., P0056).

load_project returns:
- Project brief (Overview, Goals, Architecture)
- Recent O-Entry session summaries
- Relevant rules and lessons

Do NOT call read_memory separately. load_project is the only action.

## OUTPUT

After load_project returns, output exactly:

[CORTEX READY]
Project: <name from load_project>
Context loaded. Ready.
[/CORTEX READY]

Then wait for the user's first message.
