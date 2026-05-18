# its-over-9k - The AI Memory Framework

> Your AI forgets everything between sessions. **its-over-9k fixes that** — and a lot more.

![It's Over 9000](https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExc3h1MDJxbWE0MnU0Y3Y2cmc3Z3ZkOWdjaThwYzVqbTkwbHo1eWM1NCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/tPKoWQJk3cEbC/giphy.gif)

One `load_project()` call. ~3000 tokens. Your agent knows everything important about a project — every past mistake, every decision, every open task — **across sessions, devices, and AI providers.** No setup per conversation. No "let me re-read the codebase." It just *remembers*.

> **AI agent?** Skip this file. Read [AGENT_SETUP.md](AGENT_SETUP.md) — written for you, not for humans.

---

## What This Is

its-over-9k is not a note-taking plugin. It's a **memory framework** for AI agents — a complete infrastructure layer for persistent, portable, token-efficient knowledge that survives session boundaries, device switches, and provider changes.

Four core guarantees:

| Pillar | What it means |
|--------|--------------|
| **Token efficiency** | 5-level lazy loading — you pay for what you read, never more |
| **Portability** | Same memory across Claude, Gemini, GPT, local models, any MCP client |
| **Efficient storage** | Hierarchical tree structure — context scales with depth, not flat append |
| **No context waste** | Auto-session capture + project briefing = zero re-read overhead |

---

## The Problem

Every AI session starts from zero. Your agent asks the same questions, makes the same mistakes, contradicts last week's decisions, and wastes 50k tokens loading context it already processed yesterday.

You've tried workarounds — CLAUDE.md files, custom prompts, manually pasting context. They don't scale. You have 10 projects. You switch between 3 devices. You use different AI tools.

## The Solution

```
You:    "Load project"
Agent:  [calls load_project("P0048") — 3000 tokens]
Agent:  "v1.2.9, TypeScript/SQLite/npm. 3 open bugs, 8 roadmap items.
         Last session: rebrand complete, rename_id bug fixed (89 changes).
         Next: O-Entry Auto-Purge. What's the focus today?"
```

That's it. 3000 tokens for a complete project briefing. The agent knows the stack, the architecture, the open bugs, the recent decisions, and exactly where you left off — even if "you" was a different AI on a different machine yesterday.

---

## How It Works

```
Level 1  ──  One-line summary          (always loaded — ~5k tokens for 300+ entries)
  Level 2  ──  Paragraph detail        (loaded on demand)
     Level 3  ──  Full context          (loaded on demand)
      Level 4  ──  Extended detail      (loaded on demand)
        Level 5  ──  Raw/verbatim data  (loaded on demand)
```

At session start, the agent loads Level 1 summaries — one line per memory. When it needs detail, it drills down. Your 300-entry memory costs 5k tokens to overview. A single project costs ~3000 tokens.

**Nothing is summarized away.** Level 1 is a compressed view, but Levels 2–5 hold the complete original text, word for word, accessible on demand.

---

## Framework Features

### Automatic Session Memory

Every conversation is recorded automatically. No "save your work" prompts. No manual checkpoints.

```
You type  →  Agent responds  →  Stop hook fires  →  Exchange saved to O-entry
                                                   →  Linked to active project
                                                   →  Haiku auto-titles the session
```

Switch projects mid-session? The O-entry switches too. Start a new session on a different device? The next agent sees every exchange from every device — **the conversation never dies**.

### Haiku Background Checkpoints

Every N exchanges (configurable, default 5), a Haiku subagent wakes up in the background. It reads the recent conversation, extracts lessons learned, errors encountered, and decisions made, then writes them to long-term memory — with full MCP tool access. Your main agent is never interrupted.

The checkpoint also writes a **handoff note** to the project: "Here's what was done, here's what's in progress, here's the next step." The next agent — on any device, any provider — picks up exactly where you left off.

### Project-Based, Not Session-Based

Sessions are meaningless. Projects are everything.

- O-entries are linked to the active project, not the session
- Checkpoint counters count project exchanges, not session messages
- `load_project` shows recent conversations with full context — across all devices

### Skills System

its-over-9k ships with a complete **skills layer** — structured behavior files that agents load on demand. Skills define *how* an agent should do something (debug, write memory, curate entries, handle a session start) — separate from memory, separate from prompts.

```bash
npx hmem update-skills    # Pull latest skills to your AI tool's skill directory
```

Skills are versioned and updated independently. Your agents get smarter without reinstalling. 21 skills ship by default:

| Skill | Triggers when… |
|-------|----------------|
| `o9k-session-start` | Every session start — loads project + surfaces pending git work, open tasks, misrouted O-entries |
| `o9k-using-hmem` | Meta-skill loaded at session start; defines mandatory memory habits |
| `o9k-read` | Reading from long-term memory (search, prefix filter, find_related, cross-project read) |
| `o9k-write` | Writing to hmem — picks prefix, tree location, tags, detects duplicates |
| `o9k-search` | User references something without an ID ("the bug we had", "letzte Woche") |
| `o9k-new-project` | Creating a P-entry — handles schema, sections, O-entry linking |
| `o9k-new-error` | Creating an E-entry with the strict 5-level scaffold |
| `o9k-activate` | Switching active project mid-session, plus fixing misrouted exchanges |
| `o9k-context` | Loading specific context when load_project output isn't enough |
| `o9k-recall` | Dispatching a Haiku sub-agent to search hmem |
| `o9k-dispatch` | Dispatching an isolated sub-agent for any search/lookup/calculation |
| `o9k-curate` | Cleaning up an .hmem file (mark obsolete, fix titles, consolidate dupes) |
| `o9k-migrate-o` | Migrating O-entries to the project-bound 5-level structure |
| `o9k-consolidate` | Merging session checkpoint summaries into one final O-entry summary |
| `o9k-wipe` | Prep for `/clear` — save high-value knowledge, update Next Steps |
| `o9k-config` | View/change memory settings, hooks, sync, checkpoints |
| `o9k-setup` | First-time install of hmem for Claude Code / Gemini CLI / OpenCode |
| `o9k-sync-setup` | Set up `hmem-sync` for cross-device sync |
| `o9k-update` | Update flow — runs `npm update -g`, syncs skills, applies migrations |
| `o9k-release` | Pre-publish checklist for its-over-9k itself |
| `o9k-subagent` | Template for sub-agents dispatched by `o9k-dispatch` |

### Company Memory

Beyond personal memory, agents can maintain a **shared company store** — a separate `company.hmem` that multiple agents and team members can read from. Personal and company memory coexist; agents query both simultaneously.

```typescript
import { openCompanyMemory } from 'its-over-9k';
const store = openCompanyMemory('/path/to/project');
```

### Embeddable SDK

its-over-9k ships as a fully documented TypeScript SDK — import `HmemStore` directly into your own agents, tools, or automation pipelines:

```typescript
import {
  HmemStore, openCompanyMemory, resolveHmemPath,
  loadHmemConfig, saveHmemConfig, DEFAULT_CONFIG, DEFAULT_PREFIXES, formatPrefixList,
  searchMemory,
} from 'its-over-9k';
import type {
  AgentRole, MemoryEntry, MemoryNode, HmemConfig,
  SearchResult, SearchOptions, SearchScope,
} from 'its-over-9k';

const store = new HmemStore('/path/to/agent.hmem');
const results = searchMemory('/path/to/project', 'auth token bug', { maxResults: 5 });
```

---

## MCP Tools

its-over-9k ships **two** MCP servers:

- **`hmem`** (daily-use, 13 tools) — read, write, search, project lifecycle.
- **`hmem-curate`** (maintenance, 11 tools) — bulk edits, schema migrations, backup/restore. Activate only when curating.

### `hmem` — daily-use server (13)

| Tool | What it does |
|------|-------------|
| `read_memory` | 5-level lazy read — by ID, prefix, search, time, or tag |
| `write_memory` | Create new entries with title, body, tags, links |
| `append_memory` | Add child nodes to existing entries |
| `update_memory` | Patch fields: title, body, tags, irrelevant, links |
| `search_memory` | FTS5 full-text search with sub-node attribution |
| `find_related` | Find contextually related entries by tag overlap |
| `load_project` | Activate a project + get full briefing + recent sessions |
| `read_project` | Read project without activating (comparison/reference) |
| `create_project` | Scaffold a new project entry with standard schema |
| `list_projects` | List all projects with status summary |
| `flush_context` | Persist current session context to long-term memory |
| `move_nodes` | Move a subtree under a different parent (also in curate server) |
| `set_active_device` | Register and switch between devices |

### `hmem-curate` — maintenance server (11)

| Tool | What it does |
|------|-------------|
| `memory_stats` | Per-prefix counts, total tokens, favorites, hashtags, stale-list |
| `memory_health` | Find broken links, orphan tags, empty entries, dangling chains |
| `export_memory` | Export the full .hmem to a portable JSON snapshot |
| `import_memory` | Import a JSON snapshot back into a .hmem (destructive) |
| `update_many` | Bulk-patch a set of entries (irrelevant, tags, body, etc.) |
| `tag_bulk` | Add/remove a tag across many entries |
| `tag_rename` | Rename a tag globally across all entries |
| `move_memory` | Move an entire entry to a new ID slot |
| `move_nodes` | Move a subtree under a different parent (also in main server) |
| `rename_id` | Rename an entry's ID; rewrites all inbound links |
| `reset_memory_cache` | Invalidate the in-memory L1 cache (after raw SQL writes) |

Register both servers in your MCP client config to use them. See [Manual setup](#manual-setup).

---

## CLI Commands

After `npm install -g its-over-9k`, the `hmem` binary is on PATH.

### User-facing

| Command | Purpose |
|---------|---------|
| `hmem init` | Interactive installer for AI tools (Claude Code, OpenCode, Gemini CLI, Cursor, Windsurf, Cline). Flags: `--global` / `--local` / `--tools <list>` / `--dir <path>` / `--no-example` |
| `hmem update-skills` | Copy/sync bundled skill files to detected AI tools (called automatically on `npm install`) |
| `hmem doctor` | Detect stale or deprecated hmem MCP entries in host configs |
| `hmem stats` | Memory statistics + per-project token estimates + 🔴 4k threshold flagging |
| `hmem setup-hook` | Re-add the SessionStart hook to Claude Code settings (if removed) |
| `hmem version` | Show version |

### Hook drivers (called by AI tools, not by hand)

| Command | Wired into | What it does |
|---------|-----------|--------------|
| `hmem hook-startup` | UserPromptSubmit | First-message context injection (memory overview, project list, sync status). Periodic checkpoint reminders. Reads JSON from stdin |
| `hmem log-exchange` | Stop (sync) | Append the latest exchange to the active O-entry |
| `hmem checkpoint` | Stop (async) | Background Haiku/DeepSeek call — extracts lessons, errors, decisions; updates project handoff note |
| `hmem context-inject` | SessionStart[clear] | Inject project + rules context after `/clear` |
| `hmem deactivate` | SessionStart[clear] | Clear active project for current session |
| `hmem statusline` | statusLine | Render Claude Code statusline (device · active project · checkpoint counter). Reads JSON from stdin |

### Curation

| Command | Purpose |
|---------|---------|
| `hmem delete <ID>` | Permanently delete an entry (curator only, never synced) |
| `hmem migrate-o-entries` | Migrate O-entries to the current project-bound schema |
| `hmem summarize-session <id>` | Generate a summary node for a session |

### Sync (requires `hmem-sync` installed)

| Command | Purpose |
|---------|---------|
| `hmem sync push` | Push local memory to the sync server |
| `hmem sync pull` | Pull latest memory from the sync server |
| `hmem sync status` | Show server URL · auth state · last-sync timestamp |
| `hmem sync setup [--join]` | Interactive passphrase + device setup |

### Backup / migration

| Command | Purpose |
|---------|---------|
| `hmem export-staging <hmem> <json>` | Export `.hmem` SQLite to a portable JSON staging file |
| `hmem import-staging <json> <hmem>` | Import a JSON staging file back into a `.hmem` |

`hmem serve` starts the MCP stdio server directly — your AI tool launches it automatically; you only run it by hand for debugging.

---

## Memory Categories

Default prefixes (configurable via `prefixes` in `hmem.config.json`):

| Prefix | Category | Example |
|--------|----------|---------|
| **P** | Project | `its-over-9k \| Active \| TS/SQLite/npm` |
| **L** | Lesson | `HMEM_AGENT_ID must be set in hooks — resolveHmemPath falls back to wrong DB` |
| **T** | Task | `T0033 hmem-sync SaaS monetization — recurring monthly tier design` |
| **E** | Error | `158 spurious O-entries created when Haiku MCP lacked HMEM_NO_SESSION guard` |
| **D** | Decision | `Project-based O-entries over session-based — sessions are meaningless` |
| **M** | Milestone | `v1.0.0 — package renamed to its-over-9k, npm rebrand complete` |
| **S** | Skill | `Skill: TypeScript debugging with source maps` |
| **N** | Navigator | High-level navigation entry (table of contents for a topic) |
| **H** | Human | `User Skill: TypeScript 9, Architecture 9, React 3` |
| **R** | Rule | `Max one npm publish per day — batch changes` |
| **O** | Original | Auto-recorded conversation history (every exchange, every device) |
| **I** | Infrastructure | `Strato Server \| Active \| Linux \| Ubuntu 22.04` |
| **C** | Convention | `Tag scheme: lowercase, prefer existing tags before inventing` |

Add custom prefixes (e.g. `A` for App, `F` for Function reference) by listing them under `prefixes` in `hmem.config.json` — they show up in `read_memory({ prefix: "X" })` filters automatically.

---

## Quick Start

### 1. Install

```bash
npm install -g its-over-9k
```

### 2. Run the interactive installer

```bash
npx hmem init
```

Detects your AI tools, creates the memory directory, configures MCP, and installs all hooks:

| Hook | When | What |
|------|------|------|
| `UserPromptSubmit` | Every message | First message: load memory overview. Every Nth: checkpoint reminder |
| `Stop` (sync) | Every response | Log exchange to active O-entry |
| `Stop` (async) | Every response | Haiku auto-titles untitled sessions |
| `SessionStart[clear]` | After /clear | Re-inject project context |

### 3. Verify

Restart your AI tool, then:

```
read_memory()
```

Empty response = working (first run). Error = check the [troubleshooting section](#troubleshooting).

### Manual setup

<details>
<summary>Claude Code — edit ~/.claude/.mcp.json</summary>

```json
{
  "mcpServers": {
    "hmem": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/its-over-9k/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/home/yourname/.hmem",
        "HMEM_AGENT_ID": "DEVELOPER"
      }
    }
  }
}
```

Find the paths:
```bash
echo "Node: $(which node)"
echo "Server: $(npm root -g)/its-over-9k/dist/mcp-server.js"
```
</details>

<details>
<summary>Open Code — edit ~/.config/opencode/opencode.json</summary>

```json
{
  "mcp": {
    "hmem": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/its-over-9k/dist/mcp-server.js"],
      "environment": { "HMEM_PROJECT_DIR": "/home/yourname/.hmem" },
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary>Cursor / Windsurf / Cline</summary>

Edit `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "hmem": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/its-over-9k/dist/mcp-server.js"],
      "env": { "HMEM_PROJECT_DIR": "/home/yourname/.hmem" }
    }
  }
}
```
</details>

---

## Configuration

`hmem.config.json` in your `HMEM_PROJECT_DIR` (or `Agents/NAME/`):

```json
{
  "memory": {
    "maxCharsPerLevel": [200, 2500, 10000, 25000, 50000],
    "maxDepth": 5,
    "checkpointMode": "auto",
    "checkpointInterval": 5,
    "recentOEntries": 10,
    "maxTitleChars": 50,
    "prefixes": { "X": "Custom" }
  },
  "sync": {
    "serverUrl": "https://your-server/hmem-sync",
    "userId": "yourname",
    "salt": "...",
    "token": "..."
  }
}
```

| Key | Default | What it does |
|-----|---------|-------------|
| `checkpointMode` | `"remind"` | `"auto"` = background agent writes L/D/E. `"remind"` = prompts the main agent |
| `checkpointInterval` | `5` | Exchanges between checkpoints. `0` = disabled |
| `checkpointProvider` | `"anthropic"` | `"anthropic"` or `"openai"` (any OpenAI-compatible: DeepSeek, Groq, …) |
| `checkpointModel` | `"claude-haiku-4-5-20251001"` | Model name for the configured provider |
| `checkpointBaseUrl` | — | OpenAI-compatible base URL (e.g. `https://api.deepseek.com/v1`) |
| `checkpointApiKeyEnv` | provider default | Env var holding the API key. Defaults: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| `recentOEntries` | `10` | How many recent sessions to show in `load_project` |
| `prefixes` | built-in | Add custom entry types |

