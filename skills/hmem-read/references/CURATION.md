# After Loading — Proactive Curation Reference

Memory is the agent's brain. If something is wrong, stale, or noisy — fix it NOW, don't list problems for later. This applies after `load_project` AND after `read_memory`.

## Scan load_project Output

Every time a `load_project` response is received, scan it for issues and fix them immediately — before responding to the user. The load_project output IS the briefing that every future session gets. If it contains noise, every future session starts with noise.

### What to Look For and How to Fix It

| Problem | Example | Action |
|---------|---------|--------|
| Resolved/done bugs | `.6.2 E0101: O-entry root title never updated` (fixed months ago) | `update_memory(id="P0048.6.2", content="...", irrelevant=true)` |
| Old protocol entries | `.7.32 - windowsHide: true on all child_process spawns` (fragment) | `update_memory(id="P0048.7.32", content="...", irrelevant=true)` |
| Stale version info | Overview says "v5.3.1" but current is v6.0.0 | `update_memory(id="P0048.1.1", content="Current state: v6.0.0 on npm...")` |
| Duplicate sections | `.10 Bugs (duplicate of .6)` | `update_memory(id="P0048.10", content="...", irrelevant=true)` |
| Completed open tasks | `.8.2 DONE: O-Entry Session History Injection` | Should be auto-filtered; if not, mark irrelevant |
| Wrong project's exchanges | O-entry exchanges from P0052 appearing in P0048 | Use `move_nodes` (see below) |
| Stale env/config references | Still references `HMEM_PROJECT_DIR` instead of `HMEM_PATH` | Update the node content |

Use `update_many` when marking multiple entries irrelevant in one go:

```
update_many(ids=["P0048.7.32", "P0048.6.2", "P0048.6.5"], irrelevant=true)
```

## Fix Misplaced O-Entries with move_nodes

When exchanges or session nodes land in the wrong O-entry (e.g. project confusion during a session), move them to the correct location:

```
move_nodes(source_ids=["O0048.3.1.5", "O0048.3.1.6"], target_parent="O0052.1.1")
```

This preserves the exchange content while fixing the tree structure. Don't delete misplaced entries — move them to where they belong.

## Scan Bulk Read Output (read_memory)

After any `read_memory()` call, scan for:

- **Wrong facts** — write correction first, then mark obsolete with `[ID]`:
  ```
  write_memory(prefix="E", content="Correct fix is...") -> E0076
  update_memory(id="E0042", content="Wrong — see [E0076]", obsolete=true)
  ```
- **Noise/irrelevant** — `update_memory(id="T0005", content="...", irrelevant=true)`
- **Important discoveries** — `update_memory(id="S0001", content="...", favorite=true)`

## When NOT to Curate

- Don't curate after every single `read_memory` call — only on the first bulk read of a session and after `load_project`
- Don't curate during time-critical tasks (the user is waiting for a bug fix, not curation)
- Don't mark entries irrelevant if unsure — ask the user first

For a thorough deep-clean, use the `/hmem-self-curate` skill.
