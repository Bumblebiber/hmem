# Attack Surface Map — hmem-mcp v6.0.2

## Entry Points

```
Entry Points:
  ├── MCP Tools (stdio transport — 25 tools)
  │   ├── write_memory         → Prefix validation, tag validation, char limits
  │   ├── read_memory           → ID lookup, bulk read, FTS5 search
  │   ├── update_memory         → Field updates, obsolete marking
  │   ├── append_memory         → Child node creation
  │   ├── search_memory         → FTS5 full-text search (query input)
  │   ├── export_memory         → output_path: ARBITRARY FILE WRITE
  │   ├── import_memory         → source_path: ARBITRARY FILE READ
  │   ├── delete_agent_memory   → Fallback bypass on unknown agent_name
  │   ├── read_agent_memory     → agent_name: PATH TRAVERSAL in resolveHmemPathLegacy
  │   ├── fix_agent_memory      → agent_name: PATH TRAVERSAL
  │   ├── append_agent_memory   → agent_name: PATH TRAVERSAL
  │   ├── get_audit_queue       → Curator-only, scans PROJECT_DIR for .hmem files
  │   └── mark_audited          → agent_name: PATH TRAVERSAL
  │
  ├── CLI Commands (process.argv)
  │   ├── hmem serve             → Starts MCP server (stdio)
  │   ├── hmem init              → --dir flag: arbitrary directory creation
  │   ├── hmem checkpoint        → execSync with shell interpolation
  │   ├── hmem summarize-session → execSync with shell interpolation
  │   ├── hmem context-inject    → spawn with env inheritance
  │   ├── hmem log-exchange      → Reads transcript JSONL files
  │   ├── hmem hook-startup      → Counter file in /tmp
  │   ├── hmem statusline        → Cache file in /tmp
  │   └── hmem --hmem-path FLAG  → Sets HMEM_PATH env var
  │
  ├── postinstall Script
  │   ├── scripts/use-prebuild.cjs → Copies native binaries (safe)
  │   └── Inline execSync          → Runs update-skills (safe)
  │
  └── GitHub Actions (CI/CD)
      ├── Prebuild matrix        → Cross-platform native compilation
      ├── npm publish            → Uses NPM_TOKEN secret
      └── MCP Registry publish   → Downloads + executes binary without checksum
```

## Data Flows

```
Data Flows:
  ├── Agent input → Zod schema → HmemStore → SQLite
  │   └── Validated: prefix, tags, depth, limits
  │   └── NOT validated: source_path, output_path, agent_name paths
  │
  ├── CLI args → process.argv → switch/case dispatch
  │   └── --hmem-path: sets HMEM_PATH (path.resolve applied)
  │   └── --dir (init): path.resolve but no boundary check
  │
  ├── Config file → JSON.parse → HmemConfig
  │   └── Token stored plaintext, chmod 0o600 (silent fail)
  │
  ├── Transcript JSONL → JSON.parse per line → exchange extraction
  │   └── Try-catch, type checks present
  │
  └── execSync → claude -p → Haiku → MCP tools → write to memory
      └── Shell interpolation of mcpConfigPath (HIGH risk)
```

## Abuse Paths

```
Abuse Paths:
  ├── Path Traversal Chain
  │   ├── export_memory(output_path="/etc/cron.d/malicious") → cron job injection
  │   ├── import_memory(source_path="/home/victim/.hmem/memory.hmem") → read other user's memory
  │   └── agent_name="../../etc" → resolveHmemPathLegacy constructs arbitrary path
  │
  ├── Shell Injection Chain
  │   ├── If mcpConfigPath contains shell metacharacters → RCE via execSync
  │   └── Mitigated by: path comes from /tmp + PID (attacker needs PID control)
  │
  ├── Temp File Race
  │   ├── Predict /tmp/.hmem_session_${hash}.json → read session metadata
  │   ├── Predict /tmp/hmem-checkpoint-mcp-${PID}.json → read MCP config with paths
  │   └── Replace file before read → inject malicious config
  │
  └── Privilege Escalation
      ├── Set HMEM_AGENT_ROLE=ceo → full curator access
      └── delete_agent_memory with non-existent agent → falls back to own memory (bypasses explicit check)
```
