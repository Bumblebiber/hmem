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

## Recommended: Use `hmem-sync connect`

The `connect` command replaces `setup` and `restore` with a single smart wizard:

```bash
npx hmem-sync connect
```

It automatically:
1. Asks for credentials (new account or existing)
2. Detects local DB + server data
3. Shows entry counts on both sides
4. Asks the user what to sync (push, pull, merge, or skip)
5. Verifies the result

**Custom / Self-hosted servers:** The `--server-url` flag accepts any hmem-sync compatible
server, not just the default. Examples: `https://yourdomain.com/hmem-sync` for a self-hosted
instance, or `http://localhost:3100` for a local development server.

For non-interactive use:
```bash
# New account
npx hmem-sync connect --user-id myname --passphrase "pass" --hmem-path ~/.hmem/memory.hmem

# Existing account
npx hmem-sync connect --user-id myname --passphrase "pass" --token abc123... --hmem-path ~/.hmem/memory.hmem

# Custom server
npx hmem-sync connect --server-url http://localhost:3100 --user-id myname --passphrase "pass" --hmem-path ~/.hmem/memory.hmem
```

The legacy `setup` and `restore` commands still work for backwards compatibility.

## Legacy: Determine the scenario

If not using `connect`, pick manually:

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
        "HMEM_PATH": "/path/to/your/memory.hmem",
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

Show the user where these files are (in the same directory as your .hmem file):
```bash
cat "$(dirname "$HMEM_PATH")/.hmem-sync-config.json"
cat "$(dirname "$HMEM_PATH")/.hmem-sync-token"
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
  --hmem-path ~/.hmem/memory.hmem
```

**IMPORTANT:** The `--hmem-path` must point to the exact .hmem file path.
The filename is used as identity for sync — it must match across devices.

### Step 4: Verify

After restore, the output shows entry count and path:

```
✓ Restore complete: 325 entries in ~/.hmem/memory.hmem

Set HMEM_PATH in your .mcp.json to this path.
```

### Step 5: Configure MCP (same as Scenario A, Step 3)

Add `HMEM_SYNC_PASSPHRASE` to `.mcp.json` env block and restart the AI tool.

---

## Urgent Announcements

Broadcast messages to all synced devices. Each device sees announcements once on the next pull.

### When to send

- Server migration (new URL, DNS change)
- Breaking config changes (e.g. "update maxL1Chars to 200")
- Security issues (compromised token, rotate credentials)
- Coordinated action needed across all devices

### How to send

```bash
# From the directory containing .hmem-sync-config.json:
npx hmem-sync announce --message "Server URL changing to https://new-server/hmem-sync"

# Or via curl:
curl -X POST https://server/hmem-sync/announcements \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Your urgent message here"}'
```

### How to edit or delete

```bash
# List all announcements:
curl -s https://server/hmem-sync/announcements -H "Authorization: Bearer $TOKEN"

# Edit (by ID from list):
curl -X PUT https://server/hmem-sync/announcements/2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Corrected message"}'

# Delete:
curl -X DELETE https://server/hmem-sync/announcements/2 \
  -H "Authorization: Bearer $TOKEN"
```

### When you RECEIVE an announcement

Announcements appear as yellow warnings before pull output. They indicate urgent action is needed.

**Act on them immediately — before any other work.** Do not write to memory, do not start tasks.
Read the message, execute the requested action (config change, URL update, etc.), verify it worked,
then continue with normal work.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| 401 Token verification failed | Passphrase special chars broken by shell | Use `--passphrase` flag or `HMEM_SYNC_PASSPHRASE` env in .mcp.json |
| Config not found | hmem-sync looks in wrong directory | Run from the directory containing your .hmem file, or use `--config` flag |
| 0 entries after sync | Different `HMEM_PATH` filename on devices | Filename must match — it's used as sync identity |
| read_memory returns empty | `~/.claude.json` caches old HMEM_PATH | Check `~/.claude.json` for stale MCP env overrides |
| "npm ERR" on update | Running `npm update` inside a project dir | Always use `npm update -g hmem-sync` (global flag!) |

## Path Convention

```
HMEM_PATH points directly to the .hmem file (e.g. ~/.hmem/memory.hmem)
The parent directory is derived automatically.
```

Config files are always stored next to the .hmem file:
```
.hmem-sync-config.json  — server URL, user ID, salt (not secret)
.hmem-sync-token        — auth token (chmod 600, never commit)
.hmem-sync.json         — sync state (last push/pull timestamps)
```

## Multi-Server Sync

For redundancy, you can configure multiple servers in `hmem.config.json` as an array.
hmem-sync will push to and pull from all configured servers, so data survives if one
server goes down. See the hmem-sync README for the exact schema.
