---
name: hmem-write
description: "Store facts, preferences, decisions, and project context into hmem long-term memory using the write_memory MCP tool. Use when the user says 'remember this', 'save this', 'don't forget', 'store this for later', or invokes /hmem-write. Persists key lessons, error resolutions, architecture decisions, user preferences, and project state across sessions. Use when Claude should record conversation insights, save project context, persist important facts, or store user preferences for future reference."
---

# How to use write_memory

Call the MCP tool `write_memory` to save lessons, errors, decisions, or project insights to long-term memory.

If `write_memory` is not available:
1. Tell the user: "write_memory tool not found. Please reconnect the MCP server (in Claude Code: `/mcp`, in other tools: restart the tool)."
2. **NEVER write directly to the .hmem SQLite file via shell commands.** The database has WAL journaling, integrity checks, and tree-structure logic that raw SQL INSERT will bypass — causing corruption or data loss.

---

## Syntax

```
write_memory(
  prefix: "E",
  content: "Short Title (~50 chars)\n\nL1 body — detailed explanation, can span multiple lines\nsecond body line with more context\n\tL2 node title\n\n\tL2 body text (supports newlines)\n\tmore L2 body\n\t\tL3 detail (2 tabs)\n\t\t\tL4 raw data (3 tabs — rarely needed)"
)
```

**Title + Body convention (git-commit style):** Every node has a **title** (short navigation label) and an optional **body** (detailed content loaded on drill-down). Separate them with a **blank line** — just like a git commit message.

- **Title:** The first line (L1) or first line at a given indent level (L2+). ~50 chars, like a chapter title.
- **Body:** Everything after the blank line at the same indent level. Freetext, no special prefix needed. Shown only when the node is drilled into, not in listings.
- **Legacy `> ` prefix:** Still works for backward compatibility, but blank-line separation is preferred.
- **Without body:** The full text is stored as `content` and the title is auto-extracted from the first `maxTitleChars` characters.

**L1 example with body:**
```
Short Error Title

SQLite connection failed because .mcp.json used a relative path.
The fix was to use an absolute path in the HMEM_PATH env var.
	Details about reproduction

	Steps: 1. Set HMEM_PATH=./hmem  2. Run hmem serve  3. Observe SQLITE_CANTOPEN
```

**L1 example without body (still works):**
```
SQLite connection failed due to wrong path in .mcp.json
	Fix: use absolute path in env var
```

**Indentation:** 1 tab = 1 level. Alternatively: 2 or 4 spaces per level (auto-detected).
**Warning:** A tab at the start of any line always means "go one level deeper" — it is structural, not content. If you need to store code or text that contains leading tabs, use spaces instead.
**IDs and timestamps** are assigned automatically — never write them yourself.

---

## Hashtags — add to every write_memory and append_memory call

Hashtags connect entries **across all prefixes and hierarchy levels**. They are the only cross-prefix discovery mechanism.

**Add 3–5 tags per call (max 10):**
```
write_memory(prefix="E", content="...", tags=["#hmem", "#sqlite", "#bug", "#migration", "#windows"])
append_memory(id="P0029", content="...", tags=["#hmem", "#sync", "#cli"])
```

**Rules:**
- Lowercase, starts with `#`, only letters/digits/hyphen/underscore: `#hmem-sync`, `#api_key`
- `append_memory` tags are **additive** — they do not replace existing tags
- `write_memory` tags: if entry has children → land on **first child node**; if leaf (no children) → land on **root**
- `append_memory` tags are stored **only on the target node** — no upward propagation
- Every node at any depth can have its own tags — use this to make sub-topics discoverable

**Good tags:** `#hmem`, `#sync`, `#sqlite`, `#windows`, `#release`, `#bug`, `#security`, `#althing`, `#cli`, `#migration`
**Bad tags:** `#fix` (too generic), `#important` (no context), `#2026` (not a topic)

