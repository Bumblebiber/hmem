---
name: hmem-new-error
description: >
  Create a new error/bug entry (E-entry) in hmem. Use this skill whenever:
  the user wants to log a bug, document an error, file a bug report, track a
  problem ("Bug loggen", "Fehler eintragen", "E-Entry anlegen", "log this error",
  "track this bug", "document this problem", "in hmem festhalten als Fehler");
  OR you are about to call write_memory with prefix="E"; OR a bug or unexpected
  behavior has been found and should be persisted in long-term memory.
  Never write E-entries manually without this skill — the format is strict and
  the auto-scaffold handles structure automatically.
---

# /hmem-new-error — New Error Entry

E-entries use a fixed 6-section schema (Analysis → Possible fixes → Fixing attempts → Solution → Cause → Key Learnings). The server **auto-scaffolds** all sections — you only need to provide a title and a flat description.

## The one rule: NO TABS in the description

The parser treats every tab-indented line as a structural node. Tabs in the description accidentally create invalid L2 nodes. Write the description as flat text after a blank line:

```
✅ write_memory(
  prefix="E",
  content="Short bug title\n\nFlat description of what went wrong. No tabs here.",
  tags=["#project", "#area", "#open"],
  links=["P00XX"]
)

❌ write_memory(
  prefix="E",
  content="Short bug title\n\nDescription:\n\tStep 1 caused X\n\tStep 2 failed",
  ...
)
```

The ❌ example creates invalid L2 nodes (`Step 1 caused X`, `Step 2 failed`) that fail schema validation.

---

## Step 1: Collect the information

Ask the user (or extract from context):

| Field | Notes |
|-------|-------|
| **Title** | Short, descriptive. Max ~50 chars. Format: `What broke / where` |
| **Description** | What happened, what was observed. Flat text, no tabs. |
| **Tags** | At least `#open` + 2–3 topic tags. |
| **Links** | Which P-entry does this belong to? (`P00XX`) |

---

## Step 2: Write the entry

```
write_memory(
  prefix="E",
  content="<title>\n\n<flat description>",
  tags=["#open", "#tag1", "#tag2"],
  links=["P00XX"]
)
```

The server auto-creates:
- **.1 Analysis** (your description moves here automatically)
- **.2 Possible fixes**
- **.3 Fixing attempts**
- **.4 Solution**
- **.5 Cause**
- **.6 Key Learnings**

The write response shows the created ID (e.g. `E0149`) and a `#open` tag.

---

## Step 3: Fill in what you know

Use `append_memory` to add detail to the sections you can already fill:

```
append_memory(id="E00XX.1", content="Root cause hypothesis: ...")  # Analysis
append_memory(id="E00XX.2", content="Try X first, then Y")        # Possible fixes
```

Leave empty sections alone — Haiku fills them at the next checkpoint, or you fill them as debugging progresses.

---

## Step 4: When solved

```
update_memory(id="E00XX", content="<title> #solved", tags=["#solved", "#tag1", "#tag2"])
append_memory(id="E00XX.4", content="Final fix: ...")    # Solution
append_memory(id="E00XX.5", content="Root cause: ...")   # Cause
append_memory(id="E00XX.6", content="Key learning: ...") # Key Learnings
```

The Key Learnings section auto-creates an L-entry when updated (reaction rule in hmem.config.json).

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Tab-indented body text | Write flat text after the blank line — no tabs |
| Section names as L2 nodes | Don't write `\tAnalysis\n\t\tdetail` — auto-scaffold does this |
| Forgetting `#open` tag | Always include `#open` — it's how bugs are tracked |
| Too long title | Keep title under 50 chars; detail goes in the body |
