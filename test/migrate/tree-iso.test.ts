import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';
import { migrateTree } from '../../src/migrate/tree.js';

describe('migrateTree timestamp normalization (§3.4 root fix)', () => {
  it('writes ISO 8601 created_at/updated_at for entries and nodes from non-ISO v1 input', () => {
    const v1 = new Database(':memory:');
    v1.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, prefix TEXT, seq INTEGER, created_at TEXT,
        level_1 TEXT, level_2 TEXT, level_3 TEXT, level_4 TEXT, level_5 TEXT, links TEXT,
        min_role TEXT, obsolete INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0,
        irrelevant INTEGER DEFAULT 0, active INTEGER DEFAULT 0, secret INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0, top_secret INTEGER DEFAULT 0, updated_at TEXT, title TEXT,
        access_count INTEGER DEFAULT 0, last_accessed TEXT, synced_at TEXT);
      CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
        depth INTEGER, seq INTEGER, content TEXT, created_at TEXT, favorite INTEGER DEFAULT 0,
        obsolete INTEGER DEFAULT 0, irrelevant INTEGER DEFAULT 0, secret INTEGER DEFAULT 0,
        links TEXT, top_secret INTEGER DEFAULT 0, updated_at TEXT, title TEXT,
        access_count INTEGER DEFAULT 0, last_accessed TEXT);
      CREATE TABLE memory_tags (entry_id TEXT NOT NULL, tag TEXT NOT NULL);`);
    // Space-format (non-ISO) timestamps — exactly what the live v1 DB carries and what the
    // server rejects with 400 Invalid datetime.
    v1.prepare(`INSERT INTO memories (id,prefix,seq,created_at,level_1,updated_at)
                VALUES ('P0001','P',1,'2026-05-01 12:00:00','Demo','2026-05-02 13:00:00')`).run();
    v1.prepare(`INSERT INTO memory_nodes (id,parent_id,root_id,depth,seq,content,created_at,updated_at)
                VALUES ('P0001.1',NULL,'P0001',2,1,'body','2026-05-01 12:00:00','2026-05-03 14:00:00')`).run();

    const v2 = openDb(':memory:');
    migrateTree(v1, v2);

    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    const entry = v2.prepare(`SELECT created_at, updated_at FROM entries WHERE label='P0001'`).get() as { created_at: string; updated_at: string };
    const node = v2.prepare(`SELECT created_at, updated_at FROM nodes`).get() as { created_at: string; updated_at: string };
    expect(entry.created_at).toMatch(iso);
    expect(entry.updated_at).toMatch(iso);
    expect(entry.updated_at).toBe('2026-05-02T13:00:00Z');
    expect(node.created_at).toMatch(iso);
    expect(node.updated_at).toMatch(iso);
    expect(node.updated_at).toBe('2026-05-03T14:00:00Z');
    v1.close(); v2.close();
  });
});
