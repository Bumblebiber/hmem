---
name: o9k-session-start
description: "Mandatory entry point for every Cortex session — invoke at conversation start, after /clear, and after any load_project call. All stable context (H-entries, projects, device, sync) is pre-injected by the hook — no read_memory(mode='essentials') needed. Surfaces pending git work, Next Steps + open T-tasks, and runs the O-entry routing check."
---

# o9k-session-start

## TRIGGER
Run at the beginning of any session, after /clear, and after any load_project call.

## CONTEXT: Pre-injected by the hook

On a bound v2 store the SessionStart hook (`hook-session-start`) pre-injects:
- H-entries (H0008 Identität, H0005 Arbeitsstil, H0003 IT-Skills, H0007 Präferenzen, etc.)
- Recent projects (`--- Recent projects ---`), Active device, hmem-sync status
- Pinned/favorite **Rules** (`--- Rules (pinned/favorited) ---`)
- The **active project's full brief** (sections + Next Steps) when a project is bound → STEP 1
- **`📌 Offene Tasks (verknüpft)`** for that project → STEP 3
- **`⚠ Offene Arbeit im Repo`** git pending-work block → STEP 2

Do NOT call `read_memory(mode='essentials')`, and do NOT re-fetch (via `load_project`/`read_memory`/`git`) anything already injected — it's redundant and slow.

## STEP 1: Project — already auto-bound by the hook

The hook **already resolved and bound** the active project (resume → user-named → workspace-cwd) and **injected its full brief** — sections, Next Steps, `📌 Offene Tasks`. When that brief is present the project is live: **do NOT call `load_project` again.** Cases:

- **Brief present, right project** → use it directly. No activation call.
- **`⚠ Kein aktives Projekt gebunden` instead** (this cwd had no prior binding) → list the `--- Recent projects ---` entries, ask which one, then activate it (`o9k-activate`).
- **User's first message names a *different* project than the bound one** → switch via `o9k-activate`.

**Legacy fallback** (no brief injected — pre-cutover or v1 install, you see only `--- Recent projects ---`/`## Projects` with no brief): use the old flow — `load_project(id: "P00XX")` for the named/chosen project.

## STEP 2: Pending-work check — already injected by the hook

The hook runs the git pending-work probe against your cwd and injects an `⚠ Offene Arbeit im Repo:` block when anything is pending (uncommitted, stashes, worktrees, unmerged branches). **If that block is present, surface it** and ask "Weiter dran arbeiten oder aufräumen?". Do NOT re-run git — it's already done. Never auto-delete/commit/merge.

**Legacy fallback** (no hook git block *and* you are in a git repo — pre-cutover/v1): run the checks yourself —

```bash
git status --porcelain; git stash list; git worktree list
git branch --no-merged main 2>/dev/null || git branch --no-merged master
```

Surface only real pending work (a branch is unmerged only if it appears in `--no-merged`).

## STEP 3: Next Steps & open tasks — read from the injected brief

The auto-bound project brief already contains the **Next Steps** node and a **`📌 Offene Tasks (verknüpft)`** list. Read them straight from the injected brief and surface what's relevant — no `read_memory`/`load_project` round-trip. No interpretation — just display.

**Legacy fallback** (no brief injected): read the "Next Steps" node (`read_memory(id: "P00XX.<seq>")`) and compare with linked T-entries, reporting ones not already in Next Steps.

## STEP 4: Noise Check

After load_project, scan for:
- **>4k tokens** → invoke `o9k-curate`
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
