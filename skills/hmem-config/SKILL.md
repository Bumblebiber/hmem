---
name: hmem-config
description: >
  View and change hmem memory settings, hooks, sync, and checkpoint configuration.
  Use this skill whenever the user types /hmem-config, asks to change memory settings,
  adjust parameters, tune bulk-read behavior, configure auto-checkpoints, manage
  hmem-sync, or troubleshoot memory-related issues. Also trigger when the user asks
  things like "how often does auto-save fire", "why is my context so large",
  "change checkpoint to auto", "how many tokens does startup cost", or "set up sync".
---

# hmem-config — View and Change Settings

This skill guides you through reading, explaining, and updating hmem's configuration. The config controls how memory is stored, displayed, checkpointed, and synced across devices.

## Locate and read the config

The config lives at `hmem.config.json` inside the hmem project directory. With an agent ID, it's typically at `~/.hmem/Agents/<NAME>/hmem.config.json`. Without one, `~/.hmem/hmem.config.json`.

Read the file directly — don't ask the user where it is. If it doesn't exist, offer to create one (only non-default values need to be specified).

The config uses a unified format with a `"memory"` block and an optional `"sync"` block:

```json
{
  "memory": { ... },
  "sync": { ... }
}
```

## Show current settings

Present a table of current values vs. defaults. Only highlight values that differ from defaults — the user cares about what they've customized, not the full list.

### Core parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `maxCharsPerLevel` | [200, 2500, 10000, 25000, 50000] | Character limits per tree level [L1–L5]. L1 is always loaded at startup, so keeping it short saves tokens across every session. L5 is raw data, rarely accessed. |
| `maxDepth` | 5 | Tree depth (1–5). Most users need 5. Lower values save storage but lose granularity. |
| `defaultReadLimit` | 100 | Max entries per bulk read. Lower = faster startup, higher = more complete overview. |
| `maxTitleChars` | 50 | Auto-extracted title length. Titles are navigation labels — too short truncates meaning, too long wastes space. |
| `accessCountTopN` | 5 | Entries with highest access count get [★] and auto-expand in bulk reads. These are "organic favorites" — the things the agent keeps coming back to. |

### Checkpoint and session parameters (v5+)

These control the automatic knowledge extraction pipeline:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `checkpointMode` | `"remind"` | **`"auto"`** spawns a Haiku subagent in the background every N exchanges — it reads the conversation, extracts lessons/errors/decisions, and writes them via MCP tools. The main agent is never interrupted. **`"remind"`** injects a prompt asking the main agent to save manually — simpler but interrupts flow. |
| `checkpointInterval` | 20 | Exchanges between checkpoints. Counted in the active O-entry, not per session — so 10 messages on your laptop + 10 on your server = checkpoint fires at 20. Set to 0 to disable. |
| `recentOEntries` | 10 | How many recent session logs to show when loading a project. All entries include full user/agent exchanges (L4/L5), not just titles. Higher = more context but more tokens at project load. |
| `contextTokenThreshold` | 100000 | When cumulative hmem output exceeds this, the agent is told to flush context and /clear. Prevents runaway token usage in long sessions. Set to 0 to disable. |

### Bulk-read tuning

The bulk-read algorithm decides which entries get expanded (full L2 detail) vs. compressed (title only). Most users don't need to touch these — the defaults work well up to ~500 entries.

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `bulkReadV2.topNewestCount` | 5 | Newest entries expanded. Increase if you want more recent context at startup. |
| `bulkReadV2.topAccessCount` | 3 | Most-accessed entries expanded (time-weighted: `access_count / log2(age_days + 2)`). |
| `bulkReadV2.topObsoleteCount` | 3 | Obsolete entries kept visible — "biggest mistakes" are still worth seeing. |
| `bulkReadV2.topSubnodeCount` | 3 | Entries with most children expanded. These tend to be the most detailed/important. |

### Prefixes

Default: P, L, T, E, D, M, S, N, H, R, O, I. Custom prefixes are merged with defaults — they don't replace them. Each prefix can have a custom description used as group header in bulk reads.

## Help the user make changes

For each parameter the user wants to change:

1. **Explain the tradeoff** in plain language — what gets better, what gets worse
2. **Show the recommended range** (see below)
3. **Validate** before writing — numbers must be positive, arrays must be valid JSON

### Recommended ranges

| Parameter | Range | Guidance |
|-----------|-------|----------|
| `maxCharsPerLevel[0]` (L1) | 60–300 | Below 60 is too terse for useful summaries. Above 300 wastes tokens on every bulk read — L1 is loaded at every session start. |
| `maxCharsPerLevel[4]` (L5) | 1000–100000 | Raw data storage. Higher allows more verbatim content but L5 is rarely loaded. |
| `maxDepth` | 2–5 | 3 suffices for simple setups. 5 for multi-agent or complex projects. |
| `checkpointMode` | `"auto"` or `"remind"` | Recommend `"auto"` — it's non-disruptive and produces better results because Haiku has MCP access to check for duplicates. |
| `checkpointInterval` | 0–100 | 20 is a good balance. Lower = more frequent saves (more Haiku cost). 0 = disabled. |
| `recentOEntries` | 0–20 | 10 is the sweet spot. Each entry with exchanges costs ~200-500 tokens in `load_project`. |
| `contextTokenThreshold` | 0–500000 | 100k is recommended for most models. Increase for 1M-context models. |

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

Write `hmem.config.json` with only non-default values. The config uses a `"memory"` wrapper:

```json
{
  "memory": {
    "checkpointMode": "auto"
  },
  "sync": { ... }
}
```

After writing, tell the user:
- Which values changed
- Changes take effect **immediately** — no restart needed
- `maxCharsPerLevel` only affects new entries (existing entries are not reformatted)

## Check hmem-sync status

Run this check as part of every /hmem-config invocation.

**If installed** (`which hmem-sync`): run `npx hmem-sync status` and show server URL, user ID, last push/pull timestamps, and whether `HMEM_SYNC_PASSPHRASE` is set in `.mcp.json` (needed for auto-sync).

**If not installed**: explain that hmem-sync enables zero-knowledge encrypted cross-device sync (AES-256-GCM, server sees only opaque blobs), and offer to install it:
```bash
npm install -g hmem-sync
npx hmem-sync connect
```

### Sync troubleshooting

| Problem | Fix |
|---------|-----|
| "Config not found" | Run `npx hmem-sync connect` |
| 401 Token verification failed | Passphrase has special chars — set `HMEM_SYNC_PASSPHRASE` in .mcp.json env |
| 0 entries after pull | `HMEM_AGENT_ID` must match between devices |
| Update | `npm update -g hmem-sync` (always global, never inside a project) |
