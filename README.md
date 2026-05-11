# its-over-9k — The AI Memory Framework

> Your AI forgets everything between sessions. **its-over-9k fixes that** — and a lot more.

![It's Over 9000](https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExc3h1MDJxbWE0MnU0Y3Y2cmc3Z3ZkOWdjaThwYzVqbTkwbHo1eWM1NCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/tPKoWQJk3cEbC/giphy.gif)

One `load_project()` call. ~700 tokens. Your agent knows everything important about a project — every past mistake, every decision, every open task — **across sessions, devices, and AI providers.** No setup per conversation. No "let me re-read the codebase." It just *remembers*.

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
Agent:  [calls load_project("P0048") — 700 tokens]
Agent:  "v7.4.1, TypeScript/SQLite/npm. 3 open bugs, 8 roadmap items.
         Last session: rebrand complete, rename_id bug fixed (89 changes).
         Next: O-Entry Auto-Purge. What's the focus today?"
```

That's it. 700 tokens for a complete project briefing. The agent knows the stack, the architecture, the open bugs, the recent decisions, and exactly where you left off — even if "you" was a different AI on a different machine yesterday.

---

## How It Works

```
Level 1  ──  One-line summary          (always loaded — ~5k tokens for 300+ entries)
  Level 2  ──  Paragraph detail        (loaded on demand)
     Level 3  ──  Full context          (loaded on demand)
      Level 4  ──  Extended detail      (loaded on demand)
        Level 5  ──  Raw/verbatim data  (loaded on demand)
```

At session start, the agent loads Level 1 summaries — one line per memory. When it needs detail, it drills down. Your 300-entry memory costs 5k tokens to overview. A single project costs ~700 tokens.

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

Every N exchanges (configurable, default 20), a Haiku subagent wakes up in the background. It reads the recent conversation, extracts lessons learned, errors encountered, and decisions made, then writes them to long-term memory — with full MCP tool access. Your main agent is never interrupted.

The checkpoint also writes a **handoff note** to the project: "Here's what was done, here's what's in progress, here's the next step." The next agent — on any device, any provider — picks up exactly where you left off.

### Project-Based, Not Session-Based

Sessions are meaningless. Projects are everything.

- O-entries are linked to the active project, not the session
- Checkpoint counters count project exchanges, not session messages
- 10 messages on your laptop + 10 on your server = checkpoint fires on message 20
- `load_project` shows recent conversations with full context — across all devices

### Skills System

its-over-9k ships with a complete **skills layer** — structured behavior files that agents load on demand. Skills define *how* an agent should do something (debug, write memory, curate entries, handle a session start) — separate from memory, separate from prompts.

```bash
npx hmem update-skills    # Pull latest skills to your AI tool's skill directory
```

Skills are versioned and updated independently. Your agents get smarter without reinstalling.

### Company Memory

Beyond personal memory, agents can maintain a **shared company store** — a separate `company.hmem` that multiple agents and team members can read from. Personal and company memory coexist; agents query both simultaneously.

```typescript
import { openCompanyMemory } from 'its-over-9k';
const store = openCompanyMemory('/path/to/project');
```

### Embeddable SDK

its-over-9k ships as a fully documented TypeScript SDK — import `HmemStore` directly into your own agents, tools, or automation pipelines:

```typescript
import { HmemStore, openCompanyMemory, searchMemory, loadHmemConfig } from 'its-over-9k';

const store = new HmemStore('/path/to/agent.hmem');
const results = searchMemory('/path/to/project', 'auth token bug', { maxResults: 5 });
```

---

## MCP Tools (12)

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
| `set_active_device` | Register and switch between devices |

---

## Memory Categories

| Prefix | Category | Example |
|--------|----------|---------|
| **P** | Project | `its-over-9k \| Active \| TS/SQLite/npm` |
| **L** | Lesson | `HMEM_AGENT_ID must be set in hooks — resolveHmemPath falls back to wrong DB` |
| **E** | Error | `158 spurious O-entries created when Haiku MCP lacked HMEM_NO_SESSION guard` |
| **D** | Decision | `Project-based O-entries over session-based — sessions are meaningless` |
| **H** | Human | `User Skill: TypeScript 9, Architecture 9, React 3` |
| **R** | Rule | `Max one npm publish per day — batch changes` |
| **O** | Original | Auto-recorded conversation history (every exchange, every device) |
| **I** | Infra | `Strato Server \| Active \| Linux \| Ubuntu 22.04` |

Custom prefixes via `hmem.config.json`.

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
    "checkpointInterval": 20,
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
| `checkpointMode` | `"remind"` | `"auto"` = Haiku writes L/D/E in background. `"remind"` = prompts the main agent |
| `checkpointInterval` | `20` | Exchanges between checkpoints. `0` = disabled |
| `recentOEntries` | `10` | How many recent sessions to show in `load_project` |
| `prefixes` | built-in | Add custom entry types |

All keys are optional. Missing keys use defaults.

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
| Hooks not firing | Restart Claude Code. Check `~/.claude/settings.json` has all 4 hooks |
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
