// test/hooks/transcript.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastUserMessage, readLastAssistantMessage, isSubagentTranscript } from '../../src/hooks/transcript.js';

let dir: string;
let tx: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmem-tx-'));
  tx = path.join(dir, 't.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'first question' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } }),
    JSON.stringify({ type: 'user', toolUseResult: { x: 1 }, message: { role: 'user', content: 'TOOL RESULT — ignore' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } }),
  ];
  fs.writeFileSync(tx, lines.join('\n') + '\n');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('transcript parsing', () => {
  it('reads the last real user message (skipping tool-result entries)', () => {
    expect(readLastUserMessage(tx)).toBe('second question');
  });
  it('reads the last assistant text message', () => {
    expect(readLastAssistantMessage(tx)).toBe('second answer');
  });
  it('returns null for a missing file', () => {
    expect(readLastUserMessage(path.join(dir, 'nope.jsonl'))).toBeNull();
  });
  it('flags subagent transcripts by /tasks/ path', () => {
    expect(isSubagentTranscript('/tmp/claude-xyz/tasks/abc/transcript.jsonl')).toBe(true);
    expect(isSubagentTranscript(tx)).toBe(false);
    expect(isSubagentTranscript(undefined)).toBe(false);
  });
});
