import { describe, it, expect } from 'vitest';
import { createSchemaEngine } from '../../src/store/schema-engine.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';

const cfg = {
  ...DEFAULT_CONFIG,
  schemas: {
    ...DEFAULT_CONFIG.schemas,
    A: { sections: [{ name: 'Specs', loadDepth: 1 }, { name: 'Access', loadDepth: 1 }] },
  },
};
const eng = createSchemaEngine(cfg);

describe('schema-engine (generic across prefixes)', () => {
  it('validates P / E / custom A through one path', () => {
    expect(eng.validateSchema('P', ['Overview', 'Codebase']).valid).toBe(true);
    expect(eng.validateSchema('E', ['Reproduction', 'Analysis']).valid).toBe(true);
    expect(eng.validateSchema('A', ['Specs', 'Access']).valid).toBe(true);
  });

  it('accepts section names with descriptive suffixes (startsWith match)', () => {
    expect(eng.validateSchema('E', ['Reproduction — steps', 'Cause: the bug']).valid).toBe(true);
  });

  it('accepts {name} objects as well as bare strings', () => {
    expect(eng.validateSchema('A', [{ name: 'Specs' }, { name: 'Access' }]).valid).toBe(true);
  });

  it('flags foreign sections', () => {
    const r = eng.validateSchema('A', ['Specs', 'Bogus']);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/Bogus/);
  });

  it('unconfigured prefix is unrestricted', () => {
    expect(eng.validateSchema('Z', ['anything']).valid).toBe(true);
  });

  it('scaffoldSections returns section names in order', () => {
    expect(eng.scaffoldSections('E')[0]).toBe('Reproduction');
    expect(eng.scaffoldSections('A')).toEqual(['Specs', 'Access']);
    expect(eng.scaffoldSections('Z')).toEqual([]);
  });
});
