# hmem — Humanlike Memory for AI Agents

>  Your AI forgets everything between sessions.  **hmem fixes that.**

One `load_project()` call. 5k tokens. Your agent knows everything important about a project,  every past mistake, every decision you ever  made together — across sessions, devices, and AI providers. No setup per conversation. No "let me re-read the codebase." It just *remembers*.

---

## The Problem

Every AI session starts from zero. Your agent asks the same questions, makes the same mistakes, contradi cts last week's decisions, and wastes 50k tok ens loading context it already processed yesterday.

You've tried workarounds — CLAUDE.m d files, custom prompts, manually pasting con text. They don't scale. You have 10 projects.  You switch between 3 devices. You use different AI tools.

## The Solution

```
You:    " Load project hmem"
Agent:  [calls load_projec t("P0048") — 700 tokens]
Agent:  "Got it. v 5.0.0, TypeScript/SQLite/npm, 10 source files ,
         3 open tasks, 9 ideas. Last sessio n you implemented
         auto-checkpoints v ia Haiku. What's next?"
```

That's it. 700 t okens for a complete project briefing. The ag ent knows the stack, the architecture, the open bugs, the recent decisions, and exactly wh ere you left off — even if "you" was a different AI on a different machine yesterday.

- --

## How It Works

```
Level 1  ──  One -line summary          (always loaded — ~5k  tokens for 300+ entries)
  Level 2  ──   Paragraph detail        (loaded on demand)
     Level 3  ──  Full context           (lo aded on demand)
      Level 4  ──  Extend ed detail      (loaded on demand)
        Lev el 5  ──  Raw/verbatim data  (loaded on d emand)
```

At session start, the agent loads  Level 1 summaries — one line per memory. W hen it needs detail, it drills down. Your 300 -entry memory costs 5k tokens to overview. A  single project costs 700.

**Nothing is summa rized away.** Level 1 is a summary, but Level s 2-5 hold the complete original text, word f or word, accessible on demand.

---

## What  Makes v5 Different

### Automatic Session Mem ory

Every conversation is recorded automatic ally. No "save your work" prompts. No manual  checkpoints.

```
You type  →  Agent respon ds  →  Stop hook fires  →  Exchange saved  to O-entry
                                                   →  Linked to active projec t
                                                   →  Haiku auto-titles the session
``` 

Switch projects mid-session? The O-entry sw itches too. Start a new session on a differen t PC? The next agent sees every exchange from  every device — **the conversation never di es**.

### Haiku Background Checkpoints

Ever y 20 exchanges, a Haiku subagent wakes up in  the background. It reads the recent conversat ion, extracts lessons learned, errors encount ered, and decisions made, then writes them to  long-term memory — with full MCP tool acce ss. Your main agent is never interrupted.

Th e checkpoint also writes a **handoff note** t o the project: "Here's what was done, here's  what's in progress, here's the next step." Th e next agent — on any device, any provider  — picks up exactly where you left off.

###  Project-Based, Not Session-Based

Sessions a re meaningless. Projects are everything.

- O -entries are linked to the active project, no t the session
- Checkpoint counters count pro ject exchanges, not session messages
- 10 mes sages on your laptop + 10 on your server = ch eckpoint fires on message 20
- `load_project`  shows recent conversations with full context  — across all devices

---

## Key Features 

| Feature | What it does |
|---------|----- --------|
| **5-level lazy loading** | Tokens  scale with need, not memory size |
| **Smart  bulk reads** | Expands newest + most-accesse d; compresses the rest to titles |
| **Projec t gate** | Activate a project — only releva nt memories are expanded |
| **Duplicate dete ction** | Warns before creating entries that  already exist |
| **Encrypted sync** | AES-25 6-GCM, zero-knowledge server, multi-server re dundancy |
| **Auto-logging** | Every exchang e recorded via Stop hook (O-prefix) |
| **Aut o-checkpoint** | Haiku extracts L/D/E entries  every N exchanges |
| **Project handoff** |  Background agent maintains "current state" in  Protocol section |
| **User skill tracking**  | Agents track your expertise (1-10) and ada pt communication |
| **Hashtags** | Cross-cut ting tags for discovery across all categories  |
| **Obsolete chains** | Mark entries wrong  with correction reference — auto-follows | 
| **Cross-provider** | Claude, Gemini, GPT,  DeepSeek, local models — same memory |
| ** Cross-tool** | Claude Code, Gemini CLI, Curso r, Windsurf, OpenCode, Cline |
| **Import/Exp ort** | Share memories between agents or back  up as Markdown |

### Categories

| Prefix |  Category | Example |
|--------|----------|-- -------|
| **P** | Project | `hmem-mcp \| Act ive \| TS/SQLite/npm \| Persistent AI memory`  |
| **L** | Lesson | `HMEM_AGENT_ID must be  set in hooks — resolveHmemPath falls back t o wrong DB` |
| **E** | Error | `158 spurious  O-entries created when Haiku MCP lacked HMEM _NO_SESSION guard` |
| **D** | Decision | `Pr oject-based O-entries over session-based —  sessions are meaningless` |
| **H** | Human |  `User Skill: TypeScript 9, Architecture 9, R eact 3` |
| **R** | Rule | `Max one npm publi sh per day — batch changes` |
| **O** | Ori ginal | Auto-recorded conversation history (e very exchange, every device) |
| **I** | Infr a | `Strato Server \| Active \| Linux \| 87.1 06.22.11` |

---

## Quick Start

### 1. Inst all

```bash
npm install -g hmem-mcp
```

###  2. Run the interactive installer

```bash
np x hmem init
```

This detects your AI tools,  creates the memory directory, configures MCP,  and installs all 4 hooks:

| Hook | When | W hat |
|------|------|------|
| `UserPromptSub mit` | Every message | First message: load me mory. Every Nth: checkpoint reminder |
| `Sto p` (sync) | Every response | Log exchange to  active O-entry |
| `Stop` (async) | Every res ponse | Haiku auto-titles untitled sessions | 
| `SessionStart[clear]` | After /clear | Re- inject project context |

### 3. Verify

Rest art your AI tool, then:

```
read_memory()
`` `

Empty response = working (first run). Erro r = check the [troubleshooting section](#trou bleshooting).

### Manual setup

If you prefe r manual configuration over `hmem init`:

<de tails>
<summary>Claude Code — edit ~/.claud e/.mcp.json</summary>

```json
{
  "mcpServer s": {
    "hmem": {
      "command": "/absolu te/path/to/node",
      "args": ["/absolute/p ath/to/hmem-mcp/dist/mcp-server.js"],
      " env": {
        "HMEM_PROJECT_DIR": "/home/yo urname/.hmem",
        "HMEM_AGENT_ID": "DEVE LOPER"
      }
    }
  }
}
```

Find the path s:
```bash
echo "Node: $(which node)"
echo "S erver: $(npm root -g)/hmem-mcp/dist/mcp-serve r.js"
```
</details>

<details>
<summary>Open Code — edit ~/.config/opencode/opencode.jso n</summary>

```json
{
  "mcp": {
    "hmem":  {
      "type": "local",
      "command": [" /absolute/path/to/node", "/absolute/path/to/h mem-mcp/dist/mcp-server.js"],
      "environm ent": { "HMEM_PROJECT_DIR": "/home/yourname/. hmem" },
      "enabled": true
    }
  }
}
`` `
</details>

<details>
<summary>Cursor / Win dsurf / Cline</summary>

Edit `~/.cursor/mcp. json`, `~/.codeium/windsurf/mcp_config.json`,  or `.vscode/mcp.json`:

```json
{
  "mcpServ ers": {
    "hmem": {
      "command": "/abso lute/path/to/node",
      "args": ["/absolute /path/to/hmem-mcp/dist/mcp-server.js"],
       "env": { "HMEM_PROJECT_DIR": "/home/yourname /.hmem" }
    }
  }
}
```
</details>

---

##  Configuration

`hmem.config.json` in your `H MEM_PROJECT_DIR` (or `Agents/NAME/`):

```jso n
{
  "memory": {
    "maxCharsPerLevel": [20 0, 2500, 10000, 25000, 50000],
    "maxDepth" : 5,
    "checkpointMode": "auto",
    "check pointInterval": 20,
    "recentOEntries": 10, 
    "maxTitleChars": 50,
    "prefixes": { " X": "Custom" }
  },
  "sync": {
    "serverUr l": "https://your-server/hmem-sync",
    "use rId": "yourname",
    "salt": "...",
    "tok en": "..."
  }
}
```

| Key | Default | What  it does |
|-----|---------|-------------|
| ` checkpointMode` | `"remind"` | `"auto"` = Hai ku writes L/D/E in background. `"remind"` = a sks the main agent |
| `checkpointInterval` |  `20` | Exchanges between checkpoints. Set `0 ` to disable |
| `recentOEntries` | `10` | Ho w many recent sessions to show in `load_proje ct` |

All keys are optional. Missing keys us e defaults.

---

## Cross-Device Sync

Sync  memories across all devices with zero-knowled ge encryption.

```bash
npm install -g hmem-s ync
npx hmem-sync connect     # Interactive w izard — first device creates, others join
` ``

Add `HMEM_SYNC_PASSPHRASE` to your MCP co nfig for automatic sync on every read/write.
 
### Multi-server redundancy

```json
{
  "sy nc": [
    { "name": "primary", "serverUrl":  "https://server1/hmem-sync", "userId": "me",  "salt": "...", "token": "..." },
    { "name" : "backup",  "serverUrl": "https://server2/hm em-sync", "userId": "me", "salt": "...", "tok en": "..." }
  ]
}
```

### Announcements

Br oadcast to all synced agents across all devic es:

```bash
npx hmem-sync announce --message  "Server URL changing — update your config! "
```


## Windows

On Windows with Git for Windows installed, Claude Code routes hook and statusLine commands through Git Bash by default. Git Bash's MSYS2 runtime crashes transiently at startup, killing the command before it runs.

**Fix: add `"shell": "powershell"` to every hook command and to `statusLine` in `~/.claude/settings.json`.**

See [`settings.windows.example.json`](settings.windows.example.json) for the full working config. Key differences from Unix:

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
        "command": "node C:/Users/YOUR_USERNAME/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js log-exchange",
        "shell": "powershell"
      }]
    }]
  },
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/YOUR_USERNAME/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js statusline",
    "shell": "powershell"
  }
}
```

Run `npm root -g` to get the correct `node_modules` path for your machine.

> **statusLine on Windows:** Stable with `"shell": "powershell"`. Without it the statusline disappears intermittently.
---

## Troubleshooting

| Problem | F ix |
|---------|-----|
| `read_memory()` fail s | Check `HMEM_PROJECT_DIR` is absolute path  and directory exists |
| nvm: `node not foun d` | Use absolute path: `which node` → use  as `"command"` |
| Hooks not firing | Restart  Claude Code. Check `~/.claude/settings.json`  has all 4 hooks |
| Exchanges not logged | C heck `HMEM_AGENT_ID` matches your `Agents/` d irectory name |
| Sync fails | Run `npx hmem- sync connect` to re-authenticate |

---

## U pdating

```bash
npm update -g hmem-mcp        # MCP server
npm update -g hmem-sync       #  Sync (if installed)
npx hmem update-skills         # Refresh skill files
```

---

## Lice nse

MIT
 
