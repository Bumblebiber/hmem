// src/hooks/brief.ts
import type { V2Store } from '../v2/store-facade.js';
import type { EntryRow } from '../store/types.js';
import { loadProject } from '../v2/projects.js';

/** T-entries linked from the project, not obsolete/deleted. */
function openTasks(store: V2Store, projectUid: string): { label: string; level_1: string }[] {
  const links = store.links.getLinks(projectUid);
  const out: { label: string; level_1: string }[] = [];
  for (const l of links) {
    const e = store.entries.getEntry(l.dst_uid) as EntryRow | null;
    if (e && e.prefix === 'T' && !e.obsolete && !e.deleted_at) {
      out.push({ label: e.label, level_1: e.level_1.split('\n')[0] });
    }
  }
  return out;
}

export function buildProjectBrief(store: V2Store, projectLabel: string): string {
  const uid = store.entries.labelToUid(projectLabel.split('.')[0]);
  const entry = uid ? store.entries.getEntry(uid) : null;
  if (!uid || !entry || entry.prefix !== 'P') return `‹${projectLabel} not found›`;

  const { text } = loadProject(store, entry.label, { why: false });
  const tasks = openTasks(store, uid);
  const taskBlock = tasks.length
    ? '\n\n📌 Offene Tasks (verknüpft):\n' + tasks.map(t => `  ${t.label}: ${t.level_1}`).join('\n')
    : '\n\n📌 Offene Tasks (verknüpft):\n  (keine)';
  return text + taskBlock;
}
