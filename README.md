# hmem — Humanlike Memory for AI Agents

> AI agents forget everything when a session ends. hmem changes that.

> hmem is actively used in production. APIs are stable since v2.0. Feedback and bug reports welcome.

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

<img width="693" height="715" alt="image" src="https://github.com/user-attachments/assets/9dcb382a-6567-4040-99d2-61916a6d7531" />


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
read_memory()              # → all L1 summaries
read_memory(id="L0003")    # → L1 + direct L2 children for this entry
read_memory(id="L0003.2")  # → that L2 node + its L3 children
```

Each node gets a compound ID (`L0003.2.1`) so any branch is individually addressable.

### Updating Memory

Entries can be updated without deleting and recreating them:

```
update_memory(id="L0003", content="Corrected L1 summary")   # update text
update_memory(id="L0003", favorite=true)                     # toggle flag only
update_memory(id="L0003.2", content="Fixed sub-node text")   # fix a sub-node
append_memory(id="L0003", content="New finding\n\tSub-detail")
```

`update_memory` replaces the text of a single node (children preserved). Content is optional — pass only flags to toggle them without repeating the text. `append_memory` adds new child nodes to an existing entry.

### Obsolete Entries

When an entry is outdated, mark it as obsolete — never delete it:

```
update_memory(id="E0023", content="...", obsolete=true)
```

Obsolete entries are **hidden from bulk reads** and replaced by a summary line at the bottom:

```
--- 3 obsolete entries hidden (E0023, D0007, L0012) — use read_memory(id=X) to view ---
```

They remain fully searchable and accessible by ID. Past errors still teach future agents what not to do — knowledge is never destroyed, only archived.

### Memory Curation

A dedicated curator agent runs periodically to maintain memory health. It detects duplicates, merges fragmented entries, marks stale pointers, and prunes low-value content — a form of the Ebbinghaus Forgetting Curve.

---

## Key Features

- **Hierarchical retrieval** — lazy loading of detail levels saves tokens
- **True tree structure** — multiple siblings at the same depth (not just one chain)
- **Compact output** — child IDs render as `.7` instead of `P0029.7`; dates shown only when differing from parent
- **Persistent across sessions** — agents remember previous work even after restart
- **Editable without deletion** — `update_memory` and `append_memory` modify entries in place; content is optional when toggling flags
- **Markers** — `[♥]` favorite, `[P]` pinned, `[!]` obsolete, `[-]` irrelevant, `[*]` active, `[s]` secret — on root entries and sub-nodes
- **Pinned entries** — super-favorites that show all children titles in bulk reads (not just the latest); use for reference entries you need in full every session
- **Hashtags** — cross-cutting tags (`#hmem`, `#security`) for filtering and discovering related entries across prefixes
- **Import/Export** — `export_memory` as Markdown or `.hmem` SQLite clone (excluding secrets); `import_memory` with L1 deduplication, sub-node merge, and automatic ID remapping on conflict
- **Obsolete chain resolution** — mark entries/sub-nodes obsolete with `[✓ID]` reference; `read_memory` auto-follows the chain to the current version
- **Access-count promotion** — most-accessed entries get expanded automatically (`[★]`); most-referenced sub-nodes shown as "Hot Nodes"
- **Session cache** — bulk reads suppress already-seen entries with Fibonacci decay; two modes: `discover` (newest-heavy) and `essentials` (importance-heavy)
- **Active-prefix filtering** — mark entries as `[*]` active to focus bulk reads on what matters now; non-active entries still show as compact titles
- **Secret entries** — `[s]` entries/nodes excluded from `export_memory`
- **Titles & compact views** — auto-extracted titles; `titles_only` mode for table-of-contents view
- **Effective-date sorting** — entries with recent appends surface to the top
- **Per-agent memory** — each agent has its own `.hmem` file (SQLite)
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
- **Offer an example memory** with 67 real entries from hmem development — or start fresh
- Configure each tool's MCP settings automatically
- Create the memory directory and `hmem.config.json`

After the installer finishes, restart your AI tool and call `read_memory()` to verify.

> **Example memory:** The installer includes `hmem_developer.hmem` — a real `.hmem` database with 67 entries and 287 nodes from actual hmem development. It contains lessons learned, architecture decisions, error fixes, and project milestones — a great way to see how hmem works in practice before writing your own entries. You can explore it immediately with `read_memory()` after install, or browse it in the TUI viewer with `python3 hmem-reader.py path/to/memory.hmem`.