All keys are optional. Missing keys use defaults.

### Checkpoint setup per harness

The auto-checkpoint agent runs in the background after every Nth exchange. It needs an LLM call — three paths, picked automatically:

1. **API key in environment** (any harness) → direct provider API loop. Configure `checkpointProvider` + `checkpointModel` + `checkpointApiKeyEnv` in `hmem.config.json`. Works from Pi, Hermes, OpenCode, and Claude Code.
2. **No API key, but `claude` CLI in PATH** → subprocess fallback (`claude -p`). Zero-config for Claude Code / Claude Max users.
3. **Neither** → checkpoint fails with a config-hint error.

**Recommended cheap setup (DeepSeek, ~10× cheaper than Haiku):**

```json
{
  "memory": {
    "checkpointMode": "auto",
    "checkpointProvider": "openai",
    "checkpointModel": "deepseek-chat",
    "checkpointBaseUrl": "https://api.deepseek.com/v1",
    "checkpointApiKeyEnv": "DEEPSEEK_API_KEY"
  }
}
```

Then `export DEEPSEEK_API_KEY=sk-...` in your shell profile. Works for any harness.

**Claude Code / Claude Max (zero-config):** no provider settings needed — the subprocess fallback uses your existing `claude` login.

**Per-harness exchange logging:** Claude Code uses `Stop` hooks (installed by `npx hmem init`). Pi uses the built-in extension (`src/extensions/pi-hmem.ts`). Hermes needs the `hermes-hmem` plugin (see `plugins/hermes-hmem/README.md`). OpenCode uses the same hook system as Claude Code.

