---
name: o9k-new-project
description: >
  Create a new project (P-entry) in hmem. Use this skill whenever: the user
  asks to create/add/set up a new project in hmem ("neues Projekt", "new project",
  "Projekt anlegen", "add project", "P-Entry erstellen", "in hmem aufnehmen",
  "track this project", "create an entry for"); OR you are about to call
  write_memory with prefix="P"; OR any agent is told to register or document
  a project in memory. Never create P-entries manually — this skill handles
  schema enforcement, section setup, and O-entry linking automatically.
  Uses the create_project MCP tool.
---

# /o9k-new-project — New Project Entry

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
- **P00XX** with sections from the configured schema (or 9 R0009 defaults if no schema)
- **O00XX** matching O-entry for session logging (if `createLinkedO: true` in schema, or always when no schema)

## Step 4: Fill in details

If a codebase was scanned, append the findings. The Codebase node (`.2`) follows a strict schema:

### Codebase node structure

- **L3 — Pipeline** (first child): Data flow overview — `entry → moduleA → moduleB → storage`
- **L3 — Modules**: One node per source file. Title = filename, body = purpose + `src/file.ts`
- **L4 — Functions**: Under each module, one node per exported function/class. Title = full TypeScript signature, body = one-line description + `src/file.ts`

```
append_memory(id="P00XX.2", title="Pipeline", body="src/cli.ts → moduleA.ts → DB")
append_memory(id="P00XX.2", title="moduleA.ts", body="Core logic handler. src/moduleA.ts")
append_memory(id="P00XX.2.N", title="doThing(x: string): Promise<boolean>", body="Does the thing. src/moduleA.ts")
```

**L4 is critical.** Without function signatures, every agent must read source files for every task. Fill L4 for all exported functions when creating a new project — dispatch a subagent to extract them if the codebase is large.

- **L5 — Extended Notes** (optional, use selectively): Add under an L4 node only when it adds real value:
  - Usage example: `write("P", { content: "Title\n\nBody", tags: ["#foo"] })`
  - Important caveats: "triggers sync push", "returns null if not found — never throws"
  - Parameter details: field list for complex option types like `ReadOptions`

  Not every function needs L5 — only where the signature alone leaves agents guessing.

```
append_memory(id="P00XX.3", content="Installation: npm install\n\n...")
```

## Step 5: Link related entries

Search for existing entries that relate to this project and add links:

```
read_memory(search="project keywords")
update_memory(id="P00XX", content="...", links=["T0044", "L0095"])
```

Then show the result: `load_project(id="P00XX")`
