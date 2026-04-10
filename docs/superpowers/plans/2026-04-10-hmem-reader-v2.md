# hmem-reader v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `hmem-reader.py` from direct SQLite queries to an MCP-backed split-view TUI — the reader becomes a pure UI layer, all data comes from `hmem serve`.

**Architecture:** A minimal async `McpClient` class spawns `hmem serve` as a subprocess and communicates via newline-delimited JSON-RPC over stdin/stdout. The Textual TUI has a horizontal split layout (Tree left, Detail right) and dispatches user actions as MCP `tools/call` requests. Agent discovery scans `~/.hmem/Agents/*/` for `.hmem` files. The only direct SQLite access remaining is `COUNT(*)` for the agent selection screen.

**Tech Stack:** Python 3.10+, Textual 8.x, asyncio.subprocess, JSON-RPC (newline-delimited)

**Spec:** `docs/superpowers/specs/2026-04-10-hmem-reader-v2-design.md`

---

## File Structure

**Rewrite:**
- `hmem-reader.py` — complete rewrite (680 → ~500 lines)

No new files — everything stays in the single script (same as v1).

**Internal modules within `hmem-reader.py`:**
1. `McpClient` class — subprocess lifecycle, JSON-RPC communication
2. `MemoryScreen` — split-view TUI with Tree + Detail pane
3. `AgentListScreen` — agent selection (scans `~/.hmem/Agents/`)
4. `HmemApp` — app shell
5. Response parser — regex extraction of entry IDs from MCP text output

---

## Task 1: McpClient — MCP subprocess communication

**Files:**
- Modify: `hmem-reader.py` (replace all imports and helper functions)

- [ ] **Step 1: Write the McpClient class**

Replace everything from line 1 through line 325 (all imports, SQLite helpers, V2 logic, token counting) with:

```python
#!/usr/bin/env python3
"""
hmem-reader v2 — Interactive MCP-backed viewer for .hmem memory files

Usage:
  hmem-reader                        # agent selection screen
  hmem-reader DEVELOPER              # opens ~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem
  hmem-reader /path/to/file.hmem     # opens a specific file

Keys:
  Enter      Drill into entry (read_memory)
  /          Search memory
  f          Find related entries
  p          Load project briefing
  i          Show memory stats
  x          Export memory (text)
  r          Toggle V2 view (re-fetch)
  e / c      Expand / collapse all
  [ / ]      Adjust split proportions
  Escape     Close overlay / back
  q          Quit
"""

import sys
import re
import json
import sqlite3
import asyncio
from pathlib import Path

from textual.app import App, ComposeResult, Screen
from textual.widgets import Tree, Header, Footer, ListView, ListItem, Label, Static, Input
from textual.containers import Horizontal
from textual.binding import Binding


HMEM_BASE = Path.home() / ".hmem"


class McpClient:
    """Minimal MCP client — communicates with `hmem serve` via newline-delimited JSON-RPC."""

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._req_id = 0
        self._hmem_path: str = ""

    async def connect(self, hmem_path: str) -> dict:
        """Spawn `hmem serve` and perform MCP initialize handshake."""
        import os
        self._hmem_path = hmem_path
        env = dict(os.environ)
        env["HMEM_PATH"] = hmem_path
        self._proc = await asyncio.create_subprocess_exec(
            "hmem", "serve",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        # Initialize handshake
        resp = await self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "hmem-reader", "version": "2.0.0"},
        })
        # Send initialized notification (no response expected)
        await self._notify("notifications/initialized")
        return resp

    async def call_tool(self, name: str, arguments: dict | None = None) -> str:
        """Call an MCP tool and return the text content."""
        resp = await self._request("tools/call", {
            "name": name,
            "arguments": arguments or {},
        })
        content = resp.get("content", [])
        return content[0]["text"] if content else ""

    async def close(self) -> None:
        """Terminate the MCP subprocess."""
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._proc = None

    async def _request(self, method: str, params: dict) -> dict:
        """Send a JSON-RPC request and return the result."""
        self._req_id += 1
        msg = {"jsonrpc": "2.0", "id": self._req_id, "method": method, "params": params}
        await self._send(msg)
        return await self._read_response(self._req_id)

    async def _notify(self, method: str, params: dict | None = None) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params:
            msg["params"] = params
        await self._send(msg)

    async def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        line = json.dumps(msg) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _read_response(self, expected_id: int) -> dict:
        assert self._proc and self._proc.stdout
        while True:
            line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=30.0)
            if not line:
                raise ConnectionError("MCP subprocess closed stdout")
            data = json.loads(line)
            # Skip notifications (no "id" field)
            if "id" not in data:
                continue
            if data["id"] == expected_id:
                if "error" in data:
                    raise RuntimeError(f"MCP error: {data['error']}")
                return data.get("result", {})
```

