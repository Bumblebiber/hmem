#!/usr/bin/env python3
"""
hmem-reader v2 — Interactive TUI viewer for .hmem memory files (MCP-based)

Usage:
  hmem-reader                        # agent selection screen
  hmem-reader DEVELOPER              # opens Agents/DEVELOPER/DEVELOPER.hmem
  hmem-reader /path/to/file.hmem     # opens a specific file

Keys (MemoryScreen):
  /          Search memories
  f          Find related entries
  p          Load project (P-entries only)
  i          Memory stats
  x          Export memory (text)
  r          Re-fetch overview
  e / c      Expand / collapse all tree nodes
  [ / ]      Adjust tree width (-/+ 10%)
  Escape     Close search bar / go back
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
from textual.containers import Horizontal, VerticalScroll
from textual.binding import Binding

HMEM_BASE = Path.home() / ".hmem"


# ── MCP Client ───────────────────────────────────────────────────────────────


class McpClient:
    """Communicate with hmem via MCP subprocess (newline-delimited JSON)."""

    def __init__(self):
        self._proc = None
        self._next_id = 1

    async def connect(self, hmem_path: str) -> dict:
        """Spawn `hmem serve`, perform initialize handshake. Returns server info."""
        import os
        env = dict(os.environ)
        env["HMEM_PATH"] = hmem_path
        self._proc = await asyncio.create_subprocess_exec(
            "hmem", "serve",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        result = await self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "hmem-reader", "version": "2.0"},
        })
        await self._notify("notifications/initialized")
        return result

    async def call_tool(self, name: str, arguments: dict | None = None) -> str:
        """Call an MCP tool, return its text content."""
        params = {"name": name, "arguments": arguments or {}}
        result = await self._request("tools/call", params)
        # Extract text from content array
        contents = result.get("content", [])
        parts = []
        for c in contents:
            if c.get("type") == "text":
                parts.append(c["text"])
        return "\n".join(parts)

    def close(self):
        """Terminate the subprocess."""
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass

    async def _request(self, method: str, params: dict) -> dict:
        """Send a JSON-RPC request and read the response."""
        msg_id = self._next_id
        self._next_id += 1
        msg = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        await self._send(msg)
        resp = await self._read_response()
        if "error" in resp:
            raise RuntimeError(f"MCP error: {resp['error']}")
        return resp.get("result", {})

    async def _notify(self, method: str, params: dict | None = None):
        """Send a JSON-RPC notification (no response expected)."""
        msg = {"jsonrpc": "2.0", "method": method}
        if params:
            msg["params"] = params
        await self._send(msg)

    async def _send(self, msg: dict):
        """Write a newline-delimited JSON message to stdin."""
        data = (json.dumps(msg) + "\n").encode()
        self._proc.stdin.write(data)
        await self._proc.stdin.drain()

    async def _read_response(self) -> dict:
        """Read a single newline-delimited JSON response from stdout."""
        line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=30)
        if not line:
            raise RuntimeError("MCP subprocess closed unexpectedly")
        return json.loads(line)


# ── Agent Discovery ──────────────────────────────────────────────────────────


def find_all_hmems() -> list[tuple[str, Path]]:
    """Scan ~/.hmem/Agents/*/ for *.hmem files, skipping dot-dirs."""
    results = []
    agents_dir = HMEM_BASE / "Agents"
    if not agents_dir.exists():
        return results
    for subdir in sorted(agents_dir.iterdir()):
        if not subdir.is_dir() or subdir.name.startswith("."):
            continue
        for hmem_file in sorted(subdir.glob("*.hmem")):
            results.append((hmem_file.stem, hmem_file))
    return results


def resolve_hmem_path(arg: str) -> tuple[str, Path]:
    """Resolve a CLI argument to (agent_name, path). Accepts file path or agent name."""
    path = Path(arg)
    if path.exists() and path.suffix == ".hmem":
        return (path.stem, path.resolve())
    # Try as agent name under ~/.hmem/Agents/<name>/<name>.hmem
    candidate = HMEM_BASE / "Agents" / arg / f"{arg}.hmem"
    if candidate.exists():
        return (arg, candidate)
    raise FileNotFoundError(f"No .hmem found for '{arg}' (tried {candidate})")


def count_entries(db_path: Path) -> int:
    """Quick SQLite COUNT(*) — the only direct DB access in the reader."""
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM memories WHERE (obsolete = 0 OR obsolete IS NULL) AND seq > 0")
        n = cur.fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


# ── Response Parser ──────────────────────────────────────────────────────────

# Matches root entries like: "P0048  hmem-mcp | Active..." or "  P0048 [!] ✓  Testdaten"
# Allows optional leading whitespace (overview indents with 2 spaces)
ENTRY_RE = re.compile(r"^\s*([A-Z]\d{4})\s+(.*)$")
# Matches tree nodes like: "  .1  Overview"  or "    .2  Goals: ..."
NODE_RE = re.compile(r"^(\s+)(\.(\d+))\s+(.*)$")
# Matches bracketed sub-nodes like "    [Session 2026-04-10] ..." or "    [Rolling Summary] ..."
# Excludes [+N] expandable markers
BRACKET_NODE_RE = re.compile(r"^(\s+)\[([^+\]][^\]]*)\]\s*(.*)$")
# Matches expandable markers like [+4] or [+1]
EXPANDABLE_RE = re.compile(r"\[\+(\d+)\]")


class ParsedLine:
    """Represents a parsed line from MCP response text."""

    def __init__(self, entry_id: str, label: str, indent: int = 0, expandable_count: int = 0):
        self.entry_id = entry_id
        self.label = label
        self.indent = indent
        self.expandable_count = expandable_count

    def __repr__(self):
        return f"ParsedLine({self.entry_id!r}, {self.label!r}, indent={self.indent})"


def parse_response_lines(text: str, parent_id: str = "") -> list[ParsedLine]:
    """Parse MCP response text into structured lines.

    For root entries (like P0048), set current_root to that ID.
    For nodes (like .1), construct ID as {current_root}.{seq}.
    """
    lines = []
    current_root = parent_id
    bracket_seq = 0  # counter for bracketed sub-nodes without .N IDs

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue

        # Check for root entry
        m = ENTRY_RE.match(line)
        if m:
            entry_id = m.group(1)
            label = m.group(2)
            current_root = entry_id
            bracket_seq = 0
            expandable = 0
            exp_m = EXPANDABLE_RE.search(label)
            if exp_m:
                expandable = int(exp_m.group(1))
            lines.append(ParsedLine(entry_id, label, indent=0, expandable_count=expandable))
            continue

        # Check for tree node (.N format)
        m = NODE_RE.match(line)
        if m:
            indent_str = m.group(1)
            seq = m.group(3)
            label = m.group(4)
            indent = len(indent_str) // 2  # 2 spaces per level
            node_id = f"{current_root}.{seq}" if current_root else f".{seq}"
            expandable = 0
            exp_m = EXPANDABLE_RE.search(label)
            if exp_m:
                expandable = int(exp_m.group(1))
            lines.append(ParsedLine(node_id, label, indent=indent, expandable_count=expandable))
            continue

        # Check for bracketed sub-nodes like [Session ...] or [Rolling Summary]
        m = BRACKET_NODE_RE.match(line)
        if m:
            indent_str = m.group(1)
            bracket_label = m.group(2)
            rest = m.group(3)
            indent = len(indent_str) // 2
            bracket_seq += 1
            node_id = f"{current_root}.b{bracket_seq}" if current_root else f".b{bracket_seq}"
            full_label = f"[{bracket_label}] {rest}" if rest else f"[{bracket_label}]"
            lines.append(ParsedLine(node_id, full_label, indent=indent, expandable_count=0))
            continue

    return lines


# ── Helpers ──────────────────────────────────────────────────────────────────


def escape_markup(text: str) -> str:
    """Escape Rich markup characters so Tree widget renders them literally."""
    return text.replace("[", "\\[")


def root_id(entry_id: str) -> str:
    """Extract root ID from a node ID: 'P0048.1.2' -> 'P0048'."""
    return entry_id.split(".")[0]


# ── Agent List Screen ────────────────────────────────────────────────────────


class AgentListScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
    ]
    CSS = "ListView { height: 1fr; padding: 0 1; }"

    def __init__(self, agents: list[tuple[str, Path]]):
        super().__init__()
        self.agents = agents

    def compose(self) -> ComposeResult:
        yield Header()
        items = []
        for name, path in self.agents:
            n = count_entries(path)
            items.append(ListItem(Label(f"  {name:<20}  {n:>3} entries")))
        yield ListView(*items)
        yield Footer()

    def on_list_view_selected(self, _event: ListView.Selected):
        idx = self.query_one(ListView).index
        if idx is None:
            return
        name, path = self.agents[idx]
        self.app.push_screen(MemoryScreen(name, path))


# ── Memory Screen (split-view) ──────────────────────────────────────────────


class MemoryScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
        Binding("escape", "go_back", "Back / Close"),
        Binding("e", "expand_all", "Expand all"),
        Binding("c", "collapse_all", "Collapse all"),
        Binding("r", "refresh", "Refresh"),
        Binding("slash", "toggle_search", "Search"),
        Binding("f", "find_related", "Related"),
        Binding("p", "load_project", "Project"),
        Binding("i", "memory_stats", "Stats"),
        Binding("x", "export_memory", "Export"),
        Binding("left_square_bracket", "shrink_tree", "Tree -"),
        Binding("right_square_bracket", "grow_tree", "Tree +"),
    ]

    CSS = """
        #split {
            height: 1fr;
        }
        #tree-pane {
            width: 40%;
            min-width: 20;
        }
        #detail-scroll {
            width: 1fr;
            border-left: solid $primary;
        }
        #detail-pane {
            padding: 0 1;
        }
        #search-bar {
            dock: bottom;
            display: none;
        }
    """

    def __init__(self, agent_name: str, db_path: Path):
        super().__init__()
        self.agent_name = agent_name
        self.db_path = db_path
        self._mcp: McpClient | None = None
        self._tree_width_pct = 40
        self._selected_id: str = ""

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="split"):
            yield Tree(self.agent_name, id="tree-pane")
            with VerticalScroll(id="detail-scroll"):
                yield Static("Select an entry to view details.", id="detail-pane")
        yield Input(placeholder="Search...", id="search-bar")
        yield Footer()

    async def on_mount(self):
        self._mcp = McpClient()
        try:
            await self._mcp.connect(str(self.db_path))
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"MCP connection failed: {e}")
            return
        await self._load_overview()

    async def _load_overview(self):
        """Fetch read_memory() overview and populate the tree."""
        try:
            text = await self._mcp.call_tool("read_memory")
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")
            return
        self.query_one("#detail-pane", Static).update(escape_markup(text))
        self._populate_tree(text)

    def _populate_tree(self, text: str):
        """Parse MCP response and build the tree, grouped by prefix letter."""
        tree = self.query_one("#tree-pane", Tree)
        tree.root.remove_children()
        tree.root.label = self.agent_name

        parsed = parse_response_lines(text)
        if not parsed:
            tree.root.add_leaf("(empty)")
            tree.root.expand()
            return

        # Group root entries by prefix letter (skip indented nodes — loaded on select)
        groups: dict[str, list[ParsedLine]] = {}
        for pl in parsed:
            if pl.indent == 0:
                prefix = pl.entry_id[0] if pl.entry_id else "?"
                if prefix not in groups:
                    groups[prefix] = []
                groups[prefix].append(pl)

        for prefix in sorted(groups.keys()):
            entries = groups[prefix]
            group_node = tree.root.add(f"{prefix} ({len(entries)})", data=None)
            for pl in entries:
                label = escape_markup(pl.label)
                if pl.expandable_count > 0:
                    node = group_node.add(f"{pl.entry_id}  {label}", data=pl.entry_id)
                    node.allow_expand = True
                else:
                    group_node.add(f"{pl.entry_id}  {label}", data=pl.entry_id)

        tree.root.expand()
        for child in tree.root.children:
            child.expand()

    async def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        """When a tree node is selected, fetch its details via MCP."""
        entry_id = event.node.data
        if not entry_id:
            return
        self._selected_id = entry_id

        try:
            text = await self._mcp.call_tool("read_memory", {"id": root_id(entry_id)})
        except Exception as e:
            self.query_one("#detail-pane", Static).update(f"Error: {e}")
            return

        self.query_one("#detail-pane", Static).update(escape_markup(text))

        # Add child nodes to tree if not already populated
        if not event.node.children:
            parsed = parse_response_lines(text, parent_id=root_id(entry_id))
            for pl in parsed:
                if pl.indent > 0 and pl.entry_id.startswith(root_id(entry_id)):
                    label = escape_markup(pl.label)
                    child_label = f"{pl.entry_id}  {label}"
                    if pl.expandable_count > 0:
                        child = event.node.add(child_label, data=pl.entry_id)
                        child.allow_expand = True
                    else:
                        event.node.add_leaf(child_label, data=pl.entry_id)
            event.node.expand()

    # ── Keybinding Actions ───────────────────────────────────────────────

    def action_toggle_search(self):
        """Toggle search bar visibility and focus."""
        search = self.query_one("#search-bar", Input)
        if search.display:
            search.display = False
            self.query_one("#tree-pane", Tree).focus()
        else:
            search.display = True
            search.value = ""
            search.focus()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Run search_memory when search input is submitted."""
        query = event.value.strip()
        if not query or not self._mcp:
            return
        try:
            text = await self._mcp.call_tool("search_memory", {"query": query})
        except Exception as e:
            text = f"Search error: {e}"
        self.query_one("#detail-pane", Static).update(escape_markup(text))
        # Hide search bar after submission
        search = self.query_one("#search-bar", Input)
        search.display = False
        self.query_one("#tree-pane", Tree).focus()

    async def action_find_related(self):
        """Find entries related to the currently selected root entry."""
        if not self._selected_id or not self._mcp:
            return
        rid = root_id(self._selected_id)
        try:
            text = await self._mcp.call_tool("find_related", {"id": rid})
        except Exception as e:
            text = f"Error: {e}"
        self.query_one("#detail-pane", Static).update(escape_markup(text))

    async def action_load_project(self):
        """Load project details (only for P-entries)."""
        if not self._selected_id or not self._mcp:
            return
        rid = root_id(self._selected_id)
        if not rid.startswith("P"):
            self.query_one("#detail-pane", Static).update(
                "load_project only works on P-entries. Select a project entry first."
            )
            return
        try:
            text = await self._mcp.call_tool("load_project", {"id": rid})
        except Exception as e:
            text = f"Error: {e}"
        self.query_one("#detail-pane", Static).update(escape_markup(text))

    async def action_memory_stats(self):
        """Show memory statistics."""
        if not self._mcp:
            return
        try:
            text = await self._mcp.call_tool("memory_stats")
        except Exception as e:
            text = f"Error: {e}"
        self.query_one("#detail-pane", Static).update(escape_markup(text))

    async def action_export_memory(self):
        """Export memory as text."""
        if not self._mcp:
            return
        try:
            text = await self._mcp.call_tool("export_memory", {"format": "text"})
        except Exception as e:
            text = f"Error: {e}"
        self.query_one("#detail-pane", Static).update(escape_markup(text))

    async def action_refresh(self):
        """Re-fetch overview."""
        await self._load_overview()

    def action_go_back(self):
        """Close search bar or go back to agent list."""
        search = self.query_one("#search-bar", Input)
        if search.display:
            search.display = False
            self.query_one("#tree-pane", Tree).focus()
        else:
            self.app.pop_screen()

    def action_shrink_tree(self):
        """Decrease tree pane width by 10%."""
        self._tree_width_pct = max(20, self._tree_width_pct - 10)
        self.query_one("#tree-pane", Tree).styles.width = f"{self._tree_width_pct}%"

    def action_grow_tree(self):
        """Increase tree pane width by 10%."""
        self._tree_width_pct = min(80, self._tree_width_pct + 10)
        self.query_one("#tree-pane", Tree).styles.width = f"{self._tree_width_pct}%"

    def action_expand_all(self):
        tree = self.query_one("#tree-pane", Tree)
        for node in tree.root.children:
            node.expand_all()

    def action_collapse_all(self):
        tree = self.query_one("#tree-pane", Tree)
        for node in tree.root.children:
            node.collapse_all()

    def on_unmount(self):
        """Clean up MCP client when screen is removed."""
        if self._mcp:
            self._mcp.close()
            self._mcp = None


# ── App Shell ────────────────────────────────────────────────────────────────


class HmemApp(App):
    TITLE = "hmem-reader"

    def __init__(self, start_screen: Screen):
        super().__init__()
        self._start_screen = start_screen

    def on_mount(self):
        self.push_screen(self._start_screen)


# ── Entry Point ──────────────────────────────────────────────────────────────


def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        try:
            agent_name, db_path = resolve_hmem_path(arg)
        except FileNotFoundError as e:
            print(f"Error: {e}")
            sys.exit(1)
        screen = MemoryScreen(agent_name, db_path)
    else:
        agents = find_all_hmems()
        if not agents:
            print(f"No .hmem files found under {HMEM_BASE}")
            sys.exit(1)
        screen = AgentListScreen(agents)

    HmemApp(screen).run()


if __name__ == "__main__":
    main()
