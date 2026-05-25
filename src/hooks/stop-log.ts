// src/hooks/stop-log.ts
import type { StopContext } from './types.js';

/** Append the latest exchange to the immutable events log. Attribution is derived
 *  from session_bindings later — Stop writes no project, no active flag (Goal #2). */
export function logStop(ctx: StopContext): void {
  const user = ctx.userText?.trim();
  const asst = ctx.assistantText?.trim();
  if (!user || !asst) return;

  ctx.store.events.appendEvent({ session_id: ctx.sessionId, role: 'user', content: ctx.userText });
  ctx.store.events.appendEvent({ session_id: ctx.sessionId, role: 'assistant', content: ctx.assistantText });
  void ctx.store.summarizer.maybeCheckpoint(ctx.sessionId);
}