> **⚠ Pi users:** Hook-based exchange logging is currently not working in the Pi runtime. Exchanges are not saved to O-entries automatically. Manual checkpointing via `hmem checkpoint` is the workaround until this is resolved.

---

## Cross-Device Sync

Sync memories across all devices with zero-knowledge AES-256-GCM encryption.

```bash
npm install -g hmem-sync
npx hmem-sync connect     # Interactive wizard — first device creates, others join
```

Add `HMEM_SYNC_PASSPHRASE` to your MCP config for automatic sync on every read/write.

### Multi-server redundancy

```json
{
  "sync": [
    { "name": "primary", "serverUrl": "https://server1/hmem-sync", "userId": "me", "salt": "...", "token": "..." },
    { "name": "backup",  "serverUrl": "https://server2/hmem-sync", "userId": "me", "salt": "...", "token": "..." }
  ]
}
```

### Announcements

Broadcast to all synced agents across all devices:

```bash
npx hmem-sync announce --message "Server URL changing — update your config!"
```

---

## Windows

On Windows with Git for Windows, Claude Code routes hook and statusLine commands through Git Bash by default. Git Bash's MSYS2 runtime crashes transiently at startup, killing the command before it runs.

**Fix: add `"shell": "powershell"` to every hook command and to `statusLine` in `~/.claude/settings.json`.**