- [ ] **Step 2: Test McpClient manually**

Run from the project root:

```bash
python3 -c "
import asyncio, sys
sys.path.insert(0, '.')
# Quick inline test — not a unit test file
async def test():
    from importlib.util import spec_from_loader
    # We can't import hmem-reader.py directly (hyphen), test the class concept:
    import json, os
    env = dict(os.environ)
    env['HMEM_PATH'] = os.path.expanduser('~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem')
    proc = await asyncio.create_subprocess_exec(
        'hmem', 'serve', stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    # Init
    msg = json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'test','version':'1.0'}}}) + '\n'
    proc.stdin.write(msg.encode()); await proc.stdin.drain()
    resp = json.loads(await proc.stdout.readline())
    print('Server:', resp['result']['serverInfo'])
    proc.stdin.write((json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n').encode())
    await proc.stdin.drain()
    # memory_stats
    msg2 = json.dumps({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'memory_stats','arguments':{}}}) + '\n'
    proc.stdin.write(msg2.encode()); await proc.stdin.drain()
    resp2 = json.loads(await proc.stdout.readline())
    print('Stats OK:', 'Total entries' in resp2['result']['content'][0]['text'])
    proc.terminate(); await proc.wait()
asyncio.run(test())
"
```

Expected: `Server: {'name': 'hmem', 'version': '...'}` and `Stats OK: True`

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): add McpClient class for MCP subprocess communication

Replaces direct SQLite queries with newline-delimited JSON-RPC over stdin/stdout.
Handshake: initialize → notifications/initialized → tools/call."
```

---

## Task 2: Agent discovery — scan ~/.hmem/Agents/

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Write agent discovery functions**

Add after `McpClient` class (replacing old `find_all_hmems`, `resolve_path`, `count_entries`):

```python
def find_all_hmems() -> list[tuple[str, Path]]:
    """Scan ~/.hmem/Agents/*/ for .hmem files."""
    results = []
    agents_dir = HMEM_BASE / "Agents"
    if not agents_dir.exists():
        return results
    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("."):
            continue
        hmem_file = agent_dir / f"{agent_dir.name}.hmem"
        if hmem_file.exists():
            results.append((agent_dir.name, hmem_file))
    return results


def resolve_hmem_path(arg: str) -> tuple[str, Path]:
    """Resolve CLI argument to (agent_name, hmem_path)."""
    p = Path(arg)
    if p.exists() and p.suffix == ".hmem":
        return p.stem, p
    # Try as agent name
    hmem_file = HMEM_BASE / "Agents" / arg / f"{arg}.hmem"
    if hmem_file.exists():
        return arg, hmem_file
    raise FileNotFoundError(f"No .hmem found for '{arg}' — checked {hmem_file}")


def count_entries(db_path: Path) -> int:
    """Quick entry count via direct SQLite (only DB access in reader)."""
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM memories WHERE (obsolete = 0 OR obsolete IS NULL) AND seq > 0")
        n = cur.fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0
```

- [ ] **Step 2: Test agent discovery**

```bash
python3 -c "
import sys; sys.path.insert(0, '.')
# Test discovery
from pathlib import Path
HMEM_BASE = Path.home() / '.hmem'
agents_dir = HMEM_BASE / 'Agents'
for d in sorted(agents_dir.iterdir()):
    if d.is_dir() and not d.name.startswith('.'):
        hf = d / f'{d.name}.hmem'
        if hf.exists(): print(f'{d.name}: {hf}')
