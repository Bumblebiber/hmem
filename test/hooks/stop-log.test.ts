// test/hooks/stop-log.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { logStop } from '../../src/hooks/stop-log.js';

describe('logStop', () => {
  it('appends user then assistant events by session_id', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    logStop({ store: s, sessionId: 'S1', userText: 'do X', assistantText: 'done X' });
    const log = s.events.getSessionLog('S1');
    expect(log.map(e => [e.seq, e.role, e.content])).toEqual([
      [1, 'user', 'do X'],
      [2, 'assistant', 'done X'],
    ]);
    s.close();
  });

  it('skips when either side is empty', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    logStop({ store: s, sessionId: 'S1', userText: '', assistantText: 'x' });
    logStop({ store: s, sessionId: 'S1', userText: 'x', assistantText: '   ' });
    expect(s.events.maxSeq('S1')).toBe(0);
    s.close();
  });

  it('never throws for a session with no binding (attribution is derived later)', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    expect(() => logStop({ store: s, sessionId: 'S-unbound', userText: 'a', assistantText: 'b' })).not.toThrow();
    expect(s.events.maxSeq('S-unbound')).toBe(2);
    s.close();
  });
});
