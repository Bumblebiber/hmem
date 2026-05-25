// src/hooks/harness/pi.ts
import type { HookContext } from '../types.js';

interface PiStdin { session_id?: string; cwd?: string; project?: string; last_assistant_message?: string; transcript_path?: string; }

// Pi uses the same generic {context} contract as Hermes (Goal #8: one impl, one shape).
export function parsePiSessionStartStdin(raw: string): HookContext {
  const j: PiStdin = JSON.parse(raw || '{}');
  return { harness: 'pi', sessionId: j.session_id ?? '', cwd: j.cwd, namedProject: j.project };
}
export function parsePiStopStdin(raw: string): HookContext {
  const j: PiStdin = JSON.parse(raw || '{}');
  return { harness: 'pi', sessionId: j.session_id ?? '', transcriptPath: j.transcript_path, lastAssistantMessage: j.last_assistant_message };
}
export function formatPiOutput(context: string): string {
  return JSON.stringify({ context });
}
