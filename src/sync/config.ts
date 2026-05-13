import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface FileSyncConfig {
  passphrase_hint?: string
  last_sync?: string
  salt?: string
  hmem_path?: string
}

export interface SyncConfig {
  server: string
  api_key?: string
  files: Record<string, FileSyncConfig>
  active_file?: string
}

const DEFAULT_CONFIG: SyncConfig = {
  server: 'https://hmem-sync.io',
  files: {},
}

export function configDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.hmem')
}

export function getConfigPath(): string {
  return join(configDir(), 'config.json')
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<SyncConfig>
  return { ...DEFAULT_CONFIG, ...parsed, files: parsed.files ?? {} }
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
}