**Bulk-tagging** for existing entries:
```
tag_bulk(filter={prefix: "E"}, add_tags=["#bug"])           # all E-entries
tag_bulk(filter={search: "hmem-sync"}, add_tags=["#sync"])  # by full-text search
tag_rename(old_tag="#hmem-store", new_tag="#hmem")           # rename a tag everywhere
```

---

## Prefixes

| Prefix | Category | When to use |
|--------|----------|-------------|
| **P** | (P)roject | Project entries — standardized L1 format (see below) |
| **L** | (L)esson | Lessons learned, best practices — cross-project knowledge |
| **E** | (E)rror | Bugs, errors + their fix — auto-scaffolded schema (see below) |
| **D** | (D)ecision | Architecture decisions with reasoning — cross-project knowledge |
| **T** | (T)ask | Cross-project or infrastructure tasks ONLY (see note below) |
| **M** | (M)ilestone | Cross-project milestones ONLY — project milestones go in P-entry L2 "Protocol" |
| **S** | (S)kill | Skills, processes, how-to guides |
| **N** | (N)avigator | Code pointers — where something lives in the codebase |
| **H** | (H)uman | Knowledge about the user — preferences, context, working style |
| **R** | (R)ule | User-defined rules and constraints — "always do X", "never do Y" |
| **I** | (I)nfrastructure | Devices, servers, deployments, network — one entry per device/server |

### Where do tasks, errors, lessons, and decisions go?

**Tasks** belong inside the project's P-entry L2 "Open tasks" node:
```
append_memory(id="P0048.8", content="Implement multi-server sync\n\tPush/pull to all configured servers", tags=["#hmem-sync"])
```
Use the T-prefix ONLY for tasks that span multiple projects or are infrastructure/meta tasks (e.g. "Set up Strato server", "Run curation pass"). These get `links=["P00XX"]` to the most relevant project.

**Milestones** belong in the P-entry L2 "Protocol" node as a chronological entry:
```
append_memory(id="P0048.7", content="v4.0.0 published — project gate + load_project tool (2026-03-27)", tags=["#release"])
```
Use the M-prefix ONLY for milestones that span multiple projects (e.g. "First cross-device sync working").

**Errors (E), Lessons (L), Decisions (D)** stay as independent root entries — they are **cross-project knowledge**. An SQLite lesson learned in hmem applies to every SQLite project. Always add `tags` and `links` to connect them back:
```
write_memory(prefix="E", content="...", tags=["#hmem", "#sqlite"], links=["P0048"])
```

**P-entry "Known issues" (L2)** contains short summaries pointing to E-entries — not the errors themselves:
```
append_memory(id="P0048.6", content="Auto-sync fails with multiple .hmem in CWD → E0097, T0043", tags=["#hmem-sync"])
```

**Custom prefixes:** If none of the above fit, you can use any single uppercase letter. To register it officially (so the system validates it), add it to `hmem.config.json` under `"prefixes"`:
```json
{ "prefixes": { "R": "Research" } }
```
Custom prefixes are merged with the defaults — they don't replace them. Without registering, the system will reject the prefix.

### Schema-Enforced Entries (P and any prefix with a defined schema)

The MCP server enforces schemas for any prefix that has a `schemas` entry in `hmem.config.json`.
For those prefixes, two rules apply:

1. **`write_memory`**: L2 node names must match the defined section names (error otherwise).
2. **`append_memory` to root entry (e.g. `P0029`, no dot)**: **blocked** — you cannot add new L2 sections.
   You must append to a specific section: `append_memory(id="P0029.N", content="...")`.

By default, `P` has a schema. If `L`, `D`, or other prefixes are configured with schemas, the same rules apply.

### P-Entry Standard Schema

Every project entry MUST follow this structure.

**L1 Title:** `Name | Status | Tech Stack | GH: owner/repo | Short description`
The GH field is optional — include it when a GitHub repo exists, omit otherwise.
**L1 Body:** (same line or next non-indented line) One-sentence project summary.

**Status values:**

| Status | Meaning |
|--------|---------|
| New | Just started, concept phase |
| Active | In active development |
| Mature | Feature-complete, only bugfixes |
| Paused | On hold, will resume later |
| Archived | Done or abandoned |

