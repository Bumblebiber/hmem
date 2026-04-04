---
name: hmem-new-project
description: >
  Create a new P-entry with the standard R0009 schema. Use when the user says
  "neues Projekt", "new project", "Projekt anlegen", or "/hmem-new-project".
  Uses the create_project MCP tool which auto-creates P-entry + O-entry.
---

# /hmem-new-project — New Project Entry

Uses the `create_project` tool to set up a complete project with one call.

## Step 1: Does a codebase exist?

Ask:
> "Gibt es bereits eine Codebase? Wenn ja, in welchem Verzeichnis?"

**If yes:** Scan the directory (README, package.json, CLAUDE.md, etc.) to extract
name, tech stack, description, entry points, key modules. Use findings to fill
the create_project parameters and later append Codebase details.

**If no:** All info comes from the user's answers.

## Step 2: Quick questions (one at a time)

Ask these in order. Skip what the codebase scan already answered.

1. **Name** — "Wie soll das Projekt heißen?"
2. **Stack** — "Welche Technologien?"
3. **One-liner** — "Beschreib das Projekt in einem Satz"
4. **Goal** — "Was ist das Hauptziel?"
5. **Who** — "Wer nutzt es?"
6. **Repo** — "Repo-Pfad oder URL?"
7. **Deployment** — "Wie wird es deployed?"

Stop early if the user says "reicht" or "das war's".

## Step 3: Create the project

```
create_project({
  name: "...",
  tech: "...",
  description: "...",
  goal: "...",
  repo: "...",
  audience: "...",
  deployment: "...",
  tags: ["#lang", "#framework"]
})
```

This creates:
- **P00XX** with all 9 R0009 sections (Overview → Ideas)
- **O00XX** matching O-entry for session logging

## Step 4: Fill in details

If a codebase was scanned, append the findings:

```
append_memory(id="P00XX.2", content="Entry point: src/index.ts\n\n...")
append_memory(id="P00XX.3", content="Installation: npm install\n\n...")
```

## Step 5: Link related entries

Search for existing entries that relate to this project and add links:

```
read_memory(search="project keywords")
update_memory(id="P00XX", content="...", links=["T0044", "L0095"])
```

Then show the result: `load_project(id="P00XX")`
