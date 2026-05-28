/** Normalize a timestamp to ISO 8601 UTC (Z-form). Single source of truth for the
 *  push wire boundary (sync/v2/sync.ts), the v1→v2 migrator (migrate/tree.ts), and the
 *  v1 sync bridge (sync-bridge.ts).
 *  - empty / null / undefined → now()
 *  - already ISO (ends with 'Z' or carries a '+' offset) → unchanged
 *  - SQLite space-format 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SSZ'
 */
export function toIso(ts: string | undefined | null): string {
  if (!ts) return new Date().toISOString();
  if (ts.endsWith('Z') || ts.includes('+')) return ts;
  return ts.replace(' ', 'T') + 'Z';
}
