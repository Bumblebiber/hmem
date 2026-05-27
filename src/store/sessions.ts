/**
 * hmem v2 — sessions table + binding-segment algebra.
 *
 * A session is a first-class row, NOT a tree node (master-plan Goal #2: no global
 * mutable "active project" state — the current project is per-session, the open
 * binding segment). This module owns `bind`/`currentProject`/`projectAt` and reads
 * the `events` table directly via raw SQL for `maxEventSeq` — it deliberately does
 * NOT import `events.ts` (D5: avoids a circular dependency with `summarize/`).
 *
 * `bind` is a total segment-algebra operation (D3): it closes the open segment at
 * `from-1` (flushing it via `onSegmentClose`), overwrites any segments at/after the
 * new boundary, splits a straddling segment, and opens `[from, NULL]`. Attribution
 * is purely derived from these `[from_seq, to_seq]` ranges — no event row is ever
 * moved (D2, scenario 6).
 */
import type Database from 'better-sqlite3';
import { newUlid } from './ulid.js';
import type { BindingRow, ClosedSegment, SessionRow } from './types.js';

function now(): string {
  return new Date().toISOString();
}

export interface SessionsApiOpts {
  /** Invoked when `bind` closes a non-empty segment that has un-flushed events. */
  onSegmentClose?: (c: ClosedSegment) => void;
}

export interface SessionsApi {
  createSession(p: {
    session_id?: string;
    device_id?: string;
    harness?: string;
  }): { session_id: string };
  getSession(session_id: string): SessionRow | null;
  touchSession(session_id: string): void;
  updateSessionSummary(session_id: string, summary: string, summary_node_uid: string | null): void;
  bind(session_id: string, project_uid: string, since?: number): void;
  currentProject(session_id: string): string | null;
  projectAt(session_id: string, seq: number): string | null;
  segmentsForSession(session_id: string): BindingRow[];
}

export function createSessionsApi(
  db: Database.Database,
  opts: SessionsApiOpts = {},
): SessionsApi {
  const onSegmentClose = opts.onSegmentClose ?? (() => {});

  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, device_id, harness, started_at, updated_at)
     VALUES (@session_id, @device_id, @harness, @ts, @ts)`,
  );
  const selSession = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  const touch = db.prepare(
    'UPDATE sessions SET last_active_at = ?, updated_at = ? WHERE session_id = ?',
  );
  const updSummary = db.prepare(
    'UPDATE sessions SET summary = ?, summary_node_uid = ?, updated_at = ? WHERE session_id = ?',
  );

  // ── bindings ──
  const selMaxEventSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?',
  );
  const selOpenSegment = db.prepare(
    'SELECT * FROM session_bindings WHERE session_id = ? AND to_seq IS NULL',
  );
  const selSegmentAt = db.prepare(
    `SELECT * FROM session_bindings
      WHERE session_id = ? AND from_seq <= ? AND (to_seq IS NULL OR to_seq >= ?)
      LIMIT 1`,
  );
  const selSegments = db.prepare(
    'SELECT * FROM session_bindings WHERE session_id = ? ORDER BY from_seq',
  );
  const hasEventInRange = db.prepare(
    'SELECT 1 FROM events WHERE session_id = ? AND seq >= ? AND seq <= ? LIMIT 1',
  );
  const delForward = db.prepare(
    'DELETE FROM session_bindings WHERE session_id = ? AND from_seq >= ?',
  );
  const closeStraddler = db.prepare(
    `UPDATE session_bindings SET to_seq = ?
      WHERE session_id = ? AND from_seq < ? AND (to_seq IS NULL OR to_seq >= ?)`,
  );
  const insertBinding = db.prepare(
    `INSERT INTO session_bindings (session_id, project_uid, from_seq, to_seq, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  );

  function getSession(session_id: string): SessionRow | null {
    return (selSession.get(session_id) as SessionRow | undefined) ?? null;
  }
  function maxEventSeq(session_id: string): number {
    return (selMaxEventSeq.get(session_id) as { m: number }).m;
  }
  function touchSession(session_id: string): void {
    const ts = now();
    touch.run(ts, ts, session_id);
  }

  function bind(session_id: string, project_uid: string, since?: number): void {
    const from = since ?? maxEventSeq(session_id) + 1;
    const open = selOpenSegment.get(session_id) as BindingRow | undefined;

    // Step 3 — boundary flush: close the open segment at from-1 and hand the
    // closed range to the summarizer, but only if it actually holds events.
    if (open && from > open.from_seq) {
      const to_seq = from - 1;
      if (to_seq >= open.from_seq && hasEventInRange.get(session_id, open.from_seq, to_seq)) {
        onSegmentClose({
          session_id,
          project_uid: open.project_uid,
          from_seq: open.from_seq,
          to_seq,
        });
      }
    }

    // Step 4 — overwrite-forward: drop the open segment (empty-retarget) and any
    // segments that started at/after the new boundary (backdate over them).
    delForward.run(session_id, from);
    // Step 5 — close the surviving straddler at from-1.
    closeStraddler.run(from - 1, session_id, from, from);
    // Step 6 — open the new segment.
    insertBinding.run(session_id, project_uid, from, now());
    // Step 7 — touch.
    touchSession(session_id);
  }

  function projectAt(session_id: string, seq: number): string | null {
    const seg = selSegmentAt.get(session_id, seq, seq) as BindingRow | undefined;
    if (!seg) return null;
    // An open segment attributes only seqs that have a real event behind them, so
    // a freshly-opened `[from, NULL]` does not claim a not-yet-appended seq.
    if (seg.to_seq === null) return seq <= maxEventSeq(session_id) ? seg.project_uid : null;
    return seg.project_uid;
  }

  return {
    createSession(p) {
      const session_id = p.session_id ?? newUlid();
      insertSession.run({
        session_id,
        device_id: p.device_id ?? null,
        harness: p.harness ?? null,
        ts: now(),
      });
      return { session_id };
    },
    getSession,
    touchSession,
    updateSessionSummary(session_id, summary, summary_node_uid) {
      updSummary.run(summary, summary_node_uid ?? null, now(), session_id);
    },
    bind,
    currentProject(session_id) {
      const open = selOpenSegment.get(session_id) as BindingRow | undefined;
      return open?.project_uid ?? null;
    },
    projectAt,
    segmentsForSession(session_id) {
      return selSegments.all(session_id) as BindingRow[];
    },
  };
}
