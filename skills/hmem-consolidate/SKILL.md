---
name: hmem-consolidate
description: Merge all session checkpoint summaries into one final O-Entry summary. Run at end of sessions with 2 or more checkpoints.
---

# hmem-consolidate

## TRIGGER
Run when:
- The session is ending AND hmem-checkpoint ran 2 or more times
- User types /consolidate

Do NOT run if there was only one checkpoint — that summary is already final.

## STEP 1: Read the O-Entry

Call read_memory on the active O-Entry:

read_memory(id: "O00XX", depth: 2)

Replace O00XX with the active O-Entry ID (P0056 → O0056).

Identify all child nodes with titles starting with "Summary YYYY-MM-DD". Collect their content.

## STEP 2: Write merged summary

From all collected summaries, write ONE final summary with max 10 bullets:
- Each bullet names a specific decision, file, command, or outcome
- Never write "discussed X" or "made progress on Y"
- Cover: main topic, decisions made, what changed, next step

## STEP 3: Append to O-Entry

append_memory(
  id: "O00XX",
  content: "Final Summary <today's date e.g. 2026-04-24>\n\n- <bullet 1>\n- <bullet 2>\n...\n- <bullet N>"
)

Do NOT delete or overwrite the individual checkpoint summaries.

## OUTPUT

[CONSOLIDATED]
Final summary written to O-Entry O00XX.
- <bullet 1>
- <bullet 2>
...
[/CONSOLIDATED]
