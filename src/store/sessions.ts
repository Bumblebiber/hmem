/**
 * hmem v2 — sessions table (binding-segment algebra follows in a later commit).
 *
 * A session is a first-class row, NOT a tree node (master-plan Goal #2: no global
 * mutable "active project" state — the current project is per-session, the open
 * binding segment). This module reads the `events` table directly via raw SQL and
 * deliberately does NOT import `events.ts` (D5: avoids a circular dependency with
 * `summarize/`). The `onSegmentClose` hook is carried now so the summarizer can be
 * wired at construction time once `bind` lands.
 */
import type Database from 'better-sqlite3';
import { newUlid } from './ulid.js';
import type { ClosedSegment, SessionRow } from './types.js';

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
  updateSessionSummary(session_id: string, summary: string, summary_node_uid: string): void;
}

export function createSessionsApi(
  db: Database.Database,
  _opts: SessionsApiOpts = {},
): SessionsApi {
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

  function getSession(session_id: string): SessionRow | null {
    return (selSession.get(session_id) as SessionRow | undefined) ?? null;
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
    touchSession(session_id) {
      const ts = now();
      touch.run(ts, ts, session_id);
    },
    updateSessionSummary(session_id, summary, summary_node_uid) {
      updSummary.run(summary, summary_node_uid, now(), session_id);
    },
  };
}