"
```

Expected: Lists DEVELOPER and any other agents.

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): replace agent discovery with ~/.hmem/Agents/ scan

Removes hardcoded Althing_CEO path. Scans ~/.hmem/Agents/*/*.hmem.
CLI: no args = selection screen, agent name = direct open, file path = direct open."
```

---

## Task 3: Response parser — extract entry IDs from MCP text

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Write the response parser**

Add after agent discovery functions:

```python
# Pattern: entry ID at start of line (possibly indented)
#   P0048  hmem-mcp | Active...          → id="P0048", indent=0
#     .1  Overview  [+4]                 → id="P0048.1", indent=2
#     .2  Codebase  [+10]               → id="P0048.2", indent=2
ENTRY_RE = re.compile(r"^(\s*)([A-Z]\d{4})\s+(.+)$")
NODE_RE = re.compile(r"^(\s*)\.(\d+)\s+(.+)$")
EXPANDABLE_RE = re.compile(r"\[\+(\d+)\]")


class ParsedLine:
    """A parsed line from MCP response text."""
    __slots__ = ("entry_id", "label", "indent", "expandable_count")

    def __init__(self, entry_id: str, label: str, indent: int, expandable_count: int):
        self.entry_id = entry_id
        self.label = label
        self.indent = indent
        self.expandable_count = expandable_count


def parse_response_lines(text: str, parent_id: str = "") -> list[ParsedLine]:
    """Parse MCP response text into structured lines for tree building.

    Returns a list of ParsedLine objects for lines that contain navigable entry/node IDs.
    """
    results = []
    current_root = parent_id
    for line in text.split("\n"):
        # Root entry: P0048  hmem-mcp | Active...
        m = ENTRY_RE.match(line)
        if m:
            indent = len(m.group(1))
            entry_id = m.group(2)
            label = m.group(3).strip()
            current_root = entry_id
            exp = EXPANDABLE_RE.search(label)
            results.append(ParsedLine(entry_id, label, indent, int(exp.group(1)) if exp else 0))
            continue
        # Sub-node: .1  Overview  [+4]
        m = NODE_RE.match(line)
        if m:
            indent = len(m.group(1))
            seq = m.group(2)
            label = m.group(3).strip()
            node_id = f"{current_root}.{seq}" if current_root else f".{seq}"
            exp = EXPANDABLE_RE.search(label)
            results.append(ParsedLine(node_id, label, indent, int(exp.group(1)) if exp else 0))
            continue
    return results
```

- [ ] **Step 2: Test the parser**

```bash
python3 -c "
import re

ENTRY_RE = re.compile(r'^(\s*)([A-Z]\d{4})\s+(.+)$')
NODE_RE = re.compile(r'^(\s*)\.(\d+)\s+(.+)$')
EXPANDABLE_RE = re.compile(r'\[\+(\d+)\]')

test_text = '''P0048  hmem-mcp | Active | TS/SQLite/npm | GH: Bumblebiber/hmem
  .1  Overview  [+4]
  .2  Codebase  [+10]
  .3  Usage  [+3]
P0054  MAIMO-RPG | Active | Unity/C#
  .1  Architecture  [+2]'''

current_root = ''
for line in test_text.split('\n'):
    m = ENTRY_RE.match(line)
    if m:
        current_root = m.group(2)
        exp = EXPANDABLE_RE.search(m.group(3))
        print(f'ENTRY: {current_root}  label={m.group(3).strip()}  exp={int(exp.group(1)) if exp else 0}')
        continue
    m = NODE_RE.match(line)
    if m:
        nid = f'{current_root}.{m.group(2)}'
        exp = EXPANDABLE_RE.search(m.group(3))
        print(f'NODE:  {nid}  label={m.group(3).strip()}  exp={int(exp.group(1)) if exp else 0}')
"
```

