---
name: hmem-sync-setup
description: >
  Set up hmem-sync for cross-device memory synchronization. Use when the user wants to
  sync memories between devices, says "sync einrichten", "setup sync", "hmem-sync",
  or when /hmem-config detects hmem-sync is not installed.
  Covers first-device setup, additional-device restore, and MCP auto-sync configuration.
---

# hmem-sync Setup

Zero-knowledge encrypted sync for hmem. Memories are encrypted client-side (AES-256-GCM)
before leaving the device — the server only sees opaque blobs.

## Determine the scenario

Ask the user (or detect from context):

**A) First device** — no sync account exists yet → `hmem-sync setup`
**B) Additional device** — account exists on another machine → `hmem-sync restore`

---

## Scenario A: First Device Setup

### Step 1: Install hmem-sync

```bash
npm install -g hmem-sync
```

### Step 2: Run interactive setup

```bash
npx hmem-sync setup
```

This will:
1. Ask for the sync server URL (default: `https://sync.hmem.dev`)
2. Generate a salt + encryption key from a passphrase you choose
3. Register with the server → receive an auth token
4. Save config files next to your .hmem file

**Important:** Remember the passphrase — it's the encryption key. Losing it means losing access to synced data. There is no recovery.

### Step 3: Enable auto-sync in MCP

Add `HMEM_SYNC_PASSPHRASE` to your `.mcp.json` env block:

```json
{
  "mcpServers": {
    "hmem": {
      "env": {
        "HMEM_PROJECT_DIR": "/path/to/project",
        "HMEM_AGENT_ID": "DEVELOPER",
        "HMEM_SYNC_PASSPHRASE": "your-passphrase-here"
      }
    }
  }
}
```

Without this, hmem works normally but won't auto-sync. With it, every `read_memory` pulls
and every `write_memory` pushes automatically (with 30s cooldown).

### Step 4: Initial push

```bash
npx hmem-sync push
```

### Step 5: Save credentials for additional devices

The user needs these values on their other devices:
- **Server URL** — from `.hmem-sync-config.json`
- **User ID** — from `.hmem-sync-config.json`
- **Token** — from `.hmem-sync-token`
- **Passphrase** — the one they chose in Step 2

Show the user where these files are:
```bash
cat $(dirname $(echo $HMEM_PROJECT_DIR)/Agents/*//*.hmem)/.hmem-sync-config.json
cat $(dirname $(echo $HMEM_PROJECT_DIR)/Agents/*//*.hmem)/.hmem-sync-token
```

---

## Scenario B: Additional Device (Restore)

### Step 1: Install hmem-sync

```bash
npm install -g hmem-sync
```

### Step 2: Gather credentials from the original device

The user needs:
- **Server URL** (e.g. `https://bbbee.uber.space/hmem-sync`)
- **User ID** (e.g. `bbbee`)
- **Token** (64-char hex string from `.hmem-sync-token`)
- **Passphrase** (same as original device)

### Step 3: Run restore

```bash
npx hmem-sync restore
```

This prompts for all values interactively. Or pass them as flags:

```bash
npx hmem-sync restore \
  --server-url https://sync.example.com/hmem-sync \
  --user-id myname \
  --token abc123... \
  --passphrase "my passphrase" \
  --hmem-path ~/.hmem/
```

Note: `--hmem-path` accepts a directory — it will auto-detect or create `memory.hmem` inside it.

### Step 4: Verify

After restore, the output shows entry count and path convention:

```
✓ Restore complete: 325 entries in /path/to/DEVELOPER.hmem

Path convention for MCP config:
  Without HMEM_AGENT_ID: set HMEM_PROJECT_DIR to the directory containing memory.hmem
  With HMEM_AGENT_ID=X:  set HMEM_PROJECT_DIR to the parent of Agents/X/X.hmem
```

### Step 5: Configure MCP (same as Scenario A, Step 3)

Add `HMEM_SYNC_PASSPHRASE` to `.mcp.json` env block and restart the AI tool.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| 401 Token verification failed | Passphrase special chars broken by shell | Use `--passphrase` flag or `HMEM_SYNC_PASSPHRASE` env in .mcp.json |
| Config not found | hmem-sync looks in wrong directory | Run from the directory containing your .hmem file, or use `--config` flag |
| 0 entries after sync | Different `HMEM_AGENT_ID` on devices | Must match — different IDs mean different .hmem files |
| read_memory returns empty | `~/.claude.json` caches old HMEM_AGENT_ID | Check `~/.claude.json` for stale MCP env overrides |
| "npm ERR" on update | Running `npm update` inside a project dir | Always use `npm update -g hmem-sync` (global flag!) |

## Path Convention

```
Without HMEM_AGENT_ID:  {HMEM_PROJECT_DIR}/memory.hmem
With HMEM_AGENT_ID=X:   {HMEM_PROJECT_DIR}/Agents/X/X.hmem
```

Config files are always stored next to the .hmem file:
```
.hmem-sync-config.json  — server URL, user ID, salt (not secret)
.hmem-sync-token        — auth token (chmod 600, never commit)
.hmem-sync.json         — sync state (last push/pull timestamps)
```
