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
| `recentDepthTiers` | … | [{count:10,depth:2},{count:3,depth:3}] | How much detail is auto-inlined for the most recent entries. See explanation below. |
| `accessCountTopN` | … | 5 | Top-N most-accessed entries always get L2 inlined in bulk reads ("organic favorites"). These are shown with a [★] marker. Set to 0 to disable. |
| `prefixes` | … | P,L,T,E,D,M,S,F | Category labels for memory entries. Custom prefixes are merged with defaults. |

### recentDepthTiers explained

This controls how much detail is automatically shown for recent entries in a default `read_memory()` call — without you having to drill in manually.

Example: `[{count: 10, depth: 2}, {count: 3, depth: 3}]`
- The **3 most recent** entries: shown with L1 + L2 + L3 detail
- The **next 7** (positions 3–9): shown with L1 + L2 detail
- Everything older: L1 summary only

Think of it like human memory — yesterday in full detail, last week in outline, older in headlines.

Set to `[]` to disable (L1 only for everything).

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

**For custom prefixes:** Ask for a single letter + label (e.g. `R = Research`). Remind the user that custom prefixes are added on top of the defaults — they don't replace them.

## Step 4 — Write the updated config

Write the updated `hmem.config.json`. Only include keys that differ from defaults — keep the file clean.

Then tell the user:
- Which values were changed
- That the change takes effect **immediately** — no restart needed
- That `maxL1Chars` and `maxLnChars` only affect new entries written after the change (existing entries are not reformatted)
