# Hook Reference (Claude Code)

`hmem init` registers 4 hooks in `~/.claude/settings.json`. Each hook is a bash script in `~/.claude/hooks/`.

## 1. UserPromptSubmit — memory load + checkpoint reminder

Script: `~/.claude/hooks/hmem-startup.sh`

- **First message**: injects `additionalContext` telling the agent to call `read_memory()` silently.
- **Every Nth message** (N = `checkpointInterval`, default 20): injects a checkpoint reminder.
  - `checkpointMode: "remind"` — adds an `additionalContext` nudge; the agent decides what to save.
  - `checkpointMode: "auto"` — checkpoint is handled by the Stop hook instead (no reminder injected).
- Subagents (messages with `parentUuid`) are skipped.
- Uses a per-session counter file at `/tmp/claude-hmem-counter-{SESSION_ID}`.

## 2. Stop (async) — exchange logging + checkpoint

Script: `~/.claude/hooks/hmem-log-exchange.sh`

- Runs asynchronously after every agent response (timeout: 10s).
- Pipes the Stop hook JSON (containing `transcript_path` and `last_assistant_message`) to `hmem log-exchange`.
- `hmem log-exchange` reads the last user message from the JSONL transcript, combines it with the agent response, and appends both to the currently active O-entry (session history).
- If no active O-entry exists, one is created automatically.
- Every N exchanges (configurable via `checkpointInterval`, default 20), triggers a checkpoint:
  - **auto mode**: Spawns `hmem checkpoint` in background — Haiku subagent with MCP tools that:
    - Titles each exchange with a descriptive summary (max 50 chars)
    - Writes L/D/E entries for non-obvious insights
    - Updates P-entry (protocol, bugs, open tasks, overview, codebase)
    - Writes a checkpoint summary for context re-injection
    - Verifies project relevance and fixes links
  - **remind mode**: Injects a reminder for the main agent to save knowledge manually
- Checks transcript file size and writes a warning flag when context exceeds `contextTokenThreshold` (default 100k tokens).

## 3. SessionStart[clear] — context re-injection

Script: `~/.claude/hooks/hmem-context-inject.sh`

- Fires only after `/clear` (matcher: `"clear"`).
- Pipes session JSON to `hmem context-inject`, which outputs `additionalContext` containing:
  - Last 20 user/assistant messages from the pre-clear transcript
  - Active project briefing (title + overview)
  - Recent O-entries (session logs) linked to the project
  - R-entries (rules)
- Keeps the agent oriented after a context reset without a full `read_memory()` call.
