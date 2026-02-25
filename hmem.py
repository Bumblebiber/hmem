#!/usr/bin/env python3
"""
hmem — Interactive viewer for .hmem SQLite memory files

Usage:
  hmem                        # agent selection screen
  hmem THOR                   # opens Agents/THOR/THOR.hmem directly
  hmem /path/to/file.hmem     # opens a specific file

Keys:
  r          Toggle V2 bulk-read view (what agents see on read_memory())
  e / c      Expand / collapse all
  q          Quit
  Escape     Back to agent list
"""

import sys
import json
import math
import sqlite3
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone


def weighted_access_score(entry: dict) -> float:
    """Time-weighted access score: access_count / log2(age_in_days + 2).
    Newer entries with fewer accesses can outrank older entries."""
    ac = entry.get("access_count", 0) or 0
    created = entry.get("created_at", "")
    if not created or ac == 0:
        return 0.0
    try:
        age_s = (datetime.now(timezone.utc) - datetime.fromisoformat(created.replace("Z", "+00:00"))).total_seconds()
        age_days = max(age_s / 86400, 0)
    except Exception:
        return float(ac)
    return ac / math.log2(age_days + 2)

from textual.app import App, ComposeResult, Screen
from textual.widgets import Tree, Header, Footer, ListView, ListItem, Label
from textual.binding import Binding

PROJECT_DIR = Path(__file__).parent / "Althing_CEO"

# Built-in prefix labels — extended/overridden by hmem.config.json
DEFAULT_PREFIX_LABELS = {
    "P": "Projects",
    "L": "Lessons Learned",
    "E": "Error Patterns",
    "D": "Decisions",
    "T": "Tasks",
    "M": "Milestones",
    "S": "Skills",
    "N": "Navigator",
    "H": "Human",
    "R": "Rules",
}

# V2 bulk-read defaults (must match hmem-store.ts DEFAULT_CONFIG.bulkReadV2)
DEFAULT_V2_CONFIG = {
    "topAccessCount": 3,
    "topNewestCount": 5,
    "topObsoleteCount": 3,
}


def load_prefix_labels(db_path: Path) -> dict[str, str]:
    """Merge built-in labels with any custom prefixes from hmem.config.json."""
    labels = dict(DEFAULT_PREFIX_LABELS)
    for config_dir in [db_path.parent, PROJECT_DIR]:
        cfg = config_dir / "hmem.config.json"
        if cfg.exists():
            try:
                data = json.loads(cfg.read_text())
                for k, v in (data.get("prefixes") or {}).items():
                    labels[k.upper()] = v
            except Exception:
                pass
            break
    return labels


def load_v2_config(db_path: Path) -> dict:
    """Load bulkReadV2 config from hmem.config.json."""
    for config_dir in [db_path.parent, PROJECT_DIR]:
        cfg = config_dir / "hmem.config.json"
        if cfg.exists():
            try:
                data = json.loads(cfg.read_text())
                v2 = data.get("bulkReadV2", {})
                return {**DEFAULT_V2_CONFIG, **v2}
            except Exception:
                pass
    return dict(DEFAULT_V2_CONFIG)


def find_all_hmems() -> list[tuple[str, Path]]:
    """Scan Agents/ and Assistenten/ for all .hmem files."""
    results = []
    for subdir in ["Agents", "Assistenten"]:
        base = PROJECT_DIR / subdir
        if not base.exists():
            continue
        for hmem_file in sorted(base.glob("*/*.hmem")):
            agent_name = hmem_file.stem
            results.append((agent_name, hmem_file))
    return results


def resolve_path(agent_name: str) -> Path:
    for subdir in ["Agents", "Assistenten"]:
        p = PROJECT_DIR / subdir / agent_name / f"{agent_name}.hmem"
        if p.exists():
            return p
    raise FileNotFoundError(f"No .hmem found for agent '{agent_name}'")


def count_entries(db_path: Path) -> int:
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM memories WHERE (obsolete = 0 OR obsolete IS NULL) AND seq > 0")
        n = cur.fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


