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
  deleted_at: string | null;
}

export interface LinkRow {
  src_uid: string;
  dst_uid: string;
  kind: string | null;
}
