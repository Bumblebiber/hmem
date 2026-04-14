# Bulk-Read Tuning

The bulk-read algorithm decides which entries get expanded (full L2 detail) vs. compressed (title only). The defaults work well up to ~500 entries. Most users do not need to change these.

## Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `bulkReadV2.topNewestCount` | 5 | Newest entries expanded. Increase for more recent context at startup. |
| `bulkReadV2.topAccessCount` | 3 | Most-accessed entries expanded (time-weighted: `access_count / log2(age_days + 2)`). |
| `bulkReadV2.topObsoleteCount` | 3 | Obsolete entries kept visible — "biggest mistakes" are still worth seeing. |
| `bulkReadV2.topSubnodeCount` | 3 | Entries with most children expanded. These tend to be the most detailed/important. |

## Tuning recipes

**"Startup is too slow / uses too many tokens":**
Reduce `topNewestCount` (e.g., 3) and `topAccessCount` (e.g., 2) to limit expanded entries at startup.

**"I have 500+ entries and bulk reads are noisy":**
Increase `topAccessCount` and decrease `topNewestCount` — favor proven entries over new ones.