def auto_extract_title(text: str, max_len: int = 30) -> str:
    """Extract a short title from text (first 30 chars or text before ' — ')."""
    if not text:
        return ""
    dash_idx = text.find(" — ")
    if 0 < dash_idx <= max_len:
        return text[:dash_idx]
    if len(text) <= max_len:
        return text
    return text[:max_len]


def load_all_data(db_path: Path) -> tuple[list[dict], list[dict], dict[str, list[dict]]]:
    """
    Load everything in 2 queries. Returns (active, obsolete, children_map).
    children_map: parent_id → [child_nodes sorted by seq]
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Query 1: all root entries (excluding headers)
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT id, prefix, seq, title, level_1, created_at, min_role,
                   COALESCE(favorite, 0)      AS favorite,
                   COALESCE(access_count, 0)  AS access_count,
                   COALESCE(obsolete, 0)      AS obsolete
            FROM memories
            WHERE seq > 0
            ORDER BY prefix, seq
        """)
    except sqlite3.OperationalError:
        # Old schema without title column
        cur.execute("""
            SELECT id, prefix, seq, NULL AS title, level_1, created_at, min_role,
                   COALESCE(favorite, 0)      AS favorite,
                   COALESCE(access_count, 0)  AS access_count,
                   COALESCE(obsolete, 0)      AS obsolete
            FROM memories
            WHERE seq > 0
            ORDER BY prefix, seq
        """)
    rows = [dict(r) for r in cur.fetchall()]

    # Query 2: all nodes at once
    cur.execute("SELECT * FROM memory_nodes ORDER BY parent_id, seq")
    all_nodes = [dict(r) for r in cur.fetchall()]
    conn.close()

    # Build parent → children map in memory
    children_map: dict[str, list[dict]] = defaultdict(list)
    for node in all_nodes:
        children_map[node["parent_id"]].append(node)

    active = [r for r in rows if not r["obsolete"]]
    obsolete = [r for r in rows if r["obsolete"]]
    return active, obsolete, children_map


