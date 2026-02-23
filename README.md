# hmem — Humanlike Memory for AI Agents

> AI agents forget everything when a session ends. hmem changes that.

> **Beta:** hmem is functional and actively used in production, but APIs and file formats
> may still change. Feedback and bug reports welcome.

**hmem** is a Model Context Protocol (MCP) server that gives AI agents persistent, humanlike memory — modeled after how human memory actually works.

Born as a side project of a multi-agent AI system, hmem solves a real problem: when you work across multiple machines or sessions, your AI instances start from zero every time. They duplicate work, contradict previous decisions, and lose hard-won context.

**hmem fixes this.**

---

## The Problem

When working across multiple PCs with AI coding agents, every new session was a fresh start. Agents had no knowledge of previous decisions, duplicated work, produced inconsistencies, and wasted tokens catching up.

Existing RAG solutions are flat — every memory fragment has the same abstraction level. The agent either gets too much detail and wastes tokens, or too little and loses nuance.

---

## The Solution: 5-Level Humanlike Memory

hmem stores and retrieves memory in five nested levels of detail — mirroring how human memory works.

```
Level 1  ──  Coarse summary         (always loaded on spawn)
  Level 2  ──  More detail
    Level 3  ──  Deep context
      Level 4  ──  Fine-grained specifics
        Level 5  ──  Full verbatim detail
```

A freshly spawned agent receives only Level 1 — the broadest strokes. When it needs more detail on a specific topic, it makes a tool call to retrieve Level 2 for that entry. And so on, down to full detail.

**Result: Agents load exactly as much context as they need — no more, no less.**

---

## How It Works

### Saving Memory

After completing a task, an agent calls `write_memory` with tab-indented content. The indentation depth maps to memory levels — multiple entries at the same depth become siblings.

```
write_memory(prefix="L", content="Always restart MCP server after recompiling TypeScript
	Running process holds old dist — tool calls return stale results
	Fix: kill $(pgrep -f mcp-server)")
```

### Loading Memory

On spawn, the agent receives all Level 1 summaries. Deeper levels are fetched on demand — by ID, one branch at a time.

```
read_memory()              # → all L1 summaries (~20 tokens)
read_memory(id="L0003")    # → L1 + direct L2 children for this entry
read_memory(id="L0003.2")  # → that L2 node + its L3 children
```

Each node gets a compound ID (`L0003.2.1`) so any branch is individually addressable.

### Memory Curation

A dedicated curator agent runs periodically to maintain memory health. It tracks retrieval counts per entry, promotes frequently accessed memories, and prunes rarely accessed ones — a form of the Ebbinghaus Forgetting Curve.

---

## Key Features

- **Hierarchical retrieval** — lazy loading of detail levels saves tokens
- **True tree structure** — multiple siblings at the same depth (not just one chain)
- **Persistent across sessions** — agents remember previous work even after restart
- **Per-agent memory** — each agent has its own `.hmem` file (SQLite)
- **Shared company knowledge** — `FIRMENWISSEN` store with role-based access control
- **Retrieval counting** — built-in importance scoring based on access frequency
- **Skill-file driven** — agents are instructed via skill files, no hardcoded logic
- **MCP-native** — works with Claude Code, Gemini CLI, OpenCode, and any MCP-compatible tool

---

## Quick Start

### Option A: Install from npm (Recommended)

```bash
npx hmem-mcp init
```

That's it. The interactive installer will:
- Detect your installed AI coding tools (Claude Code, OpenCode, Cursor, Windsurf, Cline)
- Ask whether to install **system-wide** (memories in `~/.hmem/`) or **project-local** (memories in current directory)
- Configure each tool's MCP settings automatically
- Create the memory directory and `hmem.config.json`

After the installer finishes, restart your AI tool and call `read_memory()` to verify.

### Option B: Install from source

```bash
git clone https://github.com/Bumblebiber/hmem.git
cd hmem
npm install && npm run build
node dist/cli.js init
```

### Option C: Manual Setup (no installer)

If you prefer to configure everything yourself:

#### 1. Install

