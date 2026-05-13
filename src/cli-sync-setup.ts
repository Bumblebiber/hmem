import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { loadSyncConfig, saveSyncConfig, configDir } from './sync/config.js'
import { HmemSyncClient, SyncApiError } from './sync/api.js'
import { generateKeyMaterial, deriveKey, encrypt } from './sync/crypto.js'
import { exportToStaging } from './sync-bridge.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

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

  console.log(`\n  Get your API key at: ${server}/settings/api-keys`)
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

  if (hmemPath && !opts.join) {
    const upload = (await ask('\n  Upload existing memory to server? [Y/n]: ')).trim().toLowerCase()
    if (upload !== 'n') {
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
  }

  rl.close()
  console.log('\n✓ Setup complete!')
}
