/**
 * Chunk 6c — runV2Checkpoint orchestration tests (TDD — written BEFORE the impl).
 *
 * Builds realistic in-memory v2 stores (createV2Store(':memory:')), wires a fake
 * `invoke` seam so NO subprocess / network is touched, and asserts the
 * orchestration contract:
 *   1. Backlog stub gets fixed deterministically; current open segment summary is
 *      NOT clobbered; the agent runs EXACTLY ONCE for all segments; an L entry is
 *      linked to the P-entry.
 *   2. Idempotency — a second run with no new events does not re-invoke the agent
 *      and writes no duplicate L entries; markers are unchanged.
 *   3. LLM failure is non-fatal — markers + summary refresh still persist.
 *   4. Gate — a config that fails the gate is a full no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import type { HmemConfig } from '../../src/hmem-config.js';
import { runV2Checkpoint } from '../../src/v2/checkpoint.js';
import type { V2Store } from '../../src/v2/store-facade.js';

// ── Config helpers ──────────────────────────────────────────────────────────

/** Auto mode → gate always opens (no free-path probe needed). cadence = 5. */
function autoConfig(): HmemConfig {
  return { ...DEFAULT_CONFIG, checkpointMode: 'auto', checkpointInterval: 5 };
}

// Force the free-path gate ON without env: pretend we are claude-code + binary.
const gateOpenProbes = {
  detectHarness: () => 'claude-code' as const,
  hasClaudeBinary: () => true,
};
// Force the free-path gate OFF: unknown harness + no binary.
const gateClosedProbes = {
  detectHarness: () => 'unknown' as const,
  hasClaudeBinary: () => false,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CURRENT = 'S-current';
const BACKLOG = 'S-backlog';
const STUB_SUMMARY = 'Session 2026-05-26';

function appendN(events: V2Store['events'], sid: string, n: number, prefix = 'msg') {
  for (let i = 0; i < n; i++) {
    events.appendEvent({ session_id: sid, role: 'user', content: `${prefix}-${i}` });
  }
}

/**
 * Build a store with:
 *   - a P-entry,
 *   - a CURRENT session with an OPEN segment of >= cadence events,
 *   - a BACKLOG session (closed segment) with events and a stub one-line summary,
 * both bound to the same project.
 */
function buildScenario() {
  const store = createV2Store(':memory:', autoConfig());
  const { sessions, events, entries } = store;
  const p = entries.createEntry({ prefix: 'P', level_1: 'Project Alpha' });

  // BACKLOG session: open then close its segment by binding a fresh later range.
  // Simpler: create the session, bind, append events, then bind again to close it.
  sessions.createSession({ session_id: BACKLOG });
  sessions.bind(BACKLOG, p.uid); // opens [1, NULL]
  appendN(events, BACKLOG, 4, 'backlog');
  // Close the backlog segment: re-bind opens a new segment at maxSeq+1, closing
  // the prior one at its last event. We want a CLOSED segment, so bind again at
  // a forward boundary.
  sessions.bind(BACKLOG, p.uid, 5); // closes [1,4], opens [5, NULL] (empty)
  // Plant a stub one-line summary on the backlog session (what a migration left).
  store.db
    .prepare('UPDATE sessions SET summary = ?, summary_node_uid = NULL WHERE session_id = ?')
    .run(STUB_SUMMARY, BACKLOG);

  // CURRENT session: open segment with >= cadence (5) events.
  sessions.createSession({ session_id: CURRENT });
  sessions.bind(CURRENT, p.uid);
  appendN(events, CURRENT, 6, 'current');
  // Plant a live summary on the current open segment (summarizer-owned).
  const liveSummary = 'live current summary — owned by summarizer';
  store.db
    .prepare('UPDATE sessions SET summary = ? WHERE session_id = ?')
    .run(liveSummary, CURRENT);

  return { store, pUid: p.uid, pLabel: entries.uidToLabel(p.uid)!, liveSummary };
}

/** Count live L entries linked to the given P-entry uid. */
function lEntriesLinkedTo(store: V2Store, pUid: string): number {
  return (
    store.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM entries e
           JOIN links l ON l.src_uid = e.uid
          WHERE e.prefix = 'L' AND e.deleted_at IS NULL AND l.dst_uid = ?`,
      )
      .get(pUid) as { n: number }
  ).n;
}

function markerFor(store: V2Store, sid: string, fromSeq: number): number | null {
  const row = store.db
    .prepare('SELECT last_extracted_seq FROM segment_extractions WHERE session_id = ? AND from_seq = ?')
    .get(sid, fromSeq) as { last_extracted_seq: number } | undefined;
  return row?.last_extracted_seq ?? null;
}

function sessionSummary(store: V2Store, sid: string): string | null {
  const row = store.db
    .prepare('SELECT summary FROM sessions WHERE session_id = ?')
    .get(sid) as { summary: string | null } | undefined;
  return row?.summary ?? null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runV2Checkpoint — orchestration', () => {
  let stores: V2Store[] = [];
  beforeEach(() => { stores = []; });
  afterEach(() => { for (const s of stores) { try { s.close(); } catch { /* ignore */ } } });

  it('Test 1: backlog stub fixed; current open summary NOT clobbered; one agent call; L linked', async () => {
    const { store, pUid, pLabel, liveSummary } = buildScenario();
    stores.push(store);

    // Fake invoke: simulate the extraction agent writing one L entry linked to P.
    let invokeCount = 0;
    const fakeThatWritesAnL = async () => {
      invokeCount++;
      const l = store.entries.createEntry({ prefix: 'L', level_1: 'A durable lesson' });
      store.links.addLink(l.uid, pUid);
    };

    await runV2Checkpoint(store, CURRENT, store.config, '/tmp/scenario.hmem', {
      invoke: fakeThatWritesAnL,
      gateProbes: gateOpenProbes,
    });

    // Backlog session's summary refreshed to the fallbackSummarize output (NOT the stub).
    const backlogSummary = sessionSummary(store, BACKLOG);
    expect(backlogSummary).not.toBe(STUB_SUMMARY);
    expect(backlogSummary).toContain('backlog-0'); // first user line of segment
    expect(backlogSummary).toContain('exchange'); // "— N exchange(s)"

    // A marker exists for the backlog segment.
    expect(markerFor(store, BACKLOG, 1)).toBe(4);

    // The CURRENT open segment's summary was NOT overwritten.
    expect(sessionSummary(store, CURRENT)).toBe(liveSummary);

    // The fake invoke was called EXACTLY ONCE (one prompt for all segments).
    expect(invokeCount).toBe(1);

    // An L entry exists linked to the P-entry.
    expect(lEntriesLinkedTo(store, pUid)).toBe(1);
    expect(pLabel).toMatch(/^P\d{4}$/);
  });

  it('Test 2: idempotency — second run with no new events does not re-invoke or duplicate', async () => {
    const { store, pUid } = buildScenario();
    stores.push(store);

    let invokeCount = 0;
    const fake = async () => {
      invokeCount++;
      const l = store.entries.createEntry({ prefix: 'L', level_1: 'Lesson once' });
      store.links.addLink(l.uid, pUid);
    };

    await runV2Checkpoint(store, CURRENT, store.config, '/tmp/s.hmem', { invoke: fake, gateProbes: gateOpenProbes });
    const markerBacklogAfter1 = markerFor(store, BACKLOG, 1);
    const markerCurrentAfter1 = markerFor(store, CURRENT, 1);
    expect(invokeCount).toBe(1);
    expect(lEntriesLinkedTo(store, pUid)).toBe(1);

    // Second run — no new events appended → all segments fully extracted → empty.
    await runV2Checkpoint(store, CURRENT, store.config, '/tmp/s.hmem', { invoke: fake, gateProbes: gateOpenProbes });

    expect(invokeCount).toBe(1); // NOT called again
    expect(lEntriesLinkedTo(store, pUid)).toBe(1); // no duplicate L
    expect(markerFor(store, BACKLOG, 1)).toBe(markerBacklogAfter1); // unchanged
    expect(markerFor(store, CURRENT, 1)).toBe(markerCurrentAfter1); // unchanged
  });

  it('Test 3: LLM failure is non-fatal — markers + refresh persist, no perpetual retry', async () => {
    const { store } = buildScenario();
    stores.push(store);

    let invokeCount = 0;
    const throwingInvoke = async () => {
      invokeCount++;
      throw new Error('simulated Haiku timeout');
    };

    // Must resolve (not reject) despite the agent throwing.
    await expect(
      runV2Checkpoint(store, CURRENT, store.config, '/tmp/s.hmem', { invoke: throwingInvoke, gateProbes: gateOpenProbes }),
    ).resolves.toBeUndefined();

    expect(invokeCount).toBe(1);
    // Markers for refreshed segments were still written → no perpetual reprocessing.
    expect(markerFor(store, BACKLOG, 1)).toBe(4);
    // Summary refresh persisted for the backlog segment.
    expect(sessionSummary(store, BACKLOG)).not.toBe(STUB_SUMMARY);
  });

  it('Test 4: gate fails → full no-op (no invoke, no marker, no summary change)', async () => {
    const { store } = buildScenario();
    stores.push(store);

    // Config that fails the gate: remind mode AND no free path (probes force false).
    const remindConfig: HmemConfig = { ...store.config, checkpointMode: 'remind' };

    let invokeCount = 0;
    const fake = async () => { invokeCount++; };

    await runV2Checkpoint(store, CURRENT, remindConfig, '/tmp/s.hmem', {
      invoke: fake,
      gateProbes: gateClosedProbes,
    });

    expect(invokeCount).toBe(0);               // no agent call
    expect(markerFor(store, BACKLOG, 1)).toBeNull(); // no marker written
    expect(sessionSummary(store, BACKLOG)).toBe(STUB_SUMMARY); // stub untouched
  });

  it('no-op when current session has no open binding (no project)', async () => {
    const store = createV2Store(':memory:', autoConfig());
    stores.push(store);
    store.events.appendEvent({ session_id: 'S-unbound', role: 'user', content: 'x' });

    let invokeCount = 0;
    await runV2Checkpoint(store, 'S-unbound', store.config, '/tmp/s.hmem', {
      invoke: async () => { invokeCount++; },
      gateProbes: gateOpenProbes,
    });
    expect(invokeCount).toBe(0);
  });
});
