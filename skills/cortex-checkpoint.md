---
name: cortex-checkpoint
description: Save last 5 exchanges verbatim to O-Entry, extract learnings as L-Entries, write summary. Run every 5 exchanges or on /checkpoint.
---

# cortex-checkpoint

## TRIGGER

Definition: one exchange = one USER message followed by one AGENT response.

Run this skill when:
- The current session has accumulated 5 or more USER+AGENT pairs since the session started or since /checkpoint was last run
- User types /checkpoint

## STEP 1: Save verbatim (ALWAYS FIRST)

The O-Entry ID matches the active project: P0056 → O0056 (replace last 4 digits to match). The P-Entry ID is the active project ID (e.g., P0056). Both are visible in the load_project output.

Call append_memory with the exact last 5 exchanges, no paraphrasing:

append_memory(
  id: "<active O-Entry ID>",
  content: "USER: <exact message>\nAGENT: <exact response>\n\nUSER: ..."
)

Write EVERY exchange verbatim. Never summarize in this step.

## STEP 2: Write summary node

Call append_memory to add a summary node directly after:

append_memory(
  id: "<active O-Entry ID>",
  content: "Summary YYYY-MM-DD\n\n- <what was decided>\n- <what was done>\n- <what changed>\n- <next step>"
)

Keep bullets factual. Max 5 bullets. No opinions. Replace YYYY-MM-DD with today's date (e.g., 2026-04-24).

## STEP 3: Extract learnings

Scan the exchanges for:
- Explicit decisions ("we decided X", "we use X instead of Y")
- Bugs found and their root cause
- Patterns reusable in other projects
- Architecture insights

For EACH learning found, call write_memory:

write_memory(
  title: "<one-line title of the learning>",
  body: "<what was learned. Why it matters. When to apply it.>",
  tags: ["#cortex"],
  links: ["<active P-Entry ID>"]
)

Note the ID returned by each write_memory call (e.g., L0123). Collect all IDs for the OUTPUT block.

If no clear learnings exist: skip this step entirely.

## OUTPUT

Always end with exactly this block:

[CHECKPOINT]
Saved: 5 exchanges to O-Entry
Summary:
- <bullet 1>
- <bullet 2>
- <bullet 3>
Learnings: <L0XXX, L0XXX> or "none"
[/CHECKPOINT]
