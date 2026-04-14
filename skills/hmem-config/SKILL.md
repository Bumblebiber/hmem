---
name: hmem-config
description: "View and change hmem memory settings, hooks, sync, and checkpoint configuration. Use this skill whenever the user types /hmem-config, asks to change memory settings, adjust parameters, tune bulk-read behavior, configure auto-checkpoints, manage hmem-sync, or troubleshoot memory-related issues. Also trigger when the user asks things like 'how often does auto-save fire', 'why is my context so large', 'change checkpoint to auto', 'how many tokens does startup cost', or 'set up sync'."
---

# hmem-config — View and Change Settings

This skill guides the agent through reading, explaining, and updating hmem's configuration. The config controls how memory is stored, displayed, checkpointed, and synced across devices.

## Locate and read the config

Config path: `~/.hmem/hmem.config.json` (same directory as the .hmem file).

Read the file directly — do not ask the user where it is. If it does not exist, offer to create one with only non-default values.

The config uses a `"memory"` block and an optional `"sync"` block:

```json
{
  "memory": { ... },
  "sync": { ... }
}
```

## Show current settings

Present a table of current values vs. defaults. Only highlight values that differ from defaults.

### Core parameters

| Parameter | Default | Range |
|-----------|---------|-------|
| `maxCharsPerLevel` | [200, 2500, 10000, 25000, 50000] | L1: 60–300, L5: 1000–100000 |
| `maxDepth` | 5 | 2–5 |
| `defaultReadLimit` | 100 | Positive integer |
| `maxTitleChars` | 50 | Positive integer |
| `accessCountTopN` | 5 | Positive integer |

- `maxCharsPerLevel`: Character limits per tree level [L1–L5]. L1 loads at every startup — keep it short to save tokens. L5 is raw data, rarely accessed.
- `accessCountTopN`: Entries with highest access count get [★] and auto-expand in bulk reads.

### Checkpoint and session parameters (v5+)

| Parameter | Default | Range |
|-----------|---------|-------|
| `checkpointMode` | `"remind"` | `"auto"` or `"remind"` |
| `checkpointInterval` | 20 | 0–100 |
| `recentOEntries` | 10 | 0–20 |
| `contextTokenThreshold` | 100000 | 0–500000 |

- `checkpointMode`: `"auto"` spawns a Haiku subagent in the background every N exchanges to extract lessons/errors/decisions via MCP tools without interrupting the main agent. `"remind"` injects a prompt asking the main agent to save manually.
- `checkpointInterval`: Counted in the active O-entry, not per session. Set to 0 to disable.
- `recentOEntries`: Recent session logs shown at project load. Higher = more context but more tokens.
- `contextTokenThreshold`: When cumulative hmem output exceeds this, the agent flushes context and /clear. Set to 0 to disable.

### Entry schemas (v6.3.0+)

See [references/SCHEMAS.md](references/SCHEMAS.md) for schema definitions, field reference, auto-reconcile behavior, and legacy `loadProjectExpand` settings.

### Bulk-read tuning

See [references/BULK-READ.md](references/BULK-READ.md) for the bulk-read algorithm parameters and tuning recipes.

### Prefixes

Default: P, L, T, E, D, M, S, N, H, R, O, I. Custom prefixes merge with defaults (do not replace). Each prefix can have a custom description used as group header in bulk reads.

## Help the user make changes

For each parameter the user wants to change:

1. **Explain the tradeoff** — what gets better, what gets worse
2. **Show the recommended range** from the tables above
3. **Validate** before writing — numbers must be positive, arrays must be valid JSON

### Recommended guidance

| Parameter | Guidance |
|-----------|----------|
| `maxCharsPerLevel[0]` (L1) | Below 60 too terse; above 300 wastes tokens on every bulk read |
| `checkpointMode` | Recommend `"auto"` — non-disruptive, Haiku has MCP access for dedup, writes rolling `[CP]` summaries |
| `checkpointInterval` | 20 is a good balance. Lower = more frequent saves (more Haiku cost) |
| `recentOEntries` | 10 is the sweet spot. With checkpoint summaries, `load_project` shows summary + recent exchanges only |
| `contextTokenThreshold` | 100k for most models. Increase for 1M-context models |

### Common recipes

**"I want auto-checkpoints":**
```json
{ "memory": { "checkpointMode": "auto", "checkpointInterval": 20 } }
```

**"Startup is too slow / uses too many tokens":**
Reduce `recentOEntries` (e.g., 5), `bulkReadV2.topNewestCount` (e.g., 3), or `maxCharsPerLevel[0]` (e.g., 150).

**"I have 500+ entries and bulk reads are noisy":**
Increase `bulkReadV2.topAccessCount` and decrease `topNewestCount` — favor proven entries over new ones.

## Write the updated config

Write `hmem.config.json` with only non-default values. Use the `"memory"` wrapper:

```json
{
  "memory": {
    "checkpointMode": "auto"
  }
}
```

After writing, tell the user:
- Which values changed
- Changes take effect **immediately** — no restart needed
- `maxCharsPerLevel` only affects new entries (existing entries are not reformatted)

## Check hmem-sync status

Run this check as part of every /hmem-config invocation.

**If installed** (`which hmem-sync`): run `npx hmem-sync status` and show server URL, user ID, last push/pull timestamps, and whether `HMEM_SYNC_PASSPHRASE` is set in `.mcp.json`.

**If not installed**: explain that hmem-sync enables zero-knowledge encrypted cross-device sync (AES-256-GCM) and offer to install:
```bash
npm install -g hmem-sync
npx hmem-sync connect
```

For sync issues, see [references/SYNC-TROUBLESHOOTING.md](references/SYNC-TROUBLESHOOTING.md).

## Hook configuration on Windows

Windows hook execution requires special configuration to avoid Git Bash routing crashes and inline env-var syntax failures. See [references/WINDOWS-HOOKS.md](references/WINDOWS-HOOKS.md) for the required setup, full example config, and troubleshooting matrix.
