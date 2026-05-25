/**
 * hmem v2 — the always-on live summarizer (the loop behind the DI seam).
 *
 * Imports `entries` + `events` (and reaches the `sessions`/`segment_summaries`
 * tables via raw SQL) and wires `flushSegment` as the `onSegmentClose` hook when
 * the sessions API is constructed (D5: `sessions.ts` never imports this module).
 *
 * The summarizer itself is injected (`Summarizer = (events) => string |
 * Promise<string>`) so the loop is deterministically unit-testable with a stub;
 * the real Haiku adapter lives in `./anthropic.ts`. Each binding segment owns one
 * rolling-summary node (a `#session-summary` child of the segment's project) plus a
 * one-line `sessions.summary`; re-summarizing rebuilds that node *in place* keyed
 * by `(session_id, from_seq)`, never creating a duplicate (scenario 3).
 *
 * Sync/async contract: when the injected `summarize` returns a string the whole
 * persist path runs synchronously (so a boundary flush completes within `bind`);
 * when it returns a Promise the persist is chained and a Promise is returned.
 */
import type Database from 'better-sqlite3';
import type { EntriesApi } from '../store/entries.js';
import type { EventsApi } from '../store/events.js';
import type { ClosedSegment, EventRow } from '../store/types.js';

export type Summarizer = (events: EventRow[]) => string | Promise<string>;

export interface SummarizerDeps {
  db: Database.Database;
  entries: EntriesApi;
  events: EventsApi;
  /** Optional sessions API; when absent the one-line summary is written via raw SQL. */
  sessions?: { updateSessionSummary(session_id: string, summary: string, node_uid: string): void };
  summarize: Summarizer;
  cadence: number;
}

export interface SummarizerApi {
  resummarizeSegment(session_id: string, fromSeq: number, toSeq: number): void | Promise<void>;
  flushSegment(c: ClosedSegment): void | Promise<void>;
  maybeCheckpoint(session_id: string): void | Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

export function createSummarizer(deps: SummarizerDeps): SummarizerApi {
  const { db, entries, events, sessions, summarize, cadence } = deps;

  const selProject = db.prepare(
    'SELECT project_uid FROM session_bindings WHERE session_id = ? AND from_seq = ?',
  );
  const selOpen = db.prepare(
    'SELECT from_seq FROM session_bindings WHERE session_id = ? AND to_seq IS NULL',
  );
  const selSummary = db.prepare(
    'SELECT node_uid, last_summarized_seq FROM segment_summaries WHERE session_id = ? AND from_seq = ?',
  );
  const upsertSummary = db.prepare(
    `INSERT INTO segment_summaries (session_id, from_seq, node_uid, last_summarized_seq)
     VALUES (@session_id, @from_seq, @node_uid, @last)
     ON CONFLICT(session_id, from_seq) DO UPDATE SET
       node_uid = excluded.node_uid,
       last_summarized_seq = excluded.last_summarized_seq`,
  );
  const updSessionSummary = db.prepare(
    'UPDATE sessions SET summary = ?, summary_node_uid = ?, updated_at = ? WHERE session_id = ?',
  );

  /** Materialize the rolling-summary node + cadence row + one-line session summary. */
  function persist(
    session_id: string,
    fromSeq: number,
    toSeq: number,
    project_uid: string,
    text: string,
  ): void {
    const existing = selSummary.get(session_id, fromSeq) as
      | { node_uid: string | null; last_summarized_seq: number }
      | undefined;
    let node_uid: string;
    if (existing?.node_uid) {
      node_uid = existing.node_uid;
      entries.updateNodeContent(node_uid, text); // rebuild in place (scenario 3)
    } else {
      node_uid = entries.addNode({
        root_uid: project_uid,
        content: text,
        tags: ['#session-summary'],
      }).uid;
    }
    upsertSummary.run({ session_id, from_seq: fromSeq, node_uid, last: toSeq });
    if (sessions) sessions.updateSessionSummary(session_id, text, node_uid);
    else updSessionSummary.run(text, node_uid, now(), session_id);
  }

  function resummarizeSegment(
    session_id: string,
    fromSeq: number,
    toSeq: number,
  ): void | Promise<void> {
    const project = selProject.get(session_id, fromSeq) as { project_uid: string } | undefined;
    if (!project) return; // no segment starts here → nothing to attribute
    const evs = events
      .eventsForSession(session_id)
      .filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
    const out = summarize(evs);
    if (out instanceof Promise) {
      return out.then((text) => persist(session_id, fromSeq, toSeq, project.project_uid, text));
    }
    persist(session_id, fromSeq, toSeq, project.project_uid, out);
  }

  function flushSegment(c: ClosedSegment): void | Promise<void> {
    return resummarizeSegment(c.session_id, c.from_seq, c.to_seq);
  }

  function maybeCheckpoint(session_id: string): void | Promise<void> {
    const open = selOpen.get(session_id) as { from_seq: number } | undefined;
    if (!open) return;
    const row = selSummary.get(session_id, open.from_seq) as
      | { last_summarized_seq: number }
      | undefined;
    const last = row?.last_summarized_seq ?? open.from_seq - 1;
    const maxSeq = events.maxSeq(session_id);
    if (maxSeq - last >= cadence) return resummarizeSegment(session_id, open.from_seq, maxSeq);
  }

  return { resummarizeSegment, flushSegment, maybeCheckpoint };
}
