---
name: hmem-setup
description: "Set up and configure the hmem memory system. Run this skill to install hmem, initialize the MCP server, deploy skill files, and register auto-memory hooks for Claude Code, Gemini CLI, or OpenCode. Covers first-time setup, manual installation, and post-setup verification."
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
7. Installs all 4 auto-memory hooks (Claude Code only — see [Hook Reference](references/HOOKS.md))
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

## Hooks and Configuration

For detailed reference material on hooks and configuration options, see:

- **[Hook Reference](references/HOOKS.md)** — describes the 4 Claude Code hooks registered by `hmem init` (UserPromptSubmit, Stop, SessionStart)
- **[Configuration Reference](references/CONFIG.md)** — full `hmem.config.json` schema, defaults, and bulk-read tuning parameters

Key configuration defaults: `checkpointInterval: 20`, `checkpointMode: "remind"`, `contextTokenThreshold: 100000`. Place `hmem.config.json` in the memory directory chosen during `hmem init`.

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
mkdir -p ~/.hmem
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
        "HMEM_PATH": "/absolute/path/to/your/memory.hmem",
        "HMEM_AGENT_ROLE": "worker"
      }
    }
  }
}
```

| Variable | Description |
|----------|-------------|
| `HMEM_PATH` | Absolute path to your .hmem file (e.g. `~/.hmem/memory.hmem`) |
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
| `HMEM_PATH not set` | Path missing or wrong env var name in `.mcp.json` |
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
write_memory(prefix="L", content="Short title\n\nDetailed body text\n\tL2 sub-node")
search_memory(query="error node.js")  # search across all memories
```

Separate title from body with a blank line (hidden in listings, shown on drill-down). See `hmem-write` skill for details.

See `skills/hmem-read/SKILL.md` and `skills/hmem-write/SKILL.md` for full usage.
