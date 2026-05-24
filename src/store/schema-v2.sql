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
CREATE VIRTUAL TABLE fts USING fts5(level_1, node_content, tokenize='unicode61');
-- + rowid→uid map table, as in v1 (L0095 pattern) — added in Phase 1 fts.ts.
