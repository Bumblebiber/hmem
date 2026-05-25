import Database from 'better-sqlite3';

/** Build a synthetic v1 store covering every migrator branch. */
export function makeV1Fixture(path = ':memory:'): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, prefix TEXT, seq INTEGER, created_at TEXT,
      level_1 TEXT, level_2 TEXT, level_3 TEXT, level_4 TEXT, level_5 TEXT,
      links TEXT, min_role TEXT DEFAULT 'worker',
      obsolete INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0,
      irrelevant INTEGER DEFAULT 0, active INTEGER DEFAULT 0,
      secret INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
      top_secret INTEGER DEFAULT 0, updated_at TEXT, title TEXT,
      access_count INTEGER DEFAULT 0, last_accessed TEXT, synced_at TEXT);
    CREATE TABLE memory_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL,
      depth INTEGER, seq INTEGER, content TEXT, created_at TEXT,
      favorite INTEGER DEFAULT 0, obsolete INTEGER DEFAULT 0,
      irrelevant INTEGER DEFAULT 0, secret INTEGER DEFAULT 0, links TEXT,
      top_secret INTEGER DEFAULT 0, updated_at TEXT, title TEXT,
      access_count INTEGER DEFAULT 0, last_accessed TEXT);
    CREATE TABLE memory_tags (entry_id TEXT NOT NULL, tag TEXT NOT NULL);
  `);

  const root = db.prepare(`INSERT INTO memories
    (id,prefix,seq,created_at,level_1,links,obsolete,favorite,irrelevant,pinned,updated_at,title,access_count,last_accessed)
    VALUES (@id,@prefix,@seq,@created_at,@level_1,@links,@obsolete,@favorite,@irrelevant,@pinned,@updated_at,@title,@access_count,@last_accessed)`);
  const node = db.prepare(`INSERT INTO memory_nodes
    (id,parent_id,root_id,depth,seq,content,created_at,favorite,obsolete,irrelevant,links,updated_at,title,access_count)
    VALUES (@id,@parent_id,@root_id,@depth,@seq,@content,@created_at,@favorite,@obsolete,@irrelevant,@links,@updated_at,@title,@access_count)`);
  const tag = db.prepare(`INSERT INTO memory_tags (entry_id,tag) VALUES (?,?)`);
  const R = (o: Partial<any>) => root.run({
    seq: 1, level_1: '', links: null, obsolete: 0, favorite: 0, irrelevant: 0,
    pinned: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    title: null, access_count: 0, last_accessed: null, ...o });
  const N = (o: Partial<any>) => node.run({
    parent_id: null, depth: 2, seq: 1, content: '', favorite: 0, obsolete: 0,
    irrelevant: 0, links: null, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z', title: null, access_count: 0, ...o });

  // --- non-O entries ---
  R({ id: 'P0001', prefix: 'P', level_1: 'Demo Project', access_count: 7, favorite: 1 });
  N({ id: 'P0001.1', parent_id: 'P0001', root_id: 'P0001', depth: 2, seq: 1,
      title: 'Overview', content: 'Wiki at ~/vault — see D0001' });               // heading + body
  N({ id: 'P0001.1.1', parent_id: 'P0001.1', root_id: 'P0001', depth: 3, seq: 1,
      title: 'Wiki at ~/vault — see', content: 'Wiki at ~/vault — see D0001 fully' }); // truncation-title
  R({ id: 'D0001', prefix: 'D', level_1: 'A decision', links: '["P0001"]' });       // resolvable link
  R({ id: 'L0001', prefix: 'L', level_1: 'A lesson', links: '["O0001.1.1"]' });     // link into an O subtree
  R({ id: 'E0001', prefix: 'E', level_1: 'A bug', links: '["Z9999"]' });            // dangling link
  R({ id: 'D0003', prefix: 'D', level_1: 'links to a sub-node', links: '["P0001.1"]' });  // node-target link
  R({ id: 'F0001', prefix: 'F', level_1: 'Migriert nach L0001' });                  // tombstone -> drop
  tag.run('P0001', '#demo'); tag.run('P0001', '#hmem');                             // entry tags
  tag.run('P0001.1', '#section');                                                   // node tag

  // --- O0001: normal project-bound O-root, one chunk, two exchanges ---
  R({ id: 'O0001', prefix: 'O', seq: 1, level_1: 'O-entry', links: '["P0001"]' });
  N({ id: 'O0001.1', parent_id: 'O0001', root_id: 'O0001', depth: 2, seq: 1,
      title: 'Session A', content: 'Rolling summary: did X and Y',
      created_at: '2026-03-01T10:00:00Z' });
  // exchange 1
  N({ id: 'O0001.1.1', parent_id: 'O0001.1', root_id: 'O0001', depth: 3, seq: 1,
      title: 'exchange', content: 'exchange summary' });
  N({ id: 'O0001.1.1.1', parent_id: 'O0001.1.1', root_id: 'O0001', depth: 4, seq: 1,
      title: 'u', content: 'user msg 1', created_at: '2026-03-01T10:00:00Z' });
  N({ id: 'O0001.1.1.2', parent_id: 'O0001.1.1', root_id: 'O0001', depth: 4, seq: 2,
      title: 'a', content: 'assistant msg 1', created_at: '2026-03-01T10:01:00Z' });

  // --- O0000: unattributed bucket; one real chunk + the .66 garbage chunk ---
  R({ id: 'O0000', prefix: 'O', seq: 0, level_1: 'Category header' });
  N({ id: 'O0000.1', parent_id: 'O0000', root_id: 'O0000', depth: 2, seq: 1,
      title: 'Orphan session', content: 'unattributed work' });
  N({ id: 'O0000.1.1', parent_id: 'O0000.1', root_id: 'O0000', depth: 3, seq: 1,
      title: 'o', content: 'orphan user msg', created_at: '2026-03-02T09:00:00Z' });
  N({ id: 'O0000.66', parent_id: 'O0000', root_id: 'O0000', depth: 2, seq: 66,
      title: 'hi', content: 'hello' });
  N({ id: 'O0000.66.1', parent_id: 'O0000.66', root_id: 'O0000', depth: 3, seq: 1,
      title: 'x', content: 'x'.repeat(100) });

  // --- O90001: collision twin -> dropped entirely ---
  R({ id: 'O90001', prefix: 'O', seq: 90001, level_1: 'twin', links: '["P0001"]' });
  N({ id: 'O90001.1', parent_id: 'O90001', root_id: 'O90001', depth: 2, seq: 1,
      title: 'twin session', content: 'dup' });

  // --- O0002: empty O-root ---
  R({ id: 'O0002', prefix: 'O', seq: 2, level_1: 'Empty O', links: '["P0001"]' });

  // --- a non-O body that references an O-id in prose (o_redirects workload) ---
  R({ id: 'D0002', prefix: 'D', level_1: 'refers to O0001.1.1 in prose' });

  return db;
}
