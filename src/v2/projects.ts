import type { V2Store } from './store-facade.js';
import type { EntryRow } from '../store/types.js';
import { renderEntryTree, type WhyRow } from './read-render.js';
import { createSchemaEngine } from '../store/schema-engine.js';

export function listProjects(store: V2Store): string {
  const rows = store.db.prepare(
    "SELECT label, level_1 FROM entries WHERE prefix='P' AND deleted_at IS NULL AND obsolete=0 ORDER BY seq"
  ).all() as Pick<EntryRow, 'label' | 'level_1'>[];
  if (!rows.length) return 'No projects yet.';
  return rows.map(r => `${r.label}  ${store.entries.renderRefs(r.level_1).split('\n')[0]}`).join('\n');
}

interface RecentSession { session_id: string; summary: string | null; last_active_at: string | null; }

export interface LoadProjectOpts { why?: boolean; recentLimit?: number; }
export interface LoadProjectResult { text: string; why?: WhyRow[]; }

export function loadProject(store: V2Store, address: string, opts: LoadProjectOpts = {}): LoadProjectResult {
  const uid = store.entries.labelToUid(address.split('.')[0]);
  const entry = uid ? store.entries.getEntry(uid) : null;
  if (!entry || entry.prefix !== 'P') return { text: `‹${address} not found›` };

  const brief = renderEntryTree(store, entry.label, 3);

  const sessions = store.db.prepare(
    `SELECT DISTINCT s.session_id, s.summary, s.last_active_at
       FROM sessions s JOIN session_bindings b ON b.session_id = s.session_id
      WHERE b.project_uid = ?
      ORDER BY s.last_active_at IS NULL, s.last_active_at DESC
      LIMIT ?`
  ).all(uid, opts.recentLimit ?? 5) as RecentSession[];

  const recentBlock = sessions.length
    ? '\n\n--- Recent Sessions ---\n' + sessions.map(s =>
        `  ${s.session_id.slice(0, 8)}  ${s.last_active_at ?? '—'}  ${s.summary ?? '(no summary)'}`).join('\n')
    : '\n\n--- Recent Sessions ---\n  (none)';

  const text = brief + recentBlock;
  if (!opts.why) return { text };
  return { text, why: [{ label: entry.label, shown: 'expanded', reason: 'load_project target (depth 3)' }] };
}

export interface CreateProjectInput {
  name: string;
  tech: string;
  description: string;
  goal?: string;
  audience?: string;
  status?: string;
  repo?: string;
  deployment?: string;
  tags?: string[];
}

export function createProject(store: V2Store, input: CreateProjectInput): { uid: string; label: string } {
  const status = input.status ?? 'Active';
  const base = `${input.name} | ${status} | ${input.tech} | ${input.description}`;
  const level_1 = input.repo ? `${base} | GH: ${input.repo}` : base;
  const { uid, label } = store.entries.createEntry({ prefix: 'P', level_1 });
  if (input.tags?.length) store.db.prepare('UPDATE entries SET tags=? WHERE uid=?').run(JSON.stringify(input.tags), uid);

  const engine = createSchemaEngine(store.config);
  const sections = engine.scaffoldSections('P'); // string[] of section names
  for (const section of sections) {
    store.entries.addNode({ root_uid: uid, content: section });
  }

  if (input.goal) store.entries.addNode({ root_uid: uid, content: `Goal: ${input.goal}` });
  if (input.audience) store.entries.addNode({ root_uid: uid, content: `Audience: ${input.audience}` });
  if (input.deployment) store.entries.addNode({ root_uid: uid, content: `Deployment: ${input.deployment}` });

  return { uid, label };
}

export function readProject(store: V2Store, address: string): string {
  const uid = store.entries.labelToUid(address.split('.')[0]);
  const e = uid ? store.entries.getEntry(uid) : null;
  if (!e || e.prefix !== 'P') return `‹${address} not found›`;
  return renderEntryTree(store, e.label, 3);
}
