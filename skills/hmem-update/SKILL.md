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

## Step 2b: Verify Hooks

Hooks are critical — without them, O-entries are never logged and auto-checkpoints never fire.

Check the current hook configuration:
```bash
cat ~/.claude/settings.json | grep -A5 hooks
```

**Required hooks (for `checkpointMode: "auto"`):**
- **UserPromptSubmit** — memory load + checkpoint reminder
- **Stop** — exchange logging (`hmem log-exchange`) + O-entry title generation
- **SessionStart[clear]** — context re-injection after `/clear`

**If hooks are missing or empty (`hooks: {}`):**
1. Inform the user: "Hooks are not configured — O-entries won't be logged and auto-checkpoints won't fire."
2. Suggest: "Run `/hmem-config` to set up hooks, or run `hmem init` to re-initialize."

**If hooks exist but reference old paths or scripts:**
- Check that hook scripts exist and are executable
- Verify they reference the current hmem installation path

---

## Step 2c: Check load_project Display Config

Since v5.1.8, `load_project` supports configurable section expansion:
- `loadProjectExpand.withBody`: sections showing L3 title + body (default: `[1]` = Overview)
- `loadProjectExpand.withChildren`: sections listing all L3 children as titles (default: `[6, 8]` = Bugs, Open Tasks)

Check if the user has customized this in `hmem.config.json`. If not, inform them about the option:
```json
{ "memory": { "loadProjectExpand": { "withBody": [1], "withChildren": [6, 8] } } }
```

---

## Step 2d: HMEM_PATH Migration (v6.0.0+)

v6.0.0 replaced `HMEM_PROJECT_DIR` + `HMEM_AGENT_ID` with a single `HMEM_PATH` env var.

**Check if migration is needed:**
1. Look at the user's `.mcp.json` or `~/.claude.json` for hmem env vars
2. If you see `HMEM_PROJECT_DIR` and/or `HMEM_AGENT_ID` → migration needed

**Migration steps:**

1. Determine the current .hmem file path:
   - With agent ID: `{HMEM_PROJECT_DIR}/Agents/{HMEM_AGENT_ID}/{HMEM_AGENT_ID}.hmem`
   - Without: `{HMEM_PROJECT_DIR}/memory.hmem`

2. Update MCP config — replace the old env vars with `HMEM_PATH`:
   ```json
   {
     "env": {
       "HMEM_PATH": "/absolute/path/to/your/file.hmem"
     }
   }
   ```
   Remove `HMEM_PROJECT_DIR`, `HMEM_AGENT_ID`, and `HMEM_AGENT_ROLE` from the env block.

3. The .hmem file does NOT need to move — `HMEM_PATH` points to it wherever it is.

4. If hmem-sync is installed, also update to v1.0.0+ (`npm update -g hmem-sync`).
   The `--agent-id` flag was removed — use `--hmem-path` or `HMEM_PATH` instead.

5. **CRITICAL — Sync filename must match across all devices:**
   hmem-sync identifies stores by the local filename (e.g. `DEVELOPER.hmem`). If Device A
   syncs as `DEVELOPER.hmem` and Device B syncs as `memory.hmem`, they will NOT see each
   other's data — the server treats them as separate stores.

   **Check:** Run `hmem-sync status` on each device. The "hmem file" line shows the filename
   that will be used for sync. All devices sharing the same memory MUST use the same filename.

   **Common mistake after v6.0 migration:** Devices that used `HMEM_AGENT_ID=DEVELOPER`
   have `DEVELOPER.hmem`. New devices default to `memory.hmem`. These won't sync.

   **Fix:** Rename the .hmem file on the mismatched device:
   ```bash
   mv ~/.hmem/memory.hmem ~/.hmem/DEVELOPER.hmem
   # or: mv ~/.hmem/memory.hmem ~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem
   ```
   Then update `HMEM_PATH` in the MCP config to point to the renamed file.

**Also removed in v6.0.0:**
- `min_role` parameter from `write_memory` and `update_memory` tools
- Company store role gating (all agents can now write to company store)
- `HMEM_AGENT_ROLE` / `COUNCIL_AGENT_ROLE` env vars

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

## Step 7: Restart Prompt

**IMPORTANT:** The smoke test must run against the NEW MCP server version. Since the MCP
server is loaded into the host process (Claude Code, Gemini CLI, etc.), an npm update does
NOT take effect until the tool is restarted.

Tell the user:

```
All migration steps complete. Please restart Claude Code now to load the new MCP server.
After restart, run /hmem-update again — I'll skip straight to the smoke test.
```

**If already on latest version** (detected in Step 1): Skip this step — the MCP server
is already running the current version. Proceed directly to the smoke test.

**After restart:** When `/hmem-update` runs again and Step 1 shows "already on latest",
proceed to the smoke test immediately.

---

## Step 8: Smoke Test

Verify everything works after the update. **Only run this after the restart** (or if no
update was installed — i.e., already on latest version).

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

## Step 9: Report

Tell the user what was done. **Always remind to restart** if an actual update was
installed and the user hasn't restarted yet.

```
hmem-mcp updated: v5.1.2 → v5.1.4

Changes applied:
- Skills synced (2 new, 3 updated)
- 5 P-entries checked against R0009 schema (2 fixed)
- 12 O-entries curated (4 titles fixed, 3 summaries added)
- Smoke test passed ✓

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
