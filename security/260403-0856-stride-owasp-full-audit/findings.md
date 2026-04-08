# Security Findings — hmem-mcp v6.0.2

All findings ranked by severity (Critical → Low). Each finding includes code evidence and mitigation.

---

## [HIGH] Finding 1: Path Traversal in export_memory — Arbitrary File Write

- **OWASP:** A01 Broken Access Control
- **STRIDE:** Tampering
- **Location:** `src/mcp-server.ts:1412-1429`
- **Confidence:** Confirmed

**Description:** The `export_memory` MCP tool accepts an `output_path` parameter that is passed directly to `HmemStore.exportPublicToHmem()` without any path validation or sandboxing. An AI agent (or prompt injection in agent context) can write a SQLite file to any location the process has write access to.

**Attack Scenario:**
1. Agent calls `export_memory({ format: "hmem", output_path: "/home/user/.bashrc" })`
2. SQLite file overwrites `.bashrc` — user's shell config destroyed
3. Alternatively: `output_path: "/etc/cron.d/backdoor"` — persistence via cron (if running as root)

**Code Evidence:**
```typescript
// mcp-server.ts:1412-1429
output_path: z.string().optional().describe(
  "Output path for 'hmem' format..."
),
async ({ store: storeName, format, output_path }) => {
  // ...
  const outPath = output_path || defaultPath;  // NO VALIDATION
  const result = hmemStore.exportPublicToHmem(outPath);  // WRITES TO ARBITRARY PATH
```

**Mitigation:**
```typescript
const outPath = output_path || defaultPath;
const resolved = path.resolve(outPath);
const allowedDir = path.dirname(hmemStore.getDbPath());
if (!resolved.startsWith(allowedDir)) {
  throw new Error(`Export path must be within ${allowedDir}`);
}
```

**References:** CWE-22 (Path Traversal), CWE-73 (External Control of File Name)

---

## [HIGH] Finding 2: Path Traversal in import_memory — Arbitrary File Read

- **OWASP:** A01 Broken Access Control
- **STRIDE:** Tampering
- **Location:** `src/mcp-server.ts:1454-1468`
- **Confidence:** Confirmed

**Description:** The `import_memory` tool accepts a `source_path` that is passed directly to `HmemStore.importFromHmem()`. An agent can read any SQLite database on the filesystem, potentially including other users' memory files or sensitive databases.

**Attack Scenario:**
1. Agent calls `import_memory({ source_path: "/home/otheruser/.hmem/memory.hmem" })`
2. All entries from the other user's memory are imported into attacker's database
3. Alternatively: probe filesystem by checking error messages (`"Source file not found: {path}"`)

**Code Evidence:**
```typescript
// mcp-server.ts:1454-1468
source_path: z.string().describe("Path to .hmem file to import"),
async ({ source_path, store: storeName, dry_run }) => {
  // ...
  const result = hmemStore.importFromHmem(source_path, dry_run);  // NO VALIDATION
```

**Mitigation:**
```typescript
const resolved = path.resolve(source_path);
const allowedDir = path.dirname(hmemStore.getDbPath());
if (!resolved.startsWith(allowedDir) && !resolved.startsWith(os.homedir())) {
  throw new Error("Import source must be within home directory");
}
```

**References:** CWE-22 (Path Traversal), CWE-200 (Information Exposure)

---

## [HIGH] Finding 3: Shell Command Injection via execSync in cli-checkpoint.ts

- **OWASP:** A03 Injection
- **STRIDE:** Elevation of Privilege
- **Location:** `src/cli-checkpoint.ts:228-230`
- **Confidence:** Confirmed

**Description:** The checkpoint command constructs a shell command string using template literal interpolation. The `mcpConfigPath` variable (derived from `/tmp/hmem-checkpoint-mcp-${PID}.json`) is interpolated directly into an `execSync()` call. While the path is currently PID-based and hard to inject, this is a confirmed shell injection anti-pattern.

