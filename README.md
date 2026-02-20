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

### 1. Build

```bash
git clone https://github.com/Bumblebiber/hmem.git
cd hmem
npm install
npm run build
```

### 2. Verify the server starts

Before connecting to your AI tool, test the server directly:

```bash
# Linux / macOS
HMEM_PROJECT_DIR="/absolute/path/to/hmem" node dist/mcp-server.js

# Windows (PowerShell)
$env:HMEM_PROJECT_DIR="C:\path\to\hmem"; node dist\mcp-server.js
```

Expected output: `[MCP:...] Config: levels=[120,...] depth=5 ...` — then the process waits (that's correct, it's listening on stdio).
Press `Ctrl+C` to stop.

If you see an error here, fix it before proceeding to step 3.

### 3. Register the MCP server

Choose the method for your AI tool:

---

**Claude Code** — global registration (works in any directory):

```bash
claude mcp add hmem -s user node "/absolute/path/to/hmem/dist/mcp-server.js" \
  --env HMEM_PROJECT_DIR="/absolute/path/to/hmem" \
  --env HMEM_AGENT_ID="YOUR_AGENT_NAME"
```

> **Windows note:** If your path contains spaces (e.g. `C:\My Documents\...`), verify the entry in `~/.claude.json` after running this command — Claude Code may store the path incorrectly. Open the file and ensure the path uses double backslashes: `"C:\\My Documents\\hmem\\dist\\mcp-server.js"`. Fix manually if needed.

---

**Gemini CLI / OpenCode** — place `.mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "hmem": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/hmem/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/absolute/path/to/hmem",
        "HMEM_AGENT_ID": "YOUR_AGENT_NAME"
      }
    }
  }
}
```

`HMEM_AGENT_ID` is optional — if not set, memories are stored in `memory.hmem` at the project root.

---

### 4. Verify the connection

Fully restart your AI tool, then run `/hmem-read` (after installing skill files below) or call `read_memory()` directly. You should see a memory listing (empty on first run is fine).

If the tool is not available, run `/mcp` in Claude Code to check the server status.

For complete setup instructions, run `/hmem-setup` in your AI tool (after installing the skill files below).

---

## Skill Files

Skill files teach your AI tool how to use hmem correctly. Copy them to your tool's global skills directory:

> **After copying skills, fully restart your terminal and AI tool** — skills are loaded at startup and won't appear in a running session.

**Claude Code:**
```bash
mkdir -p ~/.claude/skills/hmem-read ~/.claude/skills/hmem-write ~/.claude/skills/save ~/.claude/skills/memory-curate
cp skills/hmem-read/SKILL.md ~/.claude/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.claude/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.claude/skills/save/SKILL.md
cp skills/memory-curate/SKILL.md ~/.claude/skills/memory-curate/SKILL.md
```

**Gemini CLI:**
```bash
mkdir -p ~/.gemini/skills/hmem-read ~/.gemini/skills/hmem-write ~/.gemini/skills/save ~/.gemini/skills/memory-curate
cp skills/hmem-read/SKILL.md ~/.gemini/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.gemini/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.gemini/skills/save/SKILL.md
cp skills/memory-curate/SKILL.md ~/.gemini/skills/memory-curate/SKILL.md
```

**OpenCode:**
```bash
mkdir -p ~/.config/opencode/skills/hmem-read ~/.config/opencode/skills/hmem-write ~/.config/opencode/skills/save ~/.config/opencode/skills/memory-curate
cp skills/hmem-read/SKILL.md ~/.config/opencode/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.config/opencode/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.config/opencode/skills/save/SKILL.md
cp skills/memory-curate/SKILL.md ~/.config/opencode/skills/memory-curate/SKILL.md
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

### Das Althing Integration Tools

hmem also bundles tools for the [Das Althing](https://github.com/Bumblebiber/das-althing) multi-agent orchestrator. If you're not using Das Althing, these tools will be visible but inactive:

`spawn_agent`, `list_templates`, `get_budget_status`, `get_agent_status`, `send_message`, `get_all_agents`, `cancel_agent`, `suggest_brainstorm_team`

These will be split into a separate package in a future release.

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
  ]
}
```

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
