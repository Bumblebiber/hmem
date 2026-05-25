// src/hooks/stable-context.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { V2Store } from '../v2/store-facade.js';
import type { NodeRow } from '../store/types.js';
import type { StringProbe } from './types.js';

export interface StableDeps { syncProbe?: StringProbe; deviceProbe?: StringProbe; }

function l2Children(store: V2Store, rootUid: string): NodeRow[] {
  return store.db.prepare(
    'SELECT * FROM nodes WHERE root_uid=? AND parent_uid IS NULL AND deleted_at IS NULL ORDER BY seq',
  ).all(rootUid) as NodeRow[];
}

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Real sync-status line from ~/.hmem/config.json (mirrors v1 buildSyncStatus logic). Safe when absent. */
export function defaultSyncProbe(): string {
  const configPath = path.join(os.homedir(), '.hmem', 'config.json');
  if (!fs.existsSync(configPath)) {
    return '--- hmem-sync ---\n✗ Not configured on this device — memories stay local, no cross-device sync.';
  }
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {
    return '--- hmem-sync ---\n✗ Config file unreadable — sync inactive.';
  }

  const server = cfg.server || 'https://hmem-sync.io';
  const linked = !!(cfg.session_token || cfg.api_key);
  const activeFile = cfg.active_file;

  if (!linked) {
    return '--- hmem-sync ---\n✗ Not linked — writes stay local.';
  }
  if (!activeFile) {
    return `--- hmem-sync ---\n⚠ Authenticated to ${server} but no active file.`;
  }
  const fileCfg = cfg.files?.[activeFile];
  if (!fileCfg?.last_sync) {
    return `--- hmem-sync ---\n⚠ Linked to ${server} (active_file: ${activeFile}) but never synced.`;
  }
  const ago = formatAgo(Date.now() - new Date(fileCfg.last_sync).getTime());
  return `--- hmem-sync ---\n✓ Linked to ${server} | active_file: ${activeFile} | last sync: ${ago} — writes propagate to other devices on next \`hmem-sync push\`.`;
}

/** Real active-device block: the I-entry named in ~/.hmem/active-device, resolved in the store. Safe when absent. */
export function defaultDeviceProbe(store: V2Store): string {
  try {
    const id = fs.readFileSync(path.join(os.homedir(), '.hmem', 'active-device'), 'utf8').trim();
    const e = id ? store.entries.getEntryByLabel(id) : null;
    if (e) return `--- Active device ---\n  ${e.label}  ${e.level_1.split('\n')[0]}`;
  } catch { /* fall through */ }
  return '--- Active device ---\n  (kein aktives Gerät)';
}

export function buildStableContext(store: V2Store, deps: StableDeps = {}): string {
  const out: string[] = [];

  // H-entries
  out.push('--- Human context (H-entries) ---');
  const hs = store.db.prepare(
    "SELECT uid, label, level_1 FROM entries WHERE prefix='H' AND deleted_at IS NULL ORDER BY seq",
  ).all() as { uid: string; label: string; level_1: string }[];
  for (const h of hs) {
    out.push(`${h.label}  ${h.level_1.split('\n')[0]}`);
    for (const c of l2Children(store, h.uid)) {
      out.push('  • ' + store.entries.renderRefs(c.content).split('\n')[0].slice(0, 80));
    }
  }

  // Recent projects
  out.push('\n--- Recent projects ---');
  const ps = store.db.prepare(
    "SELECT label, level_1 FROM entries WHERE prefix='P' AND deleted_at IS NULL AND obsolete=0 ORDER BY updated_at DESC LIMIT 6",
  ).all() as { label: string; level_1: string }[];
  for (const p of ps) out.push(`${p.label}  ${p.level_1.split('\n')[0]}`);

  // Device + sync — injected stub in tests, real probe in production (DI default).
  out.push('\n' + (deps.deviceProbe ? deps.deviceProbe() : defaultDeviceProbe(store)));
  out.push('\n' + (deps.syncProbe ? deps.syncProbe() : defaultSyncProbe()));

  return out.join('\n');
}
