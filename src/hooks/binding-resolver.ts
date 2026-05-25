// src/hooks/binding-resolver.ts
import type { V2Store } from '../v2/store-facade.js';
import type { BindingResult, Harness } from './types.js';

/** Most recently bound project among sessions sharing this workspace cwd. */
export function lastProjectForWorkspace(store: V2Store, cwd: string): string | null {
  const row = store.db.prepare(
    `SELECT b.project_uid AS uid
       FROM session_bindings b JOIN sessions s ON s.session_id = b.session_id
      WHERE s.cwd = ?
      ORDER BY b.created_at DESC
      LIMIT 1`,
  ).get(cwd) as { uid: string } | undefined;
  return row?.uid ?? null;
}

export interface ResolveBindingInput {
  store: V2Store;
  sessionId: string;
  harness: Harness;
  cwd?: string;
  namedProject?: string;
  deviceId?: string;
}

export function resolveBinding(input: ResolveBindingInput): BindingResult {
  const { store, sessionId, harness, cwd, namedProject, deviceId } = input;

  // 1. Idempotent session + cwd + touch.
  store.sessions.createSession({ session_id: sessionId, harness, device_id: deviceId });
  if (cwd) store.db.prepare('UPDATE sessions SET cwd=? WHERE session_id=?').run(cwd, sessionId);
  store.sessions.touchSession(sessionId);

  const label = (uid: string) => store.entries.uidToLabel(uid);

  // 2. Resume: keep an existing open binding.
  const open = store.sessions.currentProject(sessionId);
  if (open) return { sessionId, projectUid: open, projectLabel: label(open), source: 'resume' };

  // 3. Named project.
  if (namedProject) {
    const uid = store.entries.labelToUid(namedProject.split('.')[0]);
    const entry = uid ? store.entries.getEntry(uid) : null;
    if (uid && entry?.prefix === 'P') {
      store.sessions.bind(sessionId, uid);
      return { sessionId, projectUid: uid, projectLabel: entry.label, source: 'named' };
    }
  }

  // 4. Workspace (cwd) last-active.
  if (cwd) {
    const uid = lastProjectForWorkspace(store, cwd);
    if (uid) {
      store.sessions.bind(sessionId, uid);
      return { sessionId, projectUid: uid, projectLabel: label(uid), source: 'workspace' };
    }
  }

  // 5. None — user redirects later via activate().
  return { sessionId, projectUid: null, projectLabel: null, source: 'none' };
}
