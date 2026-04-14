---
name: hmem-write
description: "Store facts, preferences, decisions, and project context into hmem long-term memory using the write_memory MCP tool. Use when the user says 'remember this', 'save this', 'don't forget', 'store this for later', or invokes /hmem-write. Persists key lessons, error resolutions, architecture decisions, user preferences, and project state across sessions. Use when Claude should record conversation insights, save project context, persist important facts, or store user preferences for future reference."
---

# How to use write_memory

Call the MCP tool `write_memory` to save lessons, errors, decisions, or project insights to long-term memory.

If `write_memory` is not available:
1. Tell the user: "write_memory tool not found. Please reconnect the MCP server (in Claude Code: `/mcp`, in other tools: restart the tool)."
2. **NEVER write directly to the .hmem SQLite file via shell commands.** The database uses WAL journaling and integrity checks that raw SQL will bypass.

---

## Syntax

```
write_memory(
  prefix: "E",
  content: "Short Title (~50 chars)\n\nL1 body — detailed explanation, can span multiple lines\nsecond body line with more context\n\tL2 node title\n\n\tL2 body text (supports newlines)\n\tmore L2 body\n\t\tL3 detail (2 tabs)\n\t\t\tL4 raw data (3 tabs — rarely needed)"
)
```

**Title + Body convention (git-commit style):** Every node has a **title** (short navigation label) and an optional **body** (detailed content). Separate them with a **blank line**.

- **Title:** First line at a given indent level. ~50 chars, like a chapter title.
- **Body:** Everything after the blank line at the same indent level. Shown only on drill-down, not in listings.
- **Legacy `> ` prefix:** Still works for backward compatibility, but blank-line separation is preferred.
- **Without body:** Full text stored as `content`, title auto-extracted from first `maxTitleChars` characters.

**L1 example with body:**
```
Short Error Title

SQLite connection failed because .mcp.json used a relative path.
The fix was to use an absolute path in the HMEM_PATH env var.
	Details about reproduction

	Steps: 1. Set HMEM_PATH=./hmem  2. Run hmem serve  3. Observe SQLITE_CANTOPEN
```

**Indentation:** 1 tab = 1 level. Alternatively: 2 or 4 spaces per level (auto-detected).
**Warning:** A tab at the start of any line always means "go one level deeper" — it is structural. Store code/text with leading tabs using spaces instead.
**IDs and timestamps** are assigned automatically — never write them manually.

---

## Hashtags — add to every write_memory and append_memory call

Hashtags connect entries **across all prefixes and hierarchy levels**. They are the only cross-prefix discovery mechanism.

**Add 3-5 tags per call (max 10):**
```
write_memory(prefix="E", content="...", tags=["#hmem", "#sqlite", "#bug", "#migration", "#windows"])
append_memory(id="P0029", content="...", tags=["#hmem", "#sync", "#cli"])
```

**Rules:**
- Lowercase, starts with `#`, only letters/digits/hyphen/underscore: `#hmem-sync`, `#api_key`
- `append_memory` tags are **additive** — they do not replace existing tags
- `write_memory` tags: if entry has children -> land on **first child node**; if leaf -> land on **root**
- Every node at any depth can have its own tags

**Good tags:** `#hmem`, `#sync`, `#sqlite`, `#windows`, `#release`, `#bug`, `#security`, `#cli`, `#migration`
**Bad tags:** `#fix` (too generic), `#important` (no context), `#2026` (not a topic)

---

## Prefixes

| Prefix | Category | When to use |
|--------|----------|-------------|
| **P** | (P)roject | Project entries — standardized L1 format |
| **L** | (L)esson | Lessons learned, best practices — cross-project knowledge |
| **E** | (E)rror | Bugs, errors + their fix — auto-scaffolded schema |
| **D** | (D)ecision | Architecture decisions with reasoning |
| **T** | (T)ask | Cross-project or infrastructure tasks ONLY |
| **M** | (M)ilestone | Cross-project milestones ONLY |
| **S** | (S)kill | Skills, processes, how-to guides |
| **N** | (N)avigator | Code pointers — where something lives in the codebase |
| **H** | (H)uman | Knowledge about the user — preferences, context, working style |
| **R** | (R)ule | User-defined rules and constraints |
| **I** | (I)nfrastructure | Devices, servers, deployments, network |

-> See [references/PREFIXES.md](references/PREFIXES.md) for placement rules (where tasks/errors/milestones belong), custom prefixes, markers, Navigator entries, bulk tag operations, and access scoring.

-> See [references/P-SCHEMA.md](references/P-SCHEMA.md) for P-entry standard schema, status values, L2 categories, and the WeatherBot example.

-> See [references/E-SCHEMA.md](references/E-SCHEMA.md) for E-entry auto-scaffolded schema, favorites, and obsolete marking.

