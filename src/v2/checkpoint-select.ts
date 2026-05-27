/**
 * hmem v2 — Chunk 6a: checkpoint-pipeline segment selection engine.
 *
 * PURE, DETERMINISTIC — no LLM, no network. Decides WHICH segments the
 * extractor will process in this pipeline run. The caller is responsible for
 * writing the extraction marker after the LLM step completes.
 *
 * ## Key design decisions (from advisor + spec review)
 *
 * 1. "Current segment" = the OPEN binding of `currentSessionId`
 *    (`to_seq IS NULL AND session_id = currentSessionId`).
 *    Any CLOSED bindings of `currentSessionId` are treated as **backlog**
 *    (eligible at `unextracted > 0`). Migrated sessions with `to_seq IS NULL`
 *    are NOT current because their `session_id !== currentSessionId`.
 *
 * 2. Segment upper bound (mirrored from `summarize/loop.ts resummarizeSegment` ~L96–111
 *    and `maybeCheckpoint` ~L117–126):
 *      - Closed segment: `to_seq` (the stored value)
 *      - Open segment:   `MAX(seq)` from `events` for that session_id
 *
 * 3. `fromSeqExclusive` = `last_extracted_seq` verbatim (0 when no marker).
 *    The caller filters with `seq > fromSeqExclusive AND seq >= from_seq`,
 *    so values below `from_seq` (e.g. 0 for a non-first segment) are safe.
 *
 * 4. Tiebreaker for equal `sessions.updated_at`: order by
 *    `(session_id, from_seq)` ASC for pure determinism.
 */
import type Database from 'better-sqlite3';
import type { V2Store } from './store-facade.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A segment selected for extraction. Contains everything the caller needs to
 * fetch unextracted events and write the marker afterward.
 *
 * Unextracted events in this segment:
 *   `seq > fromSeqExclusive AND seq >= from_seq AND seq <= toSeqInclusive`
 */
export interface SelectedSegment {
  /** Which session this binding belongs to. */
  session_id: string;
  /** The `from_seq` of the binding row — start of this segment. */
  from_seq: number;
  /**
   * `last_extracted_seq` from `segment_extractions` (0 if no marker exists).
   * Callers use `seq > fromSeqExclusive` to skip already-extracted events.
   * Note: this may be less than `from_seq` for never-extracted segments
   * that are not the first segment of a session.
   */
  fromSeqExclusive: number;
  /**
   * Upper bound of this segment (inclusive):
   *   - closed segment: `to_seq`
   *   - open segment:   `MAX(seq)` of events for this session_id
   */
  toSeqInclusive: number;
}

export interface SelectOptions {
  /** The session_id of the currently-active session (open binding). */
  currentSessionId: string;
  /** Only consider bindings for this project_uid. */
  projectUid: string;
  /**
   * Minimum unextracted event count for the CURRENT segment to be eligible.
   * Backlog segments only need `unextracted > 0`.
   * Default: 20.
   */
  cadence?: number;
  /**
   * Maximum number of segments to return. Current segment counts toward cap.
   * Default: 10.
   */
  cap?: number;
}

// ── Internal row types ───────────────────────────────────────────────────────

