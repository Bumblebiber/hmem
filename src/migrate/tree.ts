import Database from 'better-sqlite3';
import { newUlid } from '../store/ulid.js';
import { allRoots, nodesForRoot, tagsFor, V1Root, V1Node } from './v1-reader.js';

const SKIP_PREFIXES = new Set(['O', 'F']);          // O -> Half B; F -> tombstones (Task 3 / drop)

export function mergeNodeText(title: string | null, content: string | null): string {
  const t = (title ?? '').trim();
  const c = (content ?? '').trim();
  if (!c) return t;
  if (!t) return c;
  if (c === t || c.startsWith(t)) return c;
  return `${t}\n\n${c}`;
}

export interface MigrateMaps {
  labelToUid: Map<string, string>;   // 'P0001' -> entry uid
  nodeIdToUid: Map<string, string>;  // 'P0001.1.2' -> node uid
}

export function migrateTree(v1: Database.Database, v2: Database.Database): MigrateMaps {
  const labelToUid = new Map<string, string>();
  const nodeIdToUid = new Map<string, string>();

  const insEntry = v2.prepare(`INSERT INTO entries
    (uid,label,prefix,seq,level_1,created_at,updated_at,access_count,last_accessed,
     obsolete,favorite,irrelevant,pinned,tags)
    VALUES (@uid,@label,@prefix,@seq,@level_1,@created_at,@updated_at,@access_count,@last_accessed,
            @obsolete,@favorite,@irrelevant,@pinned,@tags)`);
  const insNode = v2.prepare(`INSERT INTO nodes
    (uid,root_uid,parent_uid,depth,seq,content,tags,created_at,updated_at,deleted_at)
    VALUES (@uid,@root_uid,@parent_uid,@depth,@seq,@content,@tags,@created_at,@updated_at,@deleted_at)`);

  for (const r of allRoots(v1)) {
    if (SKIP_PREFIXES.has(r.prefix)) continue;            // O -> Half B, F -> tombstone
    const uid = newUlid();
    labelToUid.set(r.id, uid);
    const tags = tagsFor(v1, r.id);
    insEntry.run({
      uid, label: r.id, prefix: r.prefix, seq: r.seq,
      level_1: r.level_1 || r.title || '',
      created_at: r.created_at, updated_at: r.updated_at ?? r.created_at,
      access_count: r.access_count, last_accessed: r.last_accessed,
      obsolete: r.obsolete, favorite: r.favorite, irrelevant: r.irrelevant, pinned: r.pinned,
      tags: tags.length ? JSON.stringify(tags) : null,
    });

    // Pass 1: assign uids to every node (so parent lookups resolve regardless of order).
    const nodes = nodesForRoot(v1, r.id);
    for (const n of nodes) nodeIdToUid.set(n.id, newUlid());
    // Pass 2: insert.
    for (const n of nodes) {
      const ntags = tagsFor(v1, n.id);
      const hidden = (n.obsolete || n.irrelevant) ? (n.updated_at ?? n.created_at) : null;
      insNode.run({
        uid: nodeIdToUid.get(n.id),
        root_uid: uid,
        parent_uid: n.depth <= 2 ? null : (nodeIdToUid.get(n.parent_id ?? '') ?? null),
        depth: n.depth, seq: n.seq,
        content: mergeNodeText(n.title, n.content),
        tags: ntags.length ? JSON.stringify(ntags) : null,
        created_at: n.created_at, updated_at: n.updated_at ?? n.created_at,
        deleted_at: hidden,
      });
    }
  }
  return { labelToUid, nodeIdToUid };
}