-> See [references/H-ASSESSMENT.md](references/H-ASSESSMENT.md) for H-prefix user skill assessment guide.

---

## Title + Body Quality Rules

**Title:** Short navigation label, ~50 chars. Think "chapter title in a book".
- Good: `"hmem.py Performance: Bulk-Queries statt N+1"`, `"Ghost Wakeup Bug in msg-router.ts"`
- Bad: `"Fixed a bug"`, `"Important lesson"` (too vague)

**Body (after blank line):** Detailed explanation — full sentences, multiline OK. Must be understandable without context.

---

## Navigate the Tree Before Writing

**Never write blindly.** Navigate the existing tree top-down to find the correct insertion point. New information almost always belongs inside an existing entry — not as a new root.

### Protocol

**Step 1 — Check L1 summaries (already in context)**
Scan root entries. Is there a matching root for this topic?
- **No match** -> `write_memory()` creates a new root
- **Match found** -> continue to Step 2

**Step 2 — Read the matching root's children**
```
read_memory(id="P0029")   # shows root + all L2 titles
```
- **No L2 match** -> `append_memory(id="P0029", content="...")` adds a new L2
- **Match found (e.g. .15)** -> continue to Step 3

**Step 3 — Drill into that L2**
```
read_memory(id="P0029.15")   # shows L2 node + all L3 titles
```
- **No L3 match** -> `append_memory(id="P0029.15", content="...")` adds a new L3
- **Match found** -> continue drilling

**Stop drilling when:** no child matches, or the level of granularity fits.

### When write_memory Is Correct

Only use `write_memory` when:
- No root entry exists for this topic
- The topic is genuinely orthogonal (different error, different decision, different project)
- Creating an E/L/D entry for a new root cause, not extending an existing one

**Rule:** If in doubt, drill one level deeper before creating a new root.

---

## When to Save

**Checkpoint mode matters.** Check `checkpointMode` in hmem.config.json:

- **`"auto"` (recommended):** A background Haiku subagent handles checkpoints automatically. The agent does NOT need to write entries unless the user explicitly asks to save something specific.
- **`"remind"`:** The agent receives a CHECKPOINT reminder every N messages. Save key learnings using `write_memory` / `append_memory` when prompted.

**In both modes:** Only save what is still valuable in 6 months.

| Save | Do not save |
|------|-------------|
| New root cause + fix | Routine actions without learning value |
| Insight that changes future work | What is already in the codebase |
| Architecture decision + reasoning | Temporary debugging notes |
| Unexpected tool/API behavior | What is in the documentation |

One `write_memory` call per category — entire hierarchy in one `content` string.

---

## Updating Existing Memories

### update_memory — Fix outdated text

Updates the text of a single node. Children are **not** touched.

```
update_memory(id="L0003", content="Corrected L1 summary — new wording")
update_memory(id="D0010", content="New L1", links=["E0042"])  # also update links
```

Use when: wording is wrong, outdated, or needs clarification.

### append_memory — Add detail to existing entry

Appends new child nodes under an existing root or node. Existing children are preserved.
Content indentation is **relative to the parent** — 0 tabs = direct child of `id`.

```
append_memory(
  id="L0003",
  content="New finding discovered later\n\nDetailed explanation of what was found and why it matters.\n\tSub-detail about it"
)
# -> adds L0003.N (L2 with title + body) and L0003.N.1 (L3)
```

### Decision Table

| Situation | Tool |
|-----------|------|
| L1 wording is wrong/outdated | `update_memory` |
| A sub-node has wrong detail | `update_memory` |
| New info to add | `append_memory` |
| Entry is completely wrong | curator: `delete_agent_memory` + `write_memory` |

---

## Company Knowledge (requires AL+ role)

```
write_memory(
  prefix: "S",
  store: "company",
  content: "..."
)
```

---

## Language Consistency

Match the language of existing entries. Before writing, check what language the memory store uses (run `read_memory()` if unsure). Do not mix languages within a single store.

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| L1 too short: "Fixed bug" | Full sentence with root cause + blank line + body |
| Writing English when existing entries are German | Match the store's language |
| Tabs inside content text (e.g. code snippets) | Use spaces for indentation within content |
| Mixed spaces and tabs for hierarchy | Stay consistent with one depth marker |
| Everything flat, no indentation | Use hierarchy — L2/L3 for details |
| Save trivial things | Quality over quantity |
| Forget to write_memory | Always call BEFORE setting Status: Completed |
| Write to .hmem via sqlite3/SQL | ONLY use `write_memory` MCP tool |
| MCP unavailable -> skip saving | Reconnect MCP first (`/mcp` or restart tool) |
| `update_memory(id="X", obsolete=true)` without correction ref | Write correction first, then mark obsolete |
