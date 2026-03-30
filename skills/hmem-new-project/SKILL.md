---
name: hmem-new-project
description: >
  Create a new P-entry following the R0009 standard schema. Asks key questions,
  optionally scans the codebase, and writes a complete project entry with all
  required sections. Use when the user says "neues Projekt", "new project",
  "Projekt anlegen", or "/hmem-new-project".
---

# /hmem-new-project — New Project Entry

Create a complete P-entry following the R0009 standard schema. This skill ensures every project starts with a proper structure.

---

## Step 1: Does a codebase exist?

Ask the user first:

> "Gibt es bereits eine Codebase für dieses Projekt? Wenn ja, in welchem Verzeichnis?"

**If yes (path provided):**
- Scan the directory: read README, CLAUDE.md, package.json/Cargo.toml/setup.py/etc.
- Detect language, framework, dependencies, entry points
- Use this to pre-fill Overview, Codebase, Usage, Deployment sections
- Continue to Step 2 for context the code can't tell us

**If no (new idea / planning phase):**
- Skip codebase scan
- All sections come from the user's answers
- Focus on Overview (.1) and Context (.4) — Codebase (.2) stays minimal

---

## Step 2: Quick questions (one at a time)

Ask these in order. Skip questions already answered by the codebase scan.

1. **Name** — "Wie soll das Projekt heißen?" (short name for the L1 title)
2. **Status** — "Status? Active / Paused / Planning / Mature / Archived"
3. **Stack** — "Welche Technologien? (z.B. TS/React, AHK v2, Python/Flask)"
4. **One-liner** — "Beschreib das Projekt in einem Satz"
5. **Goal** — "Was ist das Hauptziel?"
6. **Who/Why** — "Wer nutzt es und warum?" (target audience + motivation)
7. **GitHub/Repo** — "Gibt es ein Repo? (URL oder 'nein')"
8. **Deployment** — "Wie wird es deployed? (npm, exe, server, manual, noch nicht)"

Stop asking if the user says "reicht" or "das war's" — fill remaining sections from context or leave them minimal.

---

## Step 3: Build the P-entry

Construct the entry following R0009 schema strictly:

```
Name | Status | Stack | One-liner
> Goal and context in 1-2 sentences
\tOverview
\t\tCurrent state: ...
\t\tGoals: ...
\t\tArchitecture: ... (from codebase scan or user description)
\tCodebase
\t\tEntry point: ... (from scan)
\t\t... (key files/modules)
\tUsage
\t\tInstallation: ...
\t\tCLI/API: ...
\tContext
\t\tInitiator: User, date
\t\tTarget audience: ...
\t\tBusiness context: ...
\tDeployment
\t\t... (from scan or user answer)
\tBugs
\tProtocol
\tOpen tasks
\tIdeas
```

**Rules:**
- L1 format: `Name | Status | Stack | Description` (mandatory)
- L1 body (>): 1-2 sentence project summary
- All 9 sections must be present (.1 Overview through .9 Ideas)
- Empty sections get a placeholder child: e.g. `\t\tNone yet`
- If codebase was scanned: .2 Codebase lists key files with descriptions
- .7 Protocol starts empty (O-entries will fill it automatically)
- Tags: at least `#project` + language/framework tags

---

## Step 4: Write and activate

```
write_memory(prefix="P", content="...", tags=["#project", "#typescript", ...])
```

Then activate it:
```
update_memory(id="P00XX", active=true)
```

Show the user the created entry:
```
read_memory(id="P00XX", depth=2)
```

---

## Step 5: Link related entries

Check if there are existing L/D/E/T entries that should be linked:
```
read_memory(search="project name or keywords")
```

If found, add links:
```
update_memory(id="P00XX", links=["T0044", "L0095"])
```

---

## Codebase scan details

When scanning a codebase directory, read in this order:
1. `CLAUDE.md` or `AGENTS.md` — richest project context
2. `README.md` — overview, installation, usage
3. `package.json` / `Cargo.toml` / `setup.py` / `go.mod` — name, version, deps, scripts
4. `.github/workflows/` — CI/CD setup
5. `src/` or main source directory — entry points, key modules
6. `docs/` — any existing specs or designs

Extract:
- Project name and version
- Language and framework
- Entry point(s)
- Key modules/files (max 10-15)
- Build/run commands
- Test commands
- Dependencies (major ones only)

Do NOT read every file — scan directory structure and read key files only.

---

## Example output

```
EasySAP | Active | AHK v2/SAP GUI Scripting | SAP Freigabeprozess Automatisierung
> Automatisiert Status-Übergänge, PDF-Prüfungen, Spezifikations-Verknüpfung und FPR-Erstellung via SAP GUI COM Scripting.
  .1 Overview
    .1.1 Current state: Production, läuft auf Server-VM mit 3 SAP-Sessions
    .1.2 Goals: Vollautomatischer Freigabeprozess ohne manuelle SAP-Interaktion
    .1.3 Architecture: Client/Server via Shared Network Drive (U:\ESAP\)
  .2 Codebase
    .2.1 Easy-SAP_Server.ahk — Haupt-Automations-Engine (Polling-Loop, SAP-Sessions, Status-Pipeline)
    .2.2 Easy-SAP_Client.ahk — Lightweight Client (Hotkeys, Task-Erstellung)
    .2.3 EasySAP_Shared.ahk — Shared Functions (Logging, Session-Management, Email)
  .3 Usage
    .3.1 Server: AutoHotkey64.exe Easy-SAP_Server.ahk
    .3.2 Client: Alt+F (neue Aufgabe), Alt+X (beenden)
  ...
```
