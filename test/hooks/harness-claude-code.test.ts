// test/hooks/harness-claude-code.test.ts
import { describe, it, expect } from 'vitest';
import { parseSessionStartStdin, parseStopStdin, formatSessionStartOutput } from '../../src/hooks/harness/claude-code.js';

describe('claude-code shim parse/format', () => {
  it('parses SessionStart stdin into a HookContext', () => {
    const ctx = parseSessionStartStdin(JSON.stringify({ session_id: 'abc', cwd: '/repo', source: 'startup' }));
    expect(ctx).toMatchObject({ harness: 'claude-code', sessionId: 'abc', cwd: '/repo', source: 'startup' });
  });

  it('parses Stop stdin (session_id, transcript_path, last_assistant_message, stop_hook_active)', () => {
    const ctx = parseStopStdin(JSON.stringify({
      session_id: 'abc', transcript_path: '/t.jsonl', last_assistant_message: 'hi', stop_hook_active: false,
    }));
    expect(ctx).toMatchObject({ harness: 'claude-code', sessionId: 'abc', transcriptPath: '/t.jsonl', lastAssistantMessage: 'hi', stopHookActive: false });
  });

  it('formats SessionStart output as Claude Code additionalContext', () => {
    const out = JSON.parse(formatSessionStartOutput('BRIEF TEXT'));
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe('BRIEF TEXT');
  });
});
