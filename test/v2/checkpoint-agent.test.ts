/**
 * Chunk 6b — v2 LLM knowledge-extraction agent machinery.
 *
 * Two units under test (both network-free):
 *   1. buildV2ExtractionPrompt — pure prompt builder for ONE multi-segment prompt.
 *   2. runV2ExtractionAgent     — agent runner with an INJECTABLE invoke seam.
 *
 * TDD: written BEFORE the implementation. The runner test simulates the agent
 * by executing scripted hmem writes against the REAL v2 store via the facade —
 * NO subprocess, NO network, NO LLM.
 */
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG, type HmemConfig } from '../../src/hmem-config.js';
import { writeMemory, appendMemory } from '../../src/v2/writes.js';
import {
  buildV2ExtractionPrompt,
  runV2ExtractionAgent,
} from '../../src/v2/checkpoint-agent.js';
import type { SelectedSegment } from '../../src/v2/checkpoint-select.js';
import type { EventRow } from '../../src/store/types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A config carrying a P-schema with a readonly + a normal section. */
function configWithPSchema(): HmemConfig {
  return {
    ...DEFAULT_CONFIG,
    schemas: {
      P: {
        sections: [
          { name: 'Overview', loadDepth: 2, description: 'one-liner of the project' },
          { name: 'Architecture', loadDepth: 1, checkpointPolicy: 'readonly', description: 'design notes' },
          { name: 'Bugs', loadDepth: 1, checkpointPolicy: 'pointer', description: 'known bugs' },
          { name: 'Roadmap', loadDepth: 1, description: 'next steps' },
        ],
      },
    },
  };
}

function ev(seq: number, role: 'user' | 'assistant', content: string): EventRow {
  return { event_uid: `u${seq}`, session_id: 'S1', seq, ts: '2026-01-01T00:00:00Z', role, content };
}

// ── Part 1: pure prompt builder ───────────────────────────────────────────────

