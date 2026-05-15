---
name: o9k-session-start
description: Load project context at session start via load_project. Includes recent O-Entry summaries and a pending-work scan (uncommitted changes, stashes, worktrees, unmerged branches) so paused work doesn't get forgotten across week-long gaps. Run at the beginning of every Cortex session.
---

# o9k-session-start

## TRIGGER
Run at the beginning of any session where a Cortex project is active.

## STEP 1: Activate project

Call load_project with the working project ID:

load_project(id: "P00XX")

Replace P00XX with the actual project ID (e.g., P0048).

load_project returns the project brief, recent O-Entry summaries, rules, and lessons.
Do NOT call read_memory separately. load_project is the only activation action.

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

Fix all of the above immediately. Do not note and defer.

## STEP 5: Calibrate explanation depth

Read H0003 (IT Skills) — the scale is 1–9:
- **7–9 = Expert**: use technical language directly, no padding, no basics
- **4–6 = Proficient**: explain concepts but skip fundamentals
- **1–3 = Basics**: explain with examples

Apply this calibration for the entire session. When explaining something in a domain, check the matching H0003 skill first.

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

The UserPromptSubmit hook injects the following into every session start:
- **H-entries** — top 10 by access count (ID + title)
- **Active device apps** — Apps list of the current I-entry (if device is set)
- **Infrastructure favorites** — any I-entry with `favorite: true` (e.g. reMarkable, shared server). Mark with `update_memory(id="I00XX", favorite=true)`.
- **Recent projects** — 5 most recently updated P-entries
- **hmem-sync status** — `--- hmem-sync ---` block with link state. Only present if `~/.hmem/config.json` exists.

## OUTPUT

After all steps, output exactly:

[CORTEX READY]
Project: <name from load_project>
Sync: <dot> <status line>
Context loaded. Ready.
[/CORTEX READY]

**Sync line — read from the auto-injected `--- hmem-sync ---` block and map:**
- `✓ Linked …` → `🟢 connected (<server>, last sync <ago>)`
- `⚠ Linked … never synced` → `🟡 linked, never synced — run \`hmem-sync pull\``
- `⚠ Authenticated … no active file` → `🟡 no active file — run \`hmem-sync setup\``
- `✗ Not linked` → `🔴 not connected — writes stay local`
- No `--- hmem-sync ---` block present → omit the `Sync:` line entirely

Then wait for the user's first message.
