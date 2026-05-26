// src/hooks/harness/pi.ts
import type { HookContext } from '../types.js';

interface PiStdin { session_id?: string; cwd?: string; project?: string; last_assistant_message?: string; transcript_path?: string; }

function safeParse(raw: string): PiStdin {
  try { return JSON.parse(raw || '{}') as PiStdin; } catch { return {}; }
}

// Pi uses the same generic {context} contract as Hermes (Goal #8: one impl, one shape).
export function parsePiSessionStartStdin(raw: string): HookContext {
  const j = safeParse(raw);
  return { harness: 'pi', sessionId: j.session_id ?? '', cwd: j.cwd, namedProject: j.project };
}
export function parsePiStopStdin(raw: string): HookContext {
  const j = safeParse(raw);
  return { harness: 'pi', sessionId: j.session_id ?? '', transcriptPath: j.transcript_path, lastAssistantMessage: j.last_assistant_message };
}
export function formatPiOutput(context: string): string {
  return JSON.stringify({ context });
}
