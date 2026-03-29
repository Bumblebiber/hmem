---
name: hmem-setup
description: Interactive setup guide for hmem. Run this skill to install and configure
  the hmem MCP server — installs dependencies, configures .mcp.json, deploys skill
  files, and registers auto-memory hooks for Claude Code, Gemini CLI, or OpenCode.
---

# hmem Setup

## Recommended: `hmem init`

Install hmem globally, then run the interactive installer:

```bash
npm install -g hmem-mcp
hmem init
```

`hmem init` performs all setup steps automatically:
1. Detects installed AI tools (Claude Code, Gemini CLI, OpenCode, Cursor, Windsurf, Cline)
2. Asks for installation scope (system-wide or project-local)
3. Creates the memory directory and optional example database
4. Writes `.mcp.json` with the correct paths for each detected tool
5. Adds session-start instructions to the tool's config file (CLAUDE.md, GEMINI.md, etc.)
6. Creates `hmem.config.json` with sensible defaults
7. Installs all 4 auto-memory hooks (Claude Code only — see Hook Reference below)
8. Copies skill files (slash commands) to the tool's skill directory

After `hmem init`, install the slash-command skills:

```bash
npx hmem update-skills
```

Restart your AI tool and call `read_memory()` to verify.

Non-interactive mode (CI / scripting):

```bash
hmem init --global --tools claude-code --dir ~/.hmem --no-example
```

---

## Hook Reference (Claude Code)

`hmem init` registers 4 hooks in `~/.claude/settings.json`. Each hook is a bash script in `~/.claude/hooks/`.

### 1. UserPromptSubmit — memory load + checkpoint reminder

Script: `~/.claude/hooks/hmem-startup.sh`

- **First message**: injects `additionalContext` telling the agent to call `read_memory()` silently.
- **Every Nth message** (N = `checkpointInterval`, default 20): injects a checkpoint reminder.
  - `checkpointMode: "remind"` — adds an `additionalContext` nudge; the agent decides what to save.
  - `checkpointMode: "auto"` — checkpoint is handled by the Stop hook instead (no reminder injected).
- Subagents (messages with `parentUuid`) are skipped.
- Uses a per-session counter file at `/tmp/claude-hmem-counter-{SESSION_ID}`.

### 2. Stop (sync) — exchange logging

Script: `~/.claude/hooks/hmem-log-exchange.sh`

- Runs synchronously after every agent response (timeout: 10s).
- Pipes the Stop hook JSON (containing `transcript_path` and `last_assistant_message`) to `hmem log-exchange`.
- `hmem log-exchange` reads the last user message from the JSONL transcript, combines it with the agent response, and appends both to the currently active O-entry (session history).
- If no active O-entry exists, one is created automatically.

### 3. Stop (async) — auto-title O-entries

Script: `~/.claude/hooks/hmem-title-o-entries.sh`

- Runs asynchronously after every agent response (timeout: 30s).
- Finds O-entries with title "unassigned" or empty.
- Reads the first 5 exchanges from each untitled entry.
- Calls `claude -p --model haiku` to generate a concise one-line title (max 50 chars).
- Updates the O-entry title in the SQLite database directly.

### 4. SessionStart[clear] — context re-injection

Script: `~/.claude/hooks/hmem-context-inject.sh`

- Fires only after `/clear` (matcher: `"clear"`).
- Pipes session JSON to `hmem context-inject`, which outputs `additionalContext` containing:
  - Last 20 user/assistant messages from the pre-clear transcript
  - Active project briefing (title + overview)
  - Recent O-entries (session logs) linked to the project
  - R-entries (rules)
- Keeps the agent oriented after a context reset without a full `read_memory()` call.

---

## Configuration Reference

Place `hmem.config.json` in your memory directory (the path you chose during `hmem init`). All keys are optional — defaults are applied for anything missing.

```json
{
  "memory": {
    "maxCharsPerLevel": [200, 2500, 10000, 25000, 50000],
    "maxDepth": 5,
    "defaultReadLimit": 100,
    "maxTitleChars": 50,
    "checkpointInterval": 20,
    "checkpointMode": "remind",
    "recentOEntries": 10,
    "contextTokenThreshold": 100000,
    "bulkReadV2": {
      "topAccessCount": 3,
      "topNewestCount": 5,
      "topObsoleteCount": 3,
      "topSubnodeCount": 3,
      "newestPercent": 20,
      "newestMin": 5,
      "newestMax": 15,
      "accessPercent": 10,
      "accessMin": 3,
      "accessMax": 8
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxCharsPerLevel` | `number[]` | `[200,2500,10000,25000,50000]` | Character limit per tree depth (L1..L5). Alternative: set `maxL1Chars` + `maxLnChars` and levels are interpolated linearly. |
| `maxDepth` | `number` | `5` | Max tree depth (1 = L1 only, 5 = full). |
| `defaultReadLimit` | `number` | `100` | Max entries returned by a default `read_memory()`. |
| `maxTitleChars` | `number` | `50` | Max characters for auto-extracted titles. |
| `checkpointInterval` | `number` | `20` | Messages between checkpoint reminders. Set 0 to disable. |
| `checkpointMode` | `"remind"` or `"auto"` | `"remind"` | `"remind"` = inject a save-reminder via `additionalContext`. `"auto"` = spawn a Haiku subagent that saves directly (no user interaction). |
| `recentOEntries` | `number` | `10` | Number of recent O-entries (session logs) injected at startup and on `load_project`. Set 0 to disable. |
| `contextTokenThreshold` | `number` | `100000` | Token threshold for context-clear recommendation. When cumulative hmem output exceeds this, the agent is told to flush + `/clear`. Set 0 to disable. |

