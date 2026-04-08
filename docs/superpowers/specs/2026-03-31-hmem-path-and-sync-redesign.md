# hmem Path Resolution & Sync Redesign

**Date:** 2026-03-31
**Status:** Draft
**Affects:** hmem-mcp (hmem-store.ts, mcp-server.ts, cli-*.ts), hmem-sync (cli.ts, sync.ts)

## Problem

The current system uses `HMEM_AGENT_ID` to derive file paths via magic resolution (`Agents/NAME/NAME.hmem`). This causes:

- **Sync confusion**: hmem-sync doesn't know which file to write to on pull (E0110)
- **Config sprawl**: multiple config files with different passphrases/salts per device
- **Fragile path logic**: `resolveHmemPath()` checks `Agents/`, `Assistenten/`, falls back to `memory.hmem`
- **Unnecessary complexity**: `min_role` permission system unused in practice
- **Setup friction**: every new device needs `HMEM_AGENT_ID`, correct `HMEM_PROJECT_DIR`, matching sync config

## Solution

Replace `HMEM_AGENT_ID` + magic path resolution with explicit `HMEM_PATH`. Sync identity = filename. One passphrase per account.

## 1. Path Resolution

### Priority Order

| Priority | Source | Example |
|----------|--------|---------|
| 1 | `HMEM_PATH` env var | `~/AGENTS/Thor/Thor.hmem` |
| 2 | `.hmem` file in CWD | `./project.hmem` |
| 3 | `~/.hmem/` default | `~/.hmem/memory.hmem` |

### Rules

- `HMEM_PATH` is an absolute path to a `.hmem` file. If set, always wins.
- CWD discovery: glob for `*.hmem` in working directory. If exactly one found, use it. If multiple found, error with list (user must set `HMEM_PATH`).
- Default fallback: `~/.hmem/memory.hmem` (created on first write if missing).
- `company.hmem` always lives at `~/.hmem/company.hmem` regardless of which personal hmem is active.

### Typical Setups

**Single developer (simple):**
```
~/.hmem/
  developer.hmem     <- personal memory
  company.hmem       <- shared knowledge
  hmem.config.json   <- sync config
```

MCP config:
```json
{
  "command": "hmem",
  "env": { "HMEM_PATH": "~/.hmem/developer.hmem" }
}
```

**Multi-agent (Heimdall CLI):**
```
~/AGENTS/
  Thor/
    Thor.hmem         <- Thor's personal memory
  Loki/
    Loki.hmem         <- Loki's personal memory
~/.hmem/
  company.hmem        <- shared, both agents read/write
  hmem.config.json
```

Each agent's MCP config:
```json
{ "env": { "HMEM_PATH": "~/AGENTS/Thor/Thor.hmem" } }
{ "env": { "HMEM_PATH": "~/AGENTS/Loki/Loki.hmem" } }
```

**Project-local hmem:**
```
~/projects/my-project/
  project.hmem        <- discovered via CWD
```
No env var needed -- hmem-mcp finds it automatically.

## 2. Sync Redesign

### Core Principle: Filename = Sync Identity

The server stores blobs namespaced by `userId` + `filename`. A file named `developer.hmem` on Device A syncs with `developer.hmem` on Device B.

```
Server (bbbee):
  developer.hmem  ->  [encrypted blobs]
  Thor.hmem       ->  [encrypted blobs]
  company.hmem    ->  [encrypted blobs]
```

### One Account, One Key

Per account:
- One `passphrase` (user-chosen, stored in keychain or env)
- One `salt` (generated at setup, shared across devices)
- One `auth token` (for server authentication)

No per-file or per-device keys.

### Config: `~/.hmem/hmem.config.json`

Single config file, replaces all `.hmem-sync-*.json` files:

