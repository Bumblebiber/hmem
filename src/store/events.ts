/**
 * hmem v2 — append-only, immutable events log (replaces v1 O-entry exchanges).
 *
 * Each event carries a per-session monotonic `seq` (starts at 1) assigned as
 * MAX(seq)+1 for the session, and a ULID `event_uid`. Events are NEVER updated or
 * deleted — there is deliberately no mutation API (master-plan D1, scenario 6).
 *
 * Project attribution is *derived*, not stored: `eventsForProject` joins events to
 * `session_bindings` on the segment `[from_seq, to_seq]` that contains an event's
 * seq (D2). Retroactive correction therefore only edits a boundary integer in
 * `session_bindings` — no event row is ever moved. This dissolves the v1
 * `move_nodes` staleness class.
 */
import type Database from 'better-sqlite3';
import { newUlid } from './ulid.js';
import type { EventRow } from './types.js';

export interface EventsApi {
  appendEvent(p: {
    session_id: string;
    role: 'user' | 'assistant';
    content: string;
  }): { seq: number; event_uid: string };
  maxSeq(session_id: string): number;
  eventsForSession(session_id: string): EventRow[];
  getSessionLog(session_id: string): EventRow[];
  eventsForProject(project_uid: string): EventRow[];
}

function now(): string {
  return new Date().toISOString();
}

export function createEventsApi(db: Database.Database): EventsApi {
  const selMaxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?',
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (event_uid, session_id, seq, ts, role, content)
     VALUES (@event_uid, @session_id, @seq, @ts, @role, @content)`,
  );
  const selBySession = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq');
  // D2: an event belongs to a project iff its seq falls in a binding segment of
  // that project. Open segments (to_seq IS NULL) match every later event; since
  // only existing events are in the table, the join never invents rows.
  const selByProject = db.prepare(
    `SELECT e.* FROM events e
       JOIN session_bindings b ON b.session_id = e.session_id
      WHERE b.project_uid = ?
        AND e.seq >= b.from_seq
        AND (b.to_seq IS NULL OR e.seq <= b.to_seq)
      ORDER BY e.session_id, e.seq`,
  );

  function maxSeq(session_id: string): number {
    return (selMaxSeq.get(session_id) as { m: number }).m;
  }

  return {
    appendEvent(p) {
      const seq = maxSeq(p.session_id) + 1;
      const event_uid = newUlid();
      insertEvent.run({
        event_uid,
        session_id: p.session_id,
        seq,
        ts: now(),
        role: p.role,
        content: p.content,
      });
      return { seq, event_uid };
    },
    maxSeq,
    eventsForSession(session_id) {
      return selBySession.all(session_id) as EventRow[];
    },
    getSessionLog(session_id) {
      return selBySession.all(session_id) as EventRow[];
    },
    eventsForProject(project_uid) {
      return selByProject.all(project_uid) as EventRow[];
    },
  };
}
