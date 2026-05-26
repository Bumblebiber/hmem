import Database from 'better-sqlite3';

export interface V1Root {
  id: string; prefix: string; seq: number; created_at: string;
  level_1: string; title: string | null; links: string | null;
  obsolete: number; favorite: number; irrelevant: number; pinned: number;
  updated_at: string | null; access_count: number; last_accessed: string | null;
}

export interface V1Node {
  id: string; parent_id: string | null; root_id: string;
  depth: number; seq: number; content: string | null; title: string | null;
  created_at: string; updated_at: string | null;
  obsolete: number; irrelevant: number; links: string | null;
  access_count: number; last_accessed: string | null;
}

export function openV1(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

export function allRoots(db: Database.Database): V1Root[] {
  return db.prepare(`
    SELECT id, prefix, seq, created_at, level_1, title, links,
           obsolete, favorite, irrelevant, pinned, updated_at,
           access_count, last_accessed
    FROM memories ORDER BY id`).all() as V1Root[];
}

export function nodesForRoot(db: Database.Database, rootId: string): V1Node[] {
  return db.prepare(`
    SELECT id, parent_id, root_id, depth, seq, content, title,
           created_at, updated_at, obsolete, irrelevant, links,
           access_count, last_accessed
    FROM memory_nodes WHERE root_id = ? ORDER BY depth, seq`).all(rootId) as V1Node[];
}

export function tagsFor(db: Database.Database, entryId: string): string[] {
  return (db.prepare(`SELECT tag FROM memory_tags WHERE entry_id = ?`)
    .all(entryId) as { tag: string }[]).map(r => r.tag);
}

export function parseLinks(text: string | null): string[] {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