**L2 categories (fixed order, skip sections that are empty):**

The MCP server validates that L2 nodes start with one of these names. Minimum for a new project: Overview + Codebase (or Usage).

| L2 Category | What goes here | L3 children |
|-------------|---------------|-------------|
| **Overview** | First thing an agent reads (like CLAUDE.md /init) | Current state, Goals, Architecture, Environment |
| **Codebase** | Code structure — NO code, only names + signatures | Entry point, Core modules (each module = L4 node with signature + purpose + return), Helpers, Config, Tests |
| **Usage** | How the project is used | Installation/Setup, CLI/API commands, Common workflows |
| **Context** | Background and motivation | Initiator, Target audience, Business context, Dependencies (links) |
| **Deployment** | Build/CI/CD/publish process | (flat or with L3 sub-steps) |
| **Bugs** | Active bugs + known limitations | L3: inline report (symptom + cause) OR pointer to E-entry (`→ E0097`). L4: reproduction steps |
| **Protocol** | Session log, chronological | One-liner per session + links to O-entries |
| **Open tasks** | Project-specific TODOs | One per L3 node. Cross-project tasks → T-prefix with links |
| **Ideas** | Feature ideas, brainstorming | L3: short description, L4: implementation details |

**load_project tool:** Use `load_project(id="P0048")` to activate a project and get the full briefing (L2 content + L3 titles) in one call. This is the recommended way to start working on a project — it combines read + activate.

**Markers you may see on entries:**

| Marker | Meaning |
|--------|---------|
| `[♥]` | Favorite — always expanded in bulk reads |
| `[★]` | Top-accessed — high weighted access score |
| `[≡]` | Top-subnode — many children |
| `[⚡]` | Task-promoted — relevant to an active T/P/D entry (tag overlap) |
| `[*]` | Active — currently in focus |
| `[P]` | Pinned — super-favorite, shows full L2 |
| `[!]` | Obsolete — superseded, kept for history |
| `[-]` | Irrelevant — hidden from bulk reads |
| `✓` | Synced — backed up to all sync servers |

**Complete P-entry example (WeatherBot):**

```
write_memory(
  prefix="P",
  content="WeatherBot | New | Python/Discord.py | GH: user/weatherbot\n\nDiscord bot for weather forecasts — slash commands for current weather and multi-day forecasts\n\tOverview\n\t\tCurrent state\n\n\t\tScaffolding done, no commands yet. Bot connects to Discord but has no slash commands registered.\n\t\tGoals\n\n\t\tDaily/hourly forecasts via slash commands, multi-city support, embed formatting\n\t\tArchitecture\n\n\t\tDiscord slash command → OpenWeatherMap API → formatted embed. Single-file cog pattern.\n\t\tEnvironment\n\n\t\t/home/user/weatherbot, python bot.py, needs DISCORD_TOKEN + WEATHER_API_KEY in .env\n\tCodebase\n\t\tEntry point — bot.py, start: python bot.py\n\t\tCore modules\n\t\t\tweather_cog.py — WeatherCog(Cog); fetch_forecast(city: str) → discord.Embed\n\t\t\tformatter.py — format_embed(data: dict) → discord.Embed\n\t\tHelpers / Utilities\n\t\t\tapi_client.py — get_weather(city: str) → dict; wraps HTTP to OpenWeatherMap\n\t\tConfig / Constants — .env: DISCORD_TOKEN, WEATHER_API_KEY, DEFAULT_CITY\n\t\tTests — pytest, test_weather_cog.py (3 tests)\n\tUsage\n\t\tInstallation / Setup — pip install -r requirements.txt, cp .env.example .env\n\t\tCLI / API — /weather <city>, /forecast <city> (planned)\n\tContext\n\t\tInitiator — personal project, Mar 2026\n\t\tTarget audience — personal Discord server\n\t\tDependencies — discord.py, OpenWeatherMap API, aiohttp\n\tOpen tasks\n\t\tImplement /forecast command\n\n\t\tMulti-day view with daily highs/lows and weather icons per day\n\t\tAdd city autocomplete",
  tags=["#discord", "#python", "#weather", "#bot"],
  links=[]
)
```