interface CandidateRow {
  session_id: string;
  from_seq: number;
  to_seq: number | null;
  last_extracted_seq: number;
  /** `MAX(seq)` of events for this session_id — precomputed once per session. */
  session_max_seq: number;
  updated_at: string;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Select segments eligible for checkpoint extraction this run.
 *
 * Selection rules (deterministic, pure read):
 *  1. Scope to `projectUid` only.
 *  2. For each candidate compute `unextracted = #events with seq > last_extracted_seq`
 *     within the segment's `[from_seq .. toSeqInclusive]` range.
 *  3. Current segment (`session_id === currentSessionId AND to_seq IS NULL`):
 *     eligible iff `unextracted >= cadence`.
 *  4. Backlog segments (all others in the project): eligible iff `unextracted > 0`.
 *  5. Segments with `unextracted === 0` are skipped entirely.
 *  6. Order: current first (if eligible), then backlog by `sessions.updated_at DESC`,
 *     tiebroken by `(session_id, from_seq)` ASC for determinism.
 *  7. Return at most `cap` segments total.
 */
export function selectSegmentsForExtraction(
  store: V2Store,
  opts: SelectOptions,
): SelectedSegment[] {
  const db: Database.Database = store.db;
  const { currentSessionId, projectUid } = opts;
  const cadence = opts.cadence ?? 20;
  const cap = opts.cap ?? 10;

  // ── Step 1: Gather all candidate bindings for this project ─────────────────
  // LEFT JOIN segment_extractions to get the marker; JOIN sessions for updated_at.
  // Subquery for session_max_seq: `MAX(seq)` across all events for that session
  // (needed to compute the upper bound of an open segment).
  const rows = db
    .prepare(
      `SELECT
         b.session_id,
         b.from_seq,
         b.to_seq,
         COALESCE(x.last_extracted_seq, 0)          AS last_extracted_seq,
         COALESCE((
           SELECT MAX(e.seq)
             FROM events e
            WHERE e.session_id = b.session_id
         ), 0)                                      AS session_max_seq,
         s.updated_at
       FROM session_bindings b
       JOIN sessions s
         ON s.session_id = b.session_id
       LEFT JOIN segment_extractions x
         ON x.session_id = b.session_id
        AND x.from_seq   = b.from_seq
      WHERE b.project_uid = ?`,
    )
    .all(projectUid) as CandidateRow[];

  // ── Step 2–5: Classify each binding ───────────────────────────────────────

  let currentSeg: SelectedSegment | null = null;
  const backlogSegs: Array<SelectedSegment & { updated_at: string }> = [];

  for (const row of rows) {
    // Upper bound for this segment:
    //   - closed: row.to_seq
    //   - open:   session_max_seq  (mirrors loop.ts maybeCheckpoint line 124)
    const toSeq = row.to_seq !== null ? row.to_seq : row.session_max_seq;

    // Count unextracted events: seq > last_extracted_seq, within [from_seq .. toSeq]
    const unextracted = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt
             FROM events
            WHERE session_id = ?
              AND seq > ?
              AND seq >= ?
              AND seq <= ?`,
        )
        .get(row.session_id, row.last_extracted_seq, row.from_seq, toSeq) as { cnt: number }
    ).cnt;

    if (unextracted === 0) continue; // Rule 5

    const seg: SelectedSegment = {
      session_id: row.session_id,
      from_seq: row.from_seq,
      fromSeqExclusive: row.last_extracted_seq,
      toSeqInclusive: toSeq,
    };

    // Rule 3: current segment = open binding of currentSessionId
    if (row.session_id === currentSessionId && row.to_seq === null) {
      if (unextracted >= cadence) {
        currentSeg = seg;
      }
      // If below cadence, skip (Rule 3/5) — do not treat as backlog
    } else {
      // Rule 4: backlog — any other binding (including closed bindings of currentSessionId)
      backlogSegs.push({ ...seg, updated_at: row.updated_at });
    }
  }

  // ── Step 6: Sort backlog by updated_at DESC, tiebreak by (session_id, from_seq) ASC ──
  backlogSegs.sort((a, b) => {
    const tsDiff = b.updated_at.localeCompare(a.updated_at);
    if (tsDiff !== 0) return tsDiff;
    // Tiebreaker: session_id ASC, then from_seq ASC
    const sidDiff = a.session_id.localeCompare(b.session_id);
    if (sidDiff !== 0) return sidDiff;
    return a.from_seq - b.from_seq;
  });

  // ── Step 7: Assemble result with cap ───────────────────────────────────────
  const result: SelectedSegment[] = [];

  if (currentSeg) {
    result.push(currentSeg);
  }

  for (const { updated_at: _ts, ...seg } of backlogSegs) {
    if (result.length >= cap) break;
    result.push(seg);
  }

  return result;
}
