---
name: hmem-update
description: "Post-update checklist for hmem-mcp and hmem-sync. Run after npm update or when hmem detects a version change. Covers skill sync, entry migration, schema enforcement, O-entry curation, and smoke tests. Use when the user says 'update hmem', 'hmem updaten', or when the startup version-check detects a new version."
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

This syncs all skill files from the npm package to the local skills directory
**and prunes stale `hmem-*` skills that are no longer bundled** (as of v6.3.2).
Example output: `× hmem-self-curate (removed, no longer bundled)`.

Verify:

```bash
ls ~/.claude/skills/hmem-*/SKILL.md   # Claude Code
ls ~/.config/gemini/skills/hmem-*/     # Gemini CLI (if applicable)
```

Check for new skills that weren't there before — inform the user about new capabilities.
If a skill was removed (e.g. merged into another), mention that too so the user knows
the workflow has moved.

---

## Step 2b: Verify Hooks

Hooks are critical — without them, O-entries are never logged and auto-checkpoints never fire.

Check the current hook configuration. Use the platform-appropriate command:

```bash
# Linux / macOS
cat ~/.claude/settings.json | grep -A5 hooks
```

```powershell
# Windows (PowerShell)
Get-Content "$env:USERPROFILE\.claude\settings.json" | Select-String -Pattern "hooks" -Context 0,5
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

### Windows-specific hook checks (CRITICAL)

On Windows, two specific issues break hooks. Always run these checks when updating on Windows:

**Check 1 — `shell: powershell` present on every hook command?**

Each object in `hooks.*.hooks` and the `statusLine` object must contain `"shell": "powershell"`. Without it, Claude Code may route the command through Git Bash, whose MSYS2 runtime crashes transiently at startup (`bash.exe: *** fatal error - add_item ... errno 1`) before the command is even parsed. Every hook then fails with a generic error.

**Check 2 — No inline env-var syntax in commands?**

Commands must NOT contain `VAR=value` prefixes like `HMEM_PATH=C:/... node ...`. That's bash-only syntax; cmd.exe and PowerShell interpret `HMEM_PATH=...` as the command name and fail. All env vars must live in the top-level `env` block of settings.json.

**The correct Windows shape:**

```json
{
  "env": {
    "HMEM_PATH": "C:/Users/<you>/.hmem/Agents/<AGENT>/<AGENT>.hmem"
  },
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js log-exchange",
            "shell": "powershell"
          }
        ]
      }
    ]
  }
}
```

**If either check fails:** Offer to fix settings.json automatically. The fix is lossless on other platforms, so it's safe to apply even on shared configs synced across OSes. Point the user to the Windows hook section in `/hmem-config` for the full pattern (UserPromptSubmit, Stop, SessionStart, statusLine).

**After fixing:** Claude Code must be restarted so the `env` block is re-loaded and hooks are re-registered with the new shell.

---

## Step 2c: Check load_project Display Config

Since v5.1.8, `load_project` supports configurable section expansion:
- `loadProjectExpand.withBody`: sections showing L3 title + body (default: `[1]` = Overview)
- `loadProjectExpand.withChildren`: sections listing all L3 children as titles (default: `[6, 8]` = Bugs, Open Tasks)

Check if the user has customized this in `hmem.config.json`. If not, inform them about the option:
```json
{ "memory": { "loadProjectExpand": { "withBody": [1], "withChildren": [6, 8, 10, 16] } } }
```
Section 16 = Rules — include it so project-specific agent directives are visible on every `load_project`.

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

## Step 2e: v7.0.0 — Two-Server Split

**Only needed when upgrading from < v7.0.0**

v7.0.0 moves 11 curation/maintenance tools into a separate `hmem-curate` binary.
The daily server now only exposes the 11 daily-use tools — less context noise, no accidental curation.

Tools that moved to `hmem-curate`: `update_many`, `reset_memory_cache`, `export_memory`, `import_memory`,
`memory_stats`, `memory_health`, `tag_bulk`, `tag_rename`, `move_memory`, `rename_id`, `move_nodes`

**1. Add hmem-curate to MCP config**

Open `~/.mcp.json` (or wherever hmem is configured) and add a second entry:

```json
"hmem-curate": {
  "command": "hmem-curate",
  "env": {
    "HMEM_PATH": "/path/to/your/file.hmem",
    "HMEM_SYNC_PASSPHRASE": "..."
  }
}
```

Leave it **disabled by default** — only activate via `/mcp` when running `/hmem-curate` or `/hmem-migrate-o`.

**Verify the binary installed correctly:**
```bash
hmem-curate --version   # should print 7.0.0
```

If `hmem-curate` is not found: `npm update -g hmem-mcp` (postinstall sometimes skips bin links).

**2. Set up the hmem-using-hmem session hook**

v7.0.0 ships a meta-skill that injects dispatch/memory habits at session start — similar to Superpowers' `using-superpowers`. One command does everything:

```bash
hmem setup-hook
```

This copies `scripts/hmem-session-inject.sh` to `~/.claude/hooks/` and registers the `SessionStart` hook in `settings.json`. Idempotent — safe to run again if already installed.

After the next session restart, `hmem-using-hmem` meta-rules will be in context automatically.

---

## Step 2f: v7.0.0 — Device & Rate Limits in Statusline

**Only needed when upgrading from < v7.0.0**

**1. Active Device in Statusline**

The statusline now shows which device the session is running on (using an I-entry):

```
Strato Server  |  P0048 hmem-mcp  |  3/5  |  5h: 34%/w: 17%
```

- Shows the I-entry title (e.g., "Strato Server"), no ID prefix
- Shows "identify device" in gray if not yet configured
- On first message of a new session, the agent auto-detects the device and calls `set_active_device`

**Set up the device** (once per machine — persists across sessions):

```
set_active_device({ id: "I00XX" })   # use the I-entry ID for this machine
```

Device is stored in `~/.hmem/active-device`. To verify:
```bash
cat ~/.hmem/active-device
```

If no I-entry exists for this machine yet: create one first with `write_memory(prefix="I", ...)`.

**2. Rate Limits in Statusline (Claude Max)**

If you have a Claude Max subscription, the statusline automatically shows 5-hour and weekly usage:
```
5h: 34%/w: 17%
```
Colors: green (<50%), yellow (50–79%), red (≥80%). No config needed — data comes from Claude Code automatically. Only visible if Claude Code passes the data (Claude Max subscribers only).

---

## Step 3: Entry Migration

Some versions introduce new data formats. Check if migration is needed:

**v5.1.0+ Title/Body Separation:**
- Entries support title/body separation via blank line (title shown in listings, body on drill-down)
- Check if old entries need title/body split:
  ```
  read_memory(titles_only=true)
  ```
- Look for entries where the title is truncated mid-word or contains too much detail
- Fix with: `update_memory(id="L0042", content="Clear title\n\nDetailed body text")`

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

All P-entries (projects) must follow the standard 16-section L2 structure defined in `hmem.config.json`. Core sections:

```
.1  Overview       (readonly)
.2  Codebase       (readonly)
.3  Dependencies   (readonly)
.4  Usage          (readonly)
.5  Requirements   (readonly)
.6  Context        (readonly)
.7  Deployment     (readonly)
.8  Security       (pointer — only E-entry refs)
.9  Performance    (pointer — only E-entry refs)
.10 Bugs           (pointer — only E-entry refs)
.11 History        (readonly — session log, chronological)
.12 Roadmap        (append)
.13 Ideas          (append)
.14 Team           (readonly)
.15 Next Steps     (append)
.16 Rules          (readonly — project-specific agent directives)
```

`checkpointPolicy` controls what the Haiku checkpoint agent may write:
- `readonly` — Haiku never modifies this section
- `pointer` — Haiku may only add nodes that reference an entry ID (e.g. `[E0124]`)
- `append` — Haiku may freely add sub-nodes

For each active P-entry:
1. `read_memory(id="P00XX", depth=2)` — check L2 structure
2. Run `load_project(id="P00XX")` — auto-reconcile adds any missing sections
3. L1 body should be: `Name | Status | Stack | Repo`

**Do not restructure entries that already follow the schema.** Only fix what's missing or wrong.

---

## Step 4b: Config & DB Migration (Protocol → History + Rules)

This step is only needed when upgrading from a config that still has `"Protocol"` as a section name.

**Check if migration is needed:**
```bash
grep -c '"Protocol"' ~/.hmem/*/hmem.config.json ~/.hmem/Agents/*/hmem.config.json 2>/dev/null
```
If the output is `0` everywhere — skip this step.

**1. Update hmem.config.json**

In `memory.schemas.P.sections`, make these changes:
- Rename `"Protocol"` → `"History"` and set `"checkpointPolicy": "readonly"`
- Add `"Rules"` section at the end: `{ "name": "Rules", "loadDepth": 1, "checkpointPolicy": "readonly" }`
- Add `checkpointPolicy` to all sections per the table in Step 4
- In `loadProjectExpand.withChildren`, add `16` for Rules visibility

Full recommended policies (add to each section):
```json
{ "name": "Overview",     "checkpointPolicy": "readonly" },
{ "name": "Codebase",     "checkpointPolicy": "readonly" },
{ "name": "Dependencies", "checkpointPolicy": "readonly" },
{ "name": "Usage",        "checkpointPolicy": "readonly" },
{ "name": "Requirements", "checkpointPolicy": "readonly" },
{ "name": "Context",      "checkpointPolicy": "readonly" },
{ "name": "Deployment",   "checkpointPolicy": "readonly" },
{ "name": "Security",     "checkpointPolicy": "pointer"  },
{ "name": "Performance",  "checkpointPolicy": "pointer"  },
{ "name": "Bugs",         "checkpointPolicy": "pointer"  },
{ "name": "History",      "checkpointPolicy": "readonly" },
{ "name": "Roadmap",      "checkpointPolicy": "append"   },
{ "name": "Ideas",        "checkpointPolicy": "append"   },
{ "name": "Team",         "checkpointPolicy": "readonly" },
{ "name": "Next Steps",   "checkpointPolicy": "append"   },
{ "name": "Rules",        "loadDepth": 1, "checkpointPolicy": "readonly" }
```

**2. Rename Protocol → History in existing P-entries**

Find all Protocol section nodes and rename them:
```bash
sqlite3 /path/to/your.hmem \
  "UPDATE memory_nodes SET title='History', content=REPLACE(content,'Protocol','History'), updated_at=datetime('now') WHERE LOWER(title)='protocol' AND root_id LIKE 'P%';
   SELECT changes() || ' nodes renamed';"
```
Then rebuild the FTS index:
```bash
sqlite3 /path/to/your.hmem "PRAGMA wal_checkpoint(TRUNCATE);"
```

**3. R-entry curation**

Global R-entries should only contain rules that apply to ALL projects. Project-specific rules belong in the P-entry's `Rules` section.

Review all R-entries (`read_memory(prefix="R")`). For each one:
- Ask: "Would an agent working on an unrelated project need this?"
- If NO → move to the relevant P-entry's Rules section and mark the R-entry as irrelevant

Common candidates for migration:
- Release/publish rules → into the project's P-entry Rules
- Game/domain-specific constraints → into the relevant project's Rules
- Tool-specific workarounds → into the project's Rules

To add a rule to a P-entry:
```
append_memory(id="P00XX.YY", content="Rule text here (→ was R00ZZ)")
```
where `P00XX.YY` is the Rules section node ID (found via `load_project`).

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
read_project(id="P00XX")               # v7.0.0: read without activating O-entry routing
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
