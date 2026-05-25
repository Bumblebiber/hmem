import { loadSyncConfig, saveSyncConfig, configDir } from './sync/config.js'
import { HmemSyncClient, SyncApiError } from './sync/api.js'
import { deriveKey, encrypt } from './sync/crypto.js'
import { getPassphrase } from './sync/passphrase.js'
import { exportToStaging } from './sync-bridge.js'
import { syncPull } from './cli-sync-pull.js'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { pushV2, pullV2 } from './sync/v2/sync.js'
import { createV2Store } from './v2/store-facade.js'
import { makeHttpTransport } from './sync/v2/transport.js'
import { loadHmemConfig } from './hmem-config.js'

/** Peek the schema_major value without mutating the file. Returns null if indeterminate. */
function peekSchemaMajor(hmemPath: string): string | null {
  let db: Database.Database | null = null
  try {
    db = new Database(hmemPath, { readonly: true })
    const row = db.prepare("SELECT value FROM schema_version WHERE key='schema_major'").get() as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

export async function syncPush(opts: { skipPull?: boolean; passphrase?: string } = {}) {
  const config = await loadSyncConfig()
  if (!config.api_key) { console.error('Not configured. Run: hmem setup'); process.exit(1) }

  const fileId = config.active_file
  if (!fileId) { console.error('No active file. Run: hmem setup'); process.exit(1) }

  const fileCfg = config.files[fileId] ?? {}

  // --- v2 lane: intercept before the v1 pull/push path ---
  if (fileCfg.hmem_path && peekSchemaMajor(fileCfg.hmem_path) === '2') {
    const salt = fileCfg.salt
    if (!salt) { console.error(`No salt for "${fileId}". Run: hmem setup`); process.exit(1) }
    const passphrase = opts.passphrase ?? await getPassphrase(fileCfg.passphrase_hint)
    const client = new HmemSyncClient(config.server, config.api_key)
    const transport = makeHttpTransport(client)
    const hmemConfig = loadHmemConfig(dirname(fileCfg.hmem_path))
    const store = createV2Store(fileCfg.hmem_path, hmemConfig)
    try {
      if (!opts.skipPull) {
        const pullResult = await pullV2({ store, transport, dir: configDir(), fileId, deviceId: hostname(), passphrase, salt })
        console.log(`✓ Pulled ${pullResult.applied} updates`)
      }
      const pushResult = await pushV2({ store, transport, dir: configDir(), fileId, deviceId: hostname(), passphrase, salt })
      if (pushResult.queued) {
        console.log(`✓ Queued ${pushResult.pushed} blobs (offline — will retry on next push)`)
      } else {
        console.log(`✓ Pushed ${pushResult.pushed} blobs`)
      }
    } finally {
      store.close()
    }
    config.files[fileId] = { ...fileCfg, last_sync: new Date().toISOString() }
    await saveSyncConfig(config)
    return
  }
  // --- end v2 lane ---

  if (!opts.skipPull) {
    await syncPull({ passphrase: opts.passphrase })
  }

  const salt = fileCfg.salt
  if (!salt) { console.error(`No salt for "${fileId}". Run: hmem setup`); process.exit(1) }

  const stagingPath = join(configDir(), `${fileId}.hmem`)
  if (fileCfg.hmem_path) {
    await exportToStaging(fileCfg.hmem_path, stagingPath)
  }

  if (!existsSync(stagingPath)) {
    console.error(`No local data found. Run: hmem setup`)
    process.exit(1)
  }

  let blobs: Array<{ id?: number; client_proposed_id?: string; data: string; updated_at?: string }>
  try {
    blobs = JSON.parse(await readFile(stagingPath, 'utf8')) as typeof blobs
  } catch {
    console.error('Local data corrupted. Run: hmem setup')
    process.exit(1)
  }

  if (blobs.length === 0) { console.log('Nothing to push.'); return }

  const passphrase = opts.passphrase ?? await getPassphrase(fileCfg.passphrase_hint)
  const key = deriveKey(passphrase, salt)
  const client = new HmemSyncClient(config.server, config.api_key)

  const encoded = blobs.map((b) => ({
    proposed_id: b.client_proposed_id ?? String(b.id ?? randomUUID()),
    data: encrypt(b.data, key),
    device_id: hostname(),
    updated_at: b.updated_at ?? new Date().toISOString(),
  }))

  const BATCH = 500
  let total = 0
  for (let i = 0; i < encoded.length; i += BATCH) {
    const batch = encoded.slice(i, i + BATCH)
    try {
      const res = await client.push({ file_id: fileId, idempotency_key: randomUUID(), client_schema_major: 1, blobs: batch })
      total += res.mappings.length
      if (encoded.length > BATCH) process.stdout.write(`\r  ${total}/${encoded.length} blobs...`)
    } catch (err) {
      if (err instanceof SyncApiError && err.code === 'PAYMENT_REQUIRED') {
        console.error('\nSubscription required.')
        process.exit(1)
      }
      throw err
    }
  }

  if (encoded.length > BATCH) process.stdout.write('\n')

  config.files[fileId] = { ...fileCfg, last_sync: new Date().toISOString() }
  await saveSyncConfig(config)

  console.log(`✓ Pushed ${total} blobs`)
}
