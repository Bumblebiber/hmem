// test/hooks/harness-hermes.test.ts
import { describe, it, expect } from 'vitest';
import { parseHermesSessionStartStdin, formatHermesOutput } from '../../src/hooks/harness/hermes.js';

describe('hermes shim parse/format', () => {
  it('parses Hermes stdin into a HookContext with harness=hermes', () => {
    const ctx = parseHermesSessionStartStdin(JSON.stringify({ session_id: 'h1', cwd: '/proj' }));
    expect(ctx).toMatchObject({ harness: 'hermes', sessionId: 'h1', cwd: '/proj' });
  });
  it('formats output as {context}', () => {
    expect(JSON.parse(formatHermesOutput('BRIEF'))).toEqual({ context: 'BRIEF' });
  });
  it('returns safe defaults and does not throw on malformed stdin', () => {
    expect(() => parseHermesSessionStartStdin('garbage{{{')).not.toThrow();
    expect(parseHermesSessionStartStdin('garbage{{{')).toMatchObject({ harness: 'hermes', sessionId: '' });
  });
});