**Attack Scenario:**
1. Attacker creates a symlink: `/tmp/hmem-checkpoint-mcp-1234.json` → file with shell metacharacters in name
2. When checkpoint runs with that PID, the path is interpolated: `claude -p --mcp-config "/tmp/path$(malicious)"`
3. Shell executes the injected command

**Code Evidence:**
```typescript
// cli-checkpoint.ts:228-230
const output = execSync(
  `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --dangerously-skip-permissions 2>/dev/null`,
  { input: prompt, encoding: "utf8", timeout: 120_000 }
);
```

**Mitigation:**
```typescript
import { execFileSync } from "node:child_process";
const output = execFileSync("claude", [
  "-p", "--model", "haiku",
  "--mcp-config", mcpConfigPath,
  "--allowedTools", allowedTools,
  "--disallowedTools", disallowedTools,
  "--dangerously-skip-permissions"
], { input: prompt, encoding: "utf8", timeout: 120_000 });
```

**References:** CWE-78 (OS Command Injection)

---

## [HIGH] Finding 4: Shell Command Injection via execSync in cli-session-summary.ts

- **OWASP:** A03 Injection
- **STRIDE:** Elevation of Privilege
- **Location:** `src/cli-session-summary.ts:97-99`
- **Confidence:** Confirmed

**Description:** Same pattern as Finding 3 — `execSync` with string interpolation of `mcpConfigPath`.

**Code Evidence:**
```typescript
// cli-session-summary.ts:97-99
execSync(
  `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --dangerously-skip-permissions 2>/dev/null`,
  { input: prompt, encoding: "utf8", timeout: 60_000 }
);
```

**Mitigation:** Same as Finding 3 — use `execFileSync` with argument array.

**References:** CWE-78 (OS Command Injection)

---

## [HIGH] Finding 5: Dependency Vulnerabilities — 4 HIGH Severity

- **OWASP:** A06 Vulnerable and Outdated Components
- **STRIDE:** N/A
- **Location:** `package-lock.json` (transitive via `@modelcontextprotocol/sdk`)
- **Confidence:** Confirmed

**Description:** `npm audit` reports 4 HIGH severity vulnerabilities in transitive dependencies:

| Package | CVE/Advisory | Impact |
|---------|-------------|--------|
| hono <=4.12.6 | GHSA-v8w9-8mx6-g223 | Prototype pollution via `__proto__` |
| hono <=4.12.6 | GHSA-q5qw-h33p-qvwr | Arbitrary file access via serveStatic |
| hono <=4.12.6 | GHSA-p6xx-57qc-3wxr | SSE control field injection |
| hono <=4.12.6 | GHSA-5pq2-9x2x-5p6w | Cookie attribute injection |
| @hono/node-server <1.19.10 | GHSA-wc8c-qw6v-h7f6 | Auth bypass via encoded slashes |
| express-rate-limit 8.2.x | GHSA-46wh-pxpv-q5gq | Rate limit bypass via IPv4-mapped IPv6 |
| path-to-regexp 8.x | GHSA-j3q9-mxjg-w52f | DoS via sequential optional groups |

**Note:** These are transitive dependencies from `@modelcontextprotocol/sdk`. hmem itself doesn't use hono/express directly. The risk depends on whether MCP SDK exposes these features.

**Mitigation:** `npm audit fix`

**References:** See individual GHSA links above.

---

## [MEDIUM] Finding 6: Agent Name Path Traversal in Curator Tools

- **OWASP:** A01 Broken Access Control
- **STRIDE:** Spoofing
- **Location:** `src/mcp-server.ts:2369,2458,2550,2597`
- **Confidence:** Likely

**Description:** Curator tools pass `agent_name` to `resolveHmemPathLegacy()`, which constructs a path via `path.join(projectDir, "Agents", templateName)`. If `agent_name` contains `../`, the resulting path escapes the intended directory.

**Code Evidence:**
```typescript
// hmem-store.ts:4738
let agentDir = path.join(projectDir, "Agents", templateName);
// If agent_name = "../../etc", result = "/home/user/project/Agents/../../etc"
// path.join resolves to "/home/user/etc"
```

