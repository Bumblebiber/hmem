# Configuration Reference

Place `hmem.config.json` in your memory directory (the path you chose during `hmem init`). All keys are optional — defaults are applied for anything missing.

```json
{
  "memory": {
    "maxCharsPerLevel": [200, 2500, 10000, 25000, 50000],
    "maxDepth": 5,
    "defaultReadLimit": 100,
    "maxTitleChars": 50,
    "checkpointInterval": 20,
    "checkpointMode": "remind",
    "recentOEntries": 10,
    "contextTokenThreshold": 100000,
    "bulkReadV2": {
      "topAccessCount": 3,
      "topNewestCount": 5,
      "topObsoleteCount": 3,
      "topSubnodeCount": 3,
      "newestPercent": 20,
      "newestMin": 5,
      "newestMax": 15,
      "accessPercent": 10,
      "accessMin": 3,
      "accessMax": 8
    }
  }
}
```

## Core Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxCharsPerLevel` | `number[]` | `[200,2500,10000,25000,50000]` | Character limit per tree depth (L1..L5). Alternative: set `maxL1Chars` + `maxLnChars` and levels are interpolated linearly. |
| `maxDepth` | `number` | `5` | Max tree depth (1 = L1 only, 5 = full). |
| `defaultReadLimit` | `number` | `100` | Max entries returned by a default `read_memory()`. |
| `maxTitleChars` | `number` | `50` | Max characters for auto-extracted titles. |
| `checkpointInterval` | `number` | `20` | Messages between checkpoint reminders. Set 0 to disable. |
| `checkpointMode` | `"remind"` or `"auto"` | `"remind"` | `"remind"` = inject a save-reminder via `additionalContext`. `"auto"` = spawn a Haiku subagent that saves directly (no user interaction). |
| `recentOEntries` | `number` | `10` | Number of recent O-entries (session logs) injected at startup and on `load_project`. Set 0 to disable. |
| `contextTokenThreshold` | `number` | `100000` | Token threshold for context-clear recommendation. When cumulative hmem output exceeds this, the agent is told to flush + `/clear`. Set 0 to disable. |

## Bulk-Read Tuning (`bulkReadV2`)

Controls which entries get expanded (all L2 children shown) in a default `read_memory()` call. Per prefix category, the top N newest + top M most-accessed entries are expanded. Favorites are always expanded.

| Key | Default | Description |
|-----|---------|-------------|
| `topAccessCount` | `3` | Fixed fallback: top-accessed entries to expand. |
| `topNewestCount` | `5` | Fixed fallback: newest entries to expand. |
| `topObsoleteCount` | `3` | Obsolete entries to keep visible. |
| `topSubnodeCount` | `3` | Entries with most sub-nodes to always expand. |
| `newestPercent` | `20` | Percentage-based selection (overrides `topNewestCount`). |
| `newestMin` / `newestMax` | `5` / `15` | Clamp for percentage-based newest selection. |
| `accessPercent` | `10` | Percentage-based selection (overrides `topAccessCount`). |
| `accessMin` / `accessMax` | `3` / `8` | Clamp for percentage-based access selection. |