Note: L2 nodes use 1 tab, L3 uses 2 tabs, L4 uses 3 tabs. Separate title from body with a blank line at the same indent level. Skip empty sections — no need for placeholder text.

### E-Entry Schema (auto-scaffolded)

E-entries have a **pre-built structure** — just provide a title and short description, the server creates the rest:

```
write_memory(prefix="E", content="hmem sync bug on v1.0.1\n\nConnection fails when HMEM_PATH contains spaces", tags=["#hmem", "#sync", "#path"])
```

This auto-creates:
- **.1 Analysis** (your description goes here automatically)
- **.2 Possible fixes**
- **.3 Fixing attempts**
- **.4 Solution**
- **.5 Cause**
- **.6 Key Learnings**

Plus `#open` tag. Fill in the nodes as you debug with `append_memory`/`update_memory`. The response shows **similar E/D entries by tag overlap** — check them before reinventing the wheel. When solved, replace `#open` with `#solved` and fill .4 + .5 + .6.

E-entries are **not shown in bulk reads** — they surface automatically via tag overlap when you create new E/D entries. Solved bugs are knowledge, not clutter.

### Marking entries as favorites

Mark any entry as a favorite to ensure it always appears with its L2 detail in bulk reads (alongside a `[♥]` marker). Use this for reference info you need to see every session — API endpoints, key decisions, frequently looked-up patterns.

```
write_memory(prefix="D", content="...", favorite=true)           # set at creation
update_memory(id="D0010", content="...", favorite=true)          # set on existing
update_memory(id="D0010", content="...", favorite=false)         # clear
```

Favorites are **not** a prefix — they are a flag on any entry regardless of category.
Use sparingly: if everything is a favorite, nothing is. Prefer high-value reference entries over fleeting notes.

---

### Marking entries as obsolete

When you notice that an entry is outdated — superseded by a newer approach, a fixed bug, or changed architecture — do **not** delete it. Mark it as obsolete with a correction reference:

```
# Step 1: Write the correction FIRST
write_memory(prefix="E", content="Correct approach is XYZ\n\tDetails...")  # → E0076

# Step 2: Mark old entry obsolete — MUST include [✓ID] tag
update_memory(id="E0023", content="Wrong approach — see [✓E0076]", obsolete=true)
```

**The `[✓ID]` tag is enforced.** The system will reject `obsolete=true` without a correction reference. This ensures every obsolete entry points to its replacement. The system also creates **bidirectional links** automatically (E0023↔E0076).

The entry stays in memory with a `[!]` marker. Past errors still carry learning value ("we tried this and it failed because..."). The curator may eventually prune it, but that's their decision, not yours.

**Shortcut for stale entries:** If no correction exists (entry is just old/irrelevant, not wrong), only the curator can mark it obsolete without `[✓ID]`.

---

### N — Navigator (Code Pointers)

Use `N` to save a pointer to a specific file, function, or code location so you don't have to search for it next session.

```
write_memory(
  prefix="N",
  content="Link-Auflösung beim read_memory-Aufruf
	src/hmem-store.ts ~line 269 — read() method, ID branch
	Guard: resolveLinks !== false prevents circular refs
	Introduced in v1.4.0",
  links=["E0069"]
)
```

**L1:** What it is — one sentence describing the concept/feature
**L2:** Exact file path + line range + function/method name
**L3:** Context, caveats, related patterns
**Links:** Related entries (errors, decisions, lessons)

**Your responsibility:** Update your N entries whenever you notice code has moved or logic has changed. You don't need the curator for this — use `update_memory` directly. Stale pointers are worse than none. If you cannot verify whether the pointer is still valid, mark it obsolete: `update_memory(id="N0012", content="...", obsolete=true)`.

---

## Title + Body Quality Rules