```json
{
  "memory": {
    "maxL1Chars": 200,
    "checkpointMode": "auto"
  },
  "sync": {
    "serverUrl": "https://bbbee.uber.space/hmem-sync",
    "userId": "bbbee",
    "salt": "dAfLAQRRkJn0ReiHQ14BeVpMIduDQVV83AbQKnZKAso=",
    "token": "5bdeff5fc60723206f384b69adb68af582a0c21ac6af5225a613849efe405391"
  },
  "files": [
    "~/.hmem/developer.hmem",
    "~/AGENTS/Thor/Thor.hmem",
    "~/.hmem/company.hmem"
  ]
}
```

- `files`: list of hmem files to sync. Each is pushed/pulled by its filename.
- `sync`: single set of credentials for all files.
- No `lastPushAt`/`lastPullAt` in config -- moved to server response or per-file state inside the hmem DB itself.

### Push/Pull Flow

**Push:**
```
for each file in config.files:
  filename = basename(file)        // "developer.hmem"
  entries = getModifiedSince(file, lastPushAt)
  blobs = encrypt(entries, passphrase, salt)
  POST /push/{userId}/{filename}   // server namespaces by filename
```

**Pull:**
```
for each file in config.files:
  filename = basename(file)
  blobs = GET /pull/{userId}/{filename}
  entries = decrypt(blobs, passphrase, salt)
  merge(file, entries)
```

### New Device Setup

```bash
hmem-sync connect
# 1. Asks for server URL
# 2. Asks for passphrase
# 3. Downloads file list from server
# 4. Asks which files to sync (all / select)
# 5. Creates ~/.hmem/hmem.config.json
# 6. Pulls all selected files to ~/.hmem/ (or custom paths)
```

No salt exchange needed -- salt is stored on server per user and returned during connect.

## 3. Removals

### `HMEM_AGENT_ID` / `COUNCIL_AGENT_ID`

Removed entirely. All references in:
- `mcp-server.ts` (line 43)
- `cli-context-inject.ts` (line 43)
- `cli-checkpoint.ts` (line 70)
- `cli-session-summary.ts` (line 59)
- `cli-migrate-o.ts` (line 24)

Replaced by: derive filename from `HMEM_PATH` or CWD discovery.

### `min_role`

Removed from:
- `memories` table schema
- `write_memory` tool parameter
- `update_memory` tool parameter
- `read_memory` filtering logic
- `mcp-server.ts` rendering (line 2269)

Migration: drop column (SQLite requires table rebuild).

### `resolveHmemPath(projectDir, templateName)`

Replaced by:
```typescript
function resolveHmemPath(): string {
  if (process.env.HMEM_PATH) return resolve(expandHome(process.env.HMEM_PATH));
  const cwdFiles = glob.sync("*.hmem", { cwd: process.cwd() });
  if (cwdFiles.length === 1) return resolve(cwdFiles[0]);
  if (cwdFiles.length > 1) throw new Error(`Multiple .hmem files in CWD: ${cwdFiles.join(", ")}. Set HMEM_PATH.`);
  return resolve(homedir(), ".hmem", "memory.hmem");
}
```

### `Agents/NAME/NAME.hmem` directory structure

No longer required. Files can live anywhere. Migration moves files to `~/.hmem/` and updates config.

### Config files removed

- `~/.hmem/Agents/DEVELOPER/.hmem-sync-strato.json`
- `~/.hmem/Agents/DEVELOPER/.hmem-sync-strato-token`
- `~/.hmem-sync-strato/.hmem-sync-config.json`
- `~/.hmem-sync-strato/.hmem-sync-token`

All replaced by single `~/.hmem/hmem.config.json`.

## 4. company.hmem

- Always at `~/.hmem/company.hmem`
- Synced like any other file (filename = `company.hmem`)
- All agents on the machine can read/write via `store: "company"` parameter (unchanged)
- Discovery: hardcoded path `~/.hmem/company.hmem`, no env var needed

## 5. Migration

### Phase 1: hmem-mcp