> **Don't forget the skill files!** The MCP server provides the tools (read_memory, write_memory, etc.), but the slash commands (`/hmem-save`, `/hmem-read`) require skill files to be copied to your tool's skills directory. See the [Skill Files](#skill-files) section below — it's a one-time copy-paste.
>
> **Coming from the MCP Registry?** Run `npx hmem-mcp init` first — it configures your tools and creates the memory directory. Then copy the skill files as described below.

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

| Slash command | What it does |
|---|---|
| `/hmem-read` | Load your memory at session start — call at the beginning of every session |
| `/hmem-write` | Protocol for writing memories correctly (prefixes, hierarchy, anti-patterns) |
| `/hmem-save` | Save session learnings to memory, then commit + push |
| `/hmem-config` | View and adjust memory settings (`hmem.config.json`) interactively |
| `/hmem-curate` | Audit and clean up memory entries (curator role required) |

### Copy skills to your tool

Find the skills directory in the installed package:

```bash
HMEM_DIR="$(npm root -g)/hmem-mcp"
```

If you cloned from source, the skills are in the `skills/` directory.

**Claude Code:**
```bash
for skill in hmem-read hmem-write hmem-save hmem-config hmem-curate; do
  mkdir -p ~/.claude/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.claude/skills/$skill/SKILL.md
done
```

**Gemini CLI:**
```bash
for skill in hmem-read hmem-write hmem-save hmem-config hmem-curate; do
  mkdir -p ~/.gemini/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.gemini/skills/$skill/SKILL.md
done
```

**OpenCode:**
```bash
for skill in hmem-read hmem-write hmem-save hmem-config hmem-curate; do
  mkdir -p ~/.config/opencode/skills/$skill
  cp "$HMEM_DIR/skills/$skill/SKILL.md" ~/.config/opencode/skills/$skill/SKILL.md
done
```

---

## MCP Tools

### Memory Tools

| Tool | Description |
|------|-------------|
| `read_memory` | Read memories — L1 summaries, drill by ID, filter by prefix, search by time |
| `write_memory` | Save new memory entries with tab-indented hierarchy |
| `update_memory` | Update text and/or flags of an entry or sub-node (content optional) |
| `append_memory` | Append new child nodes to an existing entry or sub-node |
| `export_memory` | Export non-secret entries as Markdown text or `.hmem` SQLite file |
| `import_memory` | Import entries from a `.hmem` file with deduplication and ID remapping |
| `reset_memory_cache` | Clear session cache so all entries are treated as unseen |
| `search_memory` | Full-text search across all agent `.hmem` databases |

### Curator Tools (role: ceo)

| Tool | Description |
|------|-------------|
| `get_audit_queue` | List agents whose memory has changed since last audit |
| `read_agent_memory` | Read any agent's full memory (for curation) |
| `fix_agent_memory` | Correct a specific entry or sub-node in any agent's memory |
| `append_agent_memory` | Add content to an existing entry in any agent's memory (for merging duplicates) |
| `delete_agent_memory` | Delete a memory entry (prefer `fix_agent_memory(obsolete=true)` — deletion is permanent) |
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
  "maxTitleChars": 50,
  "accessCountTopN": 5,
  "bulkReadV2": {
    "topNewestCount": 5,
    "topAccessCount": 3,
    "topObsoleteCount": 3
  },
  "prefixes": {
    "R": "Research"
  }
}
```

### Memory prefixes

The default prefixes cover most use cases:

| Prefix | Category | When to use |
|--------|----------|-------------|
| `P` | Project | Project experiences, summaries |
| `L` | Lesson | Lessons learned, best practices |
| `E` | Error | Bugs, errors + their fix |
| `D` | Decision | Architecture decisions with reasoning |
| `T` | Task | Task notes, work progress |
| `M` | Milestone | Key milestones, releases |
| `S` | Skill | Skills, processes, how-to guides |
| `N` | Navigator | Code pointers — where something lives in the codebase |

To add your own, add entries to the `"prefixes"` key in `hmem.config.json`. Custom prefixes are **merged** with the defaults — you don't need to repeat the built-in ones.

### Favorites

Any entry can be marked as a **favorite** — regardless of its prefix category. Favorites always appear with their L2 detail in bulk reads, marked with `[♥]`.

```
write_memory(prefix="D", content="...", favorite=true)   # set at creation
update_memory(id="D0010", favorite=true)                 # set on existing entry
update_memory(id="D0010", favorite=false)                # clear the flag
```

Use favorites for reference info you need to see every session — key decisions, API endpoints, frequently consulted patterns. Use sparingly: if everything is a favorite, nothing is.

### Pinned entries

Pinned entries are "super-favorites" — they show **all** children titles in bulk reads, not just the latest one. While favorites show the newest child + `[+N more →]`, pinned entries give you the full table of contents at a glance.

```
write_memory(prefix="S", content="...", pinned=true)   # set at creation
update_memory(id="S0005", pinned=true)                 # set on existing entry
```

| Display | Normal | Favorite `[♥]` | Pinned `[P]` | `expand=true` |
|---|---|---|---|---|
| Children shown | Latest only | All titles | All titles | All with full content |
| `[+N more →]` hint | Yes | No | No | No |

Use pinned for entries with many structured sub-entries (handbooks, reference lists, project summaries) where you always want to see the full outline.

### Hashtags

Tag entries for cross-cutting search across prefix categories:

```
write_memory(prefix="L", content="...", tags=["#security", "#hmem"])
read_memory(tag="#security")      # filter bulk reads by tag
read_memory(id="L0042")          # shows related entries (2+ shared tags)
```

Tags are lowercase, must start with `#`, max 10 per entry. They work on root entries and sub-nodes.

