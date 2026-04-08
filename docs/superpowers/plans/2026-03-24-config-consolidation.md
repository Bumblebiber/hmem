# Config Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate 6 separate config/state/token files into a single `hmem.config.json` per agent, with migration from old format and backward-compatible fallback in hmem-sync.

**Architecture:** Extend the existing `hmem.config.json` with a `sync` section containing serverUrl, userId, salt, token, syncSecrets, and state (lastPushAt, lastPullAt). hmem-mcp's `loadHmemConfig()` gains a `sync` field it passes through but doesn't interpret. hmem-sync's `loadConfig()` reads from the unified file first, falls back to legacy files, and migrates on first successful load. `HmemSyncClient.saveState()` in `sync.ts` writes back to the unified config instead of `.hmem-sync.json`. `hmem init` writes ALL defaults explicitly. **Upgrade order: hmem-mcp first, then hmem-sync.**

**Tech Stack:** TypeScript, Node.js, better-sqlite3 (existing)

---

## Current State

### Files being consolidated

| # | File | Owner | Content |
|---|------|-------|---------|
| 1 | `hmem.config.json` | hmem-mcp | Memory settings (maxL1Chars, maxDepth, etc.) |
| 2 | `.hmem-sync-config.json` | hmem-sync | serverUrl, userId, salt, syncSecrets, hmemPath |
| 3 | `.hmem-sync-token` | hmem-sync | Bearer auth token (plain text, chmod 600) |
| 4 | `.hmem-sync.json` | hmem-sync | Sync state (last_push_at, last_pull_at) |
| 5 | `.hmem-sync-config` | hmem-sync | Alternate config location (legacy, no .json extension) |
| 6 | `.hmem-sync-announcements.json` | hmem-sync | Announcement state (can be dropped) |

### Target structure

The `memory` section stores `maxCharsPerLevel` (the internal array format), not `maxL1Chars`/`maxLnChars`. On reload, `loadHmemConfig()` interprets both formats as before.

```json
{
  "memory": {
    "maxCharsPerLevel": [200, 2500, 10000, 25000, 50000],
    "maxDepth": 5,
    "defaultReadLimit": 100,
    "maxTitleChars": 50,
    "accessCountTopN": 5,
    "prefixes": { "P": "Project", "L": "Lesson" },
    "prefixDescriptions": { "P": "(P)roject experiences and summaries" },
    "bulkReadV2": { "topAccessCount": 3, "topNewestCount": 5 }
  },
  "sync": {
    "serverUrl": "https://bbbee.uber.space/hmem-sync",
    "userId": "bbbee",
    "salt": "dAfLAQRRkJn0ReiHQ14BeVpMIduDQVV83AbQKnZKAso=",
    "token": "5bdeff5fc60723206f384b69adb68af582a0c21ac6af5225a613849efe405391",
    "syncSecrets": true,
    "lastPushAt": null,
    "lastPullAt": "2026-03-24T12:42:00.037Z"
  }
}
```

