# hmem — Hierarchical Memory for AI Agents

> AI agents forget everything when a session ends. hmem changes that.

> **Beta:** hmem is functional and actively used in production, but APIs and file formats
> may still change. Feedback and bug reports welcome.

**hmem** is a Model Context Protocol (MCP) server that gives AI agents persistent, hierarchical memory — modeled after how human memory actually works.

Born as a side project of a multi-agent AI system, hmem solves a real problem: when you work across multiple machines or sessions, your AI instances start from zero every time. They duplicate work, contradict previous decisions, and lose hard-won context.

**hmem fixes this.**

---

## The Problem

When working across multiple PCs with AI coding agents, every new session was a fresh start. Agents had no knowledge of previous decisions, duplicated work, produced inconsistencies, and wasted tokens catching up.

Existing RAG solutions are flat — every memory fragment has the same abstraction level. The agent either gets too much detail and wastes tokens, or too little and loses nuance.

---

## The Solution: 5-Level Hierarchical Memory

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

```bash
git clone https://github.com/Bumblebiber/hmem.git
cd hmem
npm install
npm run build
```

Place `.mcp.json` in the directory where you open your terminal or IDE — Claude Code, Gemini CLI, and OpenCode discover it from the current working directory.

```json
{
  "mcpServers": {
    "hmem": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/hmem/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```

**All paths must be absolute.** `HMEM_AGENT_ID` is optional — if not set, memories are stored in `memory.hmem` at the project root.

Fully restart your AI tool after adding `.mcp.json`, then call `read_memory()` to verify.

For complete setup instructions, run `/hmem-setup` in your AI tool (after installing the skill files below).

---

## Skill Files

Skill files teach your AI tool how to use hmem correctly. Copy them to your tool's global skills directory:

**Claude Code:**
```bash
mkdir -p ~/.claude/skills/hmem-read ~/.claude/skills/hmem-write ~/.claude/skills/save
cp skills/hmem-read/SKILL.md ~/.claude/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.claude/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.claude/skills/save/SKILL.md
```

**Gemini CLI:**
```bash
mkdir -p ~/.gemini/skills/hmem-read ~/.gemini/skills/hmem-write ~/.gemini/skills/save
cp skills/hmem-read/SKILL.md ~/.gemini/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.gemini/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.gemini/skills/save/SKILL.md
```

**OpenCode:**
```bash
mkdir -p ~/.config/opencode/skills/hmem-read ~/.config/opencode/skills/hmem-write ~/.config/opencode/skills/save
cp skills/hmem-read/SKILL.md ~/.config/opencode/skills/hmem-read/SKILL.md
cp skills/hmem-write/SKILL.md ~/.config/opencode/skills/hmem-write/SKILL.md
cp skills/save/SKILL.md ~/.config/opencode/skills/save/SKILL.md
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

## Origin

hmem was developed out of necessity: working on a large AI project across multiple machines meant every new Claude Code session started blind. Agents redid work, lost decisions, and contradicted each other.

The solution was a memory protocol that works the way humans remember — broad strokes first, details on demand.

---

## License

MIT