### Access-count auto-promotion (`accessCountTopN`)

The top-N most-accessed entries are automatically promoted to L2 depth in bulk reads, marked with `[★]`. This creates "organic favorites" — entries that proved important in practice rise to the surface automatically.

```json
{ "accessCountTopN": 5 }
```

Set to `0` to disable. Default: `5`.

**Time-weighted scoring:** Raw access counts would systematically favor older entries (more time to accumulate accesses). hmem uses a logarithmic age decay instead:

```
score = access_count / log2(age_in_days + 2)
```

This means a 1-day-old entry with 5 accesses (score 3.16) outranks a 1-year-old entry with 6 accesses (score 0.70) — but a genuinely important old entry with 50 accesses (score 5.87) still stays at the top. The decay is gentle enough that consistently useful entries are never buried.

| Mechanism | When useful |
|---|---|
| **favorite flag** | Entries you know are important from day 1 — even with zero access history |
| **accessCountTopN** | Entries that proved important over time — emerges from actual usage |

### Bulk reads (V2 algorithm)

`read_memory()` groups entries by prefix category. Each category expands a limited number of entries (newest + most-accessed + favorites) with their L2 children; the rest show only the L1 title. Two modes:

- **`discover`** (default on first read): newest-heavy — good for getting an overview after session start.
- **`essentials`** (auto-selected after context compression): importance-heavy — more favorites + most-accessed, fewer newest.

A **session cache** tracks which entries were already shown. Subsequent bulk reads suppress seen entries with Fibonacci decay `[5,3,2,1,0]`, keeping output fresh without repetition. Use `reset_memory_cache` to clear the cache.

To see all children of an entry, use `read_memory(id="P0005")`. For a deep dive with full content, use `read_memory(id="P0005", expand=true)`. For a compact table of contents, use `read_memory(titles_only=true)`.

### Effective-date sorting

Entries are sorted by `effective_date` — the most recent timestamp across the entry and all its nodes. This means a project entry (`P0005`) that was first written months ago but had a new session note appended today will appear near the top of the listing, alongside truly recent entries.

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

### Bulk read tuning (`bulkReadV2`)

Controls how many entries are expanded in each category during a bulk read:

```json
"bulkReadV2": {
  "topNewestCount": 5,     // expand the 5 newest entries per prefix
  "topAccessCount": 3,     // expand the 3 most-accessed per prefix
  "topObsoleteCount": 3    // show up to 3 obsolete entries (by access count)
}
```

Favorites are always expanded regardless of these limits. Entries expanded by one slot (e.g. newest) don't count against another (e.g. access).

---

## TUI Viewer (hmem-reader.py)

A terminal-based interactive viewer for browsing `.hmem` memory files. Built with [Textual](https://textual.textualize.io/).

```bash
pip install textual     # one-time dependency
python3 hmem-reader.py         # agent selection screen (scans Agents/ directory)
python3 hmem-reader.py THOR    # open a specific agent's memory
python3 hmem-reader.py ~/path/to/file.hmem  # open any .hmem file directly
```

**Keys:**
| Key | Action |
|-----|--------|
| `r` | Toggle V2 bulk-read view (what agents see on `read_memory()`) |
| `e` / `c` | Expand / collapse all nodes |
| `q` | Quit |
| `Escape` | Back to agent list |

The V2 view mirrors the MCP server's bulk-read algorithm — including time-weighted access scoring, per-prefix selection, active-prefix filtering, and all markers (`[♥]`, `[!]`, `[*]`, `[s]`, `[-]`) — so you can see exactly what an agent sees at session start.

---

## Origin

hmem was developed out of necessity: working on a large AI project across multiple machines meant every new Claude Code session started blind. Agents redid work, lost decisions, and contradicted each other.

The solution was a memory protocol that works the way humans remember — broad strokes first, details on demand.

---

## License

MIT