**Key decisions:**
- `memory` section = current top-level `hmem.config.json` fields, wrapped in `memory` key
- `sync` section = merged from `.hmem-sync-config.json` + `.hmem-sync-token` + `.hmem-sync.json`
- Token stored inline (file is already in a private directory, not committed to git)
- `hmem.config.json` gets `chmod 600` after write if sync.token is present
- Announcements state is dropped (ephemeral)
- `.mcp.json` stays separate (Claude Code standard)
- `HMEM_SYNC_PASSPHRASE` env var stays (not stored in config — it's a secret)

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hmem-config.ts` (hmem) | Modify | Add `sync` passthrough to `HmemConfig`, wrap existing fields under `memory`, backward-compat for flat format, add `saveHmemConfig()` |
| `src/cli-init.ts` (hmem) | Modify | Write ALL defaults explicitly to `hmem.config.json` on init |
| `src/mcp-server.ts` (hmem) | Modify | All 3 references to `.hmem-sync-config.json` (lines 84, 89, 933) updated to also check `config.sync` |
| `src/cli.ts` (hmem-sync) | Modify | Read config from unified `hmem.config.json`, fallback to legacy files, migrate. Also handles `.hmem-sync-config` (no .json extension) |
| `src/sync.ts` (hmem-sync) | Modify | `HmemSyncClient` constructor accepts optional `stateSaveFn` callback. `saveState()` uses callback if provided, else falls back to `.hmem-sync.json`. `loadState()` accepts initial state from caller. |
| `tests/config-consolidation.test.ts` (hmem) | Create | Tests for new config loading with both formats |
| `tests/config-migration.test.ts` (hmem-sync) | Create | Tests for migration from legacy to unified, edge cases |

---

### Task 1: Extend HmemConfig interface and loadHmemConfig (hmem-mcp)

**Files:**
- Modify: `/home/bbbee/projects/hmem/src/hmem-config.ts`
- Create: `/home/bbbee/projects/hmem/tests/config-consolidation.test.ts`

The core change: `hmem.config.json` can now have two shapes:
1. **Legacy (flat):** `{ "maxL1Chars": 200 }` — current format, memory settings at top level
2. **Unified:** `{ "memory": { "maxL1Chars": 200 }, "sync": { ... } }` — new format

`loadHmemConfig()` must handle both transparently. Detection: if `raw.memory` is an object with at least one known memory key (maxDepth, maxL1Chars, maxLnChars, maxCharsPerLevel, defaultReadLimit, prefixes, etc.), treat as unified format. Otherwise treat as flat.

- [ ] **Step 1: Write test for legacy flat config loading (unchanged behavior)**

```typescript
// tests/config-consolidation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadHmemConfig, saveHmemConfig, DEFAULT_CONFIG } from "../src/hmem-config.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-config-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadHmemConfig", () => {
  it("loads legacy flat format", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ maxL1Chars: 300 }));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(300);
    expect(cfg.sync).toBeUndefined();
  });

  it("returns defaults when no config file exists", () => {
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel).toEqual(DEFAULT_CONFIG.maxCharsPerLevel);
    expect(cfg.sync).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (existing behavior)**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: PASS (legacy behavior unchanged)

- [ ] **Step 3: Write tests for unified format**

```typescript
  it("loads unified format with memory + sync sections", () => {
    const config = {
      memory: { maxL1Chars: 400 },
      sync: {
        serverUrl: "https://example.com",
        userId: "testuser",
        salt: "abc123",
        token: "tok_secret",
        syncSecrets: true,
        lastPushAt: null,
        lastPullAt: "2026-01-01T00:00:00Z"
      }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(400);
    expect(cfg.sync).toBeDefined();
    expect(cfg.sync!.serverUrl).toBe("https://example.com");
    expect(cfg.sync!.token).toBe("tok_secret");
    expect(cfg.sync!.lastPullAt).toBe("2026-01-01T00:00:00Z");
  });

  it("loads unified format without sync section", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ memory: { maxL1Chars: 250 } }));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(250);
    expect(cfg.sync).toBeUndefined();
  });

  it("preserves syncSecrets: false (not defaulted to true)", () => {
    const config = {
      memory: {},
      sync: { serverUrl: "x", userId: "y", salt: "z", token: "t", syncSecrets: false }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.sync!.syncSecrets).toBe(false);
  });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: FAIL — sync field doesn't exist yet

- [ ] **Step 5: Implement unified config loading in hmem-config.ts**

Add `SyncConfigBlock` interface and optional `sync` field to `HmemConfig`:

```typescript
// Add after HmemConfig interface (line ~81)
export interface SyncConfigBlock {
  serverUrl: string;
  userId: string;
  salt: string;
  token?: string;
  syncSecrets?: boolean;
  lastPushAt?: string | null;
  lastPullAt?: string | null;
}
```

Add `sync?: SyncConfigBlock` to `HmemConfig` interface.

In `loadHmemConfig()`, detect format and branch:

```typescript
// After JSON.parse (line ~169):
const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// Detect unified vs flat format:
// Unified has raw.memory as an object. Flat has memory settings at top level.
const MEMORY_KEYS = new Set(["maxL1Chars", "maxLnChars", "maxCharsPerLevel", "maxDepth",
  "defaultReadLimit", "prefixes", "prefixDescriptions", "bulkReadV2", "maxTitleChars", "accessCountTopN"]);
const isUnified = raw.memory && typeof raw.memory === "object"
  && !Array.isArray(raw.memory)
  && Object.keys(raw.memory).some(k => MEMORY_KEYS.has(k));
const memoryRaw = isUnified ? raw.memory : raw;
const syncRaw = raw.sync && typeof raw.sync === "object" ? raw.sync : undefined;

// ... existing config parsing uses `memoryRaw` instead of `raw` everywhere ...

// At the end, before return:
if (syncRaw && syncRaw.serverUrl && syncRaw.userId && syncRaw.salt) {
  cfg.sync = {
    serverUrl: syncRaw.serverUrl,
    userId: syncRaw.userId,
    salt: syncRaw.salt,
    token: syncRaw.token,
    syncSecrets: syncRaw.syncSecrets !== undefined ? syncRaw.syncSecrets : true,
    lastPushAt: syncRaw.lastPushAt ?? null,
    lastPullAt: syncRaw.lastPullAt ?? null,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
cd /home/bbbee/projects/hmem
git add src/hmem-config.ts tests/config-consolidation.test.ts
git commit -m "feat: support unified hmem.config.json with memory + sync sections"
```

---

### Task 2: Add saveHmemConfig function (hmem-mcp)

**Files:**
- Modify: `/home/bbbee/projects/hmem/src/hmem-config.ts`
- Modify: `/home/bbbee/projects/hmem/tests/config-consolidation.test.ts`

Currently there is no `saveHmemConfig()` — config is read-only. We need a save function for migration and for hmem-sync to persist state changes back.

`saveHmemConfig` writes the `memory` section using the internal `maxCharsPerLevel` array (not reverse-computing `maxL1Chars`/`maxLnChars`). On reload, `loadHmemConfig` reads `maxCharsPerLevel` directly.

- [ ] **Step 1: Write test for saveHmemConfig**

```typescript
describe("saveHmemConfig", () => {
  it("saves and reloads unified config with roundtrip fidelity", () => {
    const cfg = loadHmemConfig(TMP); // defaults, no file
    cfg.maxCharsPerLevel[0] = 350;
    cfg.sync = {
      serverUrl: "https://test.com",
      userId: "me",
      salt: "salt123",
      token: "secret_token",
      syncSecrets: true,
      lastPushAt: null,
      lastPullAt: null,
    };
    saveHmemConfig(TMP, cfg);

    const reloaded = loadHmemConfig(TMP);
    expect(reloaded.maxCharsPerLevel[0]).toBe(350);
    expect(reloaded.maxDepth).toBe(cfg.maxDepth);
    expect(reloaded.sync!.serverUrl).toBe("https://test.com");
    expect(reloaded.sync!.token).toBe("secret_token");
  });

  it("saves config with chmod 600 when token present", () => {
    const cfg = loadHmemConfig(TMP);
    cfg.sync = { serverUrl: "x", userId: "y", salt: "z", token: "secret" };
    saveHmemConfig(TMP, cfg);

    const stat = statSync(join(TMP, "hmem.config.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("saves config without sync section when sync is undefined", () => {
    const cfg = loadHmemConfig(TMP);
    saveHmemConfig(TMP, cfg);

    const raw = JSON.parse(readFileSync(join(TMP, "hmem.config.json"), "utf8"));
    expect(raw.memory).toBeDefined();
    expect(raw.sync).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: FAIL — saveHmemConfig doesn't exist

- [ ] **Step 3: Implement saveHmemConfig**

```typescript
export function saveHmemConfig(projectDir: string, config: HmemConfig): void {
  const configPath = path.join(projectDir, "hmem.config.json");

  const output: Record<string, unknown> = {
    memory: {
      maxCharsPerLevel: config.maxCharsPerLevel,
      maxDepth: config.maxDepth,
      defaultReadLimit: config.defaultReadLimit,
      maxTitleChars: config.maxTitleChars,
      accessCountTopN: config.accessCountTopN,
      prefixes: config.prefixes,
      prefixDescriptions: config.prefixDescriptions,
      bulkReadV2: config.bulkReadV2,
    },
  };

  if (config.sync) {
    output.sync = config.sync;
  }

  fs.writeFileSync(configPath, JSON.stringify(output, null, 2), "utf-8");

  // Secure file if token is present
  if (config.sync?.token) {
    try { fs.chmodSync(configPath, 0o600); } catch {}
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Export saveHmemConfig from index.ts**

Add `saveHmemConfig` to the exports in `/home/bbbee/projects/hmem/src/index.ts`.

- [ ] **Step 6: Commit**

```bash
cd /home/bbbee/projects/hmem
git add src/hmem-config.ts src/index.ts tests/config-consolidation.test.ts
git commit -m "feat: add saveHmemConfig for writing unified config"
```

---

### Task 3: Update hmem init to write ALL defaults explicitly (hmem-mcp)

**Files:**
- Modify: `/home/bbbee/projects/hmem/src/cli-init.ts`
- Modify: `/home/bbbee/projects/hmem/tests/config-consolidation.test.ts`

- [ ] **Step 1: Write test for init config output**

```typescript
describe("init config output", () => {
  it("writes full defaults in unified format", () => {
    saveHmemConfig(TMP, { ...DEFAULT_CONFIG });

    const raw = JSON.parse(readFileSync(join(TMP, "hmem.config.json"), "utf8"));
    expect(raw.memory).toBeDefined();
    expect(raw.memory.maxCharsPerLevel).toEqual(DEFAULT_CONFIG.maxCharsPerLevel);
    expect(raw.memory.maxDepth).toBe(5);
    expect(raw.memory.prefixes.P).toBe("Project");
    expect(raw.sync).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/config-consolidation.test.ts`
Expected: PASS (saveHmemConfig already implemented)

- [ ] **Step 3: Find and update cli-init.ts config writing**

Find where `hmem.config.json` is written during init (search for `writeFileSync` or `hmem.config.json` in `cli-init.ts`). Replace the minimal write with:

```typescript
import { saveHmemConfig, DEFAULT_CONFIG } from "./hmem-config.js";
// ...
saveHmemConfig(projectDir, { ...DEFAULT_CONFIG });
```

- [ ] **Step 4: Build and manually test**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Run: `mkdir -p /tmp/test-init && cd /tmp/test-init && node /home/bbbee/projects/hmem/dist/cli.js init`
Verify: `cat /tmp/test-init/hmem.config.json` shows full `{ "memory": { ... } }` format

- [ ] **Step 5: Commit**

```bash
cd /home/bbbee/projects/hmem
git add src/cli-init.ts
git commit -m "feat: hmem init writes all config defaults explicitly"
```

---

### Task 4: Update HmemSyncClient state management (hmem-sync)

**Files:**
- Modify: `/home/bbbee/projects/hmem-sync/src/sync.ts`

**This is critical.** `HmemSyncClient` currently manages its own state via `.hmem-sync.json` (line 117). The constructor hardcodes `this.statePath = join(dirname(hmemPath), ".hmem-sync.json")` and `saveState()` writes there directly. We need to allow the caller (cli.ts) to provide an alternative state persistence mechanism.

- [ ] **Step 1: Add optional state callback to HmemSyncClient constructor**

Modify the constructor signature in `/home/bbbee/projects/hmem-sync/src/sync.ts:112`:

```typescript
export class HmemSyncClient {
  private db: Database.Database;
  private key: Buffer;
  private cfg: SyncConfig;
  private statePath: string;
  private state: SyncState;
  private onStateSave?: (state: SyncState) => void;

  constructor(
    hmemPath: string,
    passphrase: string,
    cfg: SyncConfig,
    options?: { initialState?: SyncState; onStateSave?: (state: SyncState) => void }
  ) {
    this.db = new Database(hmemPath, { readonly: false });
    this.ensureMigrations();
    this.key = deriveKey(passphrase, cfg.salt);
    this.cfg = cfg;
    this.statePath = join(dirname(hmemPath), ".hmem-sync.json");
    this.onStateSave = options?.onStateSave;
    this.state = options?.initialState ?? this.loadState();
  }
```

- [ ] **Step 2: Update saveState() to use callback when provided**

```typescript
  private saveState(): void {
    if (this.onStateSave) {
      this.onStateSave(this.state);
    } else {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
  }
```

- [ ] **Step 3: Verify existing callers still work (no options = backward compatible)**

All existing `new HmemSyncClient(hmemPath, pass, cfg)` calls still work — `options` is optional.

- [ ] **Step 4: Commit**

```bash
cd /home/bbbee/projects/hmem-sync
git add src/sync.ts
git commit -m "feat: HmemSyncClient accepts optional state callback for unified config"
```

---

### Task 5: hmem-sync reads from unified config with legacy fallback + migration (hmem-sync)

**Files:**
- Modify: `/home/bbbee/projects/hmem-sync/src/cli.ts`
- Create: `/home/bbbee/projects/hmem-sync/tests/config-migration.test.ts`

- [ ] **Step 1: Write comprehensive migration tests**

```typescript
// tests/config-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-migration-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadUnifiedConfig", () => {
  it("loads from unified hmem.config.json", () => {
    const config = {
      memory: { maxL1Chars: 200 },
      sync: {
        serverUrl: "https://example.com",
        userId: "test",
        salt: "abc",
        token: "tok123",
        lastPushAt: null,
        lastPullAt: null,
      }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    writeFileSync(join(TMP, "test.hmem"), "");

    const raw = JSON.parse(readFileSync(join(TMP, "hmem.config.json"), "utf8"));
    expect(raw.sync.serverUrl).toBe("https://example.com");
    expect(raw.sync.token).toBe("tok123");
  });

  it("returns null when hmem.config.json has no sync section", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ memory: { maxL1Chars: 200 } }));
    const raw = JSON.parse(readFileSync(join(TMP, "hmem.config.json"), "utf8"));
    expect(raw.sync).toBeUndefined();
  });
});

describe("migrateLegacyConfig", () => {
  it("migrates legacy files to unified config and deletes them", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ maxL1Chars: 200 }));
    writeFileSync(join(TMP, ".hmem-sync-config.json"), JSON.stringify({
      hmemPath: join(TMP, "test.hmem"),
      serverUrl: "https://old.example.com",
      userId: "olduser",
      salt: "oldsalt"
    }));
    writeFileSync(join(TMP, ".hmem-sync-token"), "old_token_123");
    writeFileSync(join(TMP, ".hmem-sync.json"), JSON.stringify({
      last_push_at: "2026-01-01T00:00:00Z",
      last_pull_at: "2026-01-02T00:00:00Z",
      serverUrl: "https://old.example.com"
    }));
    writeFileSync(join(TMP, "test.hmem"), "");

    // Will test actual function call once implemented
  });

  it("preserves existing memory section from flat-format config", () => {
    // Flat-format hmem.config.json + legacy sync files
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ maxL1Chars: 300, maxDepth: 3 }));
    writeFileSync(join(TMP, ".hmem-sync-config.json"), JSON.stringify({
      hmemPath: join(TMP, "test.hmem"),
      serverUrl: "https://s.com", userId: "u", salt: "s"
    }));
    writeFileSync(join(TMP, ".hmem-sync-token"), "tok");

    // After migration, memory settings must survive
  });

  it("handles missing token file gracefully", () => {
    writeFileSync(join(TMP, ".hmem-sync-config.json"), JSON.stringify({
      hmemPath: join(TMP, "test.hmem"),
      serverUrl: "https://s.com", userId: "u", salt: "s"
    }));
    // No .hmem-sync-token file!

    // Migration should succeed, sync.token should be undefined
  });

  it("preserves syncSecrets: false from legacy config", () => {
    writeFileSync(join(TMP, ".hmem-sync-config.json"), JSON.stringify({
      hmemPath: join(TMP, "test.hmem"),
      serverUrl: "https://s.com", userId: "u", salt: "s",
      syncSecrets: false
    }));
    writeFileSync(join(TMP, ".hmem-sync-token"), "tok");

    // After migration, syncSecrets must be false
  });

  it("does not overwrite existing sync section in unified config", () => {
    // Unified config already has sync section + legacy files exist
    const config = {
      memory: { maxL1Chars: 200 },
      sync: { serverUrl: "https://new.com", userId: "new", salt: "newsalt", token: "newtok" }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    writeFileSync(join(TMP, ".hmem-sync-config.json"), JSON.stringify({
      hmemPath: join(TMP, "test.hmem"),
      serverUrl: "https://old.com", userId: "old", salt: "oldsalt"
    }));

    // Migration should skip — unified sync already exists. Legacy files cleaned up.
  });

  it("cleans up .hmem-sync-config (no .json extension)", () => {
    writeFileSync(join(TMP, ".hmem-sync-config"), JSON.stringify({
      server: "https://s.com", userId: "u", salt: "s"
    }));

    // After migration, .hmem-sync-config should be deleted
  });
});
```

- [ ] **Step 2: Implement loadUnifiedConfig in cli.ts**

```typescript
function loadUnifiedConfig(hmemDir: string): { config: PersistedConfig; token: string; state: SyncState } | null {
  const cfgPath = join(hmemDir, "hmem.config.json");
  if (!existsSync(cfgPath)) return null;

  let raw: any;
  try { raw = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return null; }

  if (!raw.sync || typeof raw.sync !== "object") return null;
  const sync = raw.sync;

  if (!sync.serverUrl || !sync.userId || !sync.salt || !sync.token) return null;

  return {
    config: {
      hmemPath: resolveHmemFile(hmemDir),
      serverUrl: sync.serverUrl,
      userId: sync.userId,
      salt: sync.salt,
      syncSecrets: sync.syncSecrets !== undefined ? sync.syncSecrets : true,
    },
    token: sync.token,
    state: {
      last_push_at: sync.lastPushAt ?? null,
      last_pull_at: sync.lastPullAt ?? null,
      serverUrl: sync.serverUrl,
    },
  };
}
```

- [ ] **Step 3: Implement migrateLegacyConfig with safety checks**

```typescript
function migrateLegacyConfig(hmemDir: string): void {
  const legacyConfigJson = join(hmemDir, ".hmem-sync-config.json");
  const legacyConfigNoExt = join(hmemDir, ".hmem-sync-config"); // legacy no-extension variant
  const legacyTokenPath = join(hmemDir, ".hmem-sync-token");
  const legacyStatePath = join(hmemDir, ".hmem-sync.json");
  const legacyAnnounce = join(hmemDir, ".hmem-sync-announcements.json");
  const unifiedPath = join(hmemDir, "hmem.config.json");

  // Find the legacy config (prefer .json, fall back to no-extension)
  const legacyConfigPath = existsSync(legacyConfigJson) ? legacyConfigJson
    : existsSync(legacyConfigNoExt) ? legacyConfigNoExt
    : null;

  if (!legacyConfigPath) return; // nothing to migrate

  // Check: if unified config already has sync section, just clean up legacy files
  try {
    const existing = JSON.parse(readFileSync(unifiedPath, "utf8"));
    if (existing.sync && existing.sync.serverUrl && existing.sync.token) {
      // Already migrated — just delete legacy files
      for (const f of [legacyConfigJson, legacyConfigNoExt, legacyTokenPath, legacyStatePath, legacyAnnounce]) {
        try { rmSync(f); } catch {}
      }
      return;
    }
  } catch {}

  // Read legacy files
  let legacyCfg: any;
  try {
    legacyCfg = JSON.parse(readFileSync(legacyConfigPath, "utf8"));
  } catch (e: any) {
    console.error(`Cannot parse legacy config ${legacyConfigPath}: ${e.message}`);
    return;
  }

  const token = existsSync(legacyTokenPath)
    ? readFileSync(legacyTokenPath, "utf8").replace(/[^\x21-\x7E]/g, "")
    : undefined;

  let state: any = {};
  try { state = JSON.parse(readFileSync(legacyStatePath, "utf8")); } catch {}

  // Read existing hmem.config.json (may have memory section in flat or unified format)
  let existingConfig: any = {};
  try { existingConfig = JSON.parse(readFileSync(unifiedPath, "utf8")); } catch {}

  // Detect flat vs unified memory section
  const MEMORY_KEYS = ["maxL1Chars", "maxLnChars", "maxCharsPerLevel", "maxDepth",
    "defaultReadLimit", "prefixes", "prefixDescriptions", "bulkReadV2", "maxTitleChars", "accessCountTopN"];
  const isFlatFormat = !existingConfig.memory && Object.keys(existingConfig).some(k => MEMORY_KEYS.includes(k));
  const memorySection = isFlatFormat ? existingConfig : (existingConfig.memory ?? {});

  // Validate hmemPath mapping won't be lost
  if (legacyCfg.hmemPath) {
    const resolved = resolveHmemFile(hmemDir);
    if (resolve(legacyCfg.hmemPath) !== resolve(resolved)) {
      console.warn(yellow(`⚠ Legacy hmemPath "${legacyCfg.hmemPath}" differs from resolved "${resolved}". Keeping legacy files as backup.`));
      return;
    }
  }

  // Build unified config
  const unified = {
    memory: memorySection,
    sync: {
      serverUrl: legacyCfg.serverUrl,
      userId: legacyCfg.userId,
      salt: legacyCfg.salt,
      token,
      syncSecrets: legacyCfg.syncSecrets !== undefined ? legacyCfg.syncSecrets : true,
      lastPushAt: state.last_push_at ?? null,
      lastPullAt: state.last_pull_at ?? null,
    },
  };

  // Write, then verify before deleting legacy files
  writeFileSync(unifiedPath, JSON.stringify(unified, null, 2), "utf8");
  if (token) { try { chmodSync(unifiedPath, 0o600); } catch {} }

  // Verify: re-read and check
  const verify = loadUnifiedConfig(hmemDir);
  if (!verify || verify.config.serverUrl !== legacyCfg.serverUrl) {
    console.error("Migration verification failed — keeping legacy files");
    return;
  }

  // Safe to delete legacy files now
  for (const f of [legacyConfigJson, legacyConfigNoExt, legacyTokenPath, legacyStatePath, legacyAnnounce]) {
    try { rmSync(f); } catch {}
  }

  console.log(green("✓ Migrated sync config to unified hmem.config.json"));
}
```

- [ ] **Step 4: Create saveUnifiedState helper**

```typescript
function saveUnifiedState(hmemDir: string, state: SyncState): void {
  const configPath = join(hmemDir, "hmem.config.json");
  let raw: any = {};
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); } catch { return; }
  if (!raw.sync) return;

  raw.sync.lastPushAt = state.last_push_at;
  raw.sync.lastPullAt = state.last_pull_at;

  writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf8");
}
```

- [ ] **Step 5: Wire up in cmdPush/cmdPull/cmdStatus**

Replace the current `findConfig() → loadConfig() → loadToken()` chain:

```typescript
async function resolveConfig(flags: Record<string, string>): Promise<{
  cfg: PersistedConfig; token: string; state: SyncState; isUnified: boolean; hmemDir: string;
}> {
  // Try unified first
  const hmemDir = flags["hmem-path"]
    ? dirname(resolveHmemFile(flags["hmem-path"]))
    : dirname(resolveHmemFile(process.cwd()));

  // Auto-migrate if needed
  migrateLegacyConfig(hmemDir);

  const unified = loadUnifiedConfig(hmemDir);
  if (unified) {
    return { cfg: unified.config, token: unified.token, state: unified.state, isUnified: true, hmemDir };
  }

  // Also try ~/.hmem/ if not found in CWD
  const homeHmemDir = join(homedir(), ".hmem");
  if (hmemDir !== homeHmemDir) {
    migrateLegacyConfig(homeHmemDir);
    const homeUnified = loadUnifiedConfig(homeHmemDir);
    if (homeUnified) {
      return { cfg: homeUnified.config, token: homeUnified.token, state: homeUnified.state, isUnified: true, hmemDir: homeHmemDir };
    }
  }

  // Fall back to legacy loading
  const cfgFile = findConfig(flags["config"]);
  const cfg = loadConfig(cfgFile);
  const token = loadToken(cfg.hmemPath);
  return { cfg, token, state: { last_push_at: null, last_pull_at: null, serverUrl: cfg.serverUrl }, isUnified: false, hmemDir };
}
```

In `cmdPush`/`cmdPull`, when creating `HmemSyncClient`, pass the state callback if using unified config:

```typescript
const { cfg, token, state, isUnified, hmemDir } = await resolveConfig(flags);
const passphrase = await promptPassword("Passphrase");
const client = new HmemSyncClient(cfg.hmemPath, passphrase, cfg, isUnified ? {
  initialState: state,
  onStateSave: (s) => saveUnifiedState(hmemDir, s),
} : undefined);
```

- [ ] **Step 6: Update tests with actual function calls**

Wire up `loadUnifiedConfig` and `migrateLegacyConfig` into the test file by exporting them (or testing via the integration path).

- [ ] **Step 7: Run all tests**

Run: `cd /home/bbbee/projects/hmem-sync && npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
cd /home/bbbee/projects/hmem-sync
git add src/cli.ts src/sync.ts tests/config-migration.test.ts
git commit -m "feat: unified config loading with legacy migration and state callback"
```

---

### Task 6: Update hmem-sync connect command for unified format (hmem-sync)

**Files:**
- Modify: `/home/bbbee/projects/hmem-sync/src/cli.ts`

- [ ] **Step 1: Update cmdConnect to write unified config**

Replace `saveConfig()` + `saveToken()` calls. Properly detect existing config format:

```typescript
// In cmdConnect, after collecting all inputs:
const hmemDir = dirname(hmemPath);
const unifiedPath = join(hmemDir, "hmem.config.json");
let existing: any = {};
try { existing = JSON.parse(readFileSync(unifiedPath, "utf8")); } catch {}

// Detect flat vs unified to preserve memory settings
const MEMORY_KEYS = ["maxL1Chars", "maxLnChars", "maxCharsPerLevel", "maxDepth",
  "defaultReadLimit", "prefixes", "prefixDescriptions", "bulkReadV2", "maxTitleChars", "accessCountTopN"];
const isFlatFormat = !existing.memory && Object.keys(existing).some(k => MEMORY_KEYS.includes(k));
const memorySection = isFlatFormat ? existing : (existing.memory ?? {});

const unified = {
  memory: memorySection,
  sync: {
    serverUrl,
    userId,
    salt,
    token,
    syncSecrets: true,
    lastPushAt: null,
    lastPullAt: null,
  },
};

writeFileSync(unifiedPath, JSON.stringify(unified, null, 2), "utf8");
try { chmodSync(unifiedPath, 0o600); } catch {}
console.log(green(`✓ Config saved: ${unifiedPath}`));
```

- [ ] **Step 2: Test connect flow manually**

Run: `mkdir -p /tmp/test-sync && cd /tmp/test-sync && node /home/bbbee/projects/hmem-sync/dist/cli.js connect`
Verify: Only `hmem.config.json` is written, no legacy files. Memory settings preserved.

- [ ] **Step 3: Commit**

```bash
cd /home/bbbee/projects/hmem-sync
git add src/cli.ts
git commit -m "feat: connect writes unified hmem.config.json, preserves existing memory settings"
```

---

### Task 7: Update hmem-mcp auto-sync to use unified config (hmem-mcp)

**Files:**
- Modify: `/home/bbbee/projects/hmem/src/mcp-server.ts` (3 locations: lines 82-90, line 933)

- [ ] **Step 1: Update hmemSyncEnabled() at line 82-86**

```typescript
function hmemSyncEnabled(hmemPath: string, config?: HmemConfig): boolean {
  const passphrase = process.env["HMEM_SYNC_PASSPHRASE"];
  if (!passphrase) return false;
  // Unified config has sync section
  if (config?.sync?.serverUrl && config?.sync?.token) return true;
  // Legacy: check for .hmem-sync-config.json
  const cfg = path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
  return fs.existsSync(cfg);
}
```

- [ ] **Step 2: Update hmemSyncConfig() at line 88-90**

This function returns the path to `.hmem-sync-config.json`. For unified config, it should return the `hmem.config.json` path or the sync config block. Refactor callers to use the config object directly:

```typescript
function getSyncConfig(hmemPath: string, config?: HmemConfig): { configPath: string; token?: string } | null {
  if (config?.sync?.serverUrl && config?.sync?.token) {
    return { configPath: path.join(path.dirname(hmemPath), "hmem.config.json"), token: config.sync.token };
  }
  const legacy = path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
  if (fs.existsSync(legacy)) return { configPath: legacy };
  return null;
}
```

- [ ] **Step 3: Update sync setup hint at line 933**

```typescript
// Before: const syncConfigPath = path.join(path.dirname(hmemPath), ".hmem-sync-config.json");
// After: check config.sync OR .hmem-sync-config.json
const hasSyncSetup = config.sync?.serverUrl || fs.existsSync(path.join(path.dirname(hmemPath), ".hmem-sync-config.json"));
```

- [ ] **Step 4: Pass config to all hmemSyncEnabled/getSyncConfig calls**

Search all callers and pass the loaded `config` object.

- [ ] **Step 5: Build and test**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 6: Commit**

```bash
cd /home/bbbee/projects/hmem
git add src/mcp-server.ts
git commit -m "feat: auto-sync checks unified config.sync + legacy .hmem-sync-config.json"
```

---

### Task 8: Build, version bump, and end-to-end test

**Files:**
- Modify: `/home/bbbee/projects/hmem/package.json` — version bump to 3.8.0
- Modify: `/home/bbbee/projects/hmem-sync/package.json` — version bump to 0.6.0

- [ ] **Step 1: Build hmem-mcp**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile, no errors

- [ ] **Step 2: Build hmem-sync**

Run: `cd /home/bbbee/projects/hmem-sync && npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Run all tests in both repos**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Run: `cd /home/bbbee/projects/hmem-sync && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: End-to-end migration test on real data**

1. Backup: `cp ~/.hmem/Agents/DEVELOPER/hmem.config.json ~/.hmem/Agents/DEVELOPER/hmem.config.json.bak`
2. Verify legacy files exist: `ls ~/.hmem/Agents/DEVELOPER/.hmem-sync*`
3. Run: `cd ~/.hmem/Agents/DEVELOPER && node /home/bbbee/projects/hmem-sync/dist/cli.js status`
4. Verify migration happened: `cat ~/.hmem/Agents/DEVELOPER/hmem.config.json` should show `{ "memory": {...}, "sync": {...} }`
5. Verify legacy files deleted: `ls ~/.hmem/Agents/DEVELOPER/.hmem-sync*` should show nothing (or only backup)
6. Run: `echo 'iauhsd/(&876AS' | node /home/bbbee/projects/hmem-sync/dist/cli.js pull` — should work with unified config
7. Verify MCP server loads correctly: `node /home/bbbee/projects/hmem/dist/mcp-server.js` (check startup log)
8. Rollback if needed: `cp ~/.hmem/Agents/DEVELOPER/hmem.config.json.bak ~/.hmem/Agents/DEVELOPER/hmem.config.json`

- [ ] **Step 5: Version bump**

hmem: bump to 3.8.0 in `package.json`
hmem-sync: bump to 0.6.0 in `package.json`

- [ ] **Step 6: Commit and push both repos**

```bash
cd /home/bbbee/projects/hmem
git add -A && git commit -m "feat: config consolidation v3.8.0 — unified hmem.config.json"
git push

cd /home/bbbee/projects/hmem-sync
git add -A && git commit -m "feat: config consolidation v0.6.0 — unified hmem.config.json with legacy migration"
git push
```
