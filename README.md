# hmem — Humanlike Memory for AI Agents

> **Your AI loads 5k tokens and has full context of 80k+.** That's hmem — persistent, hierarchical memory that works across sessions, devices, and AI tools. Zero tokens wasted.

**hmem** is an MCP server that gives AI agents human-like long-term memory. Instead of dumping everything into context, it stores knowledge in a 5-level hierarchy — like how you remember: broad strokes first, details on demand.

The result? An AI that starts a new session and *already knows* your projects, your decisions, your past mistakes, your preferences — across your laptop, your PC, and your server. Simultaneously.

---

## Why hmem?

**Without hmem:** Every session starts from zero. Your AI asks the same questions, makes the same mistakes, contradicts last week's decisions, and wastes tokens loading context it already processed.

**With hmem:**
- **5k tokens** loads a complete overview of 300+ memories spanning months of work
- **Gets more efficient over time** — as your memory grows, the bulk read algorithm gets *better*, not worse. New entries push older, less relevant ones into title-only mode. 1,000 entries cost barely more tokens than 100.
- **Original context preserved** — nothing is summarized away or compressed. Every detail you stored is still there at full fidelity, accessible on demand. Level 1 is a summary, but Levels 2-5 hold the complete original text, word for word.
- **Drill on demand** — the AI only fetches details when it actually needs them
- **Cross-device** — encrypted sync means your laptop, PC, and server share the same brain
- **Cross-provider** — Claude, Gemini, GPT, DeepSeek, local models — all read and write the same memory. Switch providers without losing context. Your Gemini session picks up where Claude left off.
- **Cross-tool** — works with Claude Code, Gemini CLI, Cursor, Windsurf, OpenCode, Cline
- **Auto-logging** — via Claude Code's Stop hook, every conversation is automatically preserved
- **No token waste** — hierarchical lazy loading means the AI never loads more than it needs

---

## How It Works

```
Level 1  ──  One-line summary          (always loaded — ~5k tokens for 300 entries)
  Level 2  ──  Paragraph detail        (loaded on demand)
    Level 3  ──  Full context           (loaded on demand)
      Level 4  ──  Extended detail       (loaded on demand)
        Level 5  ──  Raw/verbatim data   (loaded on demand)
```

At session start, the agent loads Level 1 summaries — one line per memory. When it needs more detail on a specific topic, it drills down: `read_memory(id="L0042")` loads that entry's Level 2 children. And so on.

**Categories keep things organized:**

| Prefix | Category | Example |
|--------|----------|---------|
| P | Project | `hmem-mcp \| Active \| TS/SQLite/npm \| Persistent hierarchical AI memory` |
| L | Lesson | `Always restart MCP server after recompiling TypeScript` |
| E | Error | `hmem-sync Schema-Drift: access_count missing after pull` |
| D | Decision | `Per-node tag scoring instead of union-set for related discovery` |
| H | Human | `User Skill: IT — TypeScript: 3, Architecture: 9, AHK: 9` |
| R | Rule | `Max one npm publish per day — batch changes` |
| I | Infrastructure | `Strato Server \| Active \| Linux \| 4 cores, 8GB RAM` |
| T | Task | `Config consolidation: merge 6 files into 1` |
| O | Original | Auto-recorded raw conversation history (via Stop hook) |

---

## Key Features

- **5-level lazy loading** — tokens scale with need, not with total memory size
- **Smart bulk reads** — V2 algorithm expands newest, most-accessed, and favorites; suppresses the rest to titles
- **Project-aware filtering** — activate a project, and only relevant memories are expanded; others show title-only
- **`#universal` tag** — cross-project knowledge (MCP patterns, deployment rules) always shown regardless of active project
- **Duplicate detection** — `write_memory` warns if similar entries exist (tag overlap + FTS5 title similarity)
- **Encrypted sync** — AES-256-GCM client-side encryption, zero-knowledge server, multi-server redundancy
- **Auto-logging** — Claude Code Stop hook records every conversation automatically (O-prefix)
- **Announcements** — broadcast urgent messages to all synced devices (server migration, config changes)
- **User skill assessment** — agents silently track your expertise per topic (1-10 scale) and adapt communication
- **Hashtags** — cross-cutting tags for filtering and related-entry discovery
- **Obsolete chains** — mark entries wrong with `[✓ID]` correction reference; auto-follows to current version
- **Import/Export** — share memories between agents or back up as Markdown
- **Multi-agent routing** — `route_task` scores all agent memory stores to find the best agent for a task

### New in v4

- **`load_project` tool** — one call to activate a project and get a complete briefing (~500 tokens). The recommended way to start working on a project
- **P-Entry Standard Schema** — validated project structure with 10 L2 categories. The MCP server enforces consistency across all agents
- **Context Injection `[⚡]`** — activate a task, and related errors + lessons appear automatically in bulk reads. No manual searching for past mistakes
- **Multi-server sync** — push to multiple servers for redundancy. `"sync": [{ ... }, { ... }]` in config

---

## Installation

### Step 1: Install the package

```bash
npm install -g hmem-mcp
```

Skills are **automatically copied** to detected AI tools (Claude Code, OpenCode, Gemini CLI) via postinstall hook.

