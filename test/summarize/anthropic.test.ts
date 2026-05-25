import { describe, it, expect } from 'vitest';
import { makeAnthropicSummarizer } from '../../src/summarize/anthropic.js';

describe('anthropic summarizer adapter', () => {
  it('builds a summarizer fn', () => {
    const fn = makeAnthropicSummarizer({ model: 'claude-haiku-4-5-20251001', apiKey: 'x' });
    expect(typeof fn).toBe('function');
  });

  it('throws a clear error without an api key', () => {
    expect(() => makeAnthropicSummarizer({ model: 'claude-haiku-4-5-20251001', apiKey: '' })).toThrow(
      /api key/i,
    );
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)('produces a non-empty summary live', async () => {
    const fn = makeAnthropicSummarizer({
      model: 'claude-haiku-4-5-20251001',
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
    const out = await fn([
      {
        event_uid: 'e',
        session_id: 'S',
        seq: 1,
        ts: 't',
        role: 'user',
        content: 'We chose SQLite for storage.',
      },
    ]);
    expect(out.length).toBeGreaterThan(0);
  });
});
