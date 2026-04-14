---
name: hmem-update
description: "Post-update checklist for hmem-mcp and hmem-sync. Run after npm update or when hmem detects a version change. Covers skill sync, entry migration, schema enforcement, O-entry curation, and smoke tests. Use when the user says \"update hmem\", \"hmem updaten\", or when the startup version-check detects a new version."
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

Read the changelog: `gh release list -R Bumblebiber/hmem --limit 5` or check `git log --oneline <old-tag>..HEAD` in a local repo.

**If already on latest:** Tell the user and skip to Step 7 (smoke test).

---

## Step 2: Update Skills

```bash
hmem update-skills
```

Syncs all skill files from the npm package to the local skills directory. Verify:

```bash
ls ~/.claude/skills/hmem-*/SKILL.md   # Claude Code
ls ~/.config/gemini/skills/hmem-*/     # Gemini CLI (if applicable)
```

Inform the user about any new skills.

---

## Step 2b: Verify Hooks

Hooks are critical — without them, O-entries are never logged and auto-checkpoints never fire.

Check hook configuration in `~/.claude/settings.json`.

**Required hooks (for `checkpointMode: "auto"`):**
- **UserPromptSubmit** — memory load + checkpoint reminder
- **Stop** — exchange logging (`hmem log-exchange`) + O-entry title generation
- **SessionStart[clear]** — context re-injection after `/clear`

**If hooks are missing or empty:** Inform the user and suggest `/hmem-config` or `hmem init`.

**If hooks reference old paths:** Verify scripts exist and point to the current installation.

**Windows users:** Two platform-specific issues commonly break hooks. See [references/WINDOWS-HOOKS.md](references/WINDOWS-HOOKS.md) for diagnosis and fix steps.

---

## Step 2c: Check load_project Display Config

Since v5.1.8, `load_project` supports configurable section expansion via `hmem.config.json`:

```json
{ "memory": { "loadProjectExpand": { "withBody": [1], "withChildren": [6, 8] } } }
```

- `withBody`: sections showing L3 title + body (default: `[1]` = Overview)
- `withChildren`: sections listing all L3 children as titles (default: `[6, 8]` = Bugs, Open Tasks)

Inform the user if not yet customized.

---

## Step 2d: HMEM_PATH Migration (v6.0.0+)

v6.0.0 replaced `HMEM_PROJECT_DIR` + `HMEM_AGENT_ID` with a single `HMEM_PATH` env var. If the user's config still references the old vars, migration is needed.

See [references/MIGRATIONS.md](references/MIGRATIONS.md) for full v6.0.0 migration steps including hmem-sync filename matching.

---

## Step 3: Entry Migration

Some versions introduce new data formats. Check what version range was crossed and apply relevant migrations:

- **v5.1.0+** — Title/body separation for entries
- **v5.1.2+** — Checkpoint summaries (`[CP]`) for O-entries with >10 exchanges; skill-dialog tags

See [references/MIGRATIONS.md](references/MIGRATIONS.md) for version-specific migration procedures.

**General migration pattern:**
1. Read a sample of entries to assess current state
2. Identify entries that do not match the new format
3. Fix in batches — prioritize favorites and pinned entries first, then high-access, then the rest

---

## Step 4: P-Entry Schema Enforcement (R0009)

Verify all active P-entries follow the standard 9-section L2 structure. Add missing sections; do not restructure entries that already conform.

See [references/SCHEMA.md](references/SCHEMA.md) for the full schema and enforcement procedure.

---

## Step 5: O-Entry Curation

Check recent O-entries (`read_memory(prefix="O")`) for quality:

- **Titles** — Replace "unassigned" or generic titles with descriptive ones
- **Tags** — Every O-entry needs at least `#session`; add topic tags where obvious (`#release`, `#bugfix`, `#refactor`)
- **Checkpoint summaries** — O-entries with >10 exchanges and no `[CP]` summary need one
- **Cleanup** — Look for duplicate O-entries (same title, same date, 1-2 exchanges) that are likely subagent artifacts; mark irrelevant or delete

---

## Step 6: hmem-sync Update (if installed)

```bash
which hmem-sync && hmem-sync --version  # check if installed
npm view hmem-sync version              # latest on npm
```

If outdated, run `npm update -g hmem-sync`, then verify with `hmem-sync status`, `hmem-sync push`, and `hmem-sync pull`.

If hmem-sync is not installed, mention it is available for cross-device sync.

---

## Step 7: Restart Prompt

The smoke test must run against the new MCP server version. Since the MCP server is loaded into the host process, an npm update does NOT take effect until the tool is restarted.

Tell the user to restart Claude Code and run `/hmem-update` again — it will skip straight to the smoke test.

**If already on latest** (detected in Step 1): Skip this step and proceed directly to smoke test.

---

## Step 8: Smoke Test

Run after restart (or immediately if no update was installed):

```
read_memory()                           # bulk read works
read_memory(id="P00XX")                 # drill-down works
load_project(id="P00XX")               # project loading works
write_memory(prefix="T", content="Update smoke test — delete me", tags=["#test"])
                                        # write works → note the ID
update_memory(id="T00XX", content="Update smoke test — verified", irrelevant=true)
                                        # update works + mark for cleanup
```

If any step fails, report the error. Do not proceed with normal work until resolved.

---

## Step 9: Report

Tell the user what was done. Always remind to restart if an update was installed and the user has not restarted yet. Example:

```
hmem-mcp updated: v5.1.2 → v5.1.4

Changes applied:
- Skills synced (2 new, 3 updated)
- 5 P-entries checked against R0009 schema (2 fixed)
- 12 O-entries curated (4 titles fixed, 3 summaries added)
- Smoke test passed ✓
```

---

## Auto-Detection (for hook integration)

This skill can be triggered automatically. At session startup, if the hmem MCP server detects a version mismatch, it appends a notice to the first `read_memory()` response:

```
⚠ hmem-mcp updated: v5.1.2 → v5.1.4. Run /hmem-update to apply post-update steps.
```

The agent should then invoke this skill automatically or ask the user. Last-seen version is stored in `hmem.config.json` under `lastSeenVersion`.
