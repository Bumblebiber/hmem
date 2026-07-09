---
name: hmem-update
description: "Update flow for hmem. Runs `npm update -g`, syncs skills, applies migrations, verifies hooks, shows the changelog. Use when the user asks to update/upgrade hmem, hmem-mcp, or its-over-9k (any language), or when the startup version-check flags a new release. Runs the npm update itself — don't assume it's already done."
---

# /hmem-update — Update Routine

Drives the full update flow for hmem and hmem-sync: detects the current
version, runs `npm update -g` if outdated, syncs skill files, applies any
migrations, verifies hooks and configs, runs the smoke test. Every step is
important — do not skip steps.

> **Package naming note:** The npm package is `hmem` (formerly `its-over-9k`,
> before that `hmem-mcp`). The installed CLI is still `hmem`, the MCP server tools
> still use the `hmem` prefix, and the GitHub repo is `Bumblebiber/hmem`.
> The `its-over-9k` name now belongs to a separate project (the o9k efficiency
> meta-framework) — do not npm-update via that name anymore.
> Always use the current package name (`hmem`) for npm commands.
>
> **Version mapping:** The renames reset the version line twice:
>
> | `hmem-mcp` (legacy) | `its-over-9k` (1.x line) | `hmem` (current) |
> |---------------------|--------------------------|------------------|
> | up to 7.4.x         | 1.0.0 – 1.3.8            | 8.0.0+           |
>
> Steps 2d–2l below describe migrations only relevant when upgrading from the
> legacy 5.x/6.x/7.x line. **Skip them if your installed version is 1.x or 8.x** —
> they are already baked into the rename baseline.
>
> **Upgrading from `its-over-9k` 1.x:** uninstall the old package and install the
> new name — `npm update -g its-over-9k` will never reach 8.0:
>
> ```bash
> npm uninstall -g its-over-9k
> npm install -g hmem
> npx hmem update-skills        # also removes the old o9k-* skill folders
> ```
>
> The skills were renamed `o9k-*` → `hmem-*` in 8.0.0. `update-skills` cleans up
> stale `o9k-*` folders automatically.

---

## Step 1: Version Check

Determine the current and latest version:

```bash
hmem --version                            # current installed version (e.g. "hmem 1.2.1")
npm view hmem version              # latest on npm
npm view hmem versions --json      # all versions (for changelog range)
```

Read the changelog for the version range:
```bash
cd ~/projects/hmem && git log --oneline <old-tag>..HEAD  # if local repo exists
```

Or check GitHub releases: `gh release list -R Bumblebiber/hmem --limit 5`

**If already on latest:** Tell the user and skip to Step 7 (smoke test).

---

## Step 1b: Run the Update

If the installed version is older than the latest on npm, run the update now:

```bash
npm update -g hmem
```

If the user installed via a deprecated package name (`its-over-9k` or `hmem-mcp`),
uninstall it first to avoid two parallel installs:

```bash
npm list -g --depth=0 | grep -E 'hmem-mcp|its-over-9k|hmem'   # check what's installed
npm uninstall -g its-over-9k                                  # only if listed
npm uninstall -g hmem-mcp                                     # only if listed
npm install -g hmem                                           # fresh install
```

After the update, **the MCP server is still running the OLD version** —
it's loaded into the host process (Claude Code, Gemini CLI, etc.) and
won't pick up the new code until restart. Continue with Steps 2–6 first;
the restart happens in Step 7.

---

## Step 1c: Present the changelog to the user

**Always — even for a single-patch jump.** Right after the update is installed, fetch the GitHub release notes for every version in the gap (`<old>` exclusive → `<new>` inclusive) and present a tidy summary to the user. They just installed something; they deserve to know what it does.