describe('buildV2ExtractionPrompt (pure)', () => {
  const seg1: SelectedSegment = { session_id: 'S1', from_seq: 1, fromSeqExclusive: 0, toSeqInclusive: 2 };
  const seg2: SelectedSegment = { session_id: 'S2', from_seq: 1, fromSeqExclusive: 0, toSeqInclusive: 1 };

  const segments = [
    {
      segment: seg1,
      events: [
        ev(1, 'user', 'How do I fix the cache bug?'),
        ev(2, 'assistant', 'Invalidate on write, not on read.'),
      ],
    },
    {
      segment: seg2,
      events: [{ ...ev(1, 'user', 'Ship the release'), session_id: 'S2' }],
    },
  ];

  const prompt = buildV2ExtractionPrompt(segments, configWithPSchema(), 'P0042');

  it('covers every segment in ONE prompt, delimited per segment', () => {
    // Two distinct session segments must each appear as a delimited block.
    expect(prompt).toContain('S1');
    expect(prompt).toContain('S2');
  });

  it('lists each segment’s events by seq with role + content', () => {
    expect(prompt).toMatch(/seq\s*1/i);
    expect(prompt).toMatch(/seq\s*2/i);
    expect(prompt).toContain('How do I fix the cache bug?');
    expect(prompt).toContain('Invalidate on write, not on read.');
    expect(prompt).toContain('Ship the release');
    // role labels present
    expect(prompt.toLowerCase()).toContain('user');
    expect(prompt.toLowerCase()).toContain('assistant');
  });

  it('instructs L/D/E extraction linked to the P-label only (no batchId)', () => {
    expect(prompt).toContain('write_memory');
    // valid prefixes mentioned
    expect(prompt).toMatch(/L.*lesson|lesson.*L/i);
    // links to the P-label
    expect(prompt).toContain('links=["P0042"]');
    // 6-month-value gate + 3-5 tags rule survive
    expect(prompt).toMatch(/6 months/i);
    expect(prompt).toMatch(/3-5 tags|3-5 per/i);
    // no batch vocabulary
    expect(prompt).not.toContain('batchId');
    expect(prompt.toLowerCase()).not.toContain('batch');
  });

  it('builds the P-section routing table from config.schemas.P.sections', () => {
    // one routing line per section, with index + name
    expect(prompt).toContain('.1 Overview');
    expect(prompt).toContain('.2 Architecture');
    expect(prompt).toContain('.3 Bugs');
    expect(prompt).toContain('.4 Roadmap');
    // policy annotations
    expect(prompt).toMatch(/Architecture.*READONLY/i);
    expect(prompt).toMatch(/Bugs.*POINTER/i);
    // append uses the addressed section
    expect(prompt).toContain('append_memory');
    expect(prompt).toContain('P0042.');
  });

  it('uses session-segment vocabulary, not O-entry/exchange-node vocabulary', () => {
    expect(prompt.toLowerCase()).toContain('segment');
    expect(prompt.toLowerCase()).not.toContain('o-entry');
    expect(prompt.toLowerCase()).not.toContain('exchange node');
  });

  it('FORBIDS titling events, tagging events, moving/rebinding, and session summaries', () => {
    // No move-nodes tool machinery anywhere.
    expect(prompt).not.toContain('move_nodes');
    // No rebind TOOL CALL instructed (the only legit mention is the explicit prohibition).
    expect(prompt).not.toMatch(/rebind_segment\s*\(/i);
    // The prompt MUST explicitly forbid moving/rebinding.
    expect(prompt.toLowerCase()).toMatch(/do not move or rebind/);
    // No per-event titling instruction (v1 Task 1).
    expect(prompt.toLowerCase()).not.toContain('title each');
    expect(prompt.toLowerCase()).toMatch(/do not title individual events/);
    // No per-event tagging instruction (v1 Task 5).
    expect(prompt.toLowerCase()).not.toContain('tag exchanges');
    expect(prompt.toLowerCase()).toMatch(/do not tag individual events/);
    // No session-summary writing (the summarizer owns that).
    expect(prompt.toLowerCase()).not.toContain('rolling summary');
    expect(prompt.toLowerCase()).toMatch(/do not write session summaries/);
  });

  it('is deterministic given identical inputs', () => {
    const again = buildV2ExtractionPrompt(segments, configWithPSchema(), 'P0042');
    expect(again).toBe(prompt);
  });
});

// ── Part 2: agent runner with injectable invoke ───────────────────────────────

describe('runV2ExtractionAgent — injectable invoke seam', () => {
  it('runs scripted writes against the real store; events stay immutable', async () => {
    const s = createV2Store(':memory:', configWithPSchema());
    // P-entry with section children so P0042.<idx> resolves.
    const { label: pLabel } = writeMemory(s, {
      prefix: 'P',
      content: 'Demo Project\n\tOverview\n\tArchitecture\n\tBugs\n\tRoadmap',
    });

    // An immutable event log to prove extraction never touches it.
    s.sessions.createSession({ session_id: 'S1' });
    const pUid = s.entries.labelToUid(pLabel)!;
    s.sessions.bind('S1', pUid);
    s.events.appendEvent({ session_id: 'S1', role: 'user', content: 'fix the cache bug' });
    s.events.appendEvent({ session_id: 'S1', role: 'assistant', content: 'invalidate on write' });

    // Snapshot the immutable log BEFORE extraction.
    const before = s.db
      .prepare('SELECT event_uid, seq, role, content FROM events ORDER BY session_id, seq')
      .all();

    const segments = [
      {
        segment: { session_id: 'S1', from_seq: 1, fromSeqExclusive: 0, toSeqInclusive: 2 } as SelectedSegment,
        events: s.events.eventsForSession('S1'),
      },
    ];

    // Fake invoke: simulate the agent by running real facade writes.
    let invokedWith: { prompt: string; mcpConfigPath: string; allowedTools: string[] } | null = null;
    const fakeInvoke = async (args: { prompt: string; mcpConfigPath: string; allowedTools: string[] }) => {
      invokedWith = args;
      writeMemory(s, {
        prefix: 'L',
        content: 'Invalidate cache on write\n> Read-time invalidation caused stale hits.',
        tags: ['#cache', '#bug', '#lesson'],
        links: [pLabel],
      });
      appendMemory(s, `${pLabel}.4`, '✓ DONE: cache invalidation fixed');
    };

    await runV2ExtractionAgent(s, segments, configWithPSchema(), '/tmp/fake.hmem', pLabel, { invoke: fakeInvoke });

    // The seam was used and carried the v2-appropriate allowedTools (no move_nodes).
    expect(invokedWith).not.toBeNull();
    expect(invokedWith!.allowedTools.join(' ')).not.toContain('move_nodes');
    expect(invokedWith!.allowedTools.join(' ')).toContain('write_memory');
    expect(invokedWith!.allowedTools.join(' ')).toContain('append_memory');
    expect(invokedWith!.prompt).toContain(pLabel);

    // An L entry exists and is linked to the P-entry.
    const lUid = s.db.prepare("SELECT uid FROM entries WHERE level_1='Invalidate cache on write'").get() as { uid: string };
    expect(lUid).toBeTruthy();
    const links = s.links.getLinks(lUid.uid);
    expect(links.some(l => l.dst_uid === pUid)).toBe(true);

    // The Roadmap section (.4) got the append.
    const roadmapAppend = s.db
      .prepare("SELECT content FROM nodes WHERE root_uid=? AND content LIKE '%cache invalidation fixed%'")
      .get(pUid) as { content: string } | undefined;
    expect(roadmapAppend).toBeTruthy();

    // CRITICAL: the immutable events log is UNCHANGED (count + content).
    const after = s.db
      .prepare('SELECT event_uid, seq, role, content FROM events ORDER BY session_id, seq')
      .all();
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);

    s.close();
  });

  it('is a safe no-op when not claude-code and no claude binary', async () => {
    const s = createV2Store(':memory:', configWithPSchema());
    const { label: pLabel } = writeMemory(s, { prefix: 'P', content: 'Proj\n\tOverview' });
    const segments = [
      {
        segment: { session_id: 'S1', from_seq: 1, fromSeqExclusive: 0, toSeqInclusive: 0 } as SelectedSegment,
        events: [] as EventRow[],
      },
    ];

    // No invoke override → would normally spawn; force the unsupported route via probes.
    await expect(
      runV2ExtractionAgent(s, segments, configWithPSchema(), '/tmp/fake.hmem', pLabel, {
        probes: { detectHarness: () => 'unknown', hasClaudeBinary: () => false },
      }),
    ).resolves.toBeUndefined();

    // Nothing was written.
    const count = (s.db.prepare("SELECT COUNT(*) AS c FROM entries WHERE prefix='L'").get() as { c: number }).c;
    expect(count).toBe(0);
    void pLabel;
    s.close();
  });
});
