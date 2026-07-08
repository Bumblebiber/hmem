---
name: hmem-new-rule
description: "Add a new rule and place it correctly — decide between a cross-project R-entry and a project-specific subnode under the active project's Rules section. Use whenever the user says 'neue Regel', 'Regel hinzufügen', 'new rule', 'add a rule', or invokes /hmem-new-rule. Critical safeguard: project-specific rules placed as R-entries pollute the session-start Rules listing across every project — get the scope right BEFORE writing."
---

# /hmem-new-rule — Place a Rule in the Right Place

R-prefix entries are surfaced in the session-start Rules listing for every session. A project-specific rule written as an R-entry leaks into other projects' context. A cross-project rule buried inside one project never surfaces when working on another. Same content, very different consequence — scope decides.

## Step 1: Determine scope BEFORE writing

Ask the user, unless they already said:
> "Gilt die Regel projektübergreifend (alle Projekte) oder nur für das aktive Projekt?"

Suggest a default from these heuristics:

| Signal | Likely scope |
|--------|-------------|
| Rule names a specific repo path, file, CLI tool, schema field, project's tech stack | **Project-specific** |
| Rule mentions hmem code, propagation to end users, project structure | **Project-specific** (P0048-specific) |
| Rule is about agent behavior, communication style, write protocols, MCP interaction | **Cross-project (R)** |
| Rule references infrastructure used in many projects (e.g. Strato server, npm publish in general) | **Cross-project (R)** |
| Rule applies only when one specific project is active | **Project-specific** |

When in doubt, ask. Wrong scope is the most common failure mode of this workflow.

## Step 2A: Cross-project rule → R-entry

```
write_memory(
  prefix="R",
  title="<short imperative title>",
  body="<full rule text — what / why / examples / counter-examples>",
  tags=["#hmem", "#<topic-tag>"],
  links=["<active-project-id-if-relevant>"],
  pinned=<true only if it MUST surface in session-start every session>
)
```

- `links` may include a project ID for context, but the rule still applies broadly.
- `pinned=true` only when the rule belongs in the always-visible Rules block at session start (after the v6.x hook trim, only pinned/favorite R-entries surface). Use sparingly — pinning everything defeats the purpose.

## Step 2B: Project-specific rule → subnode under Rules

First check whether the active project has a Rules section:

```
read_memory(id="P00XX")     # look for an L2 child titled "Rules"
```

**If a Rules L2 exists** (e.g. `P0048.16`):

```
append_memory(
  id="P0048.16",
  title="<short imperative title>",
  body="<full rule text>"
)
```

**If no Rules L2 exists**, create it with the rule as its first child by leveraging the schema-name exception (root append is allowed when the first line names a section):

```
append_memory(
  id="P00XX",
  content="Rules\n\t<short imperative title>\n\n\t<full rule text>"
)
```

Project-specific rules need no tags or links (project-scoped by location) and should never be pinned (visibility is already scoped via the active project).

## Step 3: Verify

```
read_memory(id="<the-new-id>")
```

Confirm title + body are stored correctly. If anything looks off, fix with `update_memory` immediately.

## Anti-patterns

| Mistake | Why it hurts |
|---------|-------------|
| Writing R-prefix for a one-project rule | Leaks into every other project's session-start Rules block |
| Writing P00XX.Rules.X for a workflow rule that applies to all projects | Invisible whenever a different project is active |
| Pinning a project-specific rule | Already scoped by project; pinning forces it cross-project anyway |
| Setting `obsolete=true` without `[✓ID]` | Blocked by write protocol — write the correction first |
| Skipping the scope question because "it's obvious" | The previous offender did this and wrote R0028 for a P0048-only rule |

## Related

- `/hmem-write` — lower-level write_memory / append_memory protocol, prefix selection, tag conventions
- `/hmem-curate` — fix misplaced rules afterwards (mark irrelevant + move content)
