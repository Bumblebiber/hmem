---
name: hmem-context
description: Load specific context from hmem based on what is needed RIGHT NOW. Use when load_project output is not enough for the current question.
---

# hmem-context

## TRIGGER
Use when:
- The current question requires a past decision not in the project brief
- You need to recall a specific bug, pattern, or lesson
- You need code details not in the Overview

Do NOT use for session start — use hmem-session-start instead.

## STEP 1: Identify what type of information is needed

Pick ONE:
- Past decision → use search_memory with keywords from that decision
- Lesson or pattern → use find_related on the concept
- Code details → use read_memory on P00XX.2 (Codebase section)

## STEP 2: Run the search (pick ONE)

For keyword search:
search_memory(query: "<specific keywords>")

For semantic search:
find_related(id: "P00XX", query: "<concept>")

For direct node:
read_memory(id: "P00XX.2")

Replace P00XX with the active project ID (e.g., P0056).

## STEP 3: Filter results

Select at most 3 nodes that directly answer the question.
- Prefer L-Entries over O-Entries (more compact, already distilled)
- Prefer entries with matching keywords in title
- Discard everything else

## STEP 4: Output

[CONTEXT LOADED]
<title of node 1>: <body of node 1>
---
<title of node 2>: <body of node 2>
[/CONTEXT LOADED]

If nothing relevant found:

[CONTEXT LOADED]
No relevant context found for: <your query>
[/CONTEXT LOADED]
