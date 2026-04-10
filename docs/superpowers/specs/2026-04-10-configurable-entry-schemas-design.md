# Configurable Entry Schemas

**Date:** 2026-04-10
**Status:** Draft — pending implementation plan

## Problem

Entry schemas for P-entries (and potentially other prefixes like E) are hardcoded in `create_project` (9 fixed L2 sections from R0009) and `load_project` (uniform `depth=3` for all sections). This creates three issues:

1. **No customization** — every P-entry gets the same structure regardless of context. A game character in MAIMO needs completely different sections than a software project.
2. **No load control** — Protocol (36+ entries in hmem) is loaded at the same depth as Overview (3 entries), wasting tokens on low-value content during project load.
3. **No reconciliation** — when the schema evolves (e.g. adding "Next Steps"), existing entries don't gain the new sections automatically. Agents must manually create them via `append_memory`.

## Goals

1. Schema definitions per prefix in `hmem.config.json` — each `.hmem` instance has its own schemas.
2. `create_project` reads the schema and creates matching L2/L3 nodes instead of hardcoding.
3. `load_project` loads each section at its configured depth (0 = skip entirely).
4. Auto-reconcile on `load_project`: detect missing sections, create them as empty nodes, report what was added.
5. Prefixes without a schema entry remain free-form (current behavior).

## Non-goals

- Migrating or reordering existing nodes to match a changed schema. Only missing sections are added.
- Deleting nodes that exist in the entry but not in the schema. Extra sections are kept and loaded at a default depth.
- Schema definitions inside the DB (option B from brainstorming). Config file is the single source.
- Changing O-entry structure. Session logging remains hardcoded.

## Config Format

In `hmem.config.json`, new top-level key `schemas`:

```json
{
  "checkpointInterval": 5,
  "checkpointMode": "remind",
  "schemas": {
    "P": {
      "sections": [
        { "name": "Overview",    "loadDepth": 3, "defaultChildren": ["Current state", "Goals", "Environment"] },
        { "name": "Codebase",    "loadDepth": 1 },
        { "name": "Usage",       "loadDepth": 2 },
        { "name": "Context",     "loadDepth": 2, "defaultChildren": ["Initiator", "Target audience"] },
        { "name": "Deployment",  "loadDepth": 1 },
        { "name": "Bugs",        "loadDepth": 2 },
        { "name": "Protocol",    "loadDepth": 0 },
        { "name": "Open tasks",  "loadDepth": 2 },
        { "name": "Next Steps",  "loadDepth": 3 },
        { "name": "Ideas",       "loadDepth": 1 },
        { "name": "Custom",      "loadDepth": 2 }
      ],
      "createLinkedO": true
    }
  }
}
```

### Section fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | L2 node title. Used for matching during reconcile (case-insensitive). |
| `loadDepth` | number (0-4) | yes | How deep to load in `load_project`. 0 = skip entirely, 1 = title only, 2 = +L3 titles, 3 = +L3 content, 4 = full subtree. |
| `defaultChildren` | string[] | no | L3 nodes created automatically under this section by `create_project`. Each string becomes an empty L3 node title. |

### Entry-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sections` | Section[] | (required) | Ordered list of L2 sections for this prefix. |
| `createLinkedO` | boolean | false | Automatically create a matching O-entry (O00XX <-> P00XX) on `create_project`. |

### Defaults

- Prefix without schema entry: no template, free structure. `load_project` uses a uniform default depth (current behavior: depth 3).
- Schema with empty `sections: []`: valid, creates an entry with no L2 nodes.
- `defaultChildren` omitted: section is created as an empty L2 node (title only, no children).

## Affected Code Paths

### 1. `hmem-config.ts` — Schema parsing

Add `schemas` field to the `HmemConfig` type. Parse and validate on config load. Schema is optional — missing key means no schemas defined (backward compatible).

Type:

```ts
interface SchemaSection {
  name: string;
  loadDepth: number;       // 0-4
  defaultChildren?: string[];
}

interface EntrySchema {
  sections: SchemaSection[];
  createLinkedO?: boolean;
}

// Added to HmemConfig:
schemas?: Record<string, EntrySchema>;  // keyed by prefix ("P", "E", etc.)
```

### 2. `create_project` MCP tool — Schema-driven creation

Current: hardcodes 9 sections in a string template.
New: reads `config.schemas.P`, iterates `sections`, creates L2 nodes. For each section with `defaultChildren`, creates L3 nodes under it.

