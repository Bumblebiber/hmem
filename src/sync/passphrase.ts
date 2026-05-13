import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

export async function getPassphrase(hint?: string): Promise<string> {
  const env = process.env.HMEM_SYNC_PASSPHRASE
  if (env) return env
  const rl = createInterface({ input, output })
  const prompt = hint ? `Passphrase (hint: ${hint}): ` : 'Passphrase: '
  const pass = await rl.question(prompt)
  rl.close()
  if (!pass.trim()) { console.error('Passphrase cannot be empty'); process.exit(1) }
  return pass.trim()
}