**Mitigation:**
```typescript
if (!/^[A-Za-z0-9_-]+$/.test(templateName)) {
  throw new Error(`Invalid agent name: ${templateName}`);
}
```

**References:** CWE-22 (Path Traversal)

---

## [MEDIUM] Finding 7: Environment Variable Authentication Bypass

- **OWASP:** A07 Identification and Authentication Failures
- **STRIDE:** Spoofing
- **Location:** `src/mcp-server.ts:2277-2278`
- **Confidence:** Confirmed

**Description:** Curator role is checked via `process.env.HMEM_AGENT_ROLE === "ceo"`. Any process that sets this environment variable gains full curator access to all agent memories.

**Code Evidence:**
```typescript
function isCurator(): boolean {
  return process.env.HMEM_AGENT_ROLE === "ceo";
}
```

**Context:** For MCP servers running via stdio, the parent process (AI tool) controls the environment. This is by design for single-user setups. Risk increases in multi-user or shared server deployments.

**Mitigation:** Acceptable for single-user MCP. For multi-user: implement per-connection authentication.

**References:** CWE-287 (Improper Authentication)

---

## [MEDIUM] Finding 8: delete_agent_memory Fallback Bypasses Curator Check

- **OWASP:** A01 Broken Access Control
- **STRIDE:** Elevation of Privilege
- **Location:** `src/mcp-server.ts:2597-2602`
- **Confidence:** Confirmed

**Description:** When `resolveHmemPathLegacy` returns a path that doesn't exist, `delete_agent_memory` falls back to `HMEM_PATH`. The `isOwnMemory` check then returns `true`, allowing a non-curator to delete their own entries via this tool — which may be intentional, but the fallback path is confusing and could mask bugs.

**Code Evidence:**
```typescript
let hmemPath = resolveHmemPathLegacy(PROJECT_DIR, agent_name);
if (!fs.existsSync(hmemPath)) hmemPath = HMEM_PATH;  // FALLBACK
const isOwnMemory = hmemPath === HMEM_PATH;
if (!isOwnMemory && !isCurator()) { /* error */ }  // SKIPPED due to fallback
```

**Mitigation:** Remove fallback — if agent not found, return error:
```typescript
if (!fs.existsSync(hmemPath)) {
  return { content: [{ type: "text", text: `Agent "${agent_name}" not found.` }], isError: true };
}
```

**References:** CWE-639 (Authorization Bypass Through User-Controlled Key)

---

## [MEDIUM] Finding 9: World-Readable Temp Files with Predictable Names

- **OWASP:** A05 Security Misconfiguration
- **STRIDE:** Information Disclosure
- **Location:** `src/hmem-store.ts:2914`, `src/cli-checkpoint.ts:61`, `src/cli-session-summary.ts:44`, `src/cli-statusline.ts:42`
- **Confidence:** Confirmed

**Description:** Multiple components write state files to `/tmp` with predictable names based on PID or hash. These files are world-readable by default and contain session metadata, MCP config paths, and environment information.

**Affected files:**
- `/tmp/.hmem_session_${hash}.json` — session state
- `/tmp/hmem-checkpoint-mcp-${PID}.json` — MCP config with HMEM_PATH
- `/tmp/hmem-session-summary-${PID}.json` — MCP config
- `/tmp/.hmem_statusline_cache` — project metadata

**Mitigation:**
```typescript
import { mkdtempSync } from "node:fs";
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "hmem-"));
fs.chmodSync(tmpDir, 0o700);
```

**References:** CWE-377 (Insecure Temporary File), CWE-732 (Incorrect Permission Assignment)

---

## [MEDIUM] Finding 10: Error Messages Leak Internal Information

- **OWASP:** A05 Security Misconfiguration
- **STRIDE:** Information Disclosure
- **Location:** `src/mcp-server.ts` (pattern across ~15 catch blocks)
- **Confidence:** Confirmed

**Description:** All MCP tool error handlers use the pattern `ERROR: ${e}`, which returns raw exception messages including file paths, SQL errors, and potentially stack traces to the calling agent.

