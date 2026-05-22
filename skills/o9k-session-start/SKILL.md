---
name: o9k-session-start
description: "Mandatory entry point for every Cortex session — invoke at conversation start, after /clear, and after any load_project call, even when the UserPromptSubmit hook already activated a project. Loads the project briefing, then surfaces pending git work (uncommitted changes, stashes, worktrees, unmerged branches), shows Next Steps + open T-tasks from the Roadmap, and runs the O-entry routing check. The user counts on these steps to resurface stale work and open tasks at every session start — skipping them defeats the point of hmem-based session memory. Trigger phrases: 'lade Projekt X', 'load project Y', '/clear', 'bin zurück', 'wo waren wir', 'starte neu bei', any new session with an active P-entry."
---

# o9k-session-start

## TRIGGER
Run at the beginning of any session where a Cortex project is active.

## STEP 0: Load context

Before anything else, load the memory context that the hook no longer pre-injects:

```
read_memory(mode='essentials')
```

This returns H-entries (user identity, preferences), recent projects, device info, and pinned content. The `--- hmem-sync ---` status line is already in your context from the hook.

**Fallback when essentials read fails**: If the read fails with "Tool output too large" (common with >700 entries), skip it silently. The hook already injects H-entries (H0008 Identität, H0005 Arbeitsstil, etc.) and recent project IDs into context. Proceed directly to STEP 1 — you have enough to identify the user and activate a project.

## STEP 1: Activate project

**If you already see a project briefing in context** (from a prior load_project in this session), skip to STEP 2.

**Otherwise:**

- If the user's message names a specific project (e.g. "lade Projekt hmem", "P0048", "work on its-over-9k"): call `load_project(id: "P00XX")` with that ID.
- If the user did NOT name a project: do NOT load anything yet. After the greeting, list the 5 entries from the `--- Recent projects ---` block (always injected by the hook) as bullet points and ask which one to continue with. Once the user picks one, call `load_project(id: "P00XX")`.

`load_project` returns the project brief, recent O-Entry summaries, rules, and lessons. Do NOT call `read_memory` separately. `load_project` is the only activation action.

## STEP 2: Pending-work check (git repo state)

**Sessions resume after days or weeks.** Work paused on a feature branch, in a worktree, in a stash, or just uncommitted in the tree can silently rot if nobody re-surfaces it. The user is counting on you to remember — that's the entire point of starting from hmem instead of conversation history. Surface pending work *before* you do anything else substantive, so the user can decide whether to resume it or close it out.

### Find the repo

Look in the load_project output for a filesystem path — usually under `.1.4 Environment` ("Repo /home/.../<name>") or in `.2 Codebase`. If no repo is documented, or the path has no `.git` directory, skip this step silently. Not every project is a code repo (concept projects, document workflows, etc.).

### Run the checks

From the repo root:

```bash
git status --porcelain                                                    # uncommitted/untracked
git stash list                                                            # WIP stashes
git worktree list                                                         # worktrees
git for-each-ref --format='%(refname:short) %(committerdate:relative)' \
    refs/heads/ | grep -v '^main\b\|^master\b'                            # local branches != main
git branch --no-merged main 2>/dev/null || git branch --no-merged master  # branches not in main yet
```

Run them in parallel. Cross-reference: a branch listed by `for-each-ref` that is *also* in `--no-merged` has real unmerged commits — those matter most.

### Surface findings to the user

Only report when something is actually pending. If everything is clean, say nothing — don't pad the output with "no pending work".

Use this format (German when the user speaks German, English otherwise):

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

**Never auto-delete, auto-commit, or auto-merge anything.** The user decides. Your job is to surface, not to clean. A worktree from three weeks ago might be an abandoned experiment, or the half-finished feature the user has been meaning to ship — you can't tell from the outside, so you ask.

If the user's first instruction obviously supersedes pending work (e.g. "ignore the worktree, I'm doing X now"), respect that and don't badger.

## STEP 3: Next Steps & offene Tasks

Surface what's on deck so the user doesn't have to hunt for it.

### Next Steps lesen

Suche im load_project-Output unter `.8 Roadmap` nach einem Eintrag mit Titel "Next Steps". Lies ihn:

```
read_memory(id: "P00XX.8.YY")   ← Node mit Titel "Next Steps"
```

Falls kein "Next Steps"-Node existiert, überspringe diesen Schritt stillschweigend.

### T-Entries prüfen

Im load_project-Output sind unter `Links:` die verlinkten T-Entries aufgelistet. Vergleiche: Welche T-Entries tauchen **nicht** im Next-Steps-Inhalt auf? Das sind abweichende offene Tasks.

### Ausgabe

Zeige Next Steps immer (auch wenn leer). Abweichende Tasks nur wenn vorhanden.

```
📋 Next Steps:
  • Item 1
  • Item 2

📌 Offene Tasks (nicht in Next Steps):
  T0033: hmem-sync SaaS monetization
  T0042: Config-Konsolidierung
```

**Keine Interpretation, kein Priorisieren** — nur anzeigen, was drin steht.

## STEP 4: Noise Check

**Do this immediately after load_project, before any other work.**

