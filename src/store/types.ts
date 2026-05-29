/** Shared row + result types for the v2 storage core. */

export type Prefix = 'P' | 'L' | 'E' | 'D' | 'H' | 'I' | 'R' | 'T' | 'N' | 'C' | (string & {});

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface EntryRow {
  uid: string;
  label: string;
  prefix: string;
  seq: number;
  level_1: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  obsolete: number;
  favorite: number;
  irrelevant: number;
  pinned: number;
  deleted_at: string | null;
  tags: string | null;
}

export interface NodeRow {
  uid: string;
  root_uid: string;
  parent_uid: string | null;
  depth: number;
  seq: number;
  content: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
  irrelevant: number;
  deleted_at: string | null;
}

export interface LinkRow {
  src_uid: string;
  dst_uid: string;
  kind: string | null;
}

// ── Phase 2: append-only events ──

export interface EventRow {
  event_uid: string;
  session_id: string;
  seq: number;
  ts: string;
  role: 'user' | 'assistant';
  content: string;
}

// ── Phase 2: sessions ──

export interface SessionRow {
  session_id: string;
  device_id: string | null;
  harness: string | null;
  summary: string | null;
  summary_node_uid: string | null;
  started_at: string;
  last_active_at: string | null;
  ended_at: string | null;
  updated_at: string;
}

/** A binding segment closed by `bind` — handed to the `onSegmentClose` hook. */
export interface ClosedSegment {
  session_id: string;
  project_uid: string;
  from_seq: number;
  to_seq: number;
}

// ── Phase 2: project-binding segments ──

export interface BindingRow {
  session_id: string;
  project_uid: string;
  from_seq: number;
  to_seq: number | null;
  created_at: string;
}