```bash
npm install -g hmem-mcp
```

Or from source: `git clone https://github.com/Bumblebiber/hmem.git && cd hmem && npm install && npm run build`

#### 2. Register the MCP server

**Claude Code** — global registration:

```bash
claude mcp add hmem -s user -- npx hmem-mcp serve \
  --env HMEM_PROJECT_DIR="$HOME/.hmem"
```

**OpenCode** — add to `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "mcp": {
    "hmem": {
      "type": "local",
      "command": ["npx", "hmem", "serve"],
      "environment": {
        "HMEM_PROJECT_DIR": "~/.hmem"
      },
      "enabled": true
    }
  }
}
```

**Cursor / Windsurf / Cline** — add to `~/.cursor/mcp.json` (or equivalent):

```json
{
  "mcpServers": {
    "hmem": {
      "command": "npx",
      "args": ["hmem", "serve"],
      "env": {
        "HMEM_PROJECT_DIR": "~/.hmem"
      }
    }
  }
}
```

> **Windows note:** Use forward slashes or double backslashes in JSON paths.

#### 3. Verify the connection

Fully restart your AI tool, then call `read_memory()`. You should see a memory listing (empty on first run is fine).

In Claude Code, run `/mcp` to check the server status.

---

## Skill Files

Skill files teach your AI tool how to use hmem correctly. Copy them to your tool's global skills directory, then restart your AI tool.

> **After copying skills, fully restart your terminal and AI tool** — skills are loaded at startup and won't appear in a running session.

### Available skills

| Slash command | What it does | Notes |
|---|---|---|
| `/hmem-read` | Load your memory at session start | Call this at the beginning of every session |
| `/save` | Save session learnings to memory, then commit + push | Commit/push only runs if you are inside a git repo with uncommitted changes |
| `/hmem-config` | View and adjust memory settings (`hmem.config.json`) | Explains each parameter, lets you change values interactively |
| `/memory-curate` | Audit and clean up memory entries | Advanced — untested, use with caution |

### Copy skills to your tool

Find the skills directory in the installed package:

```bash
HMEM_DIR="$(npm root -g)/hmem-mcp"
```

If you cloned from source, the skills are in the `skills/` directory.

**Claude Code:**
```bash
for skill in hmem-read hmem-write save hmem-config memory-curate; do
  mkdir -p ~/.claude/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.claude/skills/$skill/SKILL.md
done
```

**Gemini CLI:**
```bash
for skill in hmem-read hmem-write save hmem-config memory-curate; do
  mkdir -p ~/.gemini/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.gemini/skills/$skill/SKILL.md
done
```

**OpenCode:**
```bash
for skill in hmem-read hmem-write save hmem-config memory-curate; do
  mkdir -p ~/.config/opencode/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.config/opencode/skills/$skill/SKILL.md
done
```

---

## MCP Tools

### Memory Tools

| Tool | Description |
|------|-------------|
| `read_memory` | Read hierarchical memories — L1 summaries or drill into any node by ID |
| `write_memory` | Save new memory entries with tab-indented hierarchy |
| `search_memory` | Full-text search across all agent `.hmem` databases |

### Curator Tools (role: ceo)

| Tool | Description |
|------|-------------|
| `get_audit_queue` | List agents whose memory has changed since last audit |
| `read_agent_memory` | Read any agent's full memory (for curation) |
| `fix_agent_memory` | Correct a specific memory entry |
| `delete_agent_memory` | Delete a memory entry (use sparingly) |
| `mark_audited` | Mark an agent as audited |

---

## Memory Directory

hmem stores all memory files (`.hmem` SQLite databases) and its configuration (`hmem.config.json`) in a single directory. The location depends on how you install:

