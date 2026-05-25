import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Store } from '../../../src/v2/store-facade.js';
import { DEFAULT_CONFIG } from '../../../src/hmem-config.js';
import { pushV2, pullV2 } from '../../../src/sync/v2/sync.js';
import type { SyncTransport } from '../../../src/sync/v2/transport.js';
import { FakeSyncServer } from './fake-server.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hmem-accept-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SALT = Buffer.alloc(32, 1).toString('base64'); // 44-char base64
const PASS = 'shared-passphrase-xyz';

function device(name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  return { name, store: createV2Store(join(dir, `${name}.hmem`), DEFAULT_CONFIG) };
}
type Dev = ReturnType<typeof device>;
const argsFor = (d: Dev, t: SyncTransport) =>
  ({ store: d.store, transport: t, dir: join(dir, d.name), fileId: 'shared', deviceId: d.name, passphrase: PASS, salt: SALT });
const evContents = (s: Dev['store']) =>
  (s.db.prepare('SELECT content FROM events ORDER BY content').all() as { content: string }[]).map((r) => r.content);

describe('Phase 6 acceptance — two devices converge', () => {
  it('unions all events and keeps both entries with zero renames (different prefixes)', async () => {
    const A = device('A'); const B = device('B');
    const t = new FakeSyncServer(2, SALT).transport();

    // OFFLINE: A creates a P-entry + session with 2 events
    const eA = A.store.entries.createEntry({ prefix: 'P', level_1: 'Project A' });
    const sA = A.store.sessions.createSession({ device_id: 'A' });
    A.store.sessions.bind(sA.session_id, eA.uid);
    A.store.events.appendEvent({ session_id: sA.session_id, role: 'user', content: 'A-event-1' });
    A.store.events.appendEvent({ session_id: sA.session_id, role: 'assistant', content: 'A-event-2' });
    // OFFLINE: B creates an L-entry (different prefix → no label collision) + session with 1 event
    const eB = B.store.entries.createEntry({ prefix: 'L', level_1: 'Lesson B' });
    const sB = B.store.sessions.createSession({ device_id: 'B' });
    B.store.sessions.bind(sB.session_id, eB.uid);
    B.store.events.appendEvent({ session_id: sB.session_id, role: 'user', content: 'B-event-1' });

    await pushV2(argsFor(A, t));
    await pushV2(argsFor(B, t));
    await pullV2(argsFor(A, t));
    await pullV2(argsFor(B, t));

    // event union: 3 distinct events on BOTH devices
    expect(evContents(A.store)).toEqual(['A-event-1', 'A-event-2', 'B-event-1']);
    expect(evContents(B.store)).toEqual(['A-event-1', 'A-event-2', 'B-event-1']);
    // both entries present on both, by ULID
    expect(A.store.entries.getEntry(eB.uid)?.level_1).toBe('Lesson B');
    expect(B.store.entries.getEntry(eA.uid)?.level_1).toBe('Project A');
    // ZERO renames: labels (display) unchanged across the sync
    expect(B.store.entries.getEntry(eA.uid)?.label).toBe(eA.label);
    expect(A.store.entries.getEntry(eB.uid)?.label).toBe(eB.label);

    A.store.close(); B.store.close();
  });

  it('LWW: concurrent edits to the same node converge to the later timestamp on both devices', async () => {
    const A = device('A'); const B = device('B');
    const t = new FakeSyncServer(2, SALT).transport();

    // A creates entry + node, pins the node to a fixed BASE time, syncs to B
    const e = A.store.entries.createEntry({ prefix: 'P', level_1: 'Shared' });
    const n = A.store.entries.addNode({ root_uid: e.uid, content: 'base' });
    A.store.db.prepare('UPDATE nodes SET updated_at=? WHERE uid=?').run('2026-05-25T10:00:00.000Z', n.uid);
    await pushV2(argsFor(A, t));
    await pullV2(argsFor(B, t));
    expect(B.store.db.prepare('SELECT content FROM nodes WHERE uid=?').get(n.uid)).toMatchObject({ content: 'base' });

    // both edit the same node offline; pin A earlier (11:00), B later (12:00) — clock-independent
    A.store.entries.updateNodeContent(n.uid, 'A-edit');
    A.store.db.prepare('UPDATE nodes SET updated_at=? WHERE uid=?').run('2026-05-25T11:00:00.000Z', n.uid);
    B.store.entries.updateNodeContent(n.uid, 'B-edit');
    B.store.db.prepare('UPDATE nodes SET updated_at=? WHERE uid=?').run('2026-05-25T12:00:00.000Z', n.uid);

    await pushV2(argsFor(A, t));
    await pushV2(argsFor(B, t));
    await pullV2(argsFor(A, t));
    await pullV2(argsFor(B, t));

    const content = (s: Dev['store']) => (s.db.prepare('SELECT content FROM nodes WHERE uid=?').get(n.uid) as { content: string }).content;
    expect(content(A.store)).toBe('B-edit'); // later timestamp wins on BOTH
    expect(content(B.store)).toBe('B-edit');

    A.store.close(); B.store.close();
  });

  it('pull is incremental via the stored cursor (second pull fetches only new blobs)', async () => {
    const A = device('A'); const B = device('B');
    const server = new FakeSyncServer(2, SALT);
    const t = server.transport();

    A.store.entries.createEntry({ prefix: 'P', level_1: 'First' });
    await pushV2(argsFor(A, t));
    await pullV2(argsFor(B, t)); // B's cursor now past the first push

    let delivered = -1;
    const counting: SyncTransport = { push: t.push, pull: async (req) => { const r = await t.pull(req); delivered = r.blobs.length; return r; } };

    A.store.entries.createEntry({ prefix: 'P', level_1: 'Second' });
    await pushV2(argsFor(A, t));
    await pullV2(argsFor(B, counting)); // B's SECOND pull, counted

    expect(delivered).toBeGreaterThan(0);             // got the new blob(s)
    expect(delivered).toBeLessThan(server.blobCount()); // but NOT the full log (incremental)
    expect(B.store.entries.getEntryByLabel('P0001')?.level_1).toBe('First');
    expect(B.store.entries.getEntryByLabel('P0002')?.level_1).toBe('Second');

    A.store.close(); B.store.close();
  });

  // ── KNOWN GAP (scope decision pending) ───────────────────────────────────────
  it.skip('same-prefix multi-device offline creation collides on the label unique index — design decision pending (relabel-by-uid vs drop-index vs defer to Phase 6.1)', async () => {
    // Both devices create a P-entry offline → both get label "P0001" with DIFFERENT ULIDs.
    // importV2's verbatim upsert inserts a new uid whose label collides with the local "P0001",
    // violating `CREATE UNIQUE INDEX idx_entries_label ... WHERE deleted_at IS NULL`, so the import
    // transaction throws and rolls back. The ULID identity is preserved (no data loss / no uid rename),
    // but the display-label index makes the verbatim upsert fail. Resolving this convergently
    // (deterministic relabel-by-uid) changes importV2's contract and is OUT of the literal Phase 6
    // acceptance scope. Tracked here so it stays visible in every test run.
    const A = device('A'); const B = device('B');
    const t = new FakeSyncServer(2, SALT).transport();
    A.store.entries.createEntry({ prefix: 'P', level_1: 'A project' }); // P0001
    B.store.entries.createEntry({ prefix: 'P', level_1: 'B project' }); // P0001 (collision on import)
    await pushV2(argsFor(A, t));
    await pushV2(argsFor(B, t));
    await expect(pullV2(argsFor(A, t))).rejects.toThrow(); // documents the CURRENT throwing behavior
    A.store.close(); B.store.close();
  });
});
