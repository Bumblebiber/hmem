// test/store/sessions-cwd-index.test.ts
import { describe, it, expect } from 'vitest';
import { openDb, runMigrations } from '../../src/store/db.js';

describe('sessions.cwd index (idx_sessions_cwd)', () => {
  it('exists on a fresh db', () => {
    const db = openDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_cwd'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('idx_sessions_cwd');
    db.close();
  });

  it('runMigrations is idempotent: index still present after re-run, no throw', () => {
    const db = openDb(':memory:');
    expect(() => runMigrations(db)).not.toThrow(); // second pass
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_cwd'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('idx_sessions_cwd');
    db.close();
  });
});
