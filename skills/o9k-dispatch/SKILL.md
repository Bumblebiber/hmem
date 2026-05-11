---
name: o9k-dispatch
description: "Dispatch an isolated sub-agent for a specific task. Sub-agent receives only the task definition, returns only the result in [RESULT]...[/RESULT] format. ALWAYS use for: searching (codebases, files, skills, texts, plans, specs, docs — any 'does X exist?' or 'find Y' question); calculations; writing isolated sections. If the task is 'look something up', 'check if there's a plan', 'search for X', 'find the spec' — dispatch, never search yourself."
---

# o9k-dispatch

## TRIGGER

**Always dispatch for:**
- **Searching** — "does a spec exist?", "find the plan for X", "search the codebase for Y", "check if skill Z covers this", "read the docs for W", "is there already a file that does X?" — any exploration or lookup task
- **Calculation or lookup** — deterministic, context-free
- **Writing an isolated section or document** — no conversation history needed
- **Writing or modifying code** — never write code directly in the main context. Pass the project ID and relevant node IDs (e.g. `.2 Codebase`) in the task so the sub-agent can sync them after completing the work. Always include in the task: `"Invoke superpowers:coding-discipline before writing code."`

**Never dispatch for tasks that require knowing the conversation context.**

The key rule for searching: if you're about to run `grep`, `find`, `read`, or `search_memory` to answer a question — dispatch instead. The sub-agent explores, you synthesize the result.

## STEP 1: Define the task

Write out before dispatching:
- INPUT: exactly what the sub-agent needs — no more, no less
- TASK: what to do with the input
- OUTPUT FORMAT: what to return
- VERIFY (optional): a concrete shell command that proves completion (e.g. `npx tsc --noEmit`, `grep "pattern" file.ts`). Use for tasks that produce code or file changes.

## STEP 2: Dispatch

Send the sub-agent ONLY this prompt — no conversation history, no project context unless the task explicitly requires it:

---
Task: <TASK>
Input: <INPUT>
[If VERIFY set:] After completing the task, run: <VERIFY_CMD>
Return your answer in exactly this format:
[RESULT]
<answer here>
[/RESULT]
[If VERIFY set:]
[VERIFY_RESULT]
pass | fail: <command output or error>
[/VERIFY_RESULT]
Max 200 words. Use the o9k-subagent skill.
---

## STEP 3: Inject result

Take ONLY the content between [RESULT] and [/RESULT].
If [VERIFY_RESULT] is present: check pass/fail. On fail, report the verification error instead of declaring the task complete.
Discard all sub-agent reasoning and preamble.
Use the result directly in the main conversation.