**Title:** Short navigation label, ~50 chars (configurable via `maxTitleChars`). Think "chapter title in a book".
- Good: `"hmem.py Performance: Bulk-Queries statt N+1"`, `"Ghost Wakeup Bug in msg-router.ts"`
- Bad: `"Fixed a bug"`, `"Important lesson"` (too vague)

**Body (after blank line):** Detailed explanation — full sentences, multiline OK. Shown on drill-down, hidden in listings.
- Must be understandable without any context
- Not "Fixed a bug" — instead explain root cause, fix, and impact

**With title + body (recommended):**
```
write_memory(prefix="L", content="hmem.py Performance: Bulk-Queries statt N+1\n\nAlle Nodes in 2 Bulk-Queries laden, nicht pro Entry einzeln.\nVorher: load_nodes() pro Entry = N+1 SQLite-Connections.\n\tImplementation detail\n\n\tChanged read() to batch-fetch all nodes for visible entries in one query")
```

**Without body (simple entries, backward-compatible):**
```
write_memory(prefix="E", content="SQLite connection failed due to wrong path in .mcp.json\n\tFix: use absolute path in env var")
```
Title auto-extracted: `"SQLite connection failed due to wrong path in .mc"`

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

## Before Writing: Navigate the Tree First

**Never write blindly.** Before creating a new entry or appending, navigate the existing tree top-down to find the correct insertion point. New information almost always belongs inside an existing entry — not as a new root.

### Protocol

**Step 1 — Check L1 summaries (already in context)**
Scan the root entries visible in your context. Is there a matching root for this topic?

- **No match** → `write_memory()` creates a new root
- **Match found** → continue to Step 2

**Step 2 — Read the matching root's children**
```
read_memory(id="P0029")   # shows root + all L2 titles
```
Do any L2 titles match the sub-topic?

- **No match (and no schema)** → `append_memory(id="P0029", content="...")` adds a new L2
- **No match (schema-constrained entry like P)** → find the closest existing section and append there (L2 additions are blocked)
- **Match found (e.g. .15)** → continue to Step 3

**Step 3 — Drill into that L2**
```
read_memory(id="P0029.15")   # shows L2 node + all L3 titles
```
Does an L3 match even more specifically?

- **No match** → `append_memory(id="P0029.15", content="...")` adds a new L3
- **Match found** → continue drilling (Step 4: `read_memory(id="P0029.15.2")`, etc.)

**Stop drilling when:** no child matches, or you've reached the level of granularity that fits.

### Example

New insight about MCP server restart behavior after TypeScript compile:

```
# Step 1: L1 summaries show L0074 "MCP server muss nach Kompilierung neugestartet werden"
# Step 2: read_memory(id="L0074") → shows .1 "Fix: kill + auto-respawn", .2 "Context: Althing only"
# No L2 matches the new sub-case → append at L2

append_memory(id="L0074", content="Standalone hmem-mcp: npm restart required (no auto-respawn)")
# → adds L0074.3 (L3 under the existing lesson)
```

Instead of: `write_memory(prefix="L", content="MCP restart needed after compile...")` — which would duplicate L0074.

### When `write_memory` is correct

Only use `write_memory` when:
- No root entry exists for this topic at all
- The topic is genuinely orthogonal (different error, different decision, different project)
- You're creating an E/L/D entry for a new root cause, not an extension of an existing one

**Rule:** If in doubt, drill one level deeper before deciding to create a new root.

---

## When to save?

**Checkpoint mode matters.** Check `checkpointMode` in hmem.config.json:

- **`"auto"` (recommended):** A background Haiku subagent handles checkpoints automatically every N exchanges. It reads recent O-entry exchanges, calls `read_memory` to avoid duplicates, and writes L/D/E entries + handoff via MCP tools. It also writes a rolling checkpoint summary (`[CP]` node tagged `#checkpoint-summary`) that compresses older exchanges for `load_project`. Skill-dialog exchanges are auto-tagged `#skill-dialog` and filtered from context injection. **You do NOT need to write entries yourself** unless the user explicitly asks you to save something specific.

