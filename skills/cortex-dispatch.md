---
name: cortex-dispatch
description: Dispatch an isolated sub-agent for a specific task. Sub-agent receives only the task definition, returns only the result in [RESULT]...[/RESULT] format.
---

# cortex-dispatch

## TRIGGER
Use when a task can be fully isolated:
- A calculation or lookup
- Writing a specific section or document
- Any task where the conversation history is NOT needed

Do NOT dispatch for tasks that require knowing the conversation context.

## STEP 1: Define the task

Write out before dispatching:
- INPUT: exactly what the sub-agent needs — no more, no less
- TASK: what to do with the input
- OUTPUT FORMAT: what to return

## STEP 2: Dispatch

Send the sub-agent ONLY this prompt — no conversation history, no project context unless the task explicitly requires it:

---
Task: <TASK>
Input: <INPUT>
Return your answer in exactly this format:
[RESULT]
<answer here>
[/RESULT]
Max 200 words. Use the cortex-subagent skill.
---

## STEP 3: Inject result

Take ONLY the content between [RESULT] and [/RESULT].
Discard all sub-agent reasoning and preamble.
Use the result directly in the main conversation.
