import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { readdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import Database from 'better-sqlite3'
import { loadSyncConfig, saveSyncConfig, configDir } from './sync/config.js'
import { HmemSyncClient, SyncApiError } from './sync/api.js'
import { generateKeyMaterial, deriveKey, encrypt } from './sync/crypto.js'
import { exportToStaging } from './sync-bridge.js'
import { syncPull } from './cli-sync-pull.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export function countLocalEntries(hmemPath: string): number {
  if (!existsSync(hmemPath)) return 0
  try {
    const db = new Database(hmemPath, { readonly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) as c FROM memories WHERE seq > 0').get() as { c: number }
      return row.c
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}

export function clearLocalTables(hmemPath: string): void {
  const db = new Database(hmemPath)
  try {
    db.exec(`
      DELETE FROM memories;
      DELETE FROM memory_nodes;
      INSERT INTO hmem_fts(hmem_fts) VALUES('delete-all');
      DELETE FROM hmem_fts_rowid_map;
    `)
  } finally {
    db.close()
  }
}

function isSQLite(filePath: string): boolean {
  try {
    const buf = readFileSync(filePath).subarray(0, 16)
    return buf.toString('utf8', 0, 15) === 'SQLite format 3'
  } catch { return false }
}

function findHmemFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findHmemFiles(full))
      } else if (entry.name.endsWith('.hmem') && isSQLite(full)) {
        results.push(full)
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results
}

export async function runSetup(opts: { join?: boolean }) {
  const rl = createInterface({ input, output })
  const ask = (prompt: string) => rl.question(prompt)

  console.log('\nWelcome to hmem sync setup!\n')

  const config = await loadSyncConfig()
  const serverAnswer = await ask(`[1/4] Sync server [${config.server}]: `)
  const server = serverAnswer.trim() || config.server

  console.log(`\n[2/4] API key`)
  console.log(`  Get your API key at: ${server}/settings/api-keys`)
  let apiKey = (await ask('  API key: ')).trim()
  if (!apiKey && config.api_key) {
    console.log('  (using existing API key from config)')
    apiKey = config.api_key
  }
  if (!apiKey) { console.error('API key is required'); rl.close(); process.exit(1) }

  const client = new HmemSyncClient(server, apiKey)
  const healthy = await client.health()
  if (!healthy) { console.error(`\n  Cannot reach server at ${server}`); rl.close(); process.exit(1) }

  const hmemDir = join(homedir(), '.hmem')
  const found = findHmemFiles(hmemDir)

  let hmemPath: string | undefined
  if (found.length === 1) {
    console.log(`\n[3/4] Memory file`)
    console.log(`  Found: ${found[0]}`)
    hmemPath = found[0]
  } else if (found.length > 1) {
    console.log(`\n[3/4] Memory file — multiple found:`)
    found.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
    const idxStr = (await ask('  Choose [1]: ')).trim()
    const idx = (parseInt(idxStr) || 1) - 1
    hmemPath = found[Math.max(0, Math.min(idx, found.length - 1))]
  } else {
    console.log(`\n[3/4] Memory file`)
    console.log('  No .hmem file found — will create empty sync file')
  }

  const passphraseAnswer = (await ask('  Passphrase for encryption: ')).trim()
  if (!passphraseAnswer) { console.error('Passphrase is required'); rl.close(); process.exit(1) }

  console.log('\n[4/4] Server file')
  let fileId: string
  let salt: string

  const existingFiles = await client.listFiles()

  if (existingFiles.length > 0) {
    const file = existingFiles[0]
    fileId = file.id
    salt = file.salt!
    console.log(`  ${opts.join ? 'Activating' : 'Using'} existing server file: ${fileId}`)
  } else {
    const { salt: newSalt, recoveryKey } = generateKeyMaterial()
    salt = newSalt
    console.log(`\n  Recovery key (save this now!):`)
    console.log(`  ${recoveryKey}`)
    await ask('  Press Enter once saved: ')

    try {
      const file = await client.createFile('personal', salt)
      fileId = file.id
      console.log(`  Created file: ${fileId}`)
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'CONFLICT') {
        const files = await client.listFiles()
        fileId = files[0].id
        salt = files[0].salt!
        console.log(`  Using existing file: ${fileId}`)
      } else throw e
    }
  }

  config.server = server
  config.api_key = apiKey
  config.active_file = fileId
  config.files[fileId] = { ...config.files[fileId], salt, hmem_path: hmemPath }
  await saveSyncConfig(config)

  const joiningExistingFile = existingFiles.length > 0
  const localCount = hmemPath ? countLocalEntries(hmemPath) : 0

  const uploadLocal = async (): Promise<void> => {
    if (!hmemPath) return
    console.log('  Exporting...')
    const stagingPath = join(configDir(), `${fileId}.hmem`)
    await exportToStaging(hmemPath, stagingPath)

    const blobsRaw = JSON.parse(await readFile(stagingPath, 'utf8')) as Array<{
      id?: number; client_proposed_id?: string; data: string; updated_at?: string
    }>
    const key = deriveKey(passphraseAnswer, salt)
    const BATCH = 500
    let total = 0

    for (let i = 0; i < blobsRaw.length; i += BATCH) {
      const batch = blobsRaw.slice(i, i + BATCH).map((b) => ({
        proposed_id: b.client_proposed_id ?? String(b.id ?? randomUUID()),
        data: encrypt(b.data, key),
        device_id: hostname(),
        updated_at: b.updated_at ?? new Date().toISOString(),
      }))
      const res = await client.push({ file_id: fileId, idempotency_key: randomUUID(), blobs: batch })
      total += res.mappings.length
      process.stdout.write(`\r  ${total}/${blobsRaw.length} blobs uploaded...`)
    }
    console.log(`\n  ✓ Uploaded ${total} blobs`)
  }

  if (hmemPath && localCount > 0 && joiningExistingFile && !opts.join) {
    console.log(`\n  ⚠ Server file "${fileId}" already exists and may contain entries from another device.`)
    console.log(`  Your local memory has ${localCount} entries.`)
    console.log('\n  Choose how to reconcile:')
    console.log('    [1] Replace local with server data (safe; local backed up to *.before-sync.*.hmem)')
    console.log('    [2] Merge: pull server first, then upload local on top (may overwrite older server entries via timestamp-LWW)')
    console.log('    [3] Cancel setup')
    const choice = ((await ask('  Choice [1]: ')).trim() || '1')

    if (choice === '3') {
      console.log('  Setup cancelled.')
      rl.close()
      process.exit(0)
    } else if (choice === '1') {
      const backup = `${hmemPath}.before-sync.${Date.now()}.hmem`
      copyFileSync(hmemPath, backup)
      console.log(`  ✓ Backed up local memory to ${backup}`)
      clearLocalTables(hmemPath)
      await syncPull({ passphrase: passphraseAnswer })
      console.log('  ✓ Local replaced with server data')
    } else {
      await syncPull({ passphrase: passphraseAnswer })
      await uploadLocal()
    }
  } else if (hmemPath && !opts.join) {
    const upload = (await ask('\n  Upload existing memory to server? [Y/n]: ')).trim().toLowerCase()
    if (upload !== 'n') {
      await uploadLocal()
    }
  }

  rl.close()
  console.log('\n✓ Setup complete!')
}
