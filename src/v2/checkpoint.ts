/**
 * hmem v2 — Chunk 6c: checkpoint-pipeline orchestration core.
 *
 * Ties Chunk 6a (segment selection) + 6b (extraction agent) together and is the
 * function the CLI handler (`src/cli-v2-checkpoint.ts`) calls once the v2 store is
 * open. After this chunk, `hmem v2-checkpoint` does real work.
 *
 * Pipeline (one pass per invocation):
 *   1. Resolve the current session's project (open binding). No project → no-op.
 *   2. Gate (`shouldRunV2Extraction`): run iff `checkpointMode === 'auto'` OR a
 *      free `claude -p` extraction route exists. `checkpointMode` has only two
 *      values today (`'remind' | 'auto'`) — there is NO explicit off/never value,
 *      so there is nothing to early-return for. Gate fails → no-op.
 *   3. Select eligible segments (6a). Empty → no-op.
 *   4. For each segment, fetch its unextracted events.
 *   5. DETERMINISTIC summary-refresh + marker (BEFORE the LLM call):
 *        - Refresh `sessions.summary` via `fallbackSummarize` (cheap, no network)
 *          for every segment that is NOT the current OPEN segment. The live
 *          summarizer owns the current open segment's summary — refreshing it
 *          would clobber.
 *        - Write the `segment_extractions` marker (UPSERT, `last_extracted_seq =
 *          toSeqInclusive`) REGARDLESS of the LLM outcome — so a transient Haiku
 *          failure never causes perpetual re-processing of the same segments.
 *   6. ONE best-effort agent call (6b) for ALL selected segments together. A
 *      throw is logged and swallowed — never propagated.
 *
 * The whole pass (deterministic refresh + agent) is gated together (spec: a
 * future "always deterministically refresh" split is out of scope for 6c).
 */
import type { HmemConfig } from '../hmem-config.js';
import type { V2Store } from './store-facade.js';
import { selectSegmentsForExtraction } from './checkpoint-select.js';
import {
  runV2ExtractionAgent,
  type SegmentWithEvents,
  type RunExtractionOptions,
} from './checkpoint-agent.js';
import { fallbackSummarize } from './summarize-adapter.js';
import { hasFreeExtractionPath, type ExtractionPathProbes } from '../cli-checkpoint-agent.js';

/** Options for {@link runV2Checkpoint}. */
export interface RunV2CheckpointOptions extends RunExtractionOptions {
  /**
   * Probes for the FREE-path gate (`hasFreeExtractionPath`). Injectable in tests
   * so the gate decision can be forced without env manipulation. Distinct from
   * `opts.probes`, which the agent runner uses for its own spawn-vs-noop routing.
   */
  gateProbes?: ExtractionPathProbes;
}

/**
 * The whole-pass gate. The v2 extraction pass runs iff:
 *   - `checkpointMode === 'auto'` (user explicitly opted into auto-extraction), OR
 *   - a FREE `claude -p` extraction route exists (default-on-when-free, D0324).
 *
 * `checkpointMode` allowed values are only `'remind' | 'auto'` (see hmem-config.ts) —
 * there is no off/never value, so nothing is early-returned for an explicit disable.
 */
export function shouldRunV2Extraction(
  config: HmemConfig,
  gateProbes?: ExtractionPathProbes,
): boolean {
  if (config.checkpointMode === 'auto') return true;
  return hasFreeExtractionPath(config, gateProbes ?? {});
}

/**
 * Run one checkpoint-extraction pass for the current session.
 *
 * @param store            an OPEN v2 store (the agent runner may close it on the
 *                         real spawn path; the test seam keeps it open).
 * @param currentSessionId the active session whose open binding defines "current".
 * @param config           hmem config (gate + cadence + prompt schema).
 * @param hmemPath         absolute path to the .hmem file (for MCP config build).
 * @param opts             optional test seams (agent `invoke`, gate/agent probes).
 */
