---
name: hmem-setup
description: Interactive setup guide for hmem. Run this skill to install and configure
  the hmem MCP server — installs dependencies, configures .mcp.json, and deploys
  skill files to the correct global locations for Claude Code, Gemini CLI, or OpenCode.
---

# hmem Setup

## Step 0 — Prerequisites

Check before proceeding:

```bash
node --version    # must be >= 18
npm --version     # any recent version
```

`better-sqlite3` requires native build tools. If `npm install` fails later:

| OS | Install |
|----|---------|
| Linux (Debian/Ubuntu) | `sudo apt install python3 make g++` |
| Linux (Arch) | `sudo pacman -S python make gcc` |
| macOS | `xcode-select --install` |
| Windows | `npm install -g windows-build-tools` |

---

## Step 1 — Clone and Build

```bash
git clone https://github.com/Bumblebiber/hmem.git
cd hmem
npm install
npm run build
```

Verify: `dist/mcp-server.js` must exist after build. If the build fails, fix errors
before continuing — everything else depends on this file.

---

## Step 2 — Create Agent Directory

hmem stores each agent's memory at `{HMEM_PROJECT_DIR}/Agents/{AGENT_ID}/{AGENT_ID}.hmem`.
The SQLite file is created automatically on first write — just create the folder:

```bash
mkdir -p /your/project/Agents/YOUR_NAME
```

For shared team knowledge (optional), hmem uses a `FIRMENWISSEN.hmem` file at the
project root — created automatically on first `write_memory(store="company")`.

---

## Step 3 — Configure MCP

Add hmem to your `.mcp.json` (create it at your project root if it doesn't exist):

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

**All paths must be absolute** — relative paths will fail silently.

| Variable | Description |
|----------|-------------|
| `HMEM_PROJECT_DIR` | Root directory where `.hmem` files are stored |
| `HMEM_AGENT_ID` | Unique identifier for this agent (e.g. `ALICE`, `DEVELOPER`) |
| `HMEM_AGENT_ROLE` | Permission level: `worker` · `al` · `pl` · `ceo` |

Roles control what entries in the shared `FIRMENWISSEN` store are visible.
`worker` sees everything marked `min_role: worker`. Higher roles unlock more.

---

## Step 4 — Install Skill Files

Skill files teach your AI tool how to use `read_memory` and `write_memory`.
Copy both to the global skills directory for your tool:

**Claude Code:**
```bash
mkdir -p ~/.claude/skills/hmem-read ~/.claude/skills/hmem-write
cp /path/to/hmem/skills/hmem-read/SKILL.md ~/.claude/skills/hmem-read/SKILL.md
cp /path/to/hmem/skills/hmem-write/SKILL.md ~/.claude/skills/hmem-write/SKILL.md
```

**Gemini CLI:**
```bash
mkdir -p ~/.gemini/skills/hmem-read ~/.gemini/skills/hmem-write
cp /path/to/hmem/skills/hmem-read/SKILL.md ~/.gemini/skills/hmem-read/SKILL.md
cp /path/to/hmem/skills/hmem-write/SKILL.md ~/.gemini/skills/hmem-write/SKILL.md
```

**OpenCode:**
```bash
mkdir -p ~/.config/opencode/skills/hmem-read ~/.config/opencode/skills/hmem-write
cp /path/to/hmem/skills/hmem-read/SKILL.md ~/.config/opencode/skills/hmem-read/SKILL.md
cp /path/to/hmem/skills/hmem-write/SKILL.md ~/.config/opencode/skills/hmem-write/SKILL.md
```

---

## Step 5 — Verify

**Fully restart** your AI tool (exit and reopen — `/clear` is not enough).
Then call:

```
read_memory()
```

Expected: `Memory is empty` (or your existing memories if any).

**Troubleshooting:**

| Symptom | Likely cause |
|---------|-------------|
| `HMEM_PROJECT_DIR not set` | Path missing or wrong env var name in `.mcp.json` |
| `No such tool: read_memory` | Tool not restarted after adding `.mcp.json` |
| `npm install` fails | Missing build tools (see Step 0) |
| `read_memory` returns empty after writing | MCP server process is stale — restart tool |

---

## Quick Reference — After Setup

```
read_memory()                          # see all your Level 1 memories
read_memory(id="L0001")               # drill into one entry
write_memory(prefix="L", content="…") # save a lesson learned
search_memory(query="error node.js")  # search across all memories
```

See `skills/hmem-read/SKILL.md` and `skills/hmem-write/SKILL.md` for full usage.
