// test/store/sessions-cwd.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, runMigrations } from '../../src/store/db.js';

describe('sessions.cwd column', () => {
  it('exists on a fresh db', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('cwd');
    db.close();
  });

  it('runMigrations is idempotent on re-run (no throw, cwd still present)', () => {
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).not.toThrow(); // second pass
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('cwd');
    db.close();
  });
});
