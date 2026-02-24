---
name: hmem-config
description: >
  View and change hmem settings. Use when the user types /hmem-config or asks
  to change memory settings, adjust parameters, or configure hmem.
---

# hmem-config — View and Change Settings

## Step 1 — Find the config file

The config file is `hmem.config.json` in the `HMEM_PROJECT_DIR` directory.

Find it:
```bash
# Check the MCP environment variable first
echo $HMEM_PROJECT_DIR

# Common locations:
# Global:  ~/.hmem/hmem.config.json
# Project: ./hmem.config.json
```

If the file does not exist, offer to create it with defaults (see Step 3).

## Step 2 — Read and display current settings

Read the file and show the user a clear table of current values vs. defaults:

| Parameter | Current value | Default | What it does |
|-----------|--------------|---------|--------------|
| `maxL1Chars` | … | 120 | Max characters for Level 1 summaries (the one-liner shown at session start). Keep short — this is what the agent always sees. |
| `maxLnChars` | … | 50000 | Max characters for deeper levels (L2–L5). Controls how much detail you can store per node. |
| `maxDepth` | … | 5 | How many nesting levels are available (1–5). 5 is the maximum. |
| `defaultReadLimit` | … | 100 | Max entries returned by a single `read_memory()` call. |
| `accessCountTopN` | … | 5 | Top-N most-accessed entries always get L2 inlined in bulk reads ("organic favorites"). These are shown with a [★] marker. Set to 0 to disable. |
| `prefixes` | … | P,L,T,E,D,M,S,N,H,R | (P)roject, (L)esson, (T)ask, (E)rror, (D)ecision, (M)ilestone, (S)kill, (N)avigator, (H)uman. Custom prefixes merged with defaults. |
| `prefixDescriptions` | … | (see below) | Human-readable descriptions for each prefix category, used as group headers in bulk reads. |
| `bulkReadV2.topAccessCount` | … | 3 | Number of top-accessed entries to expand in V2 bulk reads. |
| `bulkReadV2.topNewestCount` | … | 5 | Number of newest entries to expand in V2 bulk reads. |
| `bulkReadV2.topObsoleteCount` | … | 3 | Number of obsolete entries to keep visible ("biggest mistakes"). |

### Bulk-Read Algorithm

The bulk-read algorithm groups entries by prefix category and uses smart expansion:

- **Expanded entries**: newest (top N), most-accessed (top N), and all favorites → show ALL L2 children + links
- **[♥] Favorites**: always expanded, marked with [♥]
- **[★] Top-accessed**: most-accessed entries per prefix, marked with [★]
- **Obsolete entries**: top N by access count shown with `[!]`, rest hidden
- **Per-prefix guarantee**: each category's youngest + most-accessed entry is always expanded

Tune via `bulkReadV2`:
```json
{
  "bulkReadV2": {
    "topAccessCount": 3,
    "topNewestCount": 5,
    "topObsoleteCount": 3
  }
}
```

### prefixDescriptions

Default descriptions used as group headers in bulk reads:

```json
{
  "prefixDescriptions": {
    "P": "(P)roject experiences and summaries",
    "L": "(L)essons learned and best practices",
    "T": "(T)asks and work items",
    "E": "(E)rrors encountered and their fixes",
    "D": "(D)ecisions and their rationale",
    "M": "(M)ilestones and achievements",
    "S": "(S)kills and technical knowledge",
    "N": "(N)avigation and context notes",
    "H": "(H)uman — knowledge about the user",
    "R": "(R)ules — user-defined rules and constraints"
  }
}
```

Custom prefixes automatically get their name as the description. Override with explicit descriptions in config.

## Step 3 — Ask the user what to change

Ask the user which parameter(s) they want to adjust. For each one:

1. Explain the tradeoff (e.g. higher `maxL1Chars` = more context at startup but wastes tokens)
2. Show the current value and the recommended range
3. Ask for the new value
4. Validate the input (numbers must be positive integers, tiers must be valid JSON)

**Recommended ranges:**

| Parameter | Min | Max | Notes |
|-----------|-----|-----|-------|
| `maxL1Chars` | 60 | 200 | Below 60: too terse. Above 200: wastes token budget at every spawn. |
| `maxLnChars` | 1000 | 100000 | Higher = more detail possible, but rarely read. |
| `maxDepth` | 2 | 5 | 3 is enough for most users. 5 for complex multi-agent setups. |
| `defaultReadLimit` | 20 | 500 | Lower if startup feels slow. Higher if you have many entries. |
| `accessCountTopN` | 0 | 20 | 0 = disabled. 5 is a good default. Raise if you have many frequently-accessed entries you want always visible. |
| `bulkReadV2.topAccessCount` | 0 | 20 | How many most-accessed entries get full expansion. |
| `bulkReadV2.topNewestCount` | 0 | 20 | How many newest entries get full expansion. |
| `bulkReadV2.topObsoleteCount` | 0 | 20 | How many obsolete entries stay visible in bulk reads. |

**For custom prefixes:** Ask for a single letter + label (e.g. `R = Research`). Remind the user that custom prefixes are added on top of the defaults — they don't replace them.

## Step 4 — Write the updated config

Write the updated `hmem.config.json`. Only include keys that differ from defaults — keep the file clean.

Then tell the user:
- Which values were changed
- That the change takes effect **immediately** — no restart needed
- That `maxL1Chars` and `maxLnChars` only affect new entries written after the change (existing entries are not reformatted)
