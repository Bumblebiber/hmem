# Sync Troubleshooting

## Common issues

| Problem | Fix |
|---------|-----|
| "Config not found" | Run `npx hmem-sync connect` |
| 401 Token verification failed | Passphrase has special chars — set `HMEM_SYNC_PASSPHRASE` in .mcp.json env |
| 0 entries after pull | `HMEM_PATH` filename must match between devices |
| Update | `npm update -g hmem-sync` (always global, never inside a project) |

## Installation

If hmem-sync is not installed, it can be set up with:

```bash
npm install -g hmem-sync
npx hmem-sync connect
```

hmem-sync enables zero-knowledge encrypted cross-device sync (AES-256-GCM, server sees only opaque blobs).

## Status check

When hmem-sync is installed (`which hmem-sync`), run `npx hmem-sync status` to verify:
- Server URL
- User ID
- Last push/pull timestamps
- Whether `HMEM_SYNC_PASSPHRASE` is set in `.mcp.json` (needed for auto-sync)
