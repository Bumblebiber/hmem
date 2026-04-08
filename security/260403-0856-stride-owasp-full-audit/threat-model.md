# Threat Model — hmem-mcp v6.0.2

**Date:** 2026-04-03
**Scope:** Full codebase (`src/**/*.ts`, `scripts/`, CI/CD)

## Assets

| Asset | Type | Priority | Description |
|-------|------|----------|-------------|
| SQLite .hmem databases | Data store | Critical | Contains all user memories, project data, personal notes |
| hmem-sync tokens | Credential | Critical | Bearer tokens for cross-device sync (SHA-256 hash in DB) |
| hmem.config.json | Configuration | High | Contains sync server URLs, tokens (plaintext), salt |
| MCP tool interface | API surface | High | 25+ tools exposed to AI agents via stdio |
| Curator tools | Privileged API | High | Cross-agent memory access (read/write/delete other agents) |
| /tmp state files | Temp storage | Medium | Session state, statusline cache, checkpoint configs |
| CLI subcommands | Entry point | Medium | 10 CLI commands with file/process operations |
| npm package | Supply chain | Medium | Published to npm, installed globally by users |

## Trust Boundaries

```
Trust Boundaries:
  ├── AI Agent ←→ MCP Server (stdio transport, tool schema validation)
  ├── MCP Server ←→ SQLite (application ←→ data layer)
  ├── MCP Server ←→ hmem-sync (local server, Bearer token auth)
  ├── Worker role ←→ CEO/Curator role (env var HMEM_AGENT_ROLE)
  ├── CLI hooks ←→ Claude CLI (execSync with shell interpolation)
  ├── npm postinstall ←→ User system (script runs on install)
  └── Local filesystem ←→ /tmp (world-readable temp files)
```

## STRIDE Threat Matrix

### Spoofing

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| Env var role spoofing | HMEM_AGENT_ROLE | Medium | Role check is `process.env.HMEM_AGENT_ROLE === "ceo"` — any process setting this env var gains curator access |
| Agent name impersonation | Curator tools | Medium | `agent_name` parameter is unchecked — curator can access any agent by guessing template name |

### Tampering

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| Path traversal via export_memory | File system | High | `output_path` is user-controlled, no validation — can write to arbitrary locations |
| Path traversal via import_memory | File system | High | `source_path` is user-controlled, no validation — can read arbitrary SQLite files |
| SQL anti-pattern in LIMIT clause | SQLite | Low | `LIMIT ${limit}` string interpolation, but Zod validates as number — not exploitable |
| Hardcoded tag concatenation in SQL | SQLite | Low | Tags are hardcoded strings, not user input — fragile pattern, not currently exploitable |

### Repudiation

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| No audit log for destructive ops | Memory entries | Medium | delete, update, import have no audit trail beyond SQLite journal |
| Session state in /tmp | Temp files | Low | State files can be deleted/modified by any local user |

### Information Disclosure

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| Error messages leak paths | MCP responses | Medium | `ERROR: ${e}` pattern returns raw exception to agent |
| /tmp files world-readable | Session state | Medium | Predictable paths, no restrictive permissions |
| Sync server URL in stderr | hmem-sync config | Low | Error logs include `serverUrl` |
| import_memory confirms path existence | File system | Low | Returns "Source file not found: {path}" |

### Denial of Service

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| No rate limiting on MCP tools | Server | Low | MCP runs via stdio (single-agent), no concurrent access |
| FTS5 search with pathological input | SQLite | Low | Quote stripping prevents FTS injection, but no length limit on search terms |

### Elevation of Privilege

| Threat | Asset | Risk | Status |
|--------|-------|------|--------|
| delete_agent_memory fallback bypass | Curator check | Medium | Falls back to HMEM_PATH when agent path not found, allowing non-curator self-deletion without explicit check |
| Shell injection via execSync | System | High | `cli-checkpoint.ts:228` and `cli-session-summary.ts:97` interpolate paths into shell command strings |
| Deprecated min_role column unused | Authorization | Low | Role column exists but is never enforced in read/write |