See [`settings.windows.example.json`](settings.windows.example.json) for the full working config. Key differences:

```json
{
  "env": {
    "HMEM_PATH": "C:/Users/YOUR_USERNAME/.hmem/Agents/DEVELOPER/DEVELOPER.hmem"
  },
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "node C:/Users/YOUR_USERNAME/AppData/Roaming/npm/node_modules/its-over-9k/dist/cli.js log-exchange",
        "shell": "powershell"
      }]
    }]
  },
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/YOUR_USERNAME/AppData/Roaming/npm/node_modules/its-over-9k/dist/cli.js statusline",
    "shell": "powershell"
  }
}
```

Run `npm root -g` to get the correct `node_modules` path for your machine.

> **statusLine on Windows:** Stable with `"shell": "powershell"`. Without it the statusline disappears intermittently.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `read_memory()` fails | Check `HMEM_PROJECT_DIR` is absolute path and directory exists |
| nvm: `node not found` | Use absolute path: `which node` → use as `"command"` |
| Hooks not firing (Claude Code) | Restart Claude Code. Check `~/.claude/settings.json` has all 4 hooks |
| Hooks not firing (Pi) | Known issue — Pi hook integration is currently broken. Use `hmem checkpoint` manually as a workaround |
| Exchanges not logged | Check `HMEM_AGENT_ID` matches your `Agents/` directory name |
| Sync fails | Run `npx hmem-sync connect` to re-authenticate |

---

## Updating

```bash
npm update -g its-over-9k    # MCP server + SDK
npm update -g hmem-sync      # Sync (if installed)
npx hmem update-skills       # Refresh skill files
```

---

## License

MIT