If no schema exists for "P": fall back to current hardcoded behavior (backward compat for users who haven't configured schemas yet). This fallback can be removed in a future version once schemas are standard.

The `create_project` tool parameters remain unchanged — `name`, `tech`, `description`, etc. are injected into the Overview section's children as before.

### 3. `load_project` MCP tool — Per-section depth

Current: calls `read_memory(id, depth=3)` uniformly.
New:
1. Load the entry's L1 content and L2 children (always, depth=2 minimum).
2. For each L2 child, match by title against the schema's `sections` (case-insensitive).
3. If matched and `loadDepth > 1`: load that section's subtree to the configured depth.
4. If matched and `loadDepth === 0`: skip entirely (don't include in output).
5. If matched and `loadDepth === 1`: include title only (already loaded at step 1).
6. If unmatched (extra section not in schema): load at a default depth of 1 (title only).

This replaces the single `read_memory(id, depth=3)` call with a smarter multi-pass load.

### 4. Auto-reconcile in `load_project`

After loading, before returning output:
1. Read existing L2 node titles from the entry.
2. Compare against schema `sections` (case-insensitive title match).
3. For each schema section with no matching L2 node: create an empty L2 node via `hmemStore.addNode(entryId, sectionName)`.
4. New nodes are appended after the last existing L2 node (no reordering).
5. Add a reconcile notice to the output: `"Reconciled: added sections Next Steps, Custom"`.
6. If nothing was added: no notice.

Reconcile runs on every `load_project` call. It's idempotent — once a section exists, it won't be re-created. Cost: one additional L2-children query per call, negligible.

### 5. `/hmem-wipe` skill update

The `/hmem-wipe` skill must be updated to explicitly pflege the "Next Steps" section of the active project before `/clear`. This ensures session handoff context survives the context wipe. The skill should:
1. Read the current "Next Steps" section.
2. Ask the agent to update it with current priorities / next actions.
3. Proceed with the existing wipe flow.

## MAIMO Example

A MAIMO player's `hmem.config.json`:

```json
{
  "schemas": {
    "P": {
      "sections": [
        { "name": "Character",    "loadDepth": 3, "defaultChildren": ["Race", "Class", "Level"] },
        { "name": "Inventory",    "loadDepth": 2 },
        { "name": "Quests",       "loadDepth": 2 },
        { "name": "Relationships","loadDepth": 1 },
        { "name": "History",      "loadDepth": 0 }
      ]
    }
  }
}
```

Same `create_project` / `load_project` code, completely different behavior. History is tracked but never loaded (saves tokens). Character details are loaded deep. No O-entry needed (no session logging for game characters).

## What does NOT change

- **O-entry structure** — session logging format stays hardcoded (universal across all use cases).
- **`read_memory`, `write_memory`, `append_memory`, `update_memory`** — unchanged, schema-agnostic. Users can still freely add/modify nodes outside the schema.
- **R0009** — remains as documentation/reference. No longer the source of truth for code; `hmem.config.json` is.
- **Entries without a matching schema** — work exactly as today. `load_project` uses uniform default depth.

## Error handling

- **Invalid schema** (missing `name`, `loadDepth` out of range): log warning at config load, skip that section. Don't crash.
- **Duplicate section names** in schema: last one wins (or warn and skip). Sections are matched by title.
- **Reconcile write failure** (DB locked, disk full): log warning, continue with load. Reconcile is best-effort, not blocking.
- **`create_project` with no schema**: fall back to current hardcoded R0009 behavior.

## Testing

**Unit tests:**
- Schema parsing: valid config, missing schemas key, invalid section (no name, loadDepth=-1), empty sections array.
- Reconcile logic: entry missing 2 sections → both created. Entry has all sections → no-op. Entry has extra sections not in schema → kept, no error. Case-insensitive title matching.
- Load depth: section with loadDepth=0 excluded from output. Section with loadDepth=3 includes L3 content. Section with loadDepth=1 shows title only.

**Integration tests:**
- `create_project` with custom schema creates correct L2/L3 tree.
- `load_project` on an old entry triggers reconcile, adds missing sections, reports them.
- `load_project` with `loadDepth: 0` on Protocol section: Protocol not in output.
- Two `.hmem` instances with different schemas: each respects its own config.

## Migration

- No DB schema change.
- No forced migration of existing entries. Reconcile handles it organically on next `load_project` call.
- Users who don't add `schemas` to their config: everything works exactly as before (hardcoded fallback in `create_project`, uniform depth in `load_project`).
- R0009 entry stays in memory as documentation reference. Can be marked obsolete once all users have migrated to config-based schemas.