**Code Evidence:**
```typescript
// Pattern repeated across mcp-server.ts:660,770,825,888,958,1362,1438,1488,1538,1575,1620
catch (e) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${e}` }],
    isError: true,
  };
}
```

**Example leaked info:** `ERROR: SQLITE_ERROR: no such table: memories (path: /home/bbbee/.hmem/memory.hmem)`

**Mitigation:** Log detailed error internally, return generic message:
```typescript
catch (e) {
  console.error(`[hmem] Tool error:`, e);
  return {
    content: [{ type: "text", text: "ERROR: Operation failed. Check server logs." }],
    isError: true,
  };
}
```

**References:** CWE-209 (Information Exposure Through Error Message)

---

## [MEDIUM] Finding 11: No Audit Trail for Security Events

- **OWASP:** A09 Security Logging and Monitoring Failures
- **STRIDE:** Repudiation
- **Location:** `src/hmem-store.ts` (global)
- **Confidence:** Confirmed

**Description:** No security-relevant events are logged: entry deletion, bulk imports, curator operations on other agents' memories, or failed access attempts. An actor who deletes or modifies entries leaves no trace.

**Mitigation:** Add structured logging for destructive operations:
```typescript
log(`[AUDIT] delete entry=${id} by_role=${HMEM_AGENT_ROLE}`);
log(`[AUDIT] import from=${source_path} entries=${count}`);
log(`[AUDIT] curator read_agent agent=${agent_name}`);
```

**References:** CWE-778 (Insufficient Logging)

---

## [MEDIUM] Finding 12: Sync Tokens Stored in Plaintext Config

- **OWASP:** A02 Cryptographic Failures
- **STRIDE:** Information Disclosure
- **Location:** `src/hmem-config.ts:122`
- **Confidence:** Confirmed

**Description:** hmem-sync bearer tokens are stored as plaintext strings in `hmem.config.json`. The code attempts `chmod 0o600` but silently catches errors, so on some systems (e.g., Windows) the file remains world-readable.

**Code Evidence:**
```typescript
// hmem-config.ts:250-251
if (servers.some(s => s.token)) {
  try { fs.chmodSync(configPath, 0o600); } catch {}  // SILENT FAILURE
}
```

**Mitigation:** Throw on chmod failure when tokens are present:
```typescript
try { fs.chmodSync(configPath, 0o600); }
catch (e) { console.error(`WARNING: Could not restrict permissions on ${configPath} — token may be exposed`); }
```

**References:** CWE-312 (Cleartext Storage of Sensitive Information)

---

## [LOW] Finding 13: SQL LIMIT Clause String Interpolation

- **OWASP:** A03 Injection
- **STRIDE:** Tampering
- **Location:** `src/hmem-store.ts:804,868`
- **Confidence:** Possible (not exploitable)

**Description:** `LIMIT ${limit}` uses template literal instead of parameterized query. However, Zod validates `limit` as `z.number()` in the MCP schema, so this is **not exploitable** — the value is guaranteed to be a number. Still a code quality anti-pattern that could become dangerous if the validation layer changes.

**Code Evidence:**
```typescript
const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
```

**Mitigation:**
```typescript
// Use parameterized LIMIT
const limitClause = limit !== undefined ? ` LIMIT ?` : "";
// Add limit to params array when building query
if (limit !== undefined) params.push(limit);
```

**References:** CWE-89 (SQL Injection) — mitigated by Zod

---

## [LOW] Finding 14: Hardcoded Tag Strings Concatenated in SQL

- **OWASP:** A03 Injection
- **STRIDE:** Tampering
- **Location:** `src/hmem-store.ts:1833-1839,3103-3105,3122-3124`
- **Confidence:** Possible (not exploitable)

**Description:** Several SQL queries build `IN (...)` clauses by concatenating hardcoded tag strings (e.g., `'#checkpoint-summary'`, `'#irrelevant'`). These are not user-controlled and pose no current risk, but the pattern is fragile.

**Mitigation:** Use parameterized placeholders even for hardcoded values.

**References:** CWE-89 (SQL Injection) — not currently exploitable
