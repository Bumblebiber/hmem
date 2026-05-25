// test/hooks/cli-dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { resolveHookRunner } from '../../src/hooks/dispatch.js';

describe('hook command dispatch', () => {
  it('maps each hook command + harness to a runner', () => {
    expect(typeof resolveHookRunner('hook-session-start', 'claude-code')).toBe('function');
    expect(typeof resolveHookRunner('hook-stop', 'hermes')).toBe('function');
    expect(typeof resolveHookRunner('hook-prompt-submit', 'pi')).toBe('function');
  });
  it('returns undefined for an unknown command', () => {
    expect(resolveHookRunner('nope', 'claude-code')).toBeUndefined();
  });
});
