import { loadSyncConfig, saveSyncConfig, configDir } from './sync/config.js'
import { HmemSyncClient, SyncApiError } from './sync/api.js'
import { deriveKey, encrypt } from './sync/crypto.js'
import { getPassphrase } from './sync/passphrase.js'
import { exportToStaging } from './sync-bridge.js'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

export async function syncPush() {
  const config = await loadSyncConfig()
  if (!config.api_key) { console.error('Not configured. Run: hmem setup'); process.exit(1) }

  const fileId = config.active_file
  if (!fileId) { console.error('No active file. Run: hmem setup'); process.exit(1) }

  const fileCfg = config.files[fileId] ?? {}
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

  const passphrase = await getPassphrase(fileCfg.passphrase_hint)
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
      const res = await client.push({ file_id: fileId, idempotency_key: randomUUID(), blobs: batch })
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