Expected:
```
ENTRY: P0048  label=hmem-mcp | Active | TS/SQLite/npm | GH: Bumblebiber/hmem  exp=0
NODE:  P0048.1  label=Overview  [+4]  exp=4
NODE:  P0048.2  label=Codebase  [+10]  exp=10
NODE:  P0048.3  label=Usage  [+3]  exp=3
ENTRY: P0054  label=MAIMO-RPG | Active | Unity/C#  exp=0
NODE:  P0054.1  label=Architecture  [+2]  exp=2
```

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): add MCP response parser for tree building

Extracts entry IDs (P0048), node IDs (.1 → P0048.1), labels, and
[+N] expandable markers from MCP text responses."
```

---

## Task 4: AgentListScreen — agent selection UI

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Write the AgentListScreen**

Replace the old `AgentListScreen` class (lines 600-634) with:

```python
class AgentListScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
    ]
    CSS = """
    AgentListScreen {
        layout: vertical;
    }
    AgentListScreen ListView {
        height: 1fr;
        padding: 0 1;
    }
    """

    def __init__(self, agents: list[tuple[str, Path]]):
        super().__init__()
        self.agents = agents

    def compose(self) -> ComposeResult:
        yield Header()
        items = []
        for name, path in self.agents:
            n = count_entries(path)
            items.append(ListItem(Label(f"  {name:<20}  {n:>4} entries")))
        yield ListView(*items)
        yield Footer()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        idx = self.query_one(ListView).index
        if idx is not None:
            name, path = self.agents[idx]
            self.app.push_screen(MemoryScreen(name, path))
```

- [ ] **Step 2: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): rewrite AgentListScreen for ~/.hmem/Agents/ discovery"
```

---

## Task 5: MemoryScreen — split-view layout with MCP

**Files:**
- Modify: `hmem-reader.py`

This is the largest task. Replace the old `MemoryScreen` class with the new split-view layout backed by MCP calls.

- [ ] **Step 1: Write the MemoryScreen class — layout and initialization**

Replace the old `MemoryScreen` class (lines 426-594) with:

