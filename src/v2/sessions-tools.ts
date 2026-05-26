import type { V2Store } from './store-facade.js';
import { resolveSessionId } from './session-id.js';

export interface ActivateOpts { since?: number; }
export interface ActivateResult { session_id: string; project: string; project_uid: string; }

export function activate(store: V2Store, projectLabel: string, opts: ActivateOpts = {}): ActivateResult {
  const uid = store.entries.labelToUid(projectLabel.split('.')[0]);
  const entry = uid ? store.entries.getEntry(uid) : null;
  // Include `!uid` so TS narrows uid to string below (avoids non-null assertions).
  if (!uid || !entry || entry.prefix !== 'P') throw new Error(`activate: ${projectLabel} is not a project`);

  let sessionId = resolveSessionId();
  if (!sessionId || !store.sessions.getSession(sessionId)) {
    const created = sessionId
      ? store.sessions.createSession({ session_id: sessionId })
      : store.sessions.createSession({});
    sessionId = created.session_id;
  }
  store.sessions.bind(sessionId, uid, opts.since);
  return { session_id: sessionId, project: entry.label, project_uid: uid };
}

export function getSessionLog(store: V2Store, sessionId: string, limit?: number): string {
  let events = store.events.getSessionLog(sessionId);
  if (!events.length) return `‹no events for session ${sessionId}›`;
  let truncated = 0;
  if (limit && limit > 0 && events.length > limit) {
    truncated = events.length - limit;
    events = events.slice(-limit); // most recent `limit` events
  }
  const body = events.map(e => `#${e.seq} [${e.ts}] ${e.role}: ${e.content}`).join('\n');
  return truncated > 0 ? `‹${truncated} earlier events truncated›\n${body}` : body;
}
