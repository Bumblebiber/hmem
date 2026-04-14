# Version-Specific Migrations

## v6.0.0 — HMEM_PATH Migration

v6.0.0 replaced `HMEM_PROJECT_DIR` + `HMEM_AGENT_ID` with a single `HMEM_PATH` env var.

### Check if migration is needed

1. Look at the user's `.mcp.json` or `~/.claude.json` for hmem env vars
2. If you see `HMEM_PROJECT_DIR` and/or `HMEM_AGENT_ID` — migration needed

### Migration steps

1. Determine the current .hmem file path:
   - With agent ID: `{HMEM_PROJECT_DIR}/Agents/{HMEM_AGENT_ID}/{HMEM_AGENT_ID}.hmem`
   - Without: `{HMEM_PROJECT_DIR}/memory.hmem`

2. Update MCP config — replace old env vars with `HMEM_PATH`:
   ```json
   {
     "env": {
       "HMEM_PATH": "/absolute/path/to/your/file.hmem"
     }
   }
   ```
   Remove `HMEM_PROJECT_DIR`, `HMEM_AGENT_ID`, and `HMEM_AGENT_ROLE` from the env block.

3. The .hmem file does NOT need to move — `HMEM_PATH` points to it wherever it is.

4. If hmem-sync is installed, also update to v1.0.0+ (`npm update -g hmem-sync`).
   The `--agent-id` flag was removed — use `--hmem-path` or `HMEM_PATH` instead.

5. **CRITICAL — Sync filename must match across all devices:**
   hmem-sync identifies stores by the local filename (e.g. `DEVELOPER.hmem`). If Device A
   syncs as `DEVELOPER.hmem` and Device B syncs as `memory.hmem`, they will NOT see each
   other's data — the server treats them as separate stores.

   **Check:** Run `hmem-sync status` on each device. The "hmem file" line shows the filename
   that will be used for sync. All devices sharing the same memory MUST use the same filename.

   **Common mistake after v6.0 migration:** Devices that used `HMEM_AGENT_ID=DEVELOPER`
   have `DEVELOPER.hmem`. New devices default to `memory.hmem`. These will not sync.

   **Fix:** Rename the .hmem file on the mismatched device:
   ```bash
   mv ~/.hmem/memory.hmem ~/.hmem/DEVELOPER.hmem
   # or: mv ~/.hmem/memory.hmem ~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem
   ```
   Then update `HMEM_PATH` in the MCP config to point to the renamed file.

### Also removed in v6.0.0

- `min_role` parameter from `write_memory` and `update_memory` tools
- Company store role gating (all agents can now write to company store)
- `HMEM_AGENT_ROLE` / `COUNCIL_AGENT_ROLE` env vars

---

## v5.1.2 — Checkpoint Summaries and Skill-Dialog Tags

### Checkpoint Summaries

O-entries with >10 exchanges should have `[CP]` checkpoint summaries. Check recent O-entries:

```
read_memory(prefix="O")
```

If summaries are missing, write them:

```
append_memory(id="O00XX", content="\t[CP] Factual 3-8 sentence summary of the session")
```

### Skill-Dialog Tags

Exchanges containing skill activations should be tagged `#skill-dialog`. These are auto-tagged by the checkpoint process going forward. For old exchanges, the checkpoint auto-tagger picks them up on the next run.

---

## v5.1.0 — Title/Body Separation

Entries support title/body separation via blank line (title shown in listings, body on drill-down). Check if old entries need title/body split:

```
read_memory(titles_only=true)
```

Look for entries where the title is truncated mid-word or contains too much detail. Fix with:

```
update_memory(id="L0042", content="Clear title\n\nDetailed body text")
```
