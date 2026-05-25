import type Database from 'better-sqlite3';
import type { V2Store } from '../../v2/store-facade.js';
import type { BlobEnvelope, V2Table } from './envelope.js';
import { stagingKey, rowToEnvelope } from './envelope.js';
import { pickWinner } from './reconcile.js';
import { markAcked, type V2Staging } from './staging.js';

export interface ImportStats { inserted: number; updated: number; unioned: number; skipped: number }

const PK: Record<V2Table, string[]> = {
  entries: ['uid'],
  nodes: ['uid'],
  sessions: ['session_id'],
  events: ['event_uid'],
  links: ['src_uid', 'dst_uid'],
  session_bindings: ['session_id', 'from_seq'],
};

/** Upsert a full row verbatim. Mutable tables overwrite on PK conflict (winner already chosen);
 *  events union (bare ON CONFLICT DO NOTHING — ignores event_uid OR (session_id,seq) conflict).
 *  Bypasses the semantic write API on purpose — sync is row-level. */
function upsert(db: Database.Database, table: V2Table, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const stmt =
    table === 'events'
      ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
      : `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
        `ON CONFLICT(${PK[table].join(', ')}) DO UPDATE SET ` +
        cols.filter((c) => !PK[table].includes(c)).map((c) => `${c}=excluded.${c}`).join(', ');
  db.prepare(stmt).run(row);
}

/** Fetch the local row for a mutable table entry by its PK columns (may include soft-deleted). */
function fetchLocal(db: Database.Database, table: V2Table, row: Record<string, unknown>): Record<string, unknown> | null {
  const pks = PK[table];
  const where = pks.map((k) => `${k}=@${k}`).join(' AND ');
  const params = Object.fromEntries(pks.map((k) => [k, row[k]]));
  return (db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(params) as Record<string, unknown> | undefined) ?? null;
}

export function importV2(store: V2Store, staging: V2Staging, pulled: BlobEnvelope[]): ImportStats {
  const stats: ImportStats = { inserted: 0, updated: 0, unioned: 0, skipped: 0 };

  // Group by logical key, reduce each group to its winner (among pulled envelopes).
  const winners = new Map<string, BlobEnvelope>();
  for (const env of pulled) {
    const k = stagingKey(env.table, env.key);
    const prev = winners.get(k);
    winners.set(k, prev ? pickWinner(prev, env) : env);
  }

  const toAck: BlobEnvelope[] = [];
  const apply = store.db.transaction(() => {
    for (const [, env] of winners) {
      if (env.table === 'events') {
        // Events are write-once: union semantics, no local comparison needed.
        upsert(store.db, env.table, env.row);
        stats.unioned++;
        toAck.push(env);
      } else {
        // Mutable tables: compare against local row to honour LWW.
        const localRow = fetchLocal(store.db, env.table, env.row);
        if (localRow !== null) {
          const localEnv = rowToEnvelope(env.table, localRow);
          const winner = pickWinner(localEnv, env);
          if (winner === env) {
            upsert(store.db, env.table, env.row);
            stats.updated++;
            toAck.push(env);
          } else {
            // Local copy is newer: skip the write. Do NOT ack — this device will push its
            // newer local row on the next push and ack it then (the losing remote version
            // never enters the store, so there is nothing to echo).
            stats.skipped++;
          }
        } else {
          // Row does not exist locally — insert.
          upsert(store.db, env.table, env.row);
          stats.inserted++;
          toAck.push(env);
        }
      }
    }
  });
  apply(); // on throw: DB rolled back AND no acks applied (toAck discarded), staging untouched
  for (const env of toAck) markAcked(staging, env);
  return stats;
}
