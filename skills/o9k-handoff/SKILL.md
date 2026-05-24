---
name: o9k-handoff
description: "Prep for /clear: write a verifiable, durable handoff — save high-value knowledge and update the project's Next Steps so the next session starts *better* than this one — then prompt the user to clear. Use on /o9k-handoff, /handoff, 'wipe context', 'clear context', 'context is full', or 'start fresh'. Not for deleting hmem entries, clearing terminal output, or cleaning up nodes."
---

# Handoff — Prepare & Clear Context

The job of this skill is to leave a handoff good enough that a fresh session —
which remembers nothing of this conversation — picks up cleanly, ideally
starting *better* than you did. Follow these steps in order.

## Step 0: Abort if repos touched this session have uncommitted changes

**Hard gate — must complete before any other step.** Clearing context with
unfinished local work risks losing track of why those changes exist. The
post-clear session has no memory of the chat that produced them.

Scope this check to **only the repos the session actually touched** — not
every repo on the machine. Unrelated work on other projects is not your
concern here.

1. Look back over this session's tool history and identify every file path
   you've modified (Edit, Write, NotebookEdit, or any Bash commands that
   wrote to a tracked file). If no files were modified at all, skip Step 0
   entirely and proceed to Step 1.

2. For each unique path, resolve its git repo root:
   ```bash
   git -C <path> rev-parse --show-toplevel 2>/dev/null
   ```
   Dedupe to a set of repo roots. Drop any path that isn't inside a repo.

3. For each repo root, check status:
   ```bash
   git -C <repo-root> status --porcelain
   ```

4. If **any** repo has non-empty status output:
   - **Do not proceed to Step 1 or beyond. Do not tell the user to `/clear`.**
   - Print the dirty file list per repo so the user sees exactly what's at risk.
   - Reply with:
     > Handoff aborted — uncommitted changes in repo(s) you worked on this session. Commit, stash, or discard the listed files first, then re-run /o9k-handoff. (If the changes are intentional WIP you want to keep across the clear, stash them with a clear message: `git stash push -m "WIP: <what + why>"`.)
   - End the skill.

Only proceed to Step 1 when every session-touched repo is clean.

**Why session-scoped, not whole-machine:** other repos may have intentional
WIP unrelated to this conversation — those aren't your responsibility to
gate on. The risk this guard prevents is losing the *why* behind changes
you just helped make.

## Step 1: Optionally save high-value knowledge

Check `checkpointMode` in hmem.config.json to decide what to do:

### checkpointMode: "auto"

The Haiku subagent already extracts L/D/E entries every 20 exchanges automatically.
Skip manual writes unless you have **specific high-value knowledge** that:
- Was discovered in the last few exchanges (too recent for the last auto-checkpoint)
- Is critical enough that losing it would cost significant rework
- Is NOT already covered by a recent auto-checkpoint

If nothing qualifies, proceed directly to Step 2.

### checkpointMode: "remind"

Manually save unsaved insights from this project context:
- New lessons learned: `write_memory(prefix="L", ...)`
- Project progress: `append_memory(id="P00XX.7", ...)` (Protocol node)
- Decisions made: `write_memory(prefix="D", ...)`
- Errors encountered: `write_memory(prefix="E", ...)`

Skip if the last checkpoint was fewer than 5 messages ago.

### Why gate on checkpointMode?

Redundant writes waste tokens and create duplicates that clutter memory.
Auto-checkpoints already call `read_memory` to deduplicate before writing —
manual writes during the handoff bypass that check and risk creating noise.

## Step 2: Update Next Steps (the handoff)

Before clearing context, ensure the active project's "Next Steps" section is up to date.
This is the heart of the handoff — after /clear, the next session (or restored context)
needs to know what to work on next, and acts only on what's written here.

1. Find the "Next Steps" section: `read_memory(id="P00XX")` at depth 2 to list L2 children,
   then identify the "Next Steps" node by title (seq may vary per project).
2. Review current content: `read_memory(id="P00XX.N")` where N is the Next Steps seq.
3. Update with current priorities: `write_memory(id="P00XX.N", content="...")` with:
   - What was being worked on
   - What's done vs. still open
   - Immediate next actions for the next session
   - Any blockers or decisions pending
4. Mark completed steps as irrelevant: `update_memory(id="P00XX.N.M", irrelevant=true)` for
   each L3 child under Next Steps that has been fully completed. This keeps the section clean
   for the next session — irrelevant nodes are hidden from `load_project` output.

Skip the rewrite if Next Steps is already current (updated within the last few exchanges) — but still confirm it clears the quality bar below.

**Before declaring Step 2 done, audit the result against this quality bar — write the handoff so the next session starts *better* than this one, not just *informed* about it.** A fresh session has zero memory of the conversation behind these notes; it acts only on what's written, so a handoff that reads confidently but strands the successor is the failure mode.

- **Verifiable, not asserted.** Don't write "X is done" expecting blind trust — the successor can't see the work behind the claim, and a confidently-wrong "DONE" makes it build on sand. Give the one command that proves the state (`git log --oneline main..<branch>`, a test command, a file check) and frame it as "verify with: …".
- **Flag non-durable references.** Any path that won't survive — `/tmp/*` (periodically cleaned), gitignored scratch, build artifacts — gets marked ephemeral with a regen command, or — better — its essence gets mirrored into hmem as a child of the handoff node (the way `P0048.15.14.1` mirrored a verified boundary rule when its master plan lived only in gitignored `docs/`). Citing `/tmp/foo` as if permanent strands the successor when it's gone.
- **Name what's NOT done.** Residual risks, partial fixes, known-broken bits — state them explicitly. A caveat hidden behind "mostly works" costs the successor the exact rediscovery you already paid for.

**Litmus test before you clear:** *"Coming back fresh right now, would this note let me start better than I did today — or trip over the same things?"* If the latter, fix the note first.

## Step 3: Tell the user to /clear

O-entries are auto-logged by the Stop hook — every exchange is already saved
to the active project's O-entry. No need to manually create O-entries or call
`flush_context` for conversation history.

Reply with exactly:

> Context ready for clear. Type `/clear` — the SessionStart hook will automatically restore your project context.

Do NOT attempt to run /clear yourself — it is a built-in CLI command only the user can execute.

## What happens after /clear

Context is restored **automatically** by the `SessionStart[clear]` hook — no
agent action needed after /clear. Do **NOT** call `load_project` or `read_memory`
during or after this skill; the next session's first UserPromptSubmit hook will
trigger the normal o9k-read flow with a verified active project ID.

The hook:
1. Resets the MCP session cache
2. Injects recent conversation exchanges from the project's O-entry transcript
3. Injects the active project briefing (overview expanded)
4. Injects recent O-entry titles + rules

## Why this flow works

- **O-entries are covered.** The Stop hook logs every exchange to the active
  project's O-entry. The handoff does not need to handle conversation history.
- **Checkpoints are covered (auto mode).** The Haiku subagent extracts knowledge
  every 20 exchanges. The handoff only needs to catch the tail end, if anything.
- **Context restoration is covered.** The SessionStart[clear] hook handles
  re-injection automatically. The agent just needs the user to type /clear.
