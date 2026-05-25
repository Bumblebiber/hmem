// test/e2e/hooks-parity.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { parseSessionStartStdin, parseStopStdin } from '../../src/hooks/harness/claude-code.js';
import { parseHermesSessionStartStdin, parseHermesStopStdin } from '../../src/hooks/harness/hermes.js';
import { buildSessionStart } from '../../src/hooks/session-start.js';
import { logStop } from '../../src/hooks/stop-log.js';
import { readLastUserMessage, readLastAssistantMessage } from '../../src/hooks/transcript.js';
import type { SessionStartDeps } from '../../src/hooks/types.js';

const deps: SessionStartDeps = {
  gitProbe: () => ({ uncommitted: [], stashes: [], worktrees: [], unmergedBranches: [], isRepo: false }),
  syncProbe: () => '🟢 hmem-sync verbunden.',
  deviceProbe: () => '--- Active device ---\n  DEVELOPER ✓',
};

function seed() {
  const s = createV2Store(':memory:', DEFAULT_CONFIG);
  const h = s.entries.createEntry({ prefix: 'H', level_1: 'Identität' });
  s.entries.addNode({ root_uid: h.uid, content: 'Anrede: "Benni"' });
  const p = s.entries.createEntry({ prefix: 'P', level_1: 'its-over-9k | Active' });
  const ns = s.entries.addNode({ root_uid: p.uid, content: 'Next Steps' });
  s.entries.addNode({ root_uid: p.uid, parent_uid: ns.uid, content: 'Ship Phase 5' });
  const t = s.entries.createEntry({ prefix: 'T', level_1: 'Wire hooks' });
  s.links.addLink(p.uid, t.uid);
  return { s, p, t };
}

function rows(s: ReturnType<typeof createV2Store>, sid: string) {
  return {
    bindings: s.db.prepare('SELECT project_uid, from_seq, to_seq FROM session_bindings WHERE session_id=? ORDER BY from_seq').all(sid),
    events: s.events.getSessionLog(sid).map(e => [e.seq, e.role, e.content]),
    project: s.sessions.currentProject(sid),
  };
}

describe('Phase 5 acceptance — harness parity', () => {
  it('SessionStart injects a full brief (every o9k-session-start section)', () => {
    const { s, p, t } = seed();
    const ctx = parseSessionStartStdin(JSON.stringify({ session_id: 'CC', cwd: '/repo', source: 'startup' }));
    ctx.namedProject = p.label;
    const res = buildSessionStart(s, ctx, deps);
    for (const needle of ['Identität', 'Anrede: "Benni"', 'Recent projects', 'Active device', 'hmem-sync verbunden', 'its-over-9k', 'Next Steps', 'Ship Phase 5', t.label]) {
      expect(res.context).toContain(needle);
    }
    s.close();
  });

  it('Claude Code and Hermes sessions produce identical binding + event outcomes', () => {
    const { s: s1, p: p1 } = seed();
    const { s: s2, p: p2 } = seed();

    // Same transcript fixture for both.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmem-parity-'));
    const tx = path.join(dir, 't.jsonl');
    fs.writeFileSync(tx, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'did the thing' }] } }),
    ].join('\n') + '\n');

    // Claude Code path
    const cc = parseSessionStartStdin(JSON.stringify({ session_id: 'SID', cwd: '/repo', source: 'startup' }));
    cc.namedProject = p1.label;
    buildSessionStart(s1, cc, deps);
    const ccStop = parseStopStdin(JSON.stringify({ session_id: 'SID', transcript_path: tx, last_assistant_message: 'did the thing' }));
    logStop({ store: s1, sessionId: ccStop.sessionId, userText: readLastUserMessage(tx)!, assistantText: ccStop.lastAssistantMessage! });

    // Hermes path (no last_assistant_message → read from transcript)
    const hm = parseHermesSessionStartStdin(JSON.stringify({ session_id: 'SID', cwd: '/repo', project: p2.label }));
    buildSessionStart(s2, hm, deps);
    const hmStop = parseHermesStopStdin(JSON.stringify({ session_id: 'SID', transcript_path: tx }));
    logStop({ store: s2, sessionId: hmStop.sessionId, userText: readLastUserMessage(tx)!, assistantText: readLastAssistantMessage(tx)! });

    const a = rows(s1, 'SID');
    const b = rows(s2, 'SID');
    expect(a.events).toEqual(b.events);
    expect(a.events).toEqual([[1, 'user', 'do the thing'], [2, 'assistant', 'did the thing']]);
    expect(a.bindings.length).toBe(1);
    expect(b.bindings.length).toBe(1);
    // both bound their seeded project as the open segment
    expect(a.project).toBe(p1.uid);
    expect(b.project).toBe(p2.uid);
    fs.rmSync(dir, { recursive: true, force: true });
    s1.close(); s2.close();
  });

  it('structural: this acceptance file imports no MCP module', () => {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    // Split tokens to avoid the self-referential match of the literal pattern string.
    const forbidden = ['mcp' + '-server', 'mcp' + '-shared', 'mcp' + '-curate'];
    for (const tok of forbidden) expect(src).not.toContain(tok);
  });
});
