---
name: hmem-update
description: >
  Post-update checklist for hmem-mcp and hmem-sync. Run after npm update or when
  hmem detects a version change. Covers skill sync, entry migration, schema enforcement,
  O-entry curation, and smoke tests. Use when the user says "update hmem", "hmem updaten",
  or when the startup version-check detects a new version.
---

# /hmem-update — Post-Update Checklist

Run this after updating hmem-mcp or hmem-sync. Every step is important — do not skip steps.

---

## Step 1: Version Check

Determine what changed:

```bash
hmem --version                    # current installed version
npm view hmem-mcp version         # latest on npm
npm view hmem-mcp versions --json # all versions
```

Read the changelog for the version range:
```bash
cd ~/projects/hmem && git log --oneline <old-tag>..HEAD  # if local repo exists
```

Or check GitHub releases: `gh release list -R Bumblebiber/hmem --limit 5`

**If already on latest:** Tell the user and skip to Step 7 (smoke test).

---

## Step 2: Update Skills

```bash
hmem update-skills
```

This syncs all skill files from the npm package to the local skills directory. Verify:

```bash
ls ~/.claude/skills/hmem-*/SKILL.md   # Claude Code
ls ~/.config/gemini/skills/hmem-*/     # Gemini CLI (if applicable)
```

Check for new skills that weren't there before — inform the user about new capabilities.

---

## Step 3: Entry Migration

Some versions introduce new data formats. Check if migration is needed:

**v5.1.0+ Title/Body Separation:**
- Entries now support `>` body lines (title shown in listings, body on drill-down)
- Check if old entries need title/body split:
  ```
  read_memory(titles_only=true)
  ```
- Look for entries where the title is truncated mid-word or contains too much detail
- Fix with: `update_memory(id="L0042", content="Clear title\n> Detailed body text")`

**v5.1.2+ Checkpoint Summaries:**
- O-entries with >10 exchanges should have `[CP]` checkpoint summaries
- Check recent O-entries: `read_memory(prefix="O")`
- If summaries are missing, write them:
  ```
  append_memory(id="O00XX", content="\t[CP] Factual 3-8 sentence summary of the session")
  ```

**v5.1.2+ Skill-Dialog Tags:**
- Exchanges containing skill activations should be tagged `#skill-dialog`
- These are auto-tagged by the checkpoint process going forward
- For old exchanges: the checkpoint auto-tagger picks them up on the next run

**General migration pattern:**
1. Read a sample of entries to assess the current state
2. Identify entries that don't match the new format
3. Fix in batches — don't try to fix everything at once
4. Prioritize: favorites and pinned entries first, then high-access, then the rest

---

## Step 4: P-Entry Schema Enforcement (R0009)

All P-entries (projects) must follow the standard L2 structure:

```
.1 Overview
.2 Codebase
.3 Usage
.4 Context
.5 Deployment
.6 Bugs
.7 Protocol
.8 Open tasks
.9 Ideas
```

For each active P-entry:
1. `read_memory(id="P00XX", depth=2)` — check L2 structure
2. Compare against the schema above
3. Add missing sections: `append_memory(id="P00XX", content="\tOverview\n\t\tCurrent state: ...")`
4. L1 body should be: `Name | Status | Stack | Description`

**Do not restructure entries that already follow the schema.** Only fix what's missing or wrong.

---

## Step 5: O-Entry Curation

Check recent O-entries for quality:

```
read_memory(prefix="O")
```

**Titles:**
- Replace "unassigned" or generic titles (e.g., "hmem-mcp") with descriptive ones
- Good: "Title/Body Separation design + v5.1.0 release"
- Fix: `update_memory(id="O00XX", content="Descriptive session title")`

**Tags:**
- Every O-entry should have at least `#session`
- Add topic tags where obvious: `#release`, `#bugfix`, `#refactor`, `#brainstorming`
- Fix: `update_memory(id="O00XX", tags=["#session", "#release"])`

**Checkpoint Summaries:**
- O-entries with >10 exchanges and no `[CP]` summary need one
- Write summary: `append_memory(id="O00XX", content="\t[CP] Summary...")`
- The auto-tagger will tag it `#checkpoint-summary` on the next checkpoint run

**Cleanup:**
- Look for duplicate O-entries (same title, same date, 1-2 exchanges) — these are likely subagent artifacts
- Mark as irrelevant or delete if clearly junk

---

## Step 6: hmem-sync Update (if installed)

Check if hmem-sync is installed and needs updating:

```bash
which hmem-sync && hmem-sync --version  # check if installed
npm view hmem-sync version              # latest on npm
```

If outdated:
```bash
npm update -g hmem-sync
```

Verify sync still works:
```bash
hmem-sync status    # check connection to sync server
hmem-sync push      # test push
hmem-sync pull      # test pull
```

**If hmem-sync is not installed:** Skip this step. Mention to the user that hmem-sync is available for cross-device sync.

---

## Step 7: Smoke Test

Verify everything works after the update:

```
read_memory()                           # bulk read works
read_memory(id="P00XX")                 # drill-down works
load_project(id="P00XX")               # project loading works
write_memory(prefix="T", content="Update smoke test — delete me", tags=["#test"])
                                        # write works → note the ID
update_memory(id="T00XX", content="Update smoke test — verified", irrelevant=true)
                                        # update works + mark for cleanup
```

If any step fails: report the error to the user. Do not proceed with normal work until the issue is resolved.

---

## Step 8: Report

Tell the user what was done:

```
hmem-mcp updated: v5.1.2 → v5.1.4

Changes applied:
- Skills synced (2 new, 3 updated)
- 5 P-entries checked against R0009 schema (2 fixed)
- 12 O-entries curated (4 titles fixed, 3 summaries added)
- Smoke test passed

New features in this version:
- Rolling checkpoint summaries
- Skill-dialog exchange filtering
- hmem --version reads from package.json
```

---

## Auto-Detection (for hook integration)

This skill can be triggered automatically. At session startup, if the hmem MCP server detects that the installed version differs from the last-seen version stored in the config, it appends a notice to the first `read_memory()` response:

```
⚠ hmem-mcp updated: v5.1.2 → v5.1.4. Run /hmem-update to apply post-update steps.
```

The agent should then invoke this skill automatically or ask the user if they want to run it.

**Last-seen version** is stored in `hmem.config.json` under `lastSeenVersion`. Updated automatically after a successful `/hmem-update` run.
