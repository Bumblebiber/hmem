import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../../src/config/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config', () => {
  it('DEFAULT_CONFIG ships P/E/H/I schemas', () => {
    expect(DEFAULT_CONFIG.schemas?.P?.sections[0].name).toBe('Overview');
    expect(DEFAULT_CONFIG.schemas?.E?.sections.map((s) => s.name)).toContain('Reproduction');
    expect(Object.keys(DEFAULT_CONFIG.schemas!)).toEqual(
      expect.arrayContaining(['P', 'E', 'H', 'I']),
    );
  });

  it('loadConfig with no file returns defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-cfg-'));
    expect(loadConfig(dir).schemas?.P).toBeDefined();
  });

  it('loadConfig merges user hmem.config.json (adds a custom A prefix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-cfg-'));
    writeFileSync(
      join(dir, 'hmem.config.json'),
      JSON.stringify({ schemas: { A: { sections: [{ name: 'Specs', loadDepth: 1 }] } } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.schemas?.A?.sections[0].name).toBe('Specs'); // user-added
    expect(cfg.schemas?.P).toBeDefined(); // defaults preserved
  });

  it('rejects malformed prefix keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmem-cfg-'));
    writeFileSync(
      join(dir, 'hmem.config.json'),
      JSON.stringify({ schemas: { 'not-a-prefix': { sections: [{ name: 'X', loadDepth: 1 }] } } }),
    );
    const cfg = loadConfig(dir);
    expect(cfg.schemas?.['not-a-prefix']).toBeUndefined();
  });
});