**Bulk-read tuning** (`bulkReadV2`): controls which entries get expanded (all L2 children shown) in a default `read_memory()` call. Per prefix category, the top N newest + top M most-accessed entries are expanded. Favorites are always expanded.

| Key | Default | Description |
|-----|---------|-------------|
| `topAccessCount` | `3` | Fixed fallback: top-accessed entries to expand. |
| `topNewestCount` | `5` | Fixed fallback: newest entries to expand. |
| `topObsoleteCount` | `3` | Obsolete entries to keep visible. |
| `topSubnodeCount` | `3` | Entries with most sub-nodes to always expand. |
| `newestPercent` | `20` | Percentage-based selection (overrides `topNewestCount`). |
| `newestMin` / `newestMax` | `5` / `15` | Clamp for percentage-based newest selection. |
| `accessPercent` | `10` | Percentage-based selection (overrides `topAccessCount`). |
| `accessMin` / `accessMax` | `3` / `8` | Clamp for percentage-based access selection. |

---

## Manual Setup (Fallback)

Use these steps only if `hmem init` is not available (e.g., local clone without global install).

### Step 0 — Prerequisites

```bash
node --version    # must be >= 18
npm --version     # any recent version
```

`better-sqlite3` requires native build tools:

| OS | Install |
|----|---------|
| Linux (Debian/Ubuntu) | `sudo apt install python3 make g++` |
| Linux (Arch) | `sudo pacman -S python make gcc` |
| macOS | `xcode-select --install` |
| Windows | `npm install -g windows-build-tools` |

### Step 1 — Clone and Build

```bash
git clone https://github.com/Bumblebiber/hmem.git
cd hmem
npm install
npm run build
```

Verify: `dist/mcp-server.js` must exist after build.

### Step 2 — Create Memory Directory

```bash
mkdir -p /your/project/Agents/YOUR_NAME
```

The SQLite `.hmem` file is created automatically on first write.

### Step 3 — Configure MCP

Add hmem to your `.mcp.json` (create it at your project root if it does not exist). All paths must be absolute.

```json
{
  "mcpServers": {
    "hmem": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/hmem/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/absolute/path/to/your/project",
        "HMEM_AGENT_ID": "YOUR_NAME",
        "HMEM_AGENT_ROLE": "worker"
      }
    }
  }
}
```

| Variable | Description |
|----------|-------------|
| `HMEM_PROJECT_DIR` | Root directory where `.hmem` files are stored |
| `HMEM_AGENT_ID` | Unique identifier for this agent (e.g. `ALICE`, `DEVELOPER`) |
| `HMEM_AGENT_ROLE` | Permission level: `worker` / `al` / `pl` / `ceo` |

### Step 4 — Install Skill Files

Copy skill files to the global skills directory for your tool:

**Claude Code:**
```bash
mkdir -p ~/.claude/skills/hmem-read ~/.claude/skills/hmem-write ~/.claude/skills/save ~/.claude/skills/memory-curate
cp /path/to/hmem/skills/hmem-read/SKILL.md ~/.claude/skills/hmem-read/SKILL.md
cp /path/to/hmem/skills/hmem-write/SKILL.md ~/.claude/skills/hmem-write/SKILL.md
cp /path/to/hmem/skills/save/SKILL.md ~/.claude/skills/save/SKILL.md
cp /path/to/hmem/skills/memory-curate/SKILL.md ~/.claude/skills/memory-curate/SKILL.md
```

**Gemini CLI:**
```bash
mkdir -p ~/.gemini/skills/hmem-read ~/.gemini/skills/hmem-write ~/.gemini/skills/save ~/.gemini/skills/memory-curate
cp /path/to/hmem/skills/*/SKILL.md to corresponding ~/.gemini/skills/*/SKILL.md
```

### Step 5 — Verify

Fully restart your AI tool (exit and reopen — `/clear` is not enough). Then call:

```
read_memory()
```

Expected: `Memory is empty` (or your existing memories).

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `HMEM_PROJECT_DIR not set` | Path missing or wrong env var name in `.mcp.json` |
| `No such tool: read_memory` | Tool not restarted after adding `.mcp.json` |
| `npm install` fails | Missing build tools (see Prerequisites above) |
| `read_memory` returns empty after writing | MCP server process is stale — restart tool |
| Hooks not firing | Check `~/.claude/settings.json` — hooks must be registered there |
| Checkpoint reminders not appearing | Verify `checkpointInterval > 0` in `hmem.config.json` |

---

## Quick Reference — After Setup

```
read_memory()                          # see all L1 memories
read_memory(id="L0001")               # drill into one entry
write_memory(prefix="L", content="Short title\n> Detailed body text\n\tL2 sub-node")
search_memory(query="error node.js")  # search across all memories
```

Use `>` lines for body text (hidden in listings, shown on drill-down). See `hmem-write` skill for details.

See `skills/hmem-read/SKILL.md` and `skills/hmem-write/SKILL.md` for full usage.
