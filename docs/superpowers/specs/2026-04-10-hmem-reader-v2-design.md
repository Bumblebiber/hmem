# hmem-reader v2 Design

**Date**: 2026-04-10
**Status**: Approved
**Scope**: Complete rewrite of `hmem-reader.py` — from direct SQLite queries to MCP-backed TUI

## Problem

The current hmem-reader.py directly queries SQLite and reimplements V2 selection logic, token counting, and tree rendering in Python. This duplicates ~500 lines of logic from hmem-store.ts, drifts out of sync with MCP behavior, and cannot access MCP-only features like search_memory, find_related, or load_project. The user sees a different view than what agents see.

## Solution

Rewrite hmem-reader as a thin MCP client. All data comes from `hmem serve` (JSON-RPC over stdin/stdout). The reader becomes a pure UI layer with no business logic.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  hmem-reader.py (Textual TUI)                    │
│  ┌──────────────┬───────────────────────────────┐ │
│  │  Tree (40%)  │  Detail Pane (60%)            │ │
│  │              │  (scrollable, full content)   │ │
│  │  P — Proj    │                               │ │
│  │    P0048 *   │  P0048 hmem-mcp               │ │
│  │      .1 Over │  Active | TS/SQLite/npm       │ │
│  │      .2 Code │  GH: Bumblebiber/hmem         │ │
│  │    P0054     │  ...                          │ │
│  │  L — Less    │                               │ │
│  │    L0095 ♥   │                               │ │
│  └──────────────┴───────────────────────────────┘ │
│  [/] Search  [f] Related  [p] Project  [i] Stats  │
└──────────────────────────────────────────────────┘
        │ stdin/stdout (JSON-RPC)
        ▼
┌──────────────────┐
│  hmem serve      │
│  (MCP subprocess) │
└──────────────────┘
```

## MCP Communication

### Subprocess Lifecycle

1. Reader starts `hmem serve` with `HMEM_PATH=<selected.hmem>` as env var
2. Performs MCP `initialize` handshake (protocol version, capabilities)
3. Sends `tools/call` requests for each user action
4. Subprocess lives for the duration of the session
5. Killed on quit or agent switch

### Request/Response Format

Outgoing (stdin):
```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "read_memory", "arguments": {"id": "P0048"}}}
```

Incoming (stdout):
```json
{"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "## Memory: DEVELOPER ...\n\nP0048  hmem-mcp | Active..."}]}}
```

### MCP Client Implementation

A minimal `McpClient` class:
- `__init__(hmem_path)` — spawns subprocess, runs initialize handshake
- `call_tool(name, arguments) -> str` — sends request, returns text content
- `close()` — terminates subprocess

Uses `asyncio.subprocess` for non-blocking I/O (Textual is async-native).

## Layout

### Split View

Horizontal split: Tree (left, 40%) + Detail (right, 60%).

- `[` / `]` adjust proportions in 10% steps (min 20%, max 80% for each)
- Tree shows hierarchical entry structure with markers
- Detail pane is scrollable, shows the full MCP response text for the highlighted entry

### Tree Structure

Initial load: `read_memory()` (no params) returns L1 overview grouped by prefix. The reader parses the formatted text output and builds tree nodes.

On Enter: `read_memory(id=X)` returns the entry with L2 children. Children are added to the tree as expandable nodes. Already-loaded nodes are not re-fetched (cached in tree data).

### Detail Pane

Shows the raw text content from the MCP response. For `read_memory(id=X)`, this is the formatted entry with children, links, related entries. For `search_memory`, the search results. For `load_project`, the full project briefing.

## Keybindings

| Key | Action | MCP Tool |
|-----|--------|----------|
| Enter | Drill into entry | `read_memory(id=<selected>)` |
| `/` | Open search input | `search_memory(query=<input>)` |
| `f` | Find related entries | `find_related(id=<selected>)` |
| `p` | Load project briefing | `load_project(id=<selected>)` |
| `i` | Show memory stats | `memory_stats()` |
| `x` | Export memory | `export_memory()` |
| `r` | Toggle V2 view | Re-fetch with V2 simulation |
| `e` / `c` | Expand / collapse all | (local tree operation) |
| `[` / `]` | Adjust split proportions | (local layout operation) |
| `Escape` | Close temp view / back | (navigation) |
| `q` | Quit | (exit) |

## Agent Discovery

Three invocation modes (same CLI signature as v1):

1. **No args**: `hmem-reader` — scans `~/.hmem/Agents/*/` for `.hmem` files, shows selection screen
2. **Agent name**: `hmem-reader DEVELOPER` — opens `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`
3. **File path**: `hmem-reader /path/to/file.hmem` — opens specific file

The agent selection screen shows agent name + entry count (via quick SQLite COUNT query — the only direct DB access remaining).

## Response Parsing

MCP tool responses are plain text (formatted by mcp-server.ts). The reader needs to parse this text to:

1. **Build tree nodes**: Extract entry IDs and titles from lines like `P0048  hmem-mcp | Active...` or `  .1  Overview`
2. **Detect structure**: Indentation indicates depth (2 spaces per level)
3. **Show in detail**: Raw text displayed as-is in the detail pane

Parsing strategy: regex-based line parsing. Each line matching `^\s*(P\d{4}|\.\d+)\s+` is a navigable entry. Lines with `[+N]` indicate unexpanded children (fetchable via Enter).

## What Gets Removed

- All direct SQLite query code (`load_all_data`, `count_entries` queries)
- V2 selection logic in Python (`compute_v2_selection`, `weighted_access_score`)
- Token counting in Python (`count_all_tokens`, `count_shown_tokens`)
- `Althing_CEO` hardcoded path
- `load_prefix_labels`, `load_v2_config` (config handled by MCP server)

## Dependencies

- Python 3.10+
- `textual` (already used)
- No new dependencies (asyncio is stdlib)

## Out of Scope

- Write operations (read-only viewer)
- `memory_health` and `get_audit_queue` tools
- Real-time updates (no file watching)
- Multi-agent comparison view
