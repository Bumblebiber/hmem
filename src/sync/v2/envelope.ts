export type V2Table = 'entries' | 'nodes' | 'links' | 'sessions' | 'session_bindings' | 'events';

export interface BlobEnvelope {
  v: 2;
  table: V2Table;
  key: string;
  lww: string | null;
  deleted: boolean;
  row: Record<string, unknown>;
}

/** Stable stringify: object keys sorted recursively. Guarantees a total byte order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

const KEY: Record<V2Table, (r: Record<string, unknown>) => string> = {
  entries: (r) => String(r.uid),
  nodes: (r) => String(r.uid),
  sessions: (r) => String(r.session_id),
  events: (r) => String(r.event_uid),
  links: (r) => `${r.src_uid}|${r.dst_uid}`,
  session_bindings: (r) => `${r.session_id}|${r.from_seq}`,
};

const LWW: Record<V2Table, (r: Record<string, unknown>) => string | null> = {
  entries: (r) => (r.updated_at as string) ?? null,
  nodes: (r) => (r.updated_at as string) ?? null,
  sessions: (r) => (r.updated_at as string) ?? null,
  session_bindings: (r) => (r.created_at as string) ?? null,
  links: () => null,
  events: () => null,
};

export function rowToEnvelope(table: V2Table, row: Record<string, unknown>): BlobEnvelope {
  return {
    v: 2,
    table,
    key: KEY[table](row),
    lww: LWW[table](row),
    deleted: table !== 'events' && row.deleted_at != null,
    row,
  };
}

export function stagingKey(table: V2Table, key: string): string {
  return `${table}:${key}`;
}
