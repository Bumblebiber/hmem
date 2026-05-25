// test/hooks/prompt-submit.test.ts
import { describe, it, expect } from 'vitest';
import { createV2Store } from '../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';
import { buildPromptSubmit } from '../../src/hooks/prompt-submit.js';

describe('buildPromptSubmit', () => {
  it('returns only a sync-status line', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    const { context } = buildPromptSubmit({ store: s, sessionId: 'S1', syncProbe: () => '🟢 hmem-sync verbunden.' });
    expect(context).toBe('🟢 hmem-sync verbunden.');
    s.close();
  });

  it('is lightweight: does not include a project brief or H-entries', () => {
    const s = createV2Store(':memory:', DEFAULT_CONFIG);
    s.entries.createEntry({ prefix: 'H', level_1: 'Identität' });
    const { context } = buildPromptSubmit({ store: s, sessionId: 'S1', syncProbe: () => 'X' });
    expect(context).not.toContain('Identität');
    expect(context).not.toContain('Recent projects');
    s.close();
  });
});