### Step 2: Configure your MCP client

**IMPORTANT:** Do NOT use `claude mcp add` — it misplaces environment variables. Configure manually:

#### Claude Code

Edit `~/.claude/.mcp.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "hmem": {
      "command": "node",
      "args": ["/path/to/hmem-mcp/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/home/yourname/.hmem"
      }
    }
  }
}
```

**Find the path** to `mcp-server.js`:
```bash
echo "$(npm root -g)/hmem-mcp/dist/mcp-server.js"
```

**nvm users:** Use the absolute path to `node` instead of just `"node"`:
```bash
echo "$(which node)"
# e.g. /home/yourname/.nvm/versions/node/v24.14.0/bin/node
```

Then use that as the `"command"` value.

#### With agent ID (multi-agent setups)

If you use `HMEM_AGENT_ID`, the database path changes:

```
Without HMEM_AGENT_ID:  {HMEM_PROJECT_DIR}/memory.hmem
With HMEM_AGENT_ID=X:   {HMEM_PROJECT_DIR}/Agents/X/X.hmem
```

```json
{
  "mcpServers": {
    "hmem": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/hmem-mcp/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/home/yourname/.hmem",
        "HMEM_AGENT_ID": "DEVELOPER"
      }
    }
  }
}
```

#### OpenCode

Edit `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "hmem": {
      "type": "local",
      "command": ["/absolute/path/to/node", "/absolute/path/to/hmem-mcp/dist/mcp-server.js"],
      "environment": {
        "HMEM_PROJECT_DIR": "/home/yourname/.hmem"
      },
      "enabled": true
    }
  }
}
```

#### Cursor / Windsurf / Cline

Edit the respective MCP config file (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, or `.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "hmem": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/hmem-mcp/dist/mcp-server.js"],
      "env": {
        "HMEM_PROJECT_DIR": "/home/yourname/.hmem"
      }
    }
  }
}
```

### Step 3: Create the memory directory

```bash
mkdir -p ~/.hmem
# Or with agent ID:
mkdir -p ~/.hmem/Agents/DEVELOPER
```

### Step 4: Restart and verify

Restart your AI tool completely, then:

```
read_memory()
```

You should see a response. If empty, that's fine — first run. If you get an error, check:
- Is `HMEM_PROJECT_DIR` an absolute path?
- Does the directory exist?
- Is `node` path correct? (nvm users: use absolute path)

The server logs its configuration on startup:
```
[hmem:DEVELOPER] MCP Server running on stdio | Agent: DEVELOPER | DB: /home/you/.hmem/Agents/DEVELOPER/DEVELOPER.hmem (0 entries)
```

---

## Cross-Device Sync (hmem-sync)

Sync your memories across all devices with zero-knowledge encryption.

```bash
npm install -g hmem-sync
```

### First device

```bash
npx hmem-sync connect
```

Interactive wizard: creates account, generates encryption keys, pushes your data.

### Additional devices

```bash
npx hmem-sync connect
```

Same wizard — choose "existing account", enter your credentials from the first device.

### Enable auto-sync

Add `HMEM_SYNC_PASSPHRASE` to your MCP config:

```json
{
  "env": {
    "HMEM_PROJECT_DIR": "/home/you/.hmem",
    "HMEM_AGENT_ID": "DEVELOPER",
    "HMEM_SYNC_PASSPHRASE": "your-passphrase"
  }
}
```

With this set, every `read_memory` automatically pulls and every `write_memory` automatically pushes. 30-second cooldown prevents spam.

### Multi-server redundancy

In `hmem.config.json`, configure multiple servers:

```json
{
  "sync": [
    { "name": "primary", "serverUrl": "https://server1/hmem-sync", "userId": "me", "salt": "...", "token": "..." },
    { "name": "backup", "serverUrl": "https://server2/hmem-sync", "userId": "me", "salt": "...", "token": "..." }
  ]
}
```

Push/pull goes to all servers. Use during migration or for redundant backup.

### Announcements

Broadcast urgent messages to all synced AI agents across all devices:

```bash
npx hmem-sync announce --message "Server URL changing — update your config!"
```

Every agent on every device sees the announcement on its next sync pull. Use for config changes, server migrations, or coordination across your fleet of AI instances.

---

## Auto-Logging (O-prefix)

With Claude Code's Stop hook, every conversation exchange (your message + agent response) is automatically recorded in O-prefix entries. Zero token cost — runs in the background.

### Setup the hook

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "HMEM_PROJECT_DIR=/home/you/.hmem HMEM_AGENT_ID=DEVELOPER node /path/to/hmem-mcp/dist/cli.js log-exchange",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

O-entries are hidden from bulk reads (no noise) but searchable and linked to your active project.

---

## Configuration

`hmem.config.json` in your `HMEM_PROJECT_DIR`:

```json
{
  "memory": {
    "maxCharsPerLevel": [200, 2500, 10000, 25000, 50000],
    "maxDepth": 5,
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

All keys are optional. Missing keys use defaults.

---

## Updating

```bash
# Always global — NOT inside a project directory
npm update -g hmem-mcp
npm update -g hmem-sync
```

Skills are automatically updated via postinstall hook. No manual copy needed.

---

## License

MIT