export async function runV2Checkpoint(
  store: V2Store,
  currentSessionId: string,
  config: HmemConfig,
  hmemPath: string,
  opts: RunV2CheckpointOptions = {},
): Promise<void> {
  // ── Step 1: resolve the current session's project (open binding). ───────────
  const projectUid = store.sessions.currentProject(currentSessionId);
  if (!projectUid) return; // no open binding → nothing to attribute → no-op

  // ── Step 2: whole-pass gate. ────────────────────────────────────────────────
  if (!shouldRunV2Extraction(config, opts.gateProbes)) return;

  // ── Step 3: select eligible segments (pure, deterministic). ─────────────────
  const cadence = config.checkpointInterval && config.checkpointInterval > 0
    ? config.checkpointInterval
    : 20;
  const segments = selectSegmentsForExtraction(store, {
    currentSessionId,
    projectUid,
    cadence,
    cap: 10,
  });
  if (segments.length === 0) return;

  // Prepared lookups for per-segment binding `to_seq` and marker UPSERT.
  const selBindingToSeq = store.db.prepare(
    'SELECT to_seq FROM session_bindings WHERE session_id = ? AND from_seq = ?',
  );
  const upsertMarker = store.db.prepare(
    `INSERT INTO segment_extractions (session_id, from_seq, last_extracted_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, from_seq) DO UPDATE SET
       last_extracted_seq = excluded.last_extracted_seq`,
  );

  // ── Steps 4 + 5: fetch events, deterministic refresh + marker per segment. ──
  const withEvents: SegmentWithEvents[] = [];
  for (const segment of segments) {
    const { session_id, from_seq, fromSeqExclusive, toSeqInclusive } = segment;

    // Step 4: the unextracted events for this segment.
    const events = store.events
      .eventsForSession(session_id)
      .filter(
        e =>
          e.seq > fromSeqExclusive &&
          e.seq >= from_seq &&
          e.seq <= toSeqInclusive,
      );
    withEvents.push({ segment, events });

    // Step 5a: is this the CURRENT open segment?  iff the binding's `to_seq` is
    // NULL AND it belongs to the current session. The live summarizer owns that
    // segment's summary — refresh ALL OTHERS (closed segments, or any segment of
    // a different session). Determined explicitly from the binding row, never
    // inferred from selection order.
    const binding = selBindingToSeq.get(session_id, from_seq) as
      | { to_seq: number | null }
      | undefined;
    const isCurrentOpen =
      session_id === currentSessionId && binding != null && binding.to_seq === null;

    if (!isCurrentOpen && events.length > 0) {
      // Cheap, deterministic, NEVER network. Preserve any existing
      // summary_node_uid (do NOT fabricate one — node creation is the live
      // summarizer's job).
      const summary = fallbackSummarize(events);
      const existingNodeUid =
        store.sessions.getSession(session_id)?.summary_node_uid ?? null;
      store.sessions.updateSessionSummary(session_id, summary, existingNodeUid);
    }

    // Step 5b: write the marker NOW — regardless of the LLM outcome below.
    // Best-effort: a marker write must never sink the pass.
    try {
      upsertMarker.run(session_id, from_seq, toSeqInclusive);
    } catch (e) {
      console.error(
        `[hmem v2 checkpoint] marker upsert failed for ${session_id}@${from_seq}: ${
          (e as Error)?.message ?? String(e)
        }`,
      );
    }
  }

  // ── Step 6: ONE best-effort agent call for ALL selected segments. ───────────
  // `projectLabel` is the P-entry label for projectUid (uid → label).
  const projectLabel = store.entries.uidToLabel(projectUid) ?? projectUid;
  try {
    await runV2ExtractionAgent(store, withEvents, config, hmemPath, projectLabel, {
      invoke: opts.invoke,
      probes: opts.probes,
    });
  } catch (e) {
    console.error(
      `[hmem v2 checkpoint] extraction agent failed (non-fatal): ${
        (e as Error)?.message ?? String(e)
      }`,
    );
  }

  // ── Step 7: done. ───────────────────────────────────────────────────────────
}
