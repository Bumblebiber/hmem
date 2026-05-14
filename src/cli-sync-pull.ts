import { loadSyncConfig, saveSyncConfig, configDir } from './sync/config.js'
import { HmemSyncClient, SyncApiError } from './sync/api.js'
import { deriveKey, decrypt } from './sync/crypto.js'
import { getPassphrase } from './sync/passphrase.js'
import { importFromStaging } from './sync-bridge.js'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export async function syncPull(opts: { passphrase?: string } = {}) {
  const config = await loadSyncConfig()
  if (!config.api_key) { console.error('Not configured. Run: hmem setup'); process.exit(1) }

  const fileId = config.active_file
  if (!fileId) { console.error('No active file. Run: hmem setup'); process.exit(1) }

  const fileCfg = config.files[fileId] ?? {}
  const client = new HmemSyncClient(config.server, config.api_key)

  let response
  try {
    response = await client.pull(fileId, fileCfg.last_sync)
  } catch (err) {
    if (err instanceof SyncApiError && err.code === 'PAYMENT_REQUIRED') {
      console.error('Subscription required.')
      process.exit(1)
    }
    throw err
  }

  const salt = response.salt ?? fileCfg.salt
  if (!salt) { console.error('No salt available. Run: hmem setup'); process.exit(1) }

  const passphrase = opts.passphrase ?? await getPassphrase(fileCfg.passphrase_hint)
  const key = deriveKey(passphrase, salt)

  type RawBlob = { id: number; client_proposed_id?: string; data: string; deleted_at?: string | null; updated_at: string }
  let decryptedBlobs: RawBlob[]
  try {
    decryptedBlobs = response.blobs.map((b: RawBlob) => ({
      ...b,
      data: b.deleted_at ? b.data : decrypt(b.data, key),
    }))
  } catch {
    console.error('Decryption failed — wrong passphrase?')
    process.exit(1)
  }

  const stagingPath = join(configDir(), `${fileId}.hmem`)
  let localBlobs: RawBlob[] = []
  if (existsSync(stagingPath)) {
    try {
      localBlobs = JSON.parse(await readFile(stagingPath, 'utf8')) as RawBlob[]
    } catch { localBlobs = [] }
  }

  const map = new Map<number, RawBlob>(
    localBlobs.filter(b => typeof b.id === 'number').map(b => [b.id, b])
  )
  for (const blob of decryptedBlobs) {
    if (blob.deleted_at) map.delete(blob.id)
    else map.set(blob.id, blob)
  }

  await writeFile(stagingPath, JSON.stringify([...map.values()], null, 2))

  if (fileCfg.hmem_path) {
    await importFromStaging(stagingPath, fileCfg.hmem_path)
    console.log(`✓ Pulled ${response.blobs.length} updates → imported to ${fileCfg.hmem_path}`)
  } else {
    console.log(`✓ Pulled ${response.blobs.length} updates`)
  }

  config.files[fileId] = { ...fileCfg, last_sync: response.server_time, salt }
  await saveSyncConfig(config)
}