- **`"remind"`:** You will receive a CHECKPOINT reminder every N messages. When you see it, save key learnings yourself using `write_memory` / `append_memory`.

**In both modes:** Only save what is still valuable in 6 months.

| Save | Don't save |
|------|-----------|
| New root cause + fix | Routine actions without learning value |
| Insight that changes future work | What's already in the codebase |
| Architecture decision + reasoning | Temporary debugging notes |
| Unexpected tool/API behavior | What's in the documentation |

One `write_memory` call per category — entire hierarchy in one `content` string.

---

## Updating Existing Memories

Use `update_memory` and `append_memory` to modify entries without deleting and recreating them.

### update_memory — Fix outdated text

Updates the text of a single node. Children are **not** touched.

```
update_memory(id="L0003", content="Corrected L1 summary — new wording")
update_memory(id="L0003.2", content="Fixed L2 detail")
update_memory(id="D0010", content="New L1", links=["E0042"])  # also update links
```

Use when: the wording is wrong, outdated, or needs clarification.

### append_memory — Add detail to existing entry

Appends new child nodes under an existing root or node. Existing children are preserved.

Content indentation is **relative to the parent** — 0 tabs = direct child of `id`.
Body works the same as in `write_memory` — blank line separates title from body.

> **Schema enforcement:** For entries with a defined schema (e.g., all P-entries), appending
> to the root (e.g., `id="P0029"`) is **blocked** — that would create a new L2 section outside
> the schema. You must target a specific section: `append_memory(id="P0029.3", content="...")`.
> For entries without a schema (L, D, E, etc. by default), root appends are allowed.

```
append_memory(
  id="L0003",
  content="New finding discovered later\n\nDetailed explanation of what was found and why it matters.\nThis can span multiple lines.\n\tSub-detail about it"
)
# → adds L0003.N (L2 with title + body) and L0003.N.1 (L3)
# ↑ only works if L has no schema defined; use L0003.N for schema-constrained entries

append_memory(
  id="P0029.3",
  content="New detail in the Usage section"
)
# → adds P0029.3.M (L3 under section .3) — correct way for schema-constrained entries

append_memory(
  id="L0003.2",
  content="Extra note under L0003.2"
)
# → adds L0003.2.M (L3)
```

Use when: you have new context to add without replacing what's there.

### When to use which

| Situation | Tool |
|-----------|------|
| L1 wording is wrong/outdated | `update_memory` |
| A sub-node has wrong detail | `update_memory` |
| You have new info to add | `append_memory` |
| Entry is completely wrong | mark obsolete with `[✓newId]`, then `write_memory` for the correction |

---

## Access Count (Automatic + Time-Weighted)

Access counts are managed automatically — every `read_memory` and `append_memory` call bumps the accessed entries. The ranking uses **time-weighted scoring** (`access_count / log2(age_in_days + 2)`) so newer entries with fewer accesses can outrank stale old ones. Entries with the highest weighted scores get `[★]` markers and expanded treatment in bulk reads. To explicitly mark an entry as important, use `favorite: true` on `write_memory` or `update_memory`.

---

## Bulk Tag Operations

Apply tags to multiple entries at once, or rename a tag everywhere:

```
# Add #bugfix to all E-prefix entries
tag_bulk(filter={prefix: "E"}, add_tags=["#bugfix"])

# Add tag to entries matching a search term
tag_bulk(filter={search: "FTS5"}, add_tags=["#search", "#sqlite"])

# Remove #old from all entries that have it
tag_bulk(filter={tag: "#old"}, remove_tags=["#old"])

# Add and remove simultaneously
tag_bulk(filter={prefix: "L", tag: "#draft"}, add_tags=["#stable"], remove_tags=["#draft"])

# Rename a tag everywhere
tag_rename(old_tag="#hmem-store", new_tag="#hmem")
```

Use `tag_bulk` when adding a new systematic tag to an existing category, or cleaning up after a tagging convention change. `tag_rename` handles typos or renames across the entire memory.

---

## H-Prefix: User Skill Assessment

