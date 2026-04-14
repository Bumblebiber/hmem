# Entry Schemas (v6.3.0+)

Define per-prefix section schemas that control `create_project` structure and `load_project` rendering depth. When a schema is defined, it replaces the hardcoded R0009 sections and the `loadProjectExpand` settings.

```json
{
  "memory": {
    "schemas": {
      "P": {
        "sections": [
          { "name": "Overview",    "loadDepth": 3, "defaultChildren": ["Current state", "Goals", "Environment"] },
          { "name": "Codebase",    "loadDepth": 1 },
          { "name": "Protocol",    "loadDepth": 0 },
          { "name": "Next Steps",  "loadDepth": 3 }
        ],
        "createLinkedO": true
      }
    }
  }
}
```

## Schema fields

| Field | Type | Description |
|-------|------|-------------|
| `sections[].name` | string | L2 section title. Used for matching during auto-reconcile (case-insensitive). |
| `sections[].loadDepth` | 0-4 | 0=skip, 1=title only, 2=+L3 titles, 3=+L3 body, 4=full subtree |
| `sections[].defaultChildren` | string[] | L3 nodes created by `create_project`. Optional. |
| `createLinkedO` | boolean | Auto-create matching O-entry on `create_project`. Default: false. |

## Behavior

**Auto-reconcile:** On every `load_project`, missing schema sections are automatically added as empty L2 nodes. Extra sections not in the schema are kept (loaded at depth 1).

**No schema defined:** Falls back to hardcoded R0009 behavior and `loadProjectExpand` settings.

## Legacy: load_project display (pre-v6.3.0)

Only used when no `schemas` entry exists for the prefix. Controls which P-entry sections are expanded:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `loadProjectExpand.withBody` | `[1]` | L2 section seq numbers where L3 children show title + body content. Default: `.1 Overview` — shows full architecture/state/goals detail. |
| `loadProjectExpand.withChildren` | `[6, 8]` | L2 section seq numbers where all L3 children are listed as titles. Default: `.6 Bugs`, `.8 Open Tasks` — all items visible at a glance. |

Sections not in either list show L3 titles only in compact mode.