```bash
OLD=<previously-installed version>   # e.g. 1.2.3
NEW=$(node -p "require('/path/to/hmem/package.json').version")  # e.g. 1.2.5
gh release list -R Bumblebiber/hmem --limit 20 \
  | awk -v o="v$OLD" -v n="v$NEW" '$1 > o && $1 <= n {print $1}' \
  | while read tag; do
      echo "=== $tag ==="
      gh release view "$tag" -R Bumblebiber/hmem --json body -q .body
    done
```

Present to the user in this shape (German if user speaks German, English otherwise):

```
📦 hmem v1.2.3 → v1.2.5 — Was sich geändert hat:

v1.2.5 — Pull from hmem-sync before first-message context
  • Hook-startup pulls latest entries before building greeting/project list
  • New /hmem-release rule: release notes for every release

v1.2.4 — Natural session-start greeting
  • One-line greeting with name + 🟢/🟡/🔴 sync dot
  • Conditional project list if no project named in opening message

v1.2.3 — hmem-sync link status in session-start context
  • New --- hmem-sync --- block shows whether writes propagate
```

Keep each release to 2–4 bullets. Skip the "Impact / Migration" section unless it requires user action — flag those separately as 🛠 actions after the summary.

If `gh` is not available or the user is offline, fall back to:
```bash
cd ~/projects/hmem && git log --oneline "v$OLD..v$NEW"
```
and present commit titles instead.

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
            "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem/dist/cli.js log-exchange",
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

## Legacy migration steps (Step 2d–2l)

The following sub-steps apply **only when upgrading from the pre-rename `hmem-mcp`
line (≤ 7.4.x)**. If `hmem --version` reports a 1.x version, the migrations are
already applied at install time — skip directly to Step 3.

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

Tools that moved to `hmem-curate`: `update_many`, `export_memory`, `import_memory`,
`memory_stats`, `memory_health`, `tag_bulk`, `tag_rename`, `move_memory`, `rename_id`, `move_nodes`

> **Note (v1.3.0+):** `reset_memory_cache` is now available in **both** the main server and hmem-curate — no curate server needed to reset the session cache.

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

If `hmem-curate` is not found: `npm update -g hmem` (postinstall sometimes skips bin links).

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
Strato Server  |  P0048 hmem  |  3/5  |  5h: 34%/w: 17%
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

## Step 2g: v7.0.2 — Schema-Section Reconcile for `append_memory`

**Only needed when upgrading from < v7.0.2**

`append_memory` to a schema-enforced root entry (e.g. `append_memory(id="I0002", ...)`) is now
allowed if the content's first line matches a defined schema section name. Previously this was
always blocked ("uses a fixed schema — cannot add new L2 nodes directly").

**Use case:** Adding a section that was added to `hmem.config.json` after the entry was created
(e.g., adding the new `Rules` section to existing I-entries). No manual migration needed —
just run the reconcile step from Step 4c.

No schema changes, no DB migrations.

---

## Step 2h: v7.0.4 - Null-Safe Titles and Richer Session-Start Context

**Only needed when upgrading from < v7.0.4**

### Null-safe title fixes (set_active_device + statusline)

Some I-entries (and potentially other entries) have a NULL title in SQLite. In prior versions this caused set_active_device and the statusline to crash with Cannot read properties of null (reading split). Both are now fixed with (row.title ?? id).split("|")[0].

**No action needed** - the fix is purely in the code. If set_active_device was crashing before, it will now work correctly.

### hook-startup enhancements (first-message context injection)

The UserPromptSubmit hook now injects richer context on the **first message of every session**:

1. **Always-on device reminder** - regardless of whether a device is already set, the agent is reminded to verify the active device matches the current machine and call set_active_device if needed. Previously this reminder was only shown when no device was set at all.

2. **H-entries (human profile)** - up to 10 H-entries (sorted by access count) are injected as a short list (ID  title). Gives the agent immediate context about the user without requiring a separate read_memory(prefix="H") call.

3. **Recent projects** - the 3 most recently updated P-entries are injected as ID  title. Helps the agent recognize which project to load if the user's first message is project-related.

