/**
 * hmem v2 — entries & nodes CRUD with ULID identity.
 *
 * Identity model (master-plan Goal #1): the ULID `uid` is the immutable primary
 * key and the only thing references point at; the human `label` (`P0048`) is
 * mutable display sugar. `seq` is a monotonic per-prefix counter — soft-deleted
 * labels are NEVER recycled, so a reference to a deleted entry stays dead rather
 * than silently resolving to a different entry.
 *
 * In-prose refs are stored as `{{u:<ULID>}}` tokens. `renderRefs` turns those
 * back into the entry's *current* label at read time, so renaming a label
 * rewrites zero stored text.
 */
import type Database from 'better-sqlite3';
import { newUlid } from './ulid.js';
import type { EntryRow, NodeRow, Prefix } from './types.js';

const REF_TOKEN = /\{\{u:([0-9A-HJKMNP-TV-Z]{26})\}\}/g;

function now(): string {
  return new Date().toISOString();
}

function labelFor(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export interface EntriesApi {
  createEntry(p: { prefix: Prefix; level_1: string }): { uid: string; label: string };
  getEntry(uid: string): EntryRow | null;
  getEntryByLabel(label: string): EntryRow | null;
  labelToUid(label: string): string | null;
  uidToLabel(uid: string): string | null;
  renderRefs(text: string): string;
  relabel(uid: string, newLabel: string): boolean;
  /** Normalize the seq→label bijection for a prefix after a sync import may have
   *  introduced a transient seq collision. Deterministic over the live set (order
   *  by seq,uid: smallest keeps its seq, clashers bump to the next free seq), idempotent.
   *  Bumps both seq and label and touches updated_at so the fix propagates via LWW.
   *  Returns the number of rows changed. */
  resolveLabelCollisions(prefix: string): number;
  addNode(p: { root_uid: string; parent_uid?: string; content: string; tags?: string[] }): {
    uid: string;
  };
  getNode(uid: string): NodeRow | null;
  updateNodeContent(uid: string, content: string): boolean;
  softDelete(uid: string): boolean;
}

export function createEntriesApi(db: Database.Database): EntriesApi {
  // ── prepared statements ──
  const maxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM entries WHERE prefix = ?',
  );
  const insertEntry = db.prepare(
    `INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at)
     VALUES (@uid, @label, @prefix, @seq, @level_1, @ts, @ts)`,
  );
  const selByUid = db.prepare('SELECT * FROM entries WHERE uid = ? AND deleted_at IS NULL');
  const selByLabel = db.prepare('SELECT * FROM entries WHERE label = ? AND deleted_at IS NULL');
  const updLabel = db.prepare('UPDATE entries SET label = ?, updated_at = ? WHERE uid = ?');
  const softDelEntry = db.prepare('UPDATE entries SET deleted_at = ? WHERE uid = ?');
  const liveByPrefix = db.prepare(
    'SELECT uid, seq, label FROM entries WHERE prefix = ? AND deleted_at IS NULL ORDER BY seq ASC, uid ASC',
  );
  const updSeqLabel = db.prepare('UPDATE entries SET seq = ?, label = ?, updated_at = ? WHERE uid = ?');

  const maxNodeSeq = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM nodes
     WHERE root_uid = ? AND (parent_uid IS ?)`,
  );
  const insertNode = db.prepare(
    `INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags, created_at, updated_at)
     VALUES (@uid, @root_uid, @parent_uid, @depth, @seq, @content, @tags, @ts, @ts)`,
  );
  const selNode = db.prepare('SELECT * FROM nodes WHERE uid = ? AND deleted_at IS NULL');
  const updNodeContent = db.prepare('UPDATE nodes SET content = ?, updated_at = ? WHERE uid = ?');
  const softDelNode = db.prepare('UPDATE nodes SET deleted_at = ? WHERE uid = ?');

  function createEntry(p: { prefix: Prefix; level_1: string }): { uid: string; label: string } {
    // seq is monotonic over ALL rows of the prefix (incl. soft-deleted) so labels
    // never resurrect; the partial unique index only constrains live rows.
    const seq = (maxSeq.get(p.prefix) as { m: number }).m + 1;
    const uid = newUlid();
    const label = labelFor(p.prefix, seq);
    insertEntry.run({ uid, label, prefix: p.prefix, seq, level_1: p.level_1, ts: now() });
    return { uid, label };
  }

  function getEntry(uid: string): EntryRow | null {
    return (selByUid.get(uid) as EntryRow | undefined) ?? null;
  }
  function getEntryByLabel(label: string): EntryRow | null {
    return (selByLabel.get(label) as EntryRow | undefined) ?? null;
  }
  function labelToUid(label: string): string | null {
    return getEntryByLabel(label)?.uid ?? null;
  }
  function uidToLabel(uid: string): string | null {
    return getEntry(uid)?.label ?? null;
  }
  function renderRefs(text: string): string {
    return text.replace(REF_TOKEN, (_m, uid: string) => uidToLabel(uid) ?? '‹dead-ref›');
  }
  function relabel(uid: string, newLabel: string): boolean {
    return updLabel.run(newLabel, now(), uid).changes > 0;
  }

  function resolveLabelCollisions(prefix: string): number {
    // Pass 1: walk live rows in (seq, uid) order. The first row at each seq KEEPS it
    // (smallest uid wins a same-seq tie); any later row at an already-claimed seq is a LOSER.
    const rows = liveByPrefix.all(prefix) as { uid: string; seq: number; label: string }[];
    const claimed = new Set<number>();
    const keepers: typeof rows = [];
    const losers: typeof rows = [];
    for (const row of rows) {
      if (claimed.has(row.seq)) losers.push(row);
      else { claimed.add(row.seq); keepers.push(row); }
    }
    // Pass 2: assign each loser the lowest globally-free seq (monotonic probe → ascending, distinct).
    const loserSeq: number[] = [];
    let probe = 1;
    for (let i = 0; i < losers.length; i++) {
      while (claimed.has(probe)) probe++;
      claimed.add(probe);
      loserSeq.push(probe);
      probe++;
    }
    // Apply LOSERS FIRST so they vacate their old labels before any keeper claims one
    // (covers the case where the seq-keeper is an incoming row still on its placeholder label).
    const ts = now();
    let changed = 0;
    const apply = (uid: string, seq: number, oldSeq: number, oldLabel: string): void => {
      const desired = labelFor(prefix, seq);
      if (oldSeq !== seq || oldLabel !== desired) { updSeqLabel.run(seq, desired, ts, uid); changed++; }
    };
    for (let i = 0; i < losers.length; i++) apply(losers[i].uid, loserSeq[i], losers[i].seq, losers[i].label);
    for (const k of keepers) apply(k.uid, k.seq, k.seq, k.label);
    return changed;
  }

  function addNode(p: {
    root_uid: string;
    parent_uid?: string;
    content: string;
    tags?: string[];
  }): { uid: string } {
    const parent_uid = p.parent_uid ?? null;
    const depth = parent_uid ? (getNode(parent_uid)?.depth ?? 1) + 1 : 2;
    // maxNodeSeq uses `parent_uid IS ?` so NULL compares correctly.
    const seq = (maxNodeSeq.get(p.root_uid, parent_uid) as { m: number }).m + 1;
    const uid = newUlid();
    insertNode.run({
      uid,
      root_uid: p.root_uid,
      parent_uid,
      depth,
      seq,
      content: p.content,
      tags: p.tags ? JSON.stringify(p.tags) : null,
      ts: now(),
    });
    return { uid };
  }

  function getNode(uid: string): NodeRow | null {
    return (selNode.get(uid) as NodeRow | undefined) ?? null;
  }
  function updateNodeContent(uid: string, content: string): boolean {
    return updNodeContent.run(content, now(), uid).changes > 0;
  }

  function softDelete(uid: string): boolean {
    const ts = now();
    const entryChanged = softDelEntry.run(ts, uid).changes > 0;
    if (entryChanged) {
      // cascade soft-delete to the entry's nodes
      db.prepare('UPDATE nodes SET deleted_at = ? WHERE root_uid = ? AND deleted_at IS NULL').run(
        ts,
        uid,
      );
      return true;
    }
    return softDelNode.run(ts, uid).changes > 0;
  }

  return {
    createEntry,
    getEntry,
    getEntryByLabel,
    labelToUid,
    uidToLabel,
    renderRefs,
    relabel,
    resolveLabelCollisions,
    addNode,
    getNode,
    updateNodeContent,
    softDelete,
  };
}
