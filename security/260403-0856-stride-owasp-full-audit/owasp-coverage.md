# OWASP Top 10 Coverage — hmem-mcp v6.0.2

| ID | Category | Tested | Findings | Status |
|----|----------|--------|----------|--------|
| A01 | Broken Access Control | Yes | 4 | Warning: path traversal in export/import, agent_name, delete fallback |
| A02 | Cryptographic Failures | Yes | 1 | Warning: plaintext tokens in config |
| A03 | Injection | Yes | 4 | Warning: execSync shell injection (2), SQL anti-patterns (2, not exploitable) |
| A04 | Insecure Design | Yes | 0 | Clean: MCP stdio is single-agent by design |
| A05 | Security Misconfiguration | Yes | 2 | Warning: /tmp files, error message leakage |
| A06 | Vulnerable Components | Yes | 3 | Warning: hono, express-rate-limit, path-to-regexp (transitive) |
| A07 | Auth & Identification | Yes | 1 | Warning: env var role check |
| A08 | Software & Data Integrity | Yes | 0 | Clean: no deserialization of untrusted data, postinstall is safe |
| A09 | Logging & Monitoring | Yes | 1 | Warning: no audit trail for destructive operations |
| A10 | SSRF | Yes | 0 | Clean: no outbound HTTP requests from MCP server |

## Per-Category Details

### A01 — Broken Access Control
- [x] Path traversal on file operations — **FOUND** (export_memory, import_memory)
- [x] Missing authorization middleware — **FOUND** (agent_name not validated)
- [x] Horizontal privilege escalation — **FOUND** (delete_agent_memory fallback)
- [x] Vertical privilege escalation — Partial (env var role check)
- [x] CORS misconfiguration — N/A (stdio transport, no HTTP)
- [x] IDOR on parameterized routes — N/A (no HTTP routes)
- [x] Function-level access control — Curator check present but env-based

### A02 — Cryptographic Failures
- [x] Sensitive data in plaintext — **FOUND** (sync tokens in config)
- [x] Weak hashing — Clean (SHA-256 for sync tokens in DB)
- [x] Hardcoded secrets — Clean (none found)
- [x] Weak random — Clean (randomBytes(32) for tokens)
- [x] Exposed .env — Clean (no .env files used)

### A03 — Injection
- [x] SQL injection — **FOUND** (LIMIT anti-pattern, not exploitable; hardcoded tag concat)
- [x] Command injection — **FOUND** (execSync with interpolation in 2 files)
- [x] XSS — N/A (no web UI)
- [x] Template injection — N/A
- [x] Path injection — Covered under A01

### A04 — Insecure Design
- [x] Rate limiting — N/A (stdio, single agent)
- [x] Race conditions — Low risk (SQLite transactions mitigate)
- [x] CSRF — N/A (no HTTP)
- [x] Predictable identifiers — Low (sequential IDs are visible but not exploitable in MCP context)

### A05 — Security Misconfiguration
- [x] Debug mode — Clean
- [x] Default credentials — Clean
- [x] Verbose errors — **FOUND** (raw exceptions returned to agent)
- [x] Missing security headers — N/A (no HTTP)
- [x] Stack traces — **FOUND** (via `ERROR: ${e}` pattern)

### A06 — Vulnerable and Outdated Components
- [x] npm audit — **FOUND** (4 HIGH via transitive deps)
- [x] Outdated frameworks — Clean (Node 18+, TypeScript 5.9)
- [x] Prototype pollution in deps — **FOUND** (hono)

### A07 — Identification and Authentication Failures
- [x] Weak password policies — N/A
- [x] Session fixation — N/A
- [x] JWT vulnerabilities — N/A
- [x] Auth mechanism — **FOUND** (env var only, no per-request auth)

### A08 — Software and Data Integrity Failures
- [x] CI/CD integrity — Acceptable (GitHub Actions with secrets)
- [x] Unsigned updates — Low (MCP publisher binary not checksum-verified)
- [x] Insecure deserialization — Clean (JSON.parse with type guards)

### A09 — Security Logging and Monitoring Failures
- [x] Audit logs — **FOUND** (no logging of delete/import/curator ops)
- [x] Failed auth logging — N/A (no auth failures to log)
- [x] Sensitive data in logs — Clean (sync URLs in stderr only)
- [x] Log injection — N/A

### A10 — Server-Side Request Forgery
- [x] Unvalidated URLs — Clean (no HTTP requests)
- [x] DNS rebinding — N/A
- [x] SSRF — N/A