**No config change needed** - all enhancements are automatic from the updated cli-hook-startup.js.

### Windows example config on GitHub

settings.windows.example.json is now in the Bumblebiber/hmem repository. If you are on Windows, refer to it as the canonical example for hook and statusline configuration with "shell": "powershell".

---

## Step 2i: v7.1.0 — load_project Noise Reduction + Skill Improvements

**Only needed when upgrading from < v7.1.0**

### load_project: DONE-filter in schema mode

`load_project` now hides `✓ DONE` and `DONE`-prefixed items from **Roadmap** and **Next Steps** sections when using schema-driven rendering. Previously this filter only applied to legacy rendering mode (no schema). No config change needed — automatic.

### load_project: Project-specific R-entries only

Rules (`R`-prefix entries) are now only shown in `load_project` if the rule has an explicit link to the current project (`r.links.includes(projectId)`). Global rules without a project link are no longer injected. This eliminates ~1k token duplication for projects with many global rules. **Action:** If you have project-specific rules that should appear in `load_project`, ensure they have a `links` entry pointing to the project.

### Skill improvements

- **hmem-dispatch**: New optional `VERIFY` field — specify a shell command the sub-agent must run and return as `[VERIFY_RESULT]`. Use for code-change tasks to close the feedback loop.
- **hmem-curate**: Health check findings now classified as BLOCKER / WARNING / INFO for structured triage.
- **hmem-write**: New "After Writing" verification step — for complex L/D/E entries, read back the written entry and verify it captures "why?", not just "what?".

---

## Step 2j: v7.2.0 — Codebase Node Schema + checkpointPolicy Fix

**Only needed when upgrading from < v7.2.0**

### checkpointPolicy: readonly now correctly scoped

`readonly` on a schema section previously blocked ALL `append_memory` calls under that section (including adding L3 modules or L4 function signatures). This was a bug — the intent was only to prevent adding new L2 sections to a project root.

**New behavior:**
- `append_memory(id="P0048")` → blocked if schema has readonly sections (prevents new L2 sections) ✓
- `append_memory(id="P0048.2")` → allowed (add module to Codebase) ✓
- `append_memory(id="P0048.2.N")` → allowed (add function signature) ✓
- `pointer` policy still enforced at all depths ✓

**Action:** Change `"checkpointPolicy": "readonly"` on the **Codebase** section in your `hmem.config.json` to `"checkpointPolicy": "append"` — the section is now freely appendable by agents.

### Codebase node schema standardized

The `.2 Codebase` section now has a standard 4-level structure:
- **L3 — Pipeline** (auto-created via `defaultChildren`): data flow overview
- **L3.N — Module**: title = filename, body = purpose + `src/file.ts`
- **L4 — Function** (mandatory): title = full TS signature, body = description + `src/file.ts`
- **L5 — Extended Notes** (optional): usage example, caveats, complex param details

Agents update L4 after every code change (enforced via `hmem-subagent` POST-TASK NODE SYNC).

**Action:** Run `load_project` on each active project — the Pipeline sub-node is auto-created via `defaultChildren` reconcile if missing.

---

## Step 2k: v7.2.2 — Richer Session-Start Context + I-Entry Active Device Block

**Only needed when upgrading from < v7.2.2**

### context-inject: 5 most recent projects instead of full list

`hmem context-inject` (SessionStart[clear] hook) now shows only the **5 most recently edited P-entries** instead of all projects. A hint is appended:
```
(full list: read_memory({prefix:"P", titles_only:true}))
```
No config change needed — automatic.

### hook-startup: H-entry title fix

H-entries without a `title` field (entries whose content lives entirely in `level_1`) now display correctly. Previously they appeared as blank lines in the `--- Human context (H-entries) ---` block.

### hook-startup: Active device block

