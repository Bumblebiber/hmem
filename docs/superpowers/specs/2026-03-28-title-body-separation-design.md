# Title/Body Separation for Memory Nodes

**Date:** 2026-03-28
**Status:** Approved

## Problem

Memory nodes have `title` and `content` fields in the schema, but the write path treats every line as a single node where `content = full text` and `title = autoExtractTitle(content)` (first ~50 chars truncated). There is no way for agents to write a short title and a longer body separately. This wastes tokens in listings (full content shown instead of title) and prevents proper lazy loading.

## Design

### Write Format (backward-compatible)

Body lines are marked with `>` prefix (after indentation). Lines without `>` create new nodes (existing behavior preserved).

**L1 (Root entry):**
```
Short Title
> Body line 1 for the root entry
> Body line 2 with more detail
```
- First non-`>` line at depth 0 = `title`
- `>` lines at depth 0 = `level_1` (joined with `\n`, `>` stripped)
- Without any `>` lines: `level_1 = full first line`, `title = autoExtractTitle(level_1)` (backward-compatible)

**L2+ (Child nodes):**
```
\tNode Title
\t> Body line 1
\t> Body line 2
\t\tSub-Node Title
\t\t> Sub-node body
```
- Non-`>` line at given depth = new node, text goes into `title`
- `>` lines at same depth = body for the preceding node, joined with `\n` into `content`
- Without `>` lines: `content = full text`, `title = autoExtractTitle(content)` (backward-compatible)

**Multiline bodies:** `>` lines are joined with `\n`. The `>` marker and one optional leading space are stripped.

### Read Behavior

Three display modes, applied consistently across L1 and L2+ nodes:

| Mode | Title | Body | Children |
|------|-------|------|----------|
| `titles_only: true` | yes | no | no |
| Default (by ID) | yes | yes | shown as title-only |
| `expand: true` | yes | yes | recursive with body |

**Bulk reads:** Show `title` field for L1 entries (not `level_1`). This is mostly already the case but needs verification.

### Scope of Changes

1. **`parseTree()`** in `hmem-store.ts`
   - Detect `>` lines after stripping indentation
   - Accumulate body lines, join with `\n`, assign to `content`
   - Non-`>` line = `title` (new node)
   - For L1: `>` lines at depth 0 go into `level_1`, first line into `title`
   - Backward-compatible: no `>` lines = current behavior

2. **`parseRelativeTree()`** in `hmem-store.ts`
   - Same `>` body detection for `append_memory`

3. **Read path** in `mcp-server.ts`
   - `titles_only`: emit only `title` field
   - Default: emit `title` + `content` (body) for the requested node, children as title-only
   - `expand`: emit everything recursively
   - Bulk reads: use `title` for L1 display (not `level_1`)

4. **L1 handling** in `parseTree()`
   - First non-`>` depth-0 line = `title`
   - Subsequent `>` depth-0 lines = `level_1` body
   - Subsequent non-`>` depth-0 lines: current behavior (appended to title or ignored — verify)

### No Schema Change Required

- `memory_nodes` already has `title` (VARCHAR) + `content` (TEXT)
- `memories` already has `title` (VARCHAR) + `level_1` (TEXT)
- Both field pairs map naturally to title/body

### Backward Compatibility

- Entries written without `>` lines continue to work exactly as before
- `title = autoExtractTitle(content)` remains the fallback
- Existing data in the database is unchanged
- Old agents that don't know about `>` format keep working