Scan the output for:
- **>4k tokens** → invoke `o9k-curate` on this project first, then continue
- **✓ DONE items in Roadmap** → `update_memory(id, { irrelevant: true })`
- **Decommissioned / concept entries in Infrastructure** → `update_memory(id, { irrelevant: true })`
- **Old status snapshots in Overview** (superseded by newer) → mark obsolete
- **`[-]` prefix sections** (e.g. `P00XX.10 [-] Bugs`) — orphaned schema artifacts → `update_memory(id, { irrelevant: true })` for each
- **Duplicate L2 sections** (two nodes with same name) → mark the higher-numbered one irrelevant
- **Non-standard L2 sections** (sections not in R0009 schema: Overview, Codebase, Dependencies, Usage, Context, Deployment, Security, Performance, Bugs, History, Roadmap, Ideas, Rules, Next Steps) → evaluate: move useful children to standard sections, then mark the non-standard section irrelevant

**Batch when possible**: If multiple items need the same treatment (e.g. 3+ items to mark irrelevant), use `update_many(ids=[...], irrelevant=true)` instead of individual calls. Same for favorites or other flags.

Fix all of the above immediately. Do not note and defer.

## STEP 5: Calibrate explanation depth

Read H0003 (IT Skills) — the scale is 1–9:
- **7–9 = Expert**: use technical language directly, no padding, no basics
- **4–6 = Proficient**: explain concepts but skip fundamentals
- **1–3 = Basics**: explain with examples

Apply this calibration for the entire session. When explaining something in a domain, check the matching H0003 skill first.

## STEP 5b: H-Schema completeness check

H0000 defines the canonical H-Slots (Identität, Online-ID, IT-Skills, Business-Skills, Arbeitsstil, Kontext, Präferenzen). The Identität-Slot is **PFLICHT** — without it the agent doesn't know name, language, or accepted greetings.

**At session start, verify:**
1. Read H0000 — it lists which H-IDs cover which slots
2. For each `PFLICHT`-marked slot, check that the entry exists AND has L2 children (not just a stub)
3. If a Pflicht-Slot is missing or empty: pause the greeting, ask the user the missing questions in one block, then `write_memory(prefix="H", pinned=true, ...)` to fill it

**Questions to ask when Identität-Slot is empty:**
- Wie soll ich dich ansprechen?
- Welche Sprache bevorzugst du (Deutsch / Englisch / andere)?
- Welche Begrüßungen sind OK, welche stören dich?

Save answers immediately. Only proceed with the greeting after the slot is filled. If H0008 is pinned and has L2 children, the essentials read from STEP 0 already loaded them — you're done.

## STEP 6: O-Entry routing check

**This step is critical.** Every `load_project` call changes which O-entry receives session exchanges. If you called `load_project` on any project other than your working project — even briefly, even for administrative reasons (reconcile, curation, migration) — those exchanges were misrouted to the wrong O-entry.

After activating, check for misrouted exchanges:

```
read_memory(id: "O00XX")   ← the working project's O-entry (same seq as P00XX)
```

Look at the most recent batch. If exchanges are missing that you know happened (e.g. earlier in this session), they landed in another project's O-entry.

**To find them:** check O-entries for any other project you called `load_project` on during this session. Look for nodes created today with content matching your session.

**To fix:**
```
move_nodes(node_ids: ["O00YY.Z"], target_o_id: "O00XX")
```

Move the misrouted session/batch node to the correct O-entry.

**Rule:** Never call `load_project` on a secondary project without immediately re-calling it on your working project. Routing follows the last `load_project` call — always return control explicitly.

## What gets injected automatically (first message)

The hook injects only the `--- hmem-sync ---` status line (link state, active file, last sync). Everything else — H-entries, recent projects, device info — must be loaded via `read_memory` in STEP 0 below.

## OUTPUT — natural greeting

**Format (two lines, user's preferred language and name, no padding):**

Schema (placeholders shown — never copy literally; pull real values from H-entries):
```
<sync-status-line>
<greeting> <name> — <action>.                                  ← project named
<greeting> <name>. <list-intro>:                               ← no project named
  • Pxxxx — <title>
  ...
<follow-up question>
```

**Pulling the right values:**
- **Language** — H0005 specifies it (German native, English fluent). Match the user's first message.
- **Address form** — H0008 (Identität, pinned) is canonical: preferred name AND the explicit greeting whitelist/blacklist. Hook injects its L2 content directly, so the rules are visible without extra reads. Follow them literally — using a blacklisted greeting is a session-start failure.
- **Sync-status line** — read from the `--- hmem-sync ---` block injected by the hook. Always a separate line above the greeting:
  - `✓ Linked …` → `🟢 hmem-sync verbunden.`
  - `⚠ …` → `🟡 hmem-sync: <kurze Statusbeschreibung>.`
  - `✗ Not linked` → `🔴 hmem-sync nicht verbunden.`
  - `✗ Not configured` → `🔴 hmem-sync nicht konfiguriert.`
  Never inline the colored dot into the greeting itself. The status line is mandatory — the user needs to know whether memories propagate.

**No `[CORTEX READY]` block.** The two-line output IS the ready signal. After it, either proceed with the task (if project named) or wait for the user's answer.