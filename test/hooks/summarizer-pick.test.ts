// test/hooks/summarizer-pick.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { pickSummarizer } from '../../src/hooks/summarizer-pick.js';
import { fallbackSummarize } from '../../src/v2/summarize-adapter.js';
import { DEFAULT_CONFIG } from '../../src/hmem-config.js';

const KEY = 'ANTHROPIC_API_KEY';
describe('pickSummarizer', () => {
  const old = process.env[KEY];
  afterEach(() => { if (old === undefined) delete process.env[KEY]; else process.env[KEY] = old; });

  it('defaults to the deterministic fallback (checkpointMode=remind)', () => {
    process.env[KEY] = 'sk-test';
    expect(pickSummarizer(DEFAULT_CONFIG)).toBe(fallbackSummarize);
  });
  it('uses the real adapter only when mode=auto + provider=anthropic + key present', () => {
    process.env[KEY] = 'sk-test';
    const fn = pickSummarizer({ ...DEFAULT_CONFIG, checkpointMode: 'auto' });
    expect(fn).not.toBe(fallbackSummarize);
    expect(typeof fn).toBe('function');
  });
  it('falls back when mode=auto but no key', () => {
    delete process.env[KEY];
    expect(pickSummarizer({ ...DEFAULT_CONFIG, checkpointMode: 'auto' })).toBe(fallbackSummarize);
  });
});
