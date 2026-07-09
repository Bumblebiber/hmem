---
name: hmem-search
description: "Search hmem when the user references something without an ID — past conversations ('letzte Woche', 'remember when'), unknown proper names, definite articles assuming shared context ('the bug we had', 'das Schema von gestern'), or asks whether a schema/rule/decision is documented. Search first, ask second. Skip for explicit ID lookups like 'read P0048'."
---

# hmem Search

When the user references past context without pinning it to an ID, or when looking up definitions, schemas, or decisions stored in hmem — convert the intent into a targeted `read_memory` query.

## Workflow

1. **Extract from the prompt:**
   - **Keywords** — distinctive nouns, project names, error fragments, schema names. Skip filler like "wir", "neulich", "besprochen", "Schema für".
   - **Time hint** — map to `after`/`before` range using the current date as anchor. "gestern" → narrow (−1 to 0d), "letzte Woche" → medium (−10 to −3d), "neulich"/"vor kurzem" → generous (−21d). No time hint → skip the range.

2. **First search:**
   ```
   read_memory({ search: "<keywords>", after: "<ISO>", before: "<ISO>" })
   ```
   Keywords as a single space-separated string. Use ISO dates (`2026-04-11`), not relative forms.

3. **If results are empty or off-topic — work through this sequence immediately, without waiting:**

   **a) Drop time filter, keep keywords**
   Time hints from humans are fuzzy; the memory may sit just outside the window.

   **b) Try term variations — systematically, not just once**
   The stored entry may use a different phrasing than what the user said. Try all that apply:
   - German ↔ English: "Schema" → "schema", "Entscheidung" → "decision", "Fehler" → "error"
   - Abbreviations or expansions: "H-Schema" → "H-Entry Schema", "O-Eintrag" → "O-entry"
   - Compound splits: "Standardschema" → "Standard Schema", "Checkpoint-Strategie" → "checkpoint strategy"
   - Synonyms: "Kollision" → "conflict", "Struktur" → "structure", "Vorlage" → "template"
   - Broader category: "H-Standardschema" → "H-entry", "entry schema", "Human schema"
   - Related prefix: if the topic is about a specific entry type (H, P, E, I…), search that prefix directly via `read_memory({ prefix: "R", search: "H" })`

   Don't try one variation and stop. Run 2–3 variations before concluding nothing was found.

   **c) Switch store**
   Default is `personal`. If the topic is work-related and personal turned up nothing, try `store: "company"`.

   **d) Broaden with `find_related`**
   If you found *something* related but not quite right, use `find_related({ id: "<hit-ID>" })` to surface linked entries.

   Only report "nothing found" after all of these have failed.

4. **Present the hits:**
   - Top 3–5 most relevant: `ID · date · one-line summary`.
   - If the question implies drilling into one entry, offer `read_memory({ id: "..." })` rather than dumping everything.

## Why term variation matters

hmem entries are titled by whoever created them, not by a controlled vocabulary. "H-Standardschema" might be stored as "H-Entry Schema: Standard-Struktur für Human-Context-Einträge" (R0025). The search engine does substring/FTS matching, but only within what's actually stored. If the first search misses, the entry almost certainly exists under a different phrasing — not in a different location.

The failure mode to avoid: searching once, getting no results, and concluding the information doesn't exist. **A null result is a signal to try harder, not a final answer.**

## The "assumed shared knowledge" trigger

The user often speaks as if you already know things you don't — because from *their* side, the conversation is continuous across sessions. Watch for:

- **Definite articles without prior mention:** "der Bug mit dem Sync", "das Problem von neulich", "die Entscheidung zum Schema" — the `der/das/die` implies you should know which one.
- **Proper names dropped cold:** a project, person, feature, or error name you haven't seen this session.
- **Casual callbacks:** "wie besprochen", "wie gesagt", "du weißt schon", "as we agreed".
- **Assumed status:** "wo stehen wir mit X?", "ist Y schon fertig?"
- **Schema/rule lookups:** "gibt es ein Standard für X?", "was ist das Schema für Y?", "was haben wir zu Z beschlossen?"

When this pattern shows up: search first, answer second.

## Don't

- Don't pre-parse time into a fixed dictionary (`"neulich" → 14d`). Context shifts the right window.
- Don't silently search only `personal` when the context is clearly work-related.
- Don't return raw `read_memory` output to the user. Summarize what was found.
- Don't trigger when the user cites a specific ID — they already know where to look.
- **Don't stop after a single null result.** Work through the variation sequence before giving up.

## Related tools

- `search_memory` — dedicated FTS5 endpoint; `read_memory({ search })` covers the same ground with structured output.
- `find_related(id)` — after locating a hit, surface linked entries.
- `read_memory({ time_around: "<ID>" })` — once you have an anchor, find entries created around the same time.
- `read_memory({ prefix: "R" })` — scan all Rules when looking for documented standards or constraints.