```python
class MemoryScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
        Binding("escape", "go_back", "Back"),
        Binding("e", "expand_all", "Expand all"),
        Binding("c", "collapse_all", "Collapse all"),
        Binding("r", "toggle_v2", "V2 Read"),
        Binding("slash", "search", "Search"),
        Binding("f", "find_related", "Related"),
        Binding("p", "load_project", "Project"),
        Binding("i", "show_stats", "Stats"),
        Binding("x", "export_memory", "Export"),
        Binding("left_square_bracket", "shrink_tree", "Tree -"),
        Binding("right_square_bracket", "grow_tree", "Tree +"),
    ]
    CSS = """
    MemoryScreen {
        layout: vertical;
    }
    #split {
        height: 1fr;
    }
    #tree-pane {
        width: 40%;
        min-width: 20;
    }
    #detail-pane {
        width: 1fr;
        border-left: solid $primary;
        padding: 0 1;
        overflow-y: auto;
    }
    #search-bar {
        dock: bottom;
        height: 3;
        display: none;
    }
    """

    def __init__(self, agent_name: str, db_path: Path):
        super().__init__()
        self.agent_name = agent_name
        self.db_path = db_path
        self.mcp = McpClient()
        self._tree_pct = 40  # percentage for tree pane

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="split"):
            yield Tree(self.agent_name, id="tree-pane")
            yield Static("Select an entry to view details", id="detail-pane")
        yield Input(placeholder="Search query...", id="search-bar")
        yield Footer()

    async def on_mount(self) -> None:
        """Connect to MCP server and load initial data."""
        try:
            await self.mcp.connect(str(self.db_path))
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"MCP connection failed: {e}")
            return
        await self._load_overview()

    async def _load_overview(self) -> None:
        """Load the L1 overview (read_memory with no params)."""
        try:
            text = await self.mcp.call_tool("read_memory")
            self._populate_tree(text)
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")

    def _populate_tree(self, text: str) -> None:
        """Parse MCP response and build tree nodes."""
        tree = self.query_one("#tree-pane", Tree)
        tree.root.remove_children()
        tree.root.label = self.agent_name

        parsed = parse_response_lines(text)
        if not parsed:
            tree.root.add_leaf("(empty)")
            tree.root.expand()
            return

        # Group by prefix letter
        groups: dict[str, list[ParsedLine]] = {}
        current_group: str = ""
        for pl in parsed:
            if pl.indent == 0 and len(pl.entry_id) == 5:  # Root entry like P0048
                current_group = pl.entry_id[0]
            if current_group not in groups:
                groups[current_group] = []
            groups[current_group].append(pl)

        # Build tree: group → entries → nodes
        for prefix in sorted(groups.keys()):
            entries = groups[prefix]
            root_entries = [e for e in entries if e.indent == 0]
            group_node = tree.root.add(f"{prefix} ({len(root_entries)})")
            group_node.data = None

            current_parent = group_node
            for pl in entries:
                exp_marker = f"  [+{pl.expandable_count}]" if pl.expandable_count > 0 else ""
                label = f"{pl.entry_id}  {pl.label}"
                if pl.indent == 0:
                    # Root entry
                    current_parent = group_node.add(label, data=pl.entry_id)
                else:
                    # Sub-node
                    current_parent.add_leaf(f"  {pl.entry_id}  {pl.label}", data=pl.entry_id)

        tree.root.expand()
        for child in tree.root.children:
            child.expand()

    def on_tree_node_highlighted(self, event: Tree.NodeHighlighted) -> None:
        """Show entry ID in detail pane when highlighted (without fetching)."""
        entry_id = event.node.data
        if entry_id and isinstance(entry_id, str) and not entry_id.startswith("_detail:"):
            # Show the entry ID as hint — full content loads on Enter
            pass

    async def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        """On Enter: fetch full content via read_memory(id=...)."""
        entry_id = event.node.data
        if not entry_id or not isinstance(entry_id, str):
            return
        try:
            text = await self.mcp.call_tool("read_memory", {"id": entry_id})
            self.query_one("#detail-pane", Static).update(text)
            # Add children to tree if not already loaded
            if not event.node.children and text:
                parsed = parse_response_lines(text, parent_id=entry_id.split(".")[0] if "." in entry_id else entry_id)
                # Skip the first entry (it's the one we selected) and add children
                for pl in parsed:
                    if pl.entry_id != entry_id:
                        event.node.add_leaf(f"  {pl.entry_id}  {pl.label}", data=pl.entry_id)
                if event.node.children:
                    event.node.expand()
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")
```

- [ ] **Step 2: Test the basic layout**

```bash
python3 hmem-reader.py DEVELOPER
```

Expected: Split-view TUI with tree on left showing entry groups, detail pane on right. Press Enter on an entry to load its content.

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): split-view MemoryScreen with MCP backend

