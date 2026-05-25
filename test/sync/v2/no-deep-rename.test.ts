import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM (vitest 4): no __dirname — derive the repo root from import.meta.url
const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../../');

describe('deep-rename subsystem is retired', () => {
  it('src/sync/conflict.ts no longer exists', () => {
    expect(existsSync(join(root, 'src/sync/conflict.ts'))).toBe(false);
  });
  it('no source file imports the conflict module or resolveConflicts', async () => {
    const { execSync } = await import('node:child_process');
    let out = '';
    try { out = execSync(`grep -rn "resolveConflicts\\|sync/conflict" ${join(root, 'src')}`, { encoding: 'utf8' }); }
    catch { out = ''; } // grep exits non-zero (1) when there are no matches → success
    expect(out.trim()).toBe('');
  });
});
