import type { V2Store } from '../../v2/store-facade.js';
import type { BlobEnvelope, V2Table } from './envelope.js';
import { rowToEnvelope, stagingKey } from './envelope.js';
import { shouldPush, type V2Staging } from './staging.js';

// All six synced tables. Order is irrelevant (reconciliation is commutative).
export const SYNC_TABLES: V2Table[] = ['entries', 'nodes', 'links', 'sessions', 'session_bindings', 'events'];

/** Read every row of every synced table; return the envelopes the server doesn't yet have.
 *  `inFlight` = staging keys already sitting in the retry queue — skip them so a failed
 *  push's rows are not re-enqueued under a new idempotency key (the retry-hole fix). */
export function exportV2(store: V2Store, staging: V2Staging, inFlight: Set<string> = new Set()): BlobEnvelope[] {
  const out: BlobEnvelope[] = [];
  for (const table of SYNC_TABLES) {
    const rows = store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const env = rowToEnvelope(table, row);
      if (inFlight.has(stagingKey(table, env.key))) continue;
      if (shouldPush(staging, env)) out.push(env);
    }
  }
  return out;
}

/** Every logical key currently present in the store (incl. soft-deleted rows, which are still rows). */
export function collectLiveKeys(store: V2Store): Set<string> {
  const keys = new Set<string>();
  for (const table of SYNC_TABLES) {
    for (const row of store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
      keys.add(stagingKey(table, rowToEnvelope(table, row).key));
    }
  }
  return keys;
}