Actively track the user's expertise level across topics. This drives how you communicate —
a coding expert doesn't need variable explanations, a beginner doesn't need jargon.

### Structure

One H-entry per main topic, with sub-nodes per subtopic:

```
write_memory(prefix="H", content="User Skill: IT
	Coding — Advanced: writes TypeScript fluently, debugs SQLite schemas, understands async/MCP
	Terminal/CLI — Advanced: bash, git, systemctl, nvm, sqlite3 comfortable
	Networking — Intermediate: HTTP/DNS solid, asked about WebSocket details
	DevOps — Intermediate: systemd + nvm yes, Docker unfamiliar",
  tags=["#skill-assessment", "#it"])
```

Levels: **1-10 scale** (see user-assessment skill for full details).
1-2 = no experience, 5-6 = intermediate, 9-10 = expert. Half-points allowed.

Always include evidence (observed behavior, not assumptions).

### When to assess

- **First interaction**: Make initial assessment from vocabulary, questions, and tool usage
- **Ongoing (every few exchanges)**: Watch for signals:
  - **Upgrade signals**: uses domain-specific terms correctly, solves problems independently, corrects the agent
  - **Downgrade signals**: "das verstehe ich nicht", "explain that", asks about basic concepts, misuses terms
- **On /save**: Review and update assessments if evidence accumulated

### How to update

Reference the O-entry (automatic session log) where the skill change was observed:

```
# User demonstrated new skill — link to the exchange that proves it
append_memory(id="H0010", content="Docker — Intermediate: configured docker-compose independently (see O0042.15)")

# User's skill improved
update_memory(id="H0010.3", content="Networking — Advanced: configures DNS, TLS, reverse proxies (see O0042.23)")

# User struggled — downgrade with evidence
update_memory(id="H0010.4", content="DevOps — Beginner: asked what systemd is, needed step-by-step (see O0042.8)")
```

The O-entry reference lets future agents verify the assessment by reading the original conversation.

### How to USE assessments

Before explaining anything technical, check the relevant H-entry:

- **Beginner**: Explain concepts, use analogies, avoid jargon, step-by-step
- **Intermediate**: Brief explanations, some jargon OK, link to docs for details
- **Advanced**: Direct technical language, skip basics, focus on trade-offs
- **Expert**: Peer-level discussion, challenge assumptions, discuss edge cases

Example: If H0010.1 says "Coding — Advanced", don't explain what a Map is.
If H0010.4 says "DevOps — Beginner", explain what a systemd service does before configuring one.

### Topics are open-ended

Not just IT — any domain the user works in:
- Music (theory, instruments, production)
- Mechanical (bikes, cars, tools)
- Business (accounting, marketing, management)
- Languages (German, English proficiency)

Create new H-entries as topics emerge naturally from conversation.

---

## Language Consistency

Match the language of existing entries. Before writing, check what language the memory store uses (run `read_memory()` if unsure). If existing entries are in German, write in German. If English, write in English. Do not mix languages within a single store — it makes search and curation harder.

## Anti-Patterns

| Wrong | Right |
|-------|-------|
| L1 too short: "Fixed bug" | Full sentence with root cause + blank line + body |
| Writing English when existing entries are German | Match the store's language |
| Tabs inside content text (e.g. code snippets) | Use spaces for indentation within content — tabs at line start always mean "go deeper in the hierarchy" |
| Mixed spaces and tabs for hierarchy | Stay consistent — either tabs or spaces as your depth marker |
| Everything flat, no indentation | Use hierarchy — L2/L3 for details |
| Save trivial things | Quality over quantity |
| Forget to write_memory | Always call BEFORE setting Status: Completed |
| Write to .hmem via sqlite3/SQL | ONLY use `write_memory` MCP tool — never raw SQL |
| MCP unavailable → skip saving | Reconnect MCP first (`/mcp` or restart tool) |
| `update_memory(id="X", obsolete=true)` without `[✓ID]` | Write correction first, then mark obsolete with `[✓E0076]` tag |