Tree (left) + Detail (right). Enter drills into entries via read_memory.
Initial load shows L1 overview from read_memory()."
```

---

## Task 6: Keybinding actions — search, related, project, stats, export

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Add action methods to MemoryScreen**

Add these methods to the `MemoryScreen` class:

```python
    # ── Keybinding actions ───────────────────────────────────────────────

    async def action_search(self) -> None:
        """Toggle search bar and focus it."""
        search = self.query_one("#search-bar", Input)
        if search.display:
            search.display = False
            self.query_one("#tree-pane", Tree).focus()
        else:
            search.display = True
            search.value = ""
            search.focus()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Execute search when Enter is pressed in search bar."""
        query = event.value.strip()
        if not query:
            return
        search = self.query_one("#search-bar", Input)
        search.display = False
        self.query_one("#tree-pane", Tree).focus()
        try:
            text = await self.mcp.call_tool("search_memory", {"query": query})
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Search error: {e}")

    async def action_find_related(self) -> None:
        """Find entries related to the selected entry."""
        tree = self.query_one("#tree-pane", Tree)
        node = tree.cursor_node
        entry_id = node.data if node else None
        if not entry_id or not isinstance(entry_id, str):
            self.query_one("#detail-pane", Static).update("Select an entry first")
            return
        # Use root entry ID (strip .N suffix for find_related)
        root_id = entry_id.split(".")[0] if "." in entry_id else entry_id
        try:
            text = await self.mcp.call_tool("find_related", {"id": root_id})
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")

    async def action_load_project(self) -> None:
        """Load project briefing for the selected entry."""
        tree = self.query_one("#tree-pane", Tree)
        node = tree.cursor_node
        entry_id = node.data if node else None
        if not entry_id or not isinstance(entry_id, str):
            self.query_one("#detail-pane", Static).update("Select a P-entry first")
            return
        root_id = entry_id.split(".")[0] if "." in entry_id else entry_id
        if not root_id.startswith("P"):
            self.query_one("#detail-pane", Static).update("load_project only works on P-entries")
            return
        try:
            text = await self.mcp.call_tool("load_project", {"id": root_id})
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")

    async def action_show_stats(self) -> None:
        """Show memory stats."""
        try:
            text = await self.mcp.call_tool("memory_stats")
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")

    async def action_export_memory(self) -> None:
        """Export memory as text (shown in detail pane)."""
        try:
            text = await self.mcp.call_tool("export_memory", {"format": "text"})
            self.query_one("#detail-pane", Static).update(text)
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")

    async def action_toggle_v2(self) -> None:
        """Re-fetch overview (simulates V2 bulk read)."""
        await self._load_overview()

    def action_go_back(self) -> None:
        """Go back to agent list or close overlay."""
        search = self.query_one("#search-bar", Input)
        if search.display:
            search.display = False
            self.query_one("#tree-pane", Tree).focus()
            return
        if self.app.screen_stack and len(self.app.screen_stack) > 1:
            self.app.pop_screen()

    def action_shrink_tree(self) -> None:
        """Shrink tree pane by 10%."""
        if self._tree_pct > 20:
            self._tree_pct -= 10
            self.query_one("#tree-pane", Tree).styles.width = f"{self._tree_pct}%"

    def action_grow_tree(self) -> None:
        """Grow tree pane by 10%."""
        if self._tree_pct < 80:
            self._tree_pct += 10
            self.query_one("#tree-pane", Tree).styles.width = f"{self._tree_pct}%"

    def action_expand_all(self) -> None:
        tree = self.query_one("#tree-pane", Tree)
        for node in tree.root.children:
            node.expand_all()

    def action_collapse_all(self) -> None:
        tree = self.query_one("#tree-pane", Tree)
        for node in tree.root.children:
            node.collapse_all()

    async def on_unmount(self) -> None:
        """Clean up MCP subprocess."""
        await self.mcp.close()
```

- [ ] **Step 2: Test keybindings**

```bash
python3 hmem-reader.py DEVELOPER
```

Test each keybinding:
- `/` → search bar appears, type query, press Enter → results in detail pane
- `f` on a selected entry → related entries shown
- `p` on a P-entry → project briefing loaded
- `i` → memory stats shown
- `x` → exported text shown
- `[` / `]` → tree pane resizes
- `Escape` → closes search bar / goes back

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): add keybinding actions — search, related, project, stats, export

/, f, p, i, x keybindings call MCP tools. [ / ] adjust split proportions.
Escape closes overlays. r re-fetches overview."
```

---

## Task 7: App shell and entry point

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Write the app shell and main function**

Replace the old `HmemApp` class and `main()` function (lines 640-680) with:

```python
class HmemApp(App):
    TITLE = "hmem-reader"
    CSS = """
    Screen {
        background: $surface;
    }
    """

    def __init__(self, start_screen: Screen):
        super().__init__()
        self._start_screen = start_screen

    def on_mount(self) -> None:
        self.push_screen(self._start_screen)


def main() -> None:
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        try:
            agent_name, db_path = resolve_hmem_path(arg)
        except FileNotFoundError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
        screen = MemoryScreen(agent_name, db_path)
    else:
        agents = find_all_hmems()
        if not agents:
            print(f"No .hmem files found under {HMEM_BASE / 'Agents'}", file=sys.stderr)
            sys.exit(1)
        screen = AgentListScreen(agents)

    HmemApp(screen).run()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: End-to-end test — all three invocation modes**

```bash
# Mode 1: No args (agent selection)
python3 hmem-reader.py

# Mode 2: Agent name
python3 hmem-reader.py DEVELOPER

# Mode 3: File path
python3 hmem-reader.py ~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem
```

Expected: All three modes work. Mode 1 shows agent list, Modes 2+3 go directly to split view.

- [ ] **Step 3: Commit**

```bash
git add hmem-reader.py
git commit -m "feat(reader): complete v2 rewrite — MCP-backed split-view TUI

Replaces direct SQLite with MCP subprocess. Split-view: Tree + Detail.
Agent discovery from ~/.hmem/Agents/. All read tools available via keybindings."
```

---

## Task 8: Polish — escape markup, tree labels, edge cases

**Files:**
- Modify: `hmem-reader.py`

- [ ] **Step 1: Add Rich markup escaping for tree labels**

The `Tree` widget uses Rich markup. Square brackets in MCP response text (like `[+4]`, `[♥]`, `[Active]`) will be interpreted as Rich tags. Add an escape helper and apply it in `_populate_tree` and `on_tree_node_selected`:

```python
def escape_markup(text: str) -> str:
    """Escape Rich markup characters to prevent parse errors."""
    return text.replace("[", "\\[")
```

Update `_populate_tree` to escape labels:

```python
                label = f"{pl.entry_id}  {escape_markup(pl.label)}"
```

And in `on_tree_node_selected`:

```python
                        event.node.add_leaf(f"  {pl.entry_id}  {escape_markup(pl.label)}", data=pl.entry_id)
```

- [ ] **Step 2: Handle MCP connection errors gracefully**

In `on_mount`, if the MCP server fails to start (e.g., `hmem` not installed), show a clear error:

```python
    async def on_mount(self) -> None:
        try:
            await self.mcp.connect(str(self.db_path))
        except FileNotFoundError:
            self.query_one("#detail-pane", Static).update(
                "Error: 'hmem' command not found. Install with: npm install -g hmem-mcp"
            )
            return
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"MCP connection failed: {e}")
            return
        await self._load_overview()
```

- [ ] **Step 3: Handle `on_unmount` for AgentListScreen → MemoryScreen transitions**

When switching from agent list to memory screen, ensure MCP cleanup happens. The `on_unmount` method in `MemoryScreen` already handles this. Verify that popping back to agent list works:

```bash
python3 hmem-reader.py
# Select an agent, then press Escape to go back
```

- [ ] **Step 4: Test with edge cases**

```bash
# Test with non-existent agent
python3 hmem-reader.py NONEXISTENT
# Expected: "Error: No .hmem found for 'NONEXISTENT'"

# Test with no agents directory
# (skip if ~/.hmem/Agents exists)
```

- [ ] **Step 5: Commit**

```bash
git add hmem-reader.py
git commit -m "fix(reader): escape Rich markup in tree labels, handle MCP connection errors"
```

---

## Task 9: Final integration test

**Files:**
- No file changes — testing only

- [ ] **Step 1: Full workflow test**

```bash
python3 hmem-reader.py DEVELOPER
```

Test checklist:
- [ ] Tree shows prefix groups (P, L, E, D, ...)
- [ ] Enter on entry loads content in detail pane
- [ ] Enter on entry adds children to tree
- [ ] `/` opens search, query returns results in detail
- [ ] `f` on P-entry shows related entries
- [ ] `p` on P-entry loads project briefing
- [ ] `i` shows memory stats
- [ ] `x` shows exported text
- [ ] `[` / `]` adjusts split proportions
- [ ] `Escape` closes search bar
- [ ] `q` quits cleanly (no zombie processes)
- [ ] `e` / `c` expand/collapse all tree nodes

- [ ] **Step 2: Verify no zombie MCP processes**

```bash
# After quitting, check no hmem serve processes remain
ps aux | grep "hmem serve" | grep -v grep
```

Expected: No lingering processes.

- [ ] **Step 3: Test agent selection screen**

```bash
python3 hmem-reader.py
```

- [ ] Agent list shows all agents with entry counts
- [ ] Selecting an agent opens MemoryScreen
- [ ] Escape goes back to agent list

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add hmem-reader.py
git commit -m "fix(reader): integration test fixes"
```
