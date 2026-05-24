-- hmem v2 schema (LOCKED — see docs/superpowers/plans/2026-05-24-v2-rewrite.md §1)
-- ── Identity: ULID is PK + sync unit; label is mutable display; refs by ULID ──
CREATE TABLE entries (
  uid           TEXT PRIMARY KEY,     -- ULID, immutable, never rewritten
  label         TEXT NOT NULL,        -- 'P0048' — mutable display only
  prefix        TEXT NOT NULL,        -- 'P','L','E','D','H','I','R','T','N','C',...
  seq           INTEGER NOT NULL,     -- per-prefix label counter (display only)
  level_1       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,        -- LWW key for sync
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  obsolete      INTEGER NOT NULL DEFAULT 0,
  favorite      INTEGER NOT NULL DEFAULT 0,
  irrelevant    INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT                  -- soft-delete (sync tombstone)
  -- NOTE: NO `active` column. "Active project" is per-session = the open
  -- binding segment (see session_bindings). Goal #2: no global mutable state.
);
CREATE UNIQUE INDEX idx_entries_label ON entries(label) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_prefix ON entries(prefix);

CREATE TABLE nodes (
  uid        TEXT PRIMARY KEY,        -- ULID
  root_uid   TEXT NOT NULL,           -- → entries.uid
  parent_uid TEXT,                    -- NULL = direct child of root; else nodes.uid
  depth      INTEGER NOT NULL,        -- 2..N (no hard cap; default render to 3)
  seq        INTEGER NOT NULL,        -- sibling order (1-based)
  content    TEXT NOT NULL,
  tags       TEXT,                    -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_nodes_root ON nodes(root_uid);
CREATE INDEX idx_nodes_parent ON nodes(parent_uid);

-- Links by ULID — replaces both the JSON `links` column AND in-prose refs.
CREATE TABLE links (
  src_uid TEXT NOT NULL,              -- entries.uid or nodes.uid
  dst_uid TEXT NOT NULL,
  kind    TEXT,                       -- optional relation type
  PRIMARY KEY (src_uid, dst_uid)
);

-- Sessions: first-class records, NOT tree nodes.
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,  -- ULID, hook-deterministic per session
  device_id        TEXT,              -- → entries.uid of the I-entry
  harness          TEXT,              -- 'claude-code'|'hermes'|'pi'
  summary          TEXT,              -- one-line rolling state (cheap "Recent Sessions")
  summary_node_uid TEXT,              -- → nodes.uid in bound project's subtree
  started_at       TEXT NOT NULL,
  last_active_at   TEXT,
  ended_at         TEXT,
  updated_at       TEXT NOT NULL
);

-- Ordered binding segments → project attribution. A session may belong to
-- several projects across its lifetime; a project to several segments.
CREATE TABLE session_bindings (
  session_id  TEXT NOT NULL,          -- → sessions.session_id
  project_uid TEXT NOT NULL,          -- → entries.uid (stable ULID, never the label)
  from_seq    INTEGER NOT NULL,
  to_seq      INTEGER,                -- NULL = open segment (= "current project")
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, from_seq)
);

-- Raw exchanges: append-only, IMMUTABLE. Never updated, never LWW.
CREATE TABLE events (
  event_uid  TEXT PRIMARY KEY,        -- ULID
  session_id TEXT NOT NULL,           -- → sessions.session_id
  seq        INTEGER NOT NULL,        -- per-session monotonic
  ts         TEXT NOT NULL,
  role       TEXT NOT NULL,           -- 'user'|'assistant'
  content    TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_events_session ON events(session_id, seq);

-- Migration redirect: old O-id prose refs → new location (render-time resolution).
CREATE TABLE o_redirects (
  old_id     TEXT PRIMARY KEY,        -- 'O0048.39.2'
  session_id TEXT,
  from_seq   INTEGER,
  to_seq     INTEGER
);

CREATE TABLE schema_version (         -- holds schema_major='2' + applied migration markers
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- FTS5 over curated text. Events get their own optional index in Phase 2
-- (volume decision — see Phase 2 acceptance).
-- CONTENTLESS (L0095): the index stores no copy of the text — entries/nodes are
-- the single source of truth. `contentless_delete=1` (SQLite ≥3.43) lets us DELETE
-- index rows with a plain `DELETE FROM fts WHERE rowid=…` (the old `content=''`
-- 'delete' command is rejected by contentless_delete tables). This realizes the
-- "L0095 pattern, as in v1" intent noted in the locked §1 DDL — the §1 sketch
-- omitted the storage flags; they belong here. (Phase 1 decision, 2026-05-24.)
CREATE VIRTUAL TABLE fts USING fts5(level_1, node_content, content='', contentless_delete=1, tokenize='unicode61');

-- rowid→uid map (L0095 contentless pattern): FTS5 owns only an integer rowid,
-- so we map each indexed row back to its source entry/node uid.
CREATE TABLE fts_rowid_map (
  fts_rowid INTEGER PRIMARY KEY,
  root_uid  TEXT NOT NULL,             -- → entries.uid
  node_uid  TEXT                       -- → nodes.uid, NULL for the entry's own level_1
);
CREATE INDEX idx_fts_rm_root ON fts_rowid_map(root_uid);
CREATE INDEX idx_fts_rm_node ON fts_rowid_map(node_uid);

-- Triggers keep the index in sync. Soft-delete is a column update (deleted_at),
-- NOT a row DELETE, so soft-deleted rows stay indexed and fts.ts filters them at
-- query time. Hard DELETE (tests / future GC) is handled by the *_bd triggers.
CREATE TRIGGER fts_entry_ai AFTER INSERT ON entries BEGIN
  INSERT INTO fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
  INSERT INTO fts_rowid_map(fts_rowid, root_uid, node_uid) VALUES (last_insert_rowid(), new.uid, NULL);
END;
CREATE TRIGGER fts_node_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO fts(level_1, node_content) VALUES ('', coalesce(new.content, ''));
  INSERT INTO fts_rowid_map(fts_rowid, root_uid, node_uid) VALUES (last_insert_rowid(), new.root_uid, new.uid);
END;
CREATE TRIGGER fts_entry_au AFTER UPDATE OF level_1 ON entries BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE root_uid = old.uid AND node_uid IS NULL);
  INSERT INTO fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
  UPDATE fts_rowid_map SET fts_rowid = last_insert_rowid() WHERE root_uid = new.uid AND node_uid IS NULL;
END;
CREATE TRIGGER fts_node_au AFTER UPDATE OF content ON nodes BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE node_uid = old.uid);
  INSERT INTO fts(level_1, node_content) VALUES ('', coalesce(new.content, ''));
  UPDATE fts_rowid_map SET fts_rowid = last_insert_rowid() WHERE node_uid = new.uid;
END;
CREATE TRIGGER fts_entry_bd BEFORE DELETE ON entries BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE root_uid = old.uid AND node_uid IS NULL);
  DELETE FROM fts_rowid_map WHERE root_uid = old.uid;
END;
CREATE TRIGGER fts_node_bd BEFORE DELETE ON nodes BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE node_uid = old.uid);
  DELETE FROM fts_rowid_map WHERE node_uid = old.uid;
END;