The first-message context injection now includes a **`--- Active device (I00XX) ---`** block showing:
- I-entry body (L1) — device name, specs, IP
- All L2 section titles (Specs, OS, IP Address, Access, Services, Apps, Storage, Notes, Rules)
- For the **Apps** section: full L3 title list (installed software)
- Irrelevant L2/L3 nodes are filtered out

### hook-startup: recent projects limit raised 3 → 5

The `--- Recent projects ---` block in the first-message injection now shows 5 most recently updated P-entries (was 3).

---

## Step 2t: v1.3.8 — Pre-injected session context + checkpointMode fix

**Only relevant for Hermes Agent users.**

### `hmem-startup.sh`: stable context pre-injected — no more MCP roundtrip

The hook now calls `hmem hook-startup` (with explicit stdin pipe) on the first turn and
injects ~3.7k chars of stable context directly: H-entries, recent projects, device info,
sync status, infrastructure favorites, checkpoint status. The `hmem-session-start` skill
starts at STEP 1 (project activation) — the expensive `read_memory(mode='essentials')`
call is eliminated. Session-start time drops from ~20s to ~4s.

### `hmem-startup.sh`: `checkpointMode` respected

The hook now reads `checkpointMode` from `hmem.config.json` and only shows checkpoint
reminders when set to `"remind"`. In `"auto"` mode (default), reminders are suppressed —
checkpoints fire silently in the background.

### `hmem-session-start` skill: STEP 0 removed, H-node detection expanded

- STEP 0 (`read_memory(mode='essentials')`) removed — context is pre-injected
- STEP 5b expanded: full table of 7 required H-slots with detection guide (empty node =
  no `•` children), procedure for asking the user when H0008 is empty, and opportunistic
  fill for other slots

**Action (Hermes hosts):**
```bash
cp ~/projects/hmem/hermes-hooks/hmem-startup.sh ~/.hermes/agent-hooks/hmem-startup.sh
chmod +x ~/.hermes/agent-hooks/hmem-startup.sh
```
(or keep the symlink — no redeploy needed)

No TypeScript changes. No npm behavior change. Hook scripts + skill only.

**Only relevant for Hermes Agent users.**

### `hmem-startup.sh` rewritten — minimal bootstrap, skill-driven session start

The previous Hermes `hmem-startup.sh` duplicated session-start logic (H-entries, projects, sync status, greeting) that the `hmem-session-start` skill already handles better. The new version is a thin shim: sync-pull, write session-id cache for the statusline, inject a one-line directive that invokes the skill, then let the skill do everything else. Subagent calls now silent-pass-through. Long-session warnings added.

**Action (Hermes hosts):**
```bash
cp ~/projects/hmem/hermes-hooks/hmem-startup.sh ~/.hermes/agent-hooks/hmem-startup.sh
chmod +x ~/.hermes/agent-hooks/hmem-startup.sh
```
(or use the symlink option below to never deal with this again.)

### Symlink deployment option

`hmem-release` Step 7b now documents two deployment modes for `hermes-hooks/`:
- **Copy** (default — explicit redeploy each update)
- **Symlink** (`ln -sf ~/projects/hmem/hermes-hooks/$f ~/.hermes/agent-hooks/$f` per file — repo changes are instantly live, no redeploy needed)

Symlinks are recommended on dev devices where the repo lives in a stable path. End users on `npm install -g hmem` can symlink to `node_modules/hmem/hermes-hooks/` if their global install path is stable across updates.

---

## Step 2r: v1.3.6 — Leaner session-start + load_project drill IDs + per-device skill opt-out

**Only relevant when upgrading from ≤ v1.3.5.**

### Rules block (post-/clear injection) now filters to pinned/favorite only

The `## Rules:` listing emitted by the `SessionStart:clear` hook used to dump **every** non-obsolete R-entry — easily a dozen lines of always-on context. It now only shows R-entries with `pinned=true` or `favorite=true`.

