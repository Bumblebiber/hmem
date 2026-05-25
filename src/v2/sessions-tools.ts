import type { V2Store } from './store-facade.js';
import { resolveSessionId } from './session-id.js';

export interface ActivateOpts { since?: number; }
export interface ActivateResult { session_id: string; project: string; project_uid: string; }

export function activate(store: V2Store, projectLabel: string, opts: ActivateOpts = {}): ActivateResult {
  const uid = store.entries.labelToUid(projectLabel.split('.')[0]);
  const entry = uid ? store.entries.getEntry(uid) : null;
  if (!entry || entry.prefix !== 'P') throw new Error(`activate: ${projectLabel} is not a project`);

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

export function getSessionLog(store: V2Store, sessionId: string): string {
  const events = store.events.getSessionLog(sessionId);
  if (!events.length) return `‹no events for session ${sessionId}›`;
  return events.map(e => `#${e.seq} [${e.ts}] ${e.role}: ${e.content}`).join('\n');
}
