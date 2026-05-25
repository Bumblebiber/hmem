import { describe, it, expect, afterEach } from 'vitest';
import { resolveSessionId } from '../../src/v2/session-id.js';

describe('resolveSessionId', () => {
  const old = process.env.HMEM_SESSION_ID;
  afterEach(() => { if (old === undefined) delete process.env.HMEM_SESSION_ID; else process.env.HMEM_SESSION_ID = old; });

  it('prefers the HMEM_SESSION_ID env var', () => {
    process.env.HMEM_SESSION_ID = 'sess-env-123';
    expect(resolveSessionId()).toBe('sess-env-123');
  });

  it('returns undefined when no env var and no ppid bridge', () => {
    delete process.env.HMEM_SESSION_ID;
    expect(resolveSessionId()).toBeUndefined();
  });
});