1. Add `HMEM_PATH` env var support
2. New `resolveHmemPath()` (3-step priority)
3. Remove `HMEM_AGENT_ID` / `COUNCIL_AGENT_ID` references
4. Remove `min_role` from schema + tools
5. Keep `resolveHmemPath(projectDir, templateName)` as deprecated wrapper (logs warning, maps to new logic)

### Phase 2: hmem-sync

1. Filename-based sync namespace on server
2. `files` array in config
3. Single passphrase/salt/token per account
4. `hmem-sync connect` wizard
5. Server stores salt per user (no manual salt exchange)
6. `lastPushAt`/`lastPullAt` per file, stored in hmem DB (new `hmem_sync_state` table)

### Phase 3: Cleanup

1. Remove `Agents/` directory structure support
2. Remove legacy config file detection
3. Update all skills (hmem-sync-setup, hmem-migrate-o, hmem-config)
4. Update CLAUDE.md / AGENTS.md templates

## 6. Affected Files

### hmem-mcp

| File | Changes |
|------|---------|
| `src/hmem-store.ts` | New `resolveHmemPath()`, remove old version + `openAgentMemory()`. Drop `min_role` from schema. Add `hmem_sync_state` table. |
| `src/mcp-server.ts` | Remove `HMEM_AGENT_ID`, `min_role` from tools, update path resolution |
| `src/cli-context-inject.ts` | Remove `HMEM_AGENT_ID`, use `HMEM_PATH` |
| `src/cli-checkpoint.ts` | Remove `HMEM_AGENT_ID`, use `HMEM_PATH` |
| `src/cli-session-summary.ts` | Remove `HMEM_AGENT_ID`, use `HMEM_PATH` |
| `src/cli-log-exchange.ts` | Update path resolution |
| `src/cli-statusline.ts` | Update path resolution |
| `src/cli-migrate-o.ts` | Remove `HMEM_AGENT_ID`, use `HMEM_PATH` |

### hmem-sync

| File | Changes |
|------|---------|
| `src/cli.ts` | Filename-based namespacing, `files` array, new `connect` wizard, remove multi-config logic |
| `src/sync.ts` | Per-file push/pull with filename namespace |
| `src/server.ts` | New routes: `/push/{userId}/{filename}`, `/pull/{userId}/{filename}`, salt storage per user |

### Skills

| Skill | Changes |
|-------|---------|
| `hmem-create-agent` | **New.** Interactive wizard to create a new agent: name, hmem path, specialization/system-prompt, optional sync registration. Creates the `.hmem` file, adds to `hmem.config.json` `files` array, generates MCP config snippet for the user's editor. |
| `hmem-sync-setup` | Rewrite to use new single-config model. `hmem-sync connect` wizard. |
| `hmem-setup` | Update: no more `HMEM_AGENT_ID`, use `HMEM_PATH`. Simplified first-run. |
| `hmem-config` | Update: reflect new config structure, remove agent-id references. |
| `hmem-migrate-o` | Minor: remove `HMEM_AGENT_ID` usage. |

## 7. New Skill: hmem-create-agent

Creates a new specialized agent with its own memory.

### Interactive Flow

```
1. "Agent name?" → e.g. "Frontend"
2. "Where should the hmem live?"
   → Default: ~/.hmem/frontend.hmem
   → Custom: ~/AGENTS/Frontend/frontend.hmem
3. "Specialization?" → e.g. "React/Next.js frontend development"
   → Writes initial P0001 entry with specialization context
4. "Sync this agent's memory?" (y/n)
   → Yes: adds path to hmem.config.json files array
   → Pushes empty initial state to server
5. Output: MCP config snippet for .mcp.json / settings.json
```

### Output Example

```
Agent "Frontend" created:
  Memory: ~/.hmem/frontend.hmem
  Sync:   enabled (filename: frontend.hmem)

Add to your editor's MCP config:
  {
    "hmem": {
      "command": "hmem",
      "env": { "HMEM_PATH": "~/.hmem/frontend.hmem" }
    }
  }
```
