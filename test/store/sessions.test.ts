import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createSessionsApi } from '../../src/store/sessions.js';

const api = () => createSessionsApi(openDb(':memory:'));

describe('sessions CRUD', () => {
  it('creates with a provided id and generates one otherwise', () => {
    const s = api();
    expect(s.createSession({ session_id: 'hook-123', harness: 'claude-code' }).session_id).toBe(
      'hook-123',
    );
    expect(s.getSession('hook-123')!.harness).toBe('claude-code');
    expect(s.createSession({}).session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('createSession is idempotent for a re-used hook id', () => {
    const s = api();
    s.createSession({ session_id: 'S', harness: 'claude-code' });
    s.createSession({ session_id: 'S', harness: 'pi' }); // re-create must not clobber
    expect(s.getSession('S')!.harness).toBe('claude-code');
  });

  it('touchSession bumps last_active_at and updated_at', () => {
    const s = api();
    s.createSession({ session_id: 'S' });
    const before = s.getSession('S')!;
    expect(before.last_active_at).toBeNull();
    s.touchSession('S');
    const after = s.getSession('S')!;
    expect(after.last_active_at).not.toBeNull();
  });

  it('updateSessionSummary sets one-line summary + node pointer', () => {
    const s = api();
    s.createSession({ session_id: 'S' });
    s.updateSessionSummary('S', 'did X', 'node-uid-1');
    const row = s.getSession('S')!;
    expect(row.summary).toBe('did X');
    expect(row.summary_node_uid).toBe('node-uid-1');
  });
});
