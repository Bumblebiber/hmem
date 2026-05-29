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

/** Physical columns of a table, cached per-DB. Used to drop columns a remote (newer-schema)
 *  device emits that this device's schema lacks — forward-compatibility so an additive
 *  migration on one device never wedges pull on another. Keyed by db so multiple stores
 *  (e.g. several `:memory:` DBs in one process) don't share a stale column set. */
const colCache = new WeakMap<Database.Database, Map<string, Set<string>>>();
function knownColumns(db: Database.Database, table: V2Table): Set<string> {
  let perDb = colCache.get(db);
  if (!perDb) { perDb = new Map(); colCache.set(db, perDb); }
  let set = perDb.get(table);
  if (!set) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]; // table ∈ V2Table union — no injection
    set = new Set(rows.map((r) => r.name));
    perDb.set(table, set);
  }
  return set;
}

/** Upsert a full row verbatim. Mutable tables overwrite on PK conflict (winner already chosen);
 *  events union (bare ON CONFLICT DO NOTHING — ignores event_uid OR (session_id,seq) conflict).
 *  Bypasses the semantic write API on purpose — sync is row-level.
 *  Columns the local schema doesn't have are dropped (forward-compat — see knownColumns). */
function upsert(db: Database.Database, table: V2Table, row: Record<string, unknown>): void {
  const known = knownColumns(db, table);
  const cols = Object.keys(row).filter((c) => known.has(c));
  const params = Object.fromEntries(cols.map((c) => [c, row[c]]));
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const stmt =
    table === 'events'
      ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
      : `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
        `ON CONFLICT(${PK[table].join(', ')}) DO UPDATE SET ` +
        cols.filter((c) => !PK[table].includes(c)).map((c) => `${c}=excluded.${c}`).join(', ');
  db.prepare(stmt).run(params);
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
  // A different LIVE uid already holding an incoming entry's label → label collision.
  const clashStmt = store.db.prepare(
    'SELECT uid FROM entries WHERE label = ? AND deleted_at IS NULL AND uid != ?',
  );
  const prefixesToResolve = new Set<string>();

  /** Upsert an entries row, dodging the partial unique label index: if the label collides
   *  with a different live uid, write a placeholder label (the uid — unique, never a valid
   *  P-label) and mark the prefix for a deterministic resolveLabelCollisions pass afterwards. */
  function upsertEntry(row: Record<string, unknown>): void {
    const label = String(row.label);
    const collides =
      row.deleted_at == null && (clashStmt.get(label, row.uid) as { uid: string } | undefined) != null;
    if (collides) {
      upsert(store.db, 'entries', { ...row, label: String(row.uid) });
      prefixesToResolve.add(String(row.prefix));
    } else {
      upsert(store.db, 'entries', row);
    }
  }

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
            if (env.table === 'entries') upsertEntry(env.row);
            else upsert(store.db, env.table, env.row);
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
          if (env.table === 'entries') upsertEntry(env.row);
          else upsert(store.db, env.table, env.row);
          stats.inserted++;
          toAck.push(env);
        }
      }
    }
    // Resolve any label collisions a placeholder insert introduced (deterministic, in-tx).
    for (const prefix of prefixesToResolve) store.entries.resolveLabelCollisions(prefix);
  });
  apply(); // on throw: DB rolled back AND no acks applied (toAck discarded), staging untouched
  for (const env of toAck) markAcked(staging, env);
  return stats;
}
