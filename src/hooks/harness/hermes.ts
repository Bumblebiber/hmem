// src/hooks/harness/hermes.ts
import type { HookContext } from '../types.js';

interface HermesStdin { session_id?: string; cwd?: string; project?: string; last_assistant_message?: string; transcript_path?: string; }

export function parseHermesSessionStartStdin(raw: string): HookContext {
  const j: HermesStdin = JSON.parse(raw || '{}');
  return { harness: 'hermes', sessionId: j.session_id ?? '', cwd: j.cwd, namedProject: j.project };
}
export function parseHermesStopStdin(raw: string): HookContext {
  const j: HermesStdin = JSON.parse(raw || '{}');
  return { harness: 'hermes', sessionId: j.session_id ?? '', transcriptPath: j.transcript_path, lastAssistantMessage: j.last_assistant_message };
}
export function formatHermesOutput(context: string): string {
  return JSON.stringify({ context });
}
