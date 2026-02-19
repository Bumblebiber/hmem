# hmem — Hierarchical Memory for AI Agents

> AI agents forget everything when a session ends. hmem changes that.

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

A freshly spawned agent receives only Level 1 — the broadest strokes. When it needs more detail on a specific topic, it makes a tool call to retrieve Level 2 for that entry. And so on, recursively, down to full detail.

**Result: Agents load exactly as much context as they need — no more, no less.**

---

## How It Works

### Saving Memory

After completing a task, an agent uses the hmem MCP tool to save its experience to the database. A skill file instructs the agent on what to save, at which level, and how to structure the entry.

### Loading Memory

On spawn, the agent receives Level 1 memories automatically. Deeper levels are fetched on demand via tool calls — only when relevant.

### Memory Curation

A dedicated curator agent runs periodically to maintain memory health. It tracks retrieval counts per memory entry, promotes frequently accessed memories, and summarizes or prunes rarely accessed ones. This implements a form of the Ebbinghaus Forgetting Curve: memories that are never retrieved fade; memories that matter stay sharp.

---

## Key Features

- **Hierarchical retrieval** — lazy loading of detail levels saves tokens
- **Persistent across sessions** — agents remember previous work even after restart
- **Per-agent memory** — each agent has its own `.hmem` file (SQLite)
- **Shared company knowledge** — FIRMENWISSEN store with role-based access control
- **Retrieval counting** — built-in importance scoring based on access frequency
- **Skill-file driven** — agents are instructed via a skill file, no hardcoded logic
- **MCP-native** — integrates directly with Claude Code, Gemini CLI, OpenCode, and any MCP-compatible AI system

---

## Quick Start

```bash
npm install
npm run build
```

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "hmem": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/hmem/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/path/to/your/project",
        "HMEM_AGENT_ID": "MY_AGENT",
        "HMEM_AGENT_ROLE": "worker"
      }
    }
  }
}
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `read_memory` | Read hierarchical memories (lazy loading, depth 1–3) |
| `write_memory` | Save new memory entries with tab-indented hierarchy |
| `search_memory` | Full-text search across all agent memories |

---

## Origin

hmem was developed out of necessity: working on a large AI project across multiple machines meant every new Claude Code session started blind. Agents redid work, lost decisions, and contradicted each other.

The solution was a memory protocol that works the way humans remember — broad strokes first, details on demand.

---

## License

MIT
