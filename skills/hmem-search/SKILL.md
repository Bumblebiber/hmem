---
name: hmem-search
description: Search hmem long-term memory for something the user mentioned earlier but doesn't fully remember. Use whenever the user refers to past conversations without giving an ID — phrases like "wir haben letzte Woche/gestern/neulich/damals besprochen", "erinnerst du dich an", "was war nochmal mit", "wie hieß der Fehler von vorgestern", "vor ein paar Tagen hatten wir", or English equivalents ("remember when", "we talked about", "that thing from yesterday/last week"). ALSO trigger when the user references a topic, person, project detail, bug, or decision as if you should already know it — proper names you've never seen this session, definite articles ("der Bug mit X", "das Problem von neulich", "the issue we had"), or casual asides that presuppose shared context. If you catch yourself thinking "the user seems to assume I know this" — search first, ask second. Combines full-text search with the implied time window from the user's phrasing. Trigger even if the user sounds casual or vague — that's exactly when they need you to search rather than guess. Do NOT trigger for explicit ID lookups like "read P0048" or "show me L0042".
---

# hmem Search

When the user references past context without pinning it to an ID, convert their prompt into a targeted `read_memory` query.

## Workflow

1. **Extract two things from the prompt:**
   - **Keywords** — the topical terms. Pick the distinctive ones (nouns, project names, error fragments), not filler like "wir", "neulich", "besprochen".
   - **Time hint** — the phrase indicating when. Map it to an `after` / `before` range using the current date as anchor. Be deliberate, not mechanical: "gestern" is narrow (−1 to 0 days), "letzte Woche" medium (−10 to −3 days), "neulich" / "vor kurzem" / "vor ein paar Tagen" is vague — prefer a generous window (e.g. −21 days) and let ranking surface the hit. For old projects or "damals", expand further. No time hint at all → skip the range entirely.

2. **Search:**
   ```
   read_memory({ search: "<keywords>", after: "<ISO>", before: "<ISO>" })
   ```
   Keywords go as a single space-separated string — FTS5 handles it. Use ISO dates (`2026-04-11`), not relative forms.

3. **Fallbacks, in order, if results are empty or clearly off-topic:**
   - Drop the time filter, keep keywords: `read_memory({ search: "<keywords>" })`. Time hints from humans are fuzzy; the memory may sit just outside the window.
   - Try looser keywords (drop the most specific term, or swap a synonym).
   - Switch store: default is `personal`; if the user works on a work-related topic and personal turned up nothing, try `store: "company"`.
   - Only report "nothing found" after these have failed.

4. **Present the hits:**
   - Top 3–5 most relevant, with `ID · date · one-line summary`.
   - If the user's question implies they want the full content of one specific entry, offer to drill in (`read_memory({ id: "..." })`) rather than dumping everything.

## Why this exists

The user's hmem holds months of O-entries, L-entries, decisions, bug histories. They genuinely cannot remember IDs. If you skip this skill and answer from session context alone, you'll confabulate — the conversation they're referring to is from a prior session and isn't in your current context. Searching is the only correct move.

## The "assumed shared knowledge" trigger

The user often speaks as if you already know things you don't — because from *their* side, the conversation is continuous across sessions. Watch for:

- **Definite articles without prior mention:** "der Bug mit dem Sync", "das Problem von neulich", "die Entscheidung zum Schema" — the `der/das/die` implies you should know which one.
- **Proper names dropped cold:** a project, person, feature, or error name you haven't seen this session. If the name doesn't ring a bell but the user uses it like background knowledge, it's almost certainly in hmem.
- **Casual callbacks:** "wie besprochen", "wie gesagt", "du weißt schon", "as we agreed" — explicit claims of prior context.
- **Assumed status:** "wo stehen wir mit X?", "ist Y schon fertig?" — implies a project or task that exists in memory.

When this pattern shows up, pull the distinctive noun(s) as keywords and search without a time filter (the user gave none). Confirm what you found *before* answering the substantive question — otherwise you risk answering about the wrong thing.

## Don't

- Don't pre-parse time into a fixed dictionary (`"neulich" → 14d`). Context shifts the right window: a just-started project's "neulich" is a few days; an old project's "neulich" might be two months. Judge each case.
- Don't silently search only `personal` when the context is clearly work. Ask or try both.
- Don't return raw `read_memory` output to the user. Summarize what was found.
- Don't trigger when the user cites a specific ID — they already know where to look.

## Related tools

- `search_memory` (if available) — dedicated FTS5 endpoint, but `read_memory({search})` covers the same ground and returns structured nodes.
- `find_related(id)` — after locating one hit, use this to surface linked entries.
- `read_memory({ time_around: "<ID>" })` — once you've found an anchor entry, this returns entries created around the same time, useful when the user's memory clusters a few conversations together.