**Action:** If a rule must remain omnipresent in every session, pin it explicitly:
```
update_memory(id="R00XX", pinned=true)
```
On first run after upgrade, only previously-pinned rules (typically R0027, R0026, R0010 in a default setup) will surface.

### First-message directive shortened

The 10-line "STEP 1 / STEP 2 / STEP 3" block in `UserPromptSubmit` is now a single sentence (with a hasIntent branch). Saves ~5k tokens on every first message. The `hmem-session-start` skill still drives the actual session-start workflow.

### load_project body sanitisation

XML fragments from tool-call output (`</content>`, `<parameter ...>`, `<function_calls>`) that occasionally leak into stored memory are now stripped on display. Bodies in your hmem are not modified — only the rendered output is cleaned. If you previously saw garbled L2/L3 bodies in `load_project` output, they should now render cleanly.

### Truncation markers include drill IDs

`[+N]` cliffhangers in `load_project` are now `[+N → read PXXXX.Y.Z]` so the agent can drill directly without guessing the path.

### `/hmem-new-rule` skill added

Use it whenever adding a rule:
```
/hmem-new-rule
```
It enforces the cross-project (R-prefix) vs. project-specific (subnode under active project's Rules section) decision **before** writing — a check that the agent has gotten wrong before.

### Per-device skill exclusion via `~/.hmem/skills-disabled`

If certain bundled skills are clutter on a specific device (e.g. setup/migration skills you've already run), create `~/.hmem/skills-disabled` with one skill name per line:
```
hmem-setup
hmem-migrate-o
hmem-sync-setup
```
`hmem update-skills` now skips them and removes any previously-installed copies from `~/.claude/skills/`. The repo continues to ship all skills; only this device opts out. Lines starting with `#` are comments.

### `hmem-release` skill covers hook artifacts

The release checklist (Step 7b + Quick Reference) now explicitly audits `hermes-hooks/`, `plugins/hermes-hmem/`, and `scripts/hmem-*.sh` on every release. Previously, hook changes shipped silently with no verification step.

---

## Step 2l: v7.4.0 — syncSecrets default flipped + non-blocking sync

**Only needed when upgrading from < v7.4.0**

### syncSecrets default is now `false` (was `true`) — BREAKING

Sync configs that omitted `syncSecrets` previously pushed tokens/salts to the sync server. After upgrading, secrets stay local unless `"syncSecrets": true` is set explicitly in `hmem.config.json`. Motivated by the 2026-05-05 credential-exposure incident.

**Action:**
- If you rely on secret-sync between devices (e.g. for `hmem-sync restore` shortcuts), add `"syncSecrets": true` to your sync block.
- Otherwise: nothing to do. The safer default kicks in automatically.

Check your config:
```bash
grep -A 10 '"sync"' "$(dirname "$HMEM_PATH")/hmem.config.json"
```

### Non-blocking sync I/O

`syncPull`, `syncPullThenPush`, `syncPushSync`, `syncPushWithRetry`, `reserveId`, `reserveNextId`, and `reserveNextSubIds` are now async. The stdio transport is no longer frozen during a slow push. Tool behaviour is unchanged for callers.

### Internal: HmemStore.db is `@internal`

If you wrote third-party code that called `store.db.prepare(...)`, prefer the new public methods (`isObsolete`, `hasActiveEntryWithPrefix`, `getNonObsoleteTitle`) — direct access still works but bypasses the integrity-check guard.

### Internal: migration tracking via schema_version

The `MIGRATIONS` array of `ALTER TABLE` statements is now tracked in `schema_version` (`alter_vN`). Genuine errors are logged instead of silently swallowed. No action needed; first open after upgrade marks all known migrations as applied.

---

## Step 2q: Hermes Agent Hooks Deployment

**Only relevant for Hermes Agent users.**

Since v1.3.1, the repo ships `hermes-hooks/` with scripts for Hermes Agent
statusline integration. After npm update, deploy them:

```bash
cp ~/projects/hmem/hermes-hooks/*.sh ~/.hermes/agent-hooks/
chmod +x ~/.hermes/agent-hooks/*.sh
```

The hooks provide:
- `hmem-startup.sh` — Sync-Status, Projekt-Liste, session_id-Cache (pre_llm_call)
- `hmem-log-exchange.sh` — Exchange-Logging an hmem (post_llm_call)
- `hmem-statusline.sh` — CC-Style Statusbar: Device | Projekt → O-Node | Counter

**Hermes CLI Patch:** The statusline integration also requires a small patch
to Hermes Agent's cli.py. Apply with:

```bash
cd ~/.hermes/hermes-agent
git apply ~/projects/hmem/hermes-hooks/hermes-cli-hmem-statusline.patch
```

**Hermes config.yaml** must reference the hooks (see `/hmem-config` for the
full configuration template). After applying the patch and deploying hooks,
restart Hermes for changes to take effect.

---

## Step 2p: v1.3.0 — reset_memory_cache in main server + harness-aware checkpoint

**Only relevant when upgrading from < v1.3.0**

- **`reset_memory_cache` now in main server** — call it directly without needing the hmem-curate server. Useful when `load_project` returns "already active (loaded recently)" and you need a forced reload.
- **Harness-aware checkpoint routing** — Claude Code → Haiku via `claude -p` (Max OAuth), Codex → gpt-5.4-mini, others → configured provider. No config change needed.
- **Orphan-batch catchup** — checkpoint agent now processes up to 5 unsummarized past batches per run. Run `hmem checkpoint` manually to catch up a backlog.
- **Pi hooks known issue** — hook-based exchange logging is currently broken in the Pi runtime. Workaround: run `hmem checkpoint` manually.

No migration required.

---

## Step 2o: v1.2.5 — Pull from hmem-sync before first-message context

**Only relevant when upgrading from < v1.2.5**

`hmem hook-startup` now calls `syncPull(HMEM_PATH)` before reading local SQLite for the greeting/project list. Closes the gap where entries written on another device weren't visible until the agent's first MCP `read_memory` call triggered the existing pull.

- Bounded to 3 seconds — falls back to stale local data if the server is slow or unreachable
- No-op if hmem-sync isn't configured / no `HMEM_SYNC_PASSPHRASE` env var
- 30s cooldown is per-process and won't double-pull with MCP

Typical added latency: ~0ms (no sync) to ~1s (cross-region pull). No action required.

---

## Step 2n: v1.2.4 — Natural session-start greeting

**Only relevant when upgrading from < v1.2.4**

`hmem hook-startup` now drives a natural-language greeting on the first message of every session:

1. **Silent context load** — `load_project` if the user named one, else `read_memory()`.
2. **One-line greeting** in the user's preferred language (from H-entries), with name and a 🟢/🟡/🔴 sync dot.
3. **Conditional project list** — if the first message did NOT mention a project (regex: `lade Projekt`, `load project`, `P\d{4}`, `aktiviere`, `wechsel zu`, `switch to project`, `work on P…`, `open project`), the greeting is followed by the 5 most recent projects and a "Welches?" question.
4. **Then** the agent handles the user's actual message.

Replaces the old `[CORTEX READY]` block output from `hmem-session-start`. No config needed — automatic on next session.

---

## Step 2m: v1.2.3 — hmem-sync link status in session-start context

**Only relevant when upgrading from < v1.2.3**

`hmem hook-startup` now reads `~/.hmem/config.json` on the first message of every session and appends a one-line `--- hmem-sync ---` block to the agent's `additionalContext`:

- `✓ Linked to <server> | active_file: <id> | last sync: <ago>` — writes propagate to other devices on next `hmem-sync push`
- `⚠ Linked … never synced` — run `hmem-sync pull` to fetch
- `⚠ Authenticated … no active file` — run `hmem-sync setup`
- `✗ Not linked` — writes stay local; run `hmem-sync login`
- Silent if `config.json` doesn't exist (hmem-sync never configured)

The `hmem-session-start` skill maps this block to a visible 🟢/🟡/🔴 indicator in the `[CORTEX READY]` output, so the user sees connection state at a glance.

No action required — automatic on next session start.

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
.2  Codebase       (append — L3 modules + L4 signatures freely appendable by agents)
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

**Codebase node structure (`.2`):**
- L3 first child = **Pipeline** (data flow overview)
- L3.N = **Module** (title: filename, body: purpose + `src/file.ts`)
- L4 = **Function** (title: full TS signature, body: one-line description + `src/file.ts`)

Agents update `.2` after every code change (POST-TASK NODE SYNC in hmem-subagent skill).

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
{ "name": "Codebase",     "checkpointPolicy": "append"   },
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

## Step 4c: I-Entry Rules Node Reconciliation

I-entries (Infrastructure/Devices) have a `Rules` section in the schema for device-specific
agent directives. When this section is added to `hmem.config.json`, existing I-entries do NOT
get it automatically — unlike P-entries (which reconcile on `load_project`), I-entries have
no auto-reconcile trigger.

**Check which I-entries are missing Rules:**
```
read_memory(prefix="I", depth=2)
```
Look for entries that don't show a `Rules` L2 node.

**Add the missing Rules node** (requires hmem-mcp ≥ v7.0.2 which allows schema-section
appends to existing root entries):
```
append_memory(id="I00XX", content="Rules\n\tDevice-specific directives here")
```

Fill in relevant directives per device — examples:
- **Server:** sudo access, package manager quirks, which user Claude runs as
- **Dev machine:** OS-specific conventions (apt vs dnf), primary project
- **Mobile/laptop:** availability constraints, work vs personal restrictions
- **Services (npm, rmapi):** access method, credentials location, rate limits

**Note:** If `append_memory` returns "uses a fixed schema — cannot add new L2 nodes directly"
even with "Rules" as the first line, the running MCP server is older than v7.0.2. Update
first (`npm update -g hmem`), then restart Claude Code, then add the Rules nodes.

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
hmem updated: v1.1.0 → v1.2.1

Changes applied:
- Skills synced (2 new, 3 updated)
- 5 P-entries checked against R0009 schema (2 fixed)
- 12 O-entries curated (4 titles fixed, 3 summaries added)
- Smoke test passed ✓
```

---

## Step 10: Surface Any Problems as GitHub Issues

If anything friction-y happened during this update — wrong package name in
the skill, broken migration step, confusing version mismatch, stale MCP config
that wasn't detected, a tool returning unexpected output, anything — tell the
user to file it (or offer to draft the issue yourself):

> 👉 https://github.com/Bumblebiber/hmem/issues

A good issue includes: installed version (`hmem --version`), OS, the exact
command that failed and its output, and what you expected. The faster these
land in the tracker, the faster the next release fixes them.

Also worth running once after the update:

```bash
hmem doctor
```

This scans `~/.claude.json` for stale or deprecated hmem MCP entries (e.g. paths
from another device that no longer exist on this one, or env vars left over
from the pre-v6.0 `HMEM_PROJECT_DIR` + `HMEM_AGENT_ID` syntax). It reports
findings only — never auto-modifies host configs.

---

## Auto-Detection (for hook integration)

This skill can be triggered automatically. At session startup, if the hmem MCP server detects that the installed version differs from the last-seen version stored in the config, it appends a notice to the first `read_memory()` response:

```
⚠ hmem updated: v1.1.0 → v1.2.1. Run /hmem-update to apply post-update steps.
```

The agent should then invoke this skill automatically or ask the user if they want to run it.

**Last-seen version** is stored in `hmem.config.json` under `lastSeenVersion`. Updated automatically after a successful `/hmem-update` run.
