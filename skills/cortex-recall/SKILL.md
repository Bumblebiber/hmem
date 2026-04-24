---
name: cortex-recall
description: Dispatch a Haiku sub-agent to search hmem for relevant memories. Sub-agent returns matching entries as ID + one-line summary. Main agent context stays clean.
---

# cortex-recall

## TRIGGER
Use when:
- You need to find past decisions, lessons, or session context from hmem
- You don't know the exact node ID
- You want to keep the search work out of the main context

## STEP 1: Define the search query

Before dispatching, write down:
- QUERY: what to search for (keywords, concept, or question)
- TYPE: what kind of memory (L-Entry = lesson, O-Entry = session, P-Entry = project, any)

## STEP 2: Dispatch Haiku sub-agent

Send the sub-agent exactly this prompt (fill in QUERY and TYPE):

---
Search hmem for: <QUERY>
Memory type filter: <TYPE or "any">

Use these tools in order:
1. search_memory(query: "<QUERY>") — keyword search
2. find_related(id: "<active P-Entry ID>", query: "<QUERY>") — semantic search

Collect all results. Deduplicate by ID.

Return ONLY this format:

[RECALL RESULTS]
<ID> | <one-line summary of what this entry contains>
<ID> | <one-line summary>
...
[/RECALL RESULTS]

If nothing found:
[RECALL RESULTS]
none
[/RECALL RESULTS]

Max 10 results. Most relevant first. IDs exact (e.g., L0042, O0056.3.2, P0048.6).
---

## STEP 3: Use results

The main agent receives the [RECALL RESULTS] block.
To read a specific entry in full: call read_memory(id: "<ID from results>")
To load a project: call load_project(id: "<P-Entry ID from results>")

Do NOT load all results at once — pick only what the current question needs.
