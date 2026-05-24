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
    addNode,
    getNode,
    updateNodeContent,
    softDelete,
  };
}
