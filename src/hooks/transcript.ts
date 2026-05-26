// src/hooks/transcript.ts
import fs from 'node:fs';

const TAIL_BYTES = 5 * 1024 * 1024; // tail only — large tool outputs push messages far back

function readTail(transcriptPath: string): string[] | null {
  if (!fs.existsSync(transcriptPath)) return null;
  const stat = fs.statSync(transcriptPath);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const content = buf.toString('utf8');
  // If we started mid-file, drop the first (likely partial) line.
  return (start > 0 ? content.substring(content.indexOf('\n') + 1) : content).split('\n');
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    return t || null;
  }
  return null;
}

/** Last real user message (not a tool result / compact summary / transcript-only note). */
export function readLastUserMessage(transcriptPath: string): string | null {
  const lines = readTail(transcriptPath);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'user' && e.message?.role === 'user' && !e.toolUseResult && !e.isCompactSummary && !e.isVisibleInTranscriptOnly) {
        const t = textOf(e.message.content);
        if (t) return t;
      }
    } catch { /* skip non-JSON line */ }
  }
  return null;
}

/** Last assistant text message (fallback when the harness omits last_assistant_message). */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  const lines = readTail(transcriptPath);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'assistant' && e.message?.role === 'assistant') {
        const t = textOf(e.message.content);
        if (t) return t;
      }
    } catch { /* skip */ }
  }
  return null;
}

/** Subagent (Task tool) transcripts live under a /tasks/ dir and must NOT be logged as user exchanges. */
export function isSubagentTranscript(transcriptPath: string | undefined): boolean {
  return !!transcriptPath && transcriptPath.includes('/tasks/');
}
