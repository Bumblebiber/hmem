# Prefixes, Markers, and Bulk Tag Operations

## Prefix Table

| Prefix | Category | When to use |
|--------|----------|-------------|
| **P** | (P)roject | Project entries — standardized L1 format (see P-SCHEMA.md) |
| **L** | (L)esson | Lessons learned, best practices — cross-project knowledge |
| **E** | (E)rror | Bugs, errors + their fix — auto-scaffolded schema (see E-SCHEMA.md) |
| **D** | (D)ecision | Architecture decisions with reasoning — cross-project knowledge |
| **T** | (T)ask | Cross-project or infrastructure tasks ONLY (see note below) |
| **M** | (M)ilestone | Cross-project milestones ONLY — project milestones go in P-entry L2 "Protocol" |
| **S** | (S)kill | Skills, processes, how-to guides |
| **N** | (N)avigator | Code pointers — where something lives in the codebase |
| **H** | (H)uman | Knowledge about the user — preferences, context, working style |
| **R** | (R)ule | User-defined rules and constraints — "always do X", "never do Y" |
| **I** | (I)nfrastructure | Devices, servers, deployments, network — one entry per device/server |

## Where Do Tasks, Errors, Lessons, and Decisions Go?

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
append_memory(id="P0048.6", content="Auto-sync fails with multiple .hmem in CWD -> E0097, T0043", tags=["#hmem-sync"])
```

## Custom Prefixes

If none of the above fit, use any single uppercase letter. To register it officially (so the system validates it), add it to `hmem.config.json` under `"prefixes"`:
```json
{ "prefixes": { "R": "Research" } }
```
Custom prefixes are merged with the defaults — they do not replace them. Without registering, the system will reject the prefix.

## Markers

| Marker | Meaning |
|--------|---------|
| `[heart]` | Favorite — always expanded in bulk reads |
| `[star]` | Top-accessed — high weighted access score |
| `[triple-bar]` | Top-subnode — many children |
| `[lightning]` | Task-promoted — relevant to an active T/P/D entry (tag overlap) |
| `[*]` | Active — currently in focus |
| `[P]` | Pinned — super-favorite, shows full L2 |
| `[!]` | Obsolete — superseded, kept for history |
| `[-]` | Irrelevant — hidden from bulk reads |
| `checkmark` | Synced — backed up to all sync servers |

## N — Navigator (Code Pointers)

Use `N` to save a pointer to a specific file, function, or code location so the agent does not have to search for it next session.

```
write_memory(
  prefix="N",
  content="Link resolution in read_memory call
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

Update N entries whenever code has moved or logic has changed. Stale pointers are worse than none. If the pointer cannot be verified, mark it obsolete.

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

## Access Count (Automatic + Time-Weighted)

Access counts are managed automatically — every `read_memory` and `append_memory` call bumps the accessed entries. The ranking uses **time-weighted scoring** (`access_count / log2(age_in_days + 2)`) so newer entries with fewer accesses can outrank stale old ones. Entries with the highest weighted scores get `[star]` markers and expanded treatment in bulk reads. To explicitly mark an entry as important, use `favorite: true` on `write_memory` or `update_memory`.
