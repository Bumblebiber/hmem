---
name: hmem-session-start
description: "Mandatory entry point for every Cortex session — invoke at conversation start, after /clear, and after any load_project call. All stable context (H-entries, projects, device, sync) is pre-injected by the hook — no read_memory(mode='essentials') needed. Surfaces pending git work, Next Steps + open T-tasks, and runs the O-entry routing check."
---

# hmem-session-start

## TRIGGER
Run at the beginning of any session, after /clear, and after any load_project call.

## CONTEXT: Pre-injected by hook

All stable context is PRE-INJECTED by the hmem-startup.sh hook:
- H-entries (H0008 Identität, H0005 Arbeitsstil, H0003 IT-Skills, H0007 Präferenzen, etc.)
- Recent projects (--- Recent projects --- block)
- Device info (--- Active device --- block)
- Sync status (--- hmem-sync --- block)
- Infrastructure favorites (--- Infrastructure --- block)
- Checkpoint status

Do NOT call `read_memory(mode='essentials')` — it's redundant and slow.

## STEP 1: Activate project

**If the user's message names a specific project** (e.g. "lade Projekt hmem", "P0048"): call `load_project(id: "P00XX")`.

**If the user did NOT name a project:** list the 5 entries from the `--- Recent projects ---` block as bullet points, ask which one. Once picked, call `load_project(id: "P00XX")`.

`load_project` returns the project brief, recent O-Entry summaries, rules, lessons. `load_project` is the only activation action — no separate `read_memory`.

## STEP 2: Pending-work check (git repo state)

Sessions resume after days or weeks — pending work rots if nobody surfaces it.

### Find the repo

Look in load_project output for a filesystem path (`.1.4 Environment` / `.2 Codebase`). If no `.git`, skip.

### Run the checks (parallel)

```bash
git status --porcelain
git stash list
git worktree list
git for-each-ref --format='%(refname:short) %(committerdate:relative)' refs/heads/ | grep -v '^main\b\|^master\b'
git branch --no-merged main 2>/dev/null || git branch --no-merged master
```

Cross-reference: branch in `for-each-ref` AND `--no-merged` = real unmerged commits.

### Surface

Only when something is pending. German format:

```
⚠ Offene Arbeit im Repo:
  Worktrees:
    .worktrees/<name> — Branch <branch>, letzter Commit <relative date>
  Stashes:
    stash@{0}: <message> (<relative date>)
  Unmerged Branches:
    <branch> — <N> Commits voraus, letzter Commit <relative date>
  Uncommitted auf <current branch>:
    <file>, <file>, ...

Weiter dran arbeiten oder aufräumen?
```

Never auto-delete/commit/merge.

## STEP 3: Next Steps & offene Tasks

Read the "Next Steps" node from load_project output:

```
read_memory(id: "P00XX.8.YY")   ← Node titled "Next Steps"
```

Compare with T-entries under `Links:`. Report ones NOT in Next Steps.

```
📋 Next Steps:
  • Item 1

📌 Offene Tasks (nicht in Next Steps):
  T0033: ...
```

No interpretation — just display.

## STEP 4: Noise Check

After load_project, scan for:
- **>4k tokens** → invoke `hmem-curate`
- **✓ DONE items** → `update_memory(id, { irrelevant: true })`
- **`[-]` prefix sections** → `update_memory(id, { irrelevant: true })`
- **Duplicate L2 sections** → mark higher-numbered one irrelevant
- **Non-standard L2 sections** → move children, then mark irrelevant

Batch 3+ items: `update_many(ids=[...], irrelevant=true)`. Fix immediately.

## STEP 5: Calibrate explanation depth

H0003 (IT Skills, pre-injected). Scale 1–9:
- **7–9 = Expert**: technical, no padding
- **4–6 = Proficient**: explain concepts, skip fundamentals
- **1–3 = Basics**: explain with examples

## STEP 5b: H-Schema completeness check

H-entries are pre-injected by the hook. Each H-entry appears as a title line (e.g. `H0008  Identität — Name, Anrede, ...`) followed by `•`-prefixed L2 children when they exist.

### Detect empty H-nodes

A pre-injected H-entry is **empty** (stub) when it shows only the title line with NO `•` children below it. Example of an empty entry:

```
H0006  User Kontext: Solo-Entwickler, Gründer, 6 Geräte
```

Example of a filled entry:

```
H0008  Identität — Name, Anrede, Sprachen, Begrüßungen
  • Sprache bevorzugt: Deutsch
  • Anrede: "Benni"
```

### Required slots (must have L2 children)

| Slot | Entry | What to ask if empty |
|---|---|---|
| Identität **(MANDATORY)** | H0008 | Name, preferred language, acceptable greetings, banned greetings |
| Online-ID | H0002 | GitHub username, email |
| IT-Skills | H0003 | Skill areas with 1-9 ratings |
| Business-Skills | H0004 | Skill areas with 1-9 ratings |
| Arbeitsstil | H0005 | Communication style, language preference, pet peeves |
| Lebenskontext | H0006 | Role, devices, company, work hours |
| Präferenzen | H0007 | Likes, dislikes, preferred interaction patterns |

### Procedure

1. Scan the `--- Human context (H-entries) ---` block in the pre-injected context.
2. For each entry in the table above, check if `•`-prefixed L2 children are present.
3. If H0008 is empty: **pause the greeting** — you cannot address the user correctly. Ask all questions in one block:
   - What should I call you? (name / nickname)
   - What language do you prefer? (German / English / other)
   - Which greetings are OK, which should I avoid?
4. For other empty required slots: note them silently and fill them opportunistically during the session when the relevant information comes up naturally. Do NOT interrogate the user about all empty slots at session start — only H0008 blocks the greeting.
5. Save answers immediately with `write_memory(prefix="H", title="...", body="...", pinned=true, ...)`.
6. If every required slot has L2 children: no action needed, proceed to greeting.

## STEP 6: O-Entry routing check

Every `load_project` changes O-entry routing. If you loaded another project during this session, exchanges were misrouted.

Check: `read_memory(id: "O00XX")` — same seq as P00XX. If exchanges are missing, find them in the other project's O-entry and fix:

```
move_nodes(node_ids: ["O00YY.Z"], target_o_id: "O00XX")
```

Rule: Never `load_project` a secondary project without re-calling on your working project.

## OUTPUT — natural greeting

Two-line format:

```
<sync-status-line>
<greeting> <name> — <action>.                                  ← project named
<greeting> <name>. <list-intro>:                               ← no project named
  • Pxxxx — <title>
  ...
```

Values from pre-injected H-entries:
- **Language** — H0005: German native. Match user's first message.
- **Name/greetings** — H0008: preferred name, whitelist/blacklist.
- **Sync status** — from `--- hmem-sync ---` block:
  - `✓ Linked …` → `🟢 hmem-sync verbunden.`
  - `⚠ …` → `🟡 hmem-sync: <status>.`
  - `✗ Not linked` → `🔴 hmem-sync nicht verbunden.`
  - `✗ Not configured` → `🔴 hmem-sync nicht konfiguriert.`

No `[CORTEX READY]` block. Two lines IS the ready signal.
