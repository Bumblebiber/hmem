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
  return `--- hmem-sync ---\n✓ Linked to ${server} | active_file: ${activeFile} | last sync: ${ago} — writes propagate to other devices on next \`hmem sync push\`.`;
}

/** Real active-device block: the I-entry named in ~/.hmem/active-device, resolved in the store. Safe when absent. */
export function defaultDeviceProbe(store: V2Store): string {
  try {
    const id = fs.readFileSync(path.join(os.homedir(), '.hmem', 'active-device'), 'utf8').trim();
    const e = id ? store.entries.getEntryByLabel(id) : null;
    if (e) {
      let out = `--- Active device ---\n  ${e.label}  ${e.level_1.split('\n')[0]}`;
      // Append the device's "Apps" list (what's installed) — mirrors the legacy hook.
      const appsNode = store.db.prepare(
        `SELECT uid FROM nodes WHERE root_uid=? AND parent_uid IS NULL AND content='Apps' AND deleted_at IS NULL ORDER BY seq LIMIT 1`,
      ).get(e.uid) as { uid: string } | undefined;
      if (appsNode) {
        const apps = store.db.prepare(
          `SELECT content FROM nodes WHERE root_uid=? AND parent_uid=? AND deleted_at IS NULL ORDER BY seq`,
        ).all(e.uid, appsNode.uid) as { content: string }[];
        if (apps.length) {
          out += '\n' + apps.map(a => '  - ' + store.entries.renderRefs(a.content).split('\n')[0]).join('\n');
        }
      }
      return out;
    }
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

  // Rules — pinned/favorite R-entries only (guardrails worth seeing every start).
  // To surface a rule here: update_memory(id="R00XX", pinned=true).
  const rules = store.db.prepare(
    `SELECT label, level_1 FROM entries
      WHERE prefix='R' AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0
      AND (pinned=1 OR favorite=1) ORDER BY seq`,
  ).all() as { label: string; level_1: string }[];
  if (rules.length) {
    out.push('\n--- Rules (pinned/favorited) ---');
    for (const r of rules) {
      const raw = r.level_1 ?? '';
      const title = raw.split('\n')[0];
      const rest = raw.includes('\n') ? `\n> ${raw.split('\n').slice(1).join(' ').trim()}` : '';
      out.push(`${r.label}  ${title}${rest}`);
    }
  }

  // Infrastructure (favorites) — favorite I-entries (endpoints, keys, services worth
  // seeing every start). To surface one: update_memory(id="I00XX", favorite=true).
  const infra = store.db.prepare(
    `SELECT label, level_1 FROM entries
      WHERE prefix='I' AND favorite=1 AND deleted_at IS NULL AND obsolete=0 AND irrelevant=0 ORDER BY seq`,
  ).all() as { label: string; level_1: string }[];
  if (infra.length) {
    out.push('\n--- Infrastructure (favorites) ---');
    for (const i of infra) out.push(`${i.label}  ${i.level_1.split('\n')[0]}`);
  }

  // Device + sync — injected stub in tests, real probe in production (DI default).
  out.push('\n' + (deps.deviceProbe ? deps.deviceProbe() : defaultDeviceProbe(store)));
  out.push('\n' + (deps.syncProbe ? deps.syncProbe() : defaultSyncProbe()));

  return out.join('\n');
}
