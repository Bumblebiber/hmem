import Database from 'better-sqlite3'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

interface StagingBlob {
  id?: number
  client_proposed_id?: string
  data: string
  updated_at?: string
  deleted_at?: string | null
}

type MemoryRow = Record<string, unknown> & { id: string; updated_at?: string; created_at?: string }

function toIso(ts: string | undefined): string {
  if (!ts) return new Date().toISOString()
  if (ts.endsWith('Z') || ts.includes('+')) return ts
  return ts.replace(' ', 'T') + 'Z'
}

export async function exportToStaging(hmemPath: string, stagingPath: string): Promise<void> {
  const db = new Database(hmemPath, { readonly: true })
  try {
    const memories = db.prepare('SELECT * FROM memories').all() as MemoryRow[]
    const nodes = db.prepare('SELECT * FROM memory_nodes').all() as MemoryRow[]

    const blobs: StagingBlob[] = [
      ...memories.map((row) => ({
        client_proposed_id: row.id,
        data: JSON.stringify({ _table: 'memories', ...row }),
        updated_at: toIso(row.updated_at ?? row.created_at),
      })),
      ...nodes.map((row) => ({
        client_proposed_id: row.id,
        data: JSON.stringify({ _table: 'memory_nodes', ...row }),
        updated_at: toIso(row.updated_at ?? row.created_at),
      })),
    ]

    // Preserve existing server-assigned IDs from current staging file
    let existing: StagingBlob[] = []
    if (existsSync(stagingPath)) {
      try {
        existing = JSON.parse(await readFile(stagingPath, 'utf8')) as StagingBlob[]
      } catch { /* start fresh */ }
    }
    const idByProposed = new Map(
      existing
        .filter((b) => typeof b.id === 'number' && b.client_proposed_id)
        .map((b) => [b.client_proposed_id!, b.id])
    )

    const merged = blobs.map((b) => ({
      ...b,
      ...(idByProposed.has(b.client_proposed_id!) ? { id: idByProposed.get(b.client_proposed_id!) } : {}),
    }))

    await mkdir(dirname(stagingPath), { recursive: true })
    await writeFile(stagingPath, JSON.stringify(merged, null, 2))
  } finally {
    db.close()
  }
}

export async function importFromStaging(stagingPath: string, hmemPath: string): Promise<void> {
  if (!existsSync(stagingPath)) return

  let blobs: StagingBlob[]
  try {
    blobs = JSON.parse(await readFile(stagingPath, 'utf8')) as StagingBlob[]
  } catch {
    return
  }

  const db = new Database(hmemPath)
  try {
    const upsertMemory = db.prepare(`
      INSERT INTO memories (
        id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5,
        access_count, last_accessed, links, min_role, obsolete, favorite, irrelevant,
        title, pinned, updated_at, active
      ) VALUES (
        @id, @prefix, @seq, @created_at, @level_1, @level_2, @level_3, @level_4, @level_5,
        @access_count, @last_accessed, @links, @min_role, @obsolete, @favorite, @irrelevant,
        @title, @pinned, @updated_at, @active
      ) ON CONFLICT(id) DO UPDATE SET
        level_1=excluded.level_1, level_2=excluded.level_2, level_3=excluded.level_3,
        level_4=excluded.level_4, level_5=excluded.level_5, links=excluded.links,
        obsolete=excluded.obsolete, favorite=excluded.favorite, irrelevant=excluded.irrelevant,
        title=excluded.title, pinned=excluded.pinned, updated_at=excluded.updated_at,
        active=excluded.active
      WHERE excluded.updated_at > coalesce(memories.updated_at, '')
    `)

    const upsertNode = db.prepare(`
      INSERT INTO memory_nodes (
        id, parent_id, root_id, depth, seq, content, created_at,
        access_count, last_accessed, title, favorite, irrelevant, updated_at
      ) VALUES (
        @id, @parent_id, @root_id, @depth, @seq, @content, @created_at,
        @access_count, @last_accessed, @title, @favorite, @irrelevant, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        content=excluded.content, title=excluded.title, favorite=excluded.favorite,
        irrelevant=excluded.irrelevant, updated_at=excluded.updated_at
      WHERE excluded.updated_at > coalesce(memory_nodes.updated_at, '')
    `)

    const transaction = db.transaction((rows: StagingBlob[]) => {
      for (const blob of rows) {
        if (blob.deleted_at) continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(blob.data) as Record<string, unknown>
        } catch {
          continue
        }
        if (row._table === 'memories') {
          upsertMemory.run({
            id: row.id ?? null, prefix: row.prefix ?? null, seq: row.seq ?? 0,
            created_at: row.created_at ?? new Date().toISOString(),
            level_1: row.level_1 ?? '', level_2: row.level_2 ?? null,
            level_3: row.level_3 ?? null, level_4: row.level_4 ?? null, level_5: row.level_5 ?? null,
            access_count: row.access_count ?? 0, last_accessed: row.last_accessed ?? null,
            links: row.links ?? null, min_role: row.min_role ?? 'worker',
            obsolete: row.obsolete ?? 0, favorite: row.favorite ?? 0,
            irrelevant: row.irrelevant ?? 0, title: row.title ?? null,
            pinned: row.pinned ?? 0, updated_at: row.updated_at ?? null, active: row.active ?? 0,
          })
        } else if (row._table === 'memory_nodes') {
          upsertNode.run({
            id: row.id ?? null, parent_id: row.parent_id ?? null, root_id: row.root_id ?? null,
            depth: row.depth ?? 0, seq: row.seq ?? 0, content: row.content ?? '',
            created_at: row.created_at ?? new Date().toISOString(),
            access_count: row.access_count ?? 0, last_accessed: row.last_accessed ?? null,
            title: row.title ?? null, favorite: row.favorite ?? 0,
            irrelevant: row.irrelevant ?? 0, updated_at: row.updated_at ?? null,
          })
        }
      }
    })
    transaction(blobs)
  } finally {
    db.close()
  }
}