def compute_v2_selection(
    active: list[dict], obsolete: list[dict], v2_config: dict
) -> tuple[set[str], set[str], list[dict]]:
    """
    Compute V2 bulk-read selection.
    Returns (expanded_ids, promoted_ids, visible_obsolete).
    """
    expanded_ids = set()
    promoted_ids = set()

    # Group by prefix
    by_prefix: dict[str, list[dict]] = defaultdict(list)
    for e in active:
        by_prefix[e["prefix"]].append(e)

    for _, entries in by_prefix.items():
        # Top N newest (by created_at DESC)
        newest = sorted(entries, key=lambda e: e["created_at"] or "", reverse=True)
        for e in newest[: v2_config["topNewestCount"]]:
            expanded_ids.add(e["id"])

        # Top M most-accessed (time-weighted)
        most_accessed = sorted(
            [e for e in entries if e["access_count"] > 0],
            key=weighted_access_score,
            reverse=True,
        )[: v2_config["topAccessCount"]]
        for e in most_accessed:
            expanded_ids.add(e["id"])
            promoted_ids.add(e["id"])

    # All favorites
    for e in active:
        if e.get("favorite"):
            expanded_ids.add(e["id"])

    # Top K obsolete (time-weighted)
    visible_obsolete = sorted(
        obsolete, key=weighted_access_score, reverse=True
    )[: v2_config["topObsoleteCount"]]

    return expanded_ids, promoted_ids, visible_obsolete


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 characters per token (works for English/German mix)."""
    return len(text) // 4 if text else 0


def count_all_tokens(active: list[dict], obsolete: list[dict], children_map: dict[str, list[dict]]) -> int:
    """Count total tokens across all entries and all nodes recursively."""
    total = 0
    for entry in active + obsolete:
        total += estimate_tokens(entry.get("level_1", ""))
    for nodes in children_map.values():
        for node in nodes:
            total += estimate_tokens(node.get("content", ""))
    return total


def count_shown_tokens(
    shown_entries: list[dict],
    children_map: dict[str, list[dict]],
    v2_config: dict | None = None,
) -> int:
    """Count tokens for shown entries + their visible children (respecting V2 caps)."""
    total = 0
    for entry in shown_entries:
        total += estimate_tokens(entry.get("level_1", ""))
        children = children_map.get(entry["id"], [])
        if v2_config and children and len(children) > v2_config["topNewestCount"]:
            # Apply same V2 selection as the tree builder
            newest = sorted(children, key=lambda c: c.get("created_at") or "", reverse=True)
            newest_ids = {c["id"] for c in newest[: v2_config["topNewestCount"]]}
            access_ids = {
                c["id"]
                for c in sorted(
                    [c for c in children if c.get("access_count", 0) > 0],
                    key=weighted_access_score,
                    reverse=True,
                )[: v2_config["topAccessCount"]]
            }
            children = [c for c in children if c["id"] in newest_ids | access_ids]
        total += _count_subtree_tokens(children, children_map)
    return total


def _count_subtree_tokens(nodes: list[dict], children_map: dict[str, list[dict]]) -> int:
    """Recursively count tokens for a list of nodes and their descendants."""
    total = 0
    for node in nodes:
        total += estimate_tokens(node.get("content", ""))
        grandchildren = children_map.get(node["id"], [])
        if grandchildren:
            total += _count_subtree_tokens(grandchildren, children_map)
    return total


def fmt_tokens(n: int) -> str:
    """Format token count: 1234 → '1.2k', 56789 → '57k'."""
    if n < 1000:
        return str(n)
    elif n < 10_000:
        return f"{n / 1000:.1f}k"
    else:
        return f"{n // 1000}k"


def node_title(node: dict) -> str:
    """Get node title (from DB or auto-extracted from content)."""
    return node.get("title") or auto_extract_title(node.get("content", ""))


def add_node_to_tree(parent, node: dict, children_map: dict[str, list[dict]]):
    """Recursively add a memory_node and its children from in-memory map."""
    title = node_title(node)
    label = f"[{node['id']}] {title}"
    children = children_map.get(node["id"], [])
    if children:
        tree_node = parent.add(label)
        for child in children:
            add_node_to_tree(tree_node, child, children_map)
    else:
        parent.add_leaf(label)


def entry_title(entry: dict) -> str:
    """Get entry title (from DB or auto-extracted from level_1)."""
    return entry.get("title") or auto_extract_title(entry.get("level_1", ""))


def entry_label(entry: dict, v2_mode: bool = False) -> str:
    date = entry["created_at"][:10] if entry["created_at"] else ""
    mmdd = date[5:] if date else ""
    role_tag = f" [{entry['min_role']}+]" if entry["min_role"] != "worker" else ""
    favorite_tag = " [♥]" if entry.get("favorite") else ""
    promoted_tag = " [★]" if entry.get("_promoted") else ""
    obsolete_tag = " [!]" if entry.get("obsolete") else ""
    title = entry_title(entry)

    if v2_mode:
        # MCP-style compact: ID MM-DD [markers]  title
        return f"{entry['id']} {mmdd}{favorite_tag}{promoted_tag}{obsolete_tag}  {title}"
    else:
        # Full view: [ID] date [role] [markers]  title
        return f"[{entry['id']}] {date}{role_tag}{favorite_tag}{promoted_tag}{obsolete_tag}  {title}"


def add_entry_to_tree(
    parent, entry: dict, children_map: dict[str, list[dict]],
    v2_mode: bool = False, v2_config: dict | None = None,
):
    label = entry_label(entry, v2_mode)
    children = children_map.get(entry["id"], [])

    # V2 mode: cap L2 children (top N newest + top M most-accessed)
    if v2_config and children and len(children) > v2_config["topNewestCount"]:
        newest = sorted(children, key=lambda c: c.get("created_at") or "", reverse=True)
        newest_ids = {c["id"] for c in newest[: v2_config["topNewestCount"]]}
        access_ids = {
            c["id"]
            for c in sorted(
                [c for c in children if c.get("access_count", 0) > 0],
                key=weighted_access_score,
                reverse=True,
            )[: v2_config["topAccessCount"]]
        }
        selected_ids = newest_ids | access_ids
        selected = [c for c in children if c["id"] in selected_ids]
        hidden = len(children) - len(selected)
        children = selected
    else:
        hidden = 0

    if children:
        node = parent.add(label)
        for child in children:
            add_node_to_tree(node, child, children_map)
        if hidden > 0:
            node.add_leaf(f"[+{hidden} more → {entry['id']}]")
    else:
        parent.add_leaf(label)


# ── Memory detail screen ───────────────────────────────────────────────────


class MemoryScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
        Binding("escape,backspace", "app.pop_screen", "Back"),
        Binding("e", "expand_all", "Expand all"),
        Binding("c", "collapse_all", "Collapse all"),
        Binding("r", "toggle_v2", "V2 Read"),
    ]
    CSS = "Tree { height: 1fr; padding: 0 1; }"

    def __init__(self, agent_name: str, db_path: Path):
        super().__init__()
        self.agent_name = agent_name
        self.db_path = db_path
        self.v2_mode = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Tree(self.agent_name)
        yield Footer()

    def on_mount(self):
        self.rebuild_tree()

    def action_toggle_v2(self):
        self.v2_mode = not self.v2_mode
        self.rebuild_tree()

    def rebuild_tree(self):
        tree = self.query_one(Tree)
        tree.root.remove_children()

        active, obsolete, children_map = load_all_data(self.db_path)
        prefix_labels = load_prefix_labels(self.db_path)

        if not active and not obsolete:
            tree.root.label = f"{self.agent_name}  —  (empty)"
            tree.root.add_leaf("No memories yet.")
            return

        if self.v2_mode:
            self._build_v2_tree(tree, active, obsolete, prefix_labels, children_map)
        else:
            self._build_full_tree(tree, active, obsolete, prefix_labels, children_map)

        tree.root.expand()

    # ── Full view (all entries) ───────────────────────────────────────────

    def _build_full_tree(self, tree, active, obsolete, prefix_labels, children_map):
        # Global top-N promotion for [★] marker (time-weighted)
        sorted_by_access = sorted(
            [r for r in active if r["access_count"] > 0],
            key=weighted_access_score,
            reverse=True,
        )
        promoted_ids = {r["id"] for r in sorted_by_access[:5]}
        for r in active:
            r["_promoted"] = r["id"] in promoted_ids

        total_tok = count_all_tokens(active, obsolete, children_map)
        hidden_note = f"  +{len(obsolete)} obsolete hidden" if obsolete else ""
        tree.root.label = f"{self.agent_name}  —  {len(active)} entries{hidden_note}  [{fmt_tokens(total_tok)} tokens total]"

        groups: dict[str, list] = defaultdict(list)
        for e in active:
            groups[e["prefix"]].append(e)

        for prefix in sorted(groups.keys()):
            entries = groups[prefix]
            label_name = prefix_labels.get(prefix, prefix)
            group_node = tree.root.add(f"{prefix}  —  {label_name}  ({len(entries)})")
            for entry in entries:
                add_entry_to_tree(group_node, entry, children_map)

        if obsolete:
            obs_node = tree.root.add(f"⚠  Obsolete  ({len(obsolete)})")
            obs_node.collapse()
            for entry in obsolete:
                add_entry_to_tree(obs_node, entry, children_map)

    # ── V2 bulk-read view (what agents see) ───────────────────────────────

    def _build_v2_tree(self, tree, active, obsolete, prefix_labels, children_map):
        v2_config = load_v2_config(self.db_path)
        expanded_ids, promoted_ids, visible_obsolete = compute_v2_selection(
            active, obsolete, v2_config
        )

        # Set markers
        for r in active:
            r["_promoted"] = r["id"] in promoted_ids

        v2_active = [e for e in active if e["id"] in expanded_ids]
        total = len(active) + len(obsolete)
        shown = len(v2_active) + len(visible_obsolete)
        total_tok = count_all_tokens(active, obsolete, children_map)
        shown_tok = count_shown_tokens(v2_active + visible_obsolete, children_map, v2_config)
        tree.root.label = f"{self.agent_name}  —  V2 Read  ({shown}/{total} shown)  [{fmt_tokens(shown_tok)}/{fmt_tokens(total_tok)} tokens]"

        # Count totals per prefix (from all active)
        total_by_prefix: dict[str, int] = defaultdict(int)
        for e in active:
            total_by_prefix[e["prefix"]] += 1

        groups: dict[str, list] = defaultdict(list)
        for e in v2_active:
            groups[e["prefix"]].append(e)

        for prefix in sorted(groups.keys()):
            entries = groups[prefix]
            label_name = prefix_labels.get(prefix, prefix)
            total_count = total_by_prefix[prefix]
            group_node = tree.root.add(
                f"{prefix}  —  {label_name}  ({len(entries)}/{total_count} shown)"
            )
            for entry in entries:
                add_entry_to_tree(group_node, entry, children_map, v2_mode=True, v2_config=v2_config)

        if visible_obsolete:
            for e in visible_obsolete:
                e["_promoted"] = False
            obs_node = tree.root.add(
                f"⚠  Obsolete  ({len(visible_obsolete)}/{len(obsolete)} shown)"
            )
            for entry in visible_obsolete:
                add_entry_to_tree(obs_node, entry, children_map, v2_mode=True, v2_config=v2_config)

        # Auto-expand to match MCP output: groups + entries visible, L3+ collapsed
        for group_node in tree.root.children:
            group_node.expand()
            for entry_node in group_node.children:
                entry_node.expand()

    # ── Tree actions ──────────────────────────────────────────────────────

    def action_expand_all(self):
        for node in self.query_one(Tree).root.children:
            node.expand_all()

    def action_collapse_all(self):
        for node in self.query_one(Tree).root.children:
            node.collapse_all()


# ── Agent selection screen ─────────────────────────────────────────────────


class AgentListScreen(Screen):
    BINDINGS = [
        Binding("q", "app.quit", "Quit"),
        Binding("enter", "select", "Open"),
    ]
    CSS = "ListView { height: 1fr; padding: 0 1; }"

    def __init__(self, agents: list[tuple[str, Path]]):
        super().__init__()
        self.agents = agents  # [(name, path), ...]

    def compose(self) -> ComposeResult:
        yield Header()
        items = []
        for name, path in self.agents:
            n = count_entries(path)
            subdir = path.parent.parent.name  # "Agents" or "Assistenten"
            tag = "A" if subdir == "Assistenten" else " "
            items.append(ListItem(Label(f"[{tag}] {name:<20}  {n:>3} entries")))
        yield ListView(*items)
        yield Footer()

    def on_list_view_selected(self, _event: ListView.Selected):
        idx = self.query_one(ListView).index
        if idx is None:
            return
        name, path = self.agents[idx]
        self.app.push_screen(MemoryScreen(name, path))

    def action_select(self):
        idx = self.query_one(ListView).index
        if idx is None:
            return
        name, path = self.agents[idx]
        self.app.push_screen(MemoryScreen(name, path))


# ── App ────────────────────────────────────────────────────────────────────


class HmemApp(App):
    TITLE = "hmem viewer"

    def __init__(self, start_screen: Screen):
        super().__init__()
        self._start_screen = start_screen

    def on_mount(self):
        self.push_screen(self._start_screen)


# ── Entry point ────────────────────────────────────────────────────────────


def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        path = Path(arg)
        if path.exists() and path.suffix == ".hmem":
            db_path, agent_name = path, path.stem
        else:
            try:
                db_path = resolve_path(arg)
                agent_name = arg
            except FileNotFoundError as e:
                print(f"Error: {e}")
                sys.exit(1)
        screen = MemoryScreen(agent_name, db_path)
    else:
        agents = find_all_hmems()
        if not agents:
            print(f"No .hmem files found under {PROJECT_DIR}")
            sys.exit(1)
        screen = AgentListScreen(agents)

    HmemApp(screen).run()


if __name__ == "__main__":
    main()
