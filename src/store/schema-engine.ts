/**
 * hmem v2 — generic, prefix-agnostic schema engine.
 *
 * v1 hardcoded the P-entry schema in several code paths (E0150). Here a schema is
 * just `config.schemas[prefix]`, and validation/scaffolding run the SAME code for
 * every prefix — P, E, or a user-defined A from `hmem.config.json`. A prefix with
 * no configured schema is unrestricted (any sections allowed).
 *
 * Section matching mirrors v1 `hmem-store.ts:445`: a candidate section is valid if
 * its first token (split on — - :) starts with an allowed section name, so titles
 * like "Reproduction — exact steps" still match the "Reproduction" section.
 */
import type { HmemConfig, EntrySchema } from '../config/config.js';
import type { Prefix, ValidationResult } from './types.js';

export interface SchemaEngine {
  getSchema(prefix: Prefix): EntrySchema | undefined;
  validateSchema(prefix: Prefix, sections: unknown): ValidationResult;
  scaffoldSections(prefix: Prefix): string[];
}

function sectionName(s: unknown): string | null {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string') {
    return (s as { name: string }).name;
  }
  return null;
}

function firstToken(name: string): string {
  return name.toLowerCase().split(/\s*[—\-:]/)[0].trim();
}

export function createSchemaEngine(config: HmemConfig): SchemaEngine {
  function getSchema(prefix: Prefix): EntrySchema | undefined {
    return config.schemas?.[prefix];
  }

  function validateSchema(prefix: Prefix, sections: unknown): ValidationResult {
    const schema = getSchema(prefix);
    if (!schema) return { valid: true, errors: [] }; // unconfigured prefix → unrestricted

    const allowed = schema.sections.map((s) => s.name.toLowerCase());
    const provided = Array.isArray(sections) ? sections : [];
    const errors: string[] = [];

    for (const raw of provided) {
      const name = sectionName(raw);
      if (name === null) {
        errors.push(`${prefix}: invalid section value ${JSON.stringify(raw)}`);
        continue;
      }
      const head = firstToken(name);
      const ok = allowed.some((sec) => head.startsWith(sec));
      if (!ok) errors.push(`${prefix}: unknown section "${name}"`);
    }

    return { valid: errors.length === 0, errors };
  }

  function scaffoldSections(prefix: Prefix): string[] {
    return getSchema(prefix)?.sections.map((s) => s.name) ?? [];
  }

  return { getSchema, validateSchema, scaffoldSections };
}