| Install mode | Memory directory | Example |
|---|---|---|
| **System-wide** | `~/.hmem/` | `/home/alice/.hmem/` or `C:\Users\Alice\.hmem\` |
| **Project-local** | Project root (cwd) | `/home/alice/my-project/` |

The `hmem init` installer asks which mode you prefer and creates the directory automatically.

### Directory structure

```
~/.hmem/                     # System-wide memory directory
  memory.hmem                # Default agent memory (when no HMEM_AGENT_ID is set)
  SIGURD.hmem                # Named agent memory (HMEM_AGENT_ID=SIGURD)
  FIRMENWISSEN.hmem          # Shared company knowledge (optional)
  hmem.config.json           # Configuration file
  audit_state.json           # Curator state (optional)
```

The MCP configuration files are written to each tool's own config directory — not into `~/.hmem/`:

| Tool | Global MCP config path |
|---|---|
| Claude Code | `~/.claude/.mcp.json` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline / Roo Code | `.vscode/mcp.json` (project-only) |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HMEM_PROJECT_DIR` | Root directory where `.hmem` files are stored | *(required)* |
| `HMEM_AGENT_ID` | Agent identifier — used as filename and directory name | `""` → `memory.hmem` |
| `HMEM_AGENT_ROLE` | Permission level: `worker` · `al` · `pl` · `ceo` | `worker` |

---

## Configuration (hmem.config.json)

Place an optional `hmem.config.json` in your `HMEM_PROJECT_DIR` to tune behavior. All keys are optional — missing keys fall back to defaults.

```json
{
  "maxL1Chars": 120,
  "maxLnChars": 50000,
  "maxDepth": 5,
  "defaultReadLimit": 100,
  "recentDepthTiers": [
    { "count": 10, "depth": 2 },
    { "count": 3,  "depth": 3 }
  ],
  "prefixes": {
    "P": "Project",
    "L": "Lesson",
    "T": "Task",
    "E": "Error",
    "D": "Decision",
    "M": "Milestone",
    "S": "Skill",
    "F": "Favorite"
  }
}
```

### Custom prefixes

The default prefixes (P, L, T, E, D, M, S, F) cover most use cases. To add your own, add entries to the `"prefixes"` key:

```json
{
  "prefixes": {
    "R": "Research",
    "B": "Bookmark",
    "Q": "Question"
  }
}
```

Custom prefixes are **merged** with the defaults — you don't need to repeat the built-in ones. After adding prefixes, restart your AI tool so the MCP server picks up the new config.

**Note:** Favorites (F) are special — they are always loaded with L2 detail, regardless of recency position.

### Character limits

Two ways to set per-level character limits:

**Option A — linear interpolation** (recommended): set only the endpoints; all levels in between are computed automatically.

```json
{ "maxL1Chars": 120, "maxLnChars": 50000 }
```

With 5 depth levels this yields: `[120, 12780, 25440, 38120, 50000]`

**Option B — explicit per-level array**: set each level individually. If fewer entries than `maxDepth`, the last value is repeated.

```json
{ "maxCharsPerLevel": [120, 2500, 10000, 25000, 50000] }
```

### Recency gradient (`recentDepthTiers`)

Controls how deep children are inlined for the most recent entries in a default `read_memory()` call. Each tier is `{ count, depth }`: the *count* most recent entries get children inlined up to *depth*.

Tiers are cumulative — the **highest applicable depth wins** for each entry position.

```json
"recentDepthTiers": [
  { "count": 3,  "depth": 3 },   // last 3 entries  → L1 + L2 + L3
  { "count": 10, "depth": 2 }    // last 10 entries → L1 + L2
]
```

Result:
| Entry position | Depth inlined |
|---|---|
| 0–2 (most recent) | L1 + L2 + L3 |
| 3–9 | L1 + L2 |
| 10+ | L1 only |

This mirrors how human memory works: you remember today's events in full detail, last week's in outline, older ones only as headlines.

Set to `[]` to disable recency inlining (L1-only for all entries, same as before v1.1).

**Backward compat:** The old `"recentChildrenCount": N` key is still accepted and treated as `[{ "count": N, "depth": 2 }]`.

---

## Origin

hmem was developed out of necessity: working on a large AI project across multiple machines meant every new Claude Code session started blind. Agents redid work, lost decisions, and contradicted each other.

The solution was a memory protocol that works the way humans remember — broad strokes first, details on demand.

---

## License

MIT
