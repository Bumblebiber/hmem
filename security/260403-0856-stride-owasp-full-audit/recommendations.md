# Recommendations — hmem-mcp v6.0.2

Prioritized mitigations with code snippets. Sorted by effort-to-impact ratio.

---

## Priority 1 — High (Fix This Week)

### 1. Replace execSync Shell Interpolation with execFileSync
**Findings:** [#3](./findings.md#high-finding-3-shell-command-injection-via-execsync-in-cli-checkpointts), [#4](./findings.md#high-finding-4-shell-command-injection-via-execsync-in-cli-session-summaryts)
**Effort:** 15 minutes
**Files:** `cli-checkpoint.ts:228`, `cli-session-summary.ts:97`

```typescript
// Before (vulnerable)
execSync(
  `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --dangerously-skip-permissions 2>/dev/null`,
  { input: prompt, encoding: "utf8", timeout: 120_000 }
);

// After (safe)
import { execFileSync } from "node:child_process";
execFileSync("claude", [
  "-p", "--model", "haiku",
  "--mcp-config", mcpConfigPath,
  "--allowedTools", allowedTools,
  "--disallowedTools", disallowedTools,
  "--dangerously-skip-permissions"
], { input: prompt, encoding: "utf8", timeout: 120_000 });
```

### 2. Validate Paths in export_memory and import_memory
**Findings:** [#1](./findings.md#high-finding-1-path-traversal-in-export_memory--arbitrary-file-write), [#2](./findings.md#high-finding-2-path-traversal-in-import_memory--arbitrary-file-read)
**Effort:** 20 minutes
**Files:** `mcp-server.ts:1412-1429, 1454-1468`

```typescript
function validatePath(userPath: string, hmemDir: string): string {
  const resolved = path.resolve(userPath);
  // Allow paths within the hmem directory or home directory
  if (!resolved.startsWith(hmemDir) && !resolved.startsWith(os.homedir())) {
    throw new Error("Path must be within hmem directory or home directory");
  }
  return resolved;
}

// In export_memory:
const outPath = validatePath(output_path || defaultPath, path.dirname(hmemStore.getDbPath()));

// In import_memory:
const safePath = validatePath(source_path, path.dirname(hmemStore.getDbPath()));
```

### 3. Run npm audit fix
**Finding:** [#5](./findings.md#high-finding-5-dependency-vulnerabilities--4-high-severity)
**Effort:** 2 minutes

```bash
cd /home/bbbee/projects/hmem && npm audit fix
```

### 4. Validate agent_name in Curator Tools
**Finding:** [#6](./findings.md#medium-finding-6-agent-name-path-traversal-in-curator-tools)
**Effort:** 5 minutes
**File:** `mcp-server.ts` (before each `resolveHmemPathLegacy` call)

```typescript
function validateAgentName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`Invalid agent name: "${name}". Use alphanumeric, underscore, or hyphen only.`);
  }
  return name;
}
```

---

## Priority 2 — Medium (Fix This Sprint)

### 5. Remove delete_agent_memory Fallback
**Finding:** [#8](./findings.md#medium-finding-8-delete_agent_memory-fallback-bypasses-curator-check)
**Effort:** 5 minutes
**File:** `mcp-server.ts:2597-2600`

```typescript
// Before
let hmemPath = resolveHmemPathLegacy(PROJECT_DIR, agent_name);
if (!fs.existsSync(hmemPath)) hmemPath = HMEM_PATH;

// After
const hmemPath = resolveHmemPathLegacy(PROJECT_DIR, agent_name);
if (!fs.existsSync(hmemPath)) {
  return { content: [{ type: "text", text: `Agent "${agent_name}" not found.` }], isError: true };
}
```

### 6. Use Secure Temp Files
**Finding:** [#9](./findings.md#medium-finding-9-world-readable-temp-files-with-predictable-names)
**Effort:** 30 minutes
**Files:** `cli-checkpoint.ts:61`, `cli-session-summary.ts:44`, `hmem-store.ts:2914`

```typescript
import { mkdtempSync } from "node:fs";
import os from "node:os";

function secureTmpFile(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `hmem-${prefix}-`));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, "config.json");
}
```

### 7. Sanitize Error Messages
**Finding:** [#10](./findings.md#medium-finding-10-error-messages-leak-internal-information)
**Effort:** 30 minutes
**File:** `mcp-server.ts` (~15 catch blocks)

```typescript
function safeError(e: unknown): string {
  if (e instanceof Error) {
    // Strip file paths and stack traces
    return e.message.replace(/\/[^\s]+/g, "[path]");
  }
  return "Internal error";
}

// Usage:
catch (e) {
  console.error("[hmem] Tool error:", e);
  return { content: [{ type: "text", text: `ERROR: ${safeError(e)}` }], isError: true };
}
```

### 8. Fail Loudly on Token Permission Error
**Finding:** [#12](./findings.md#medium-finding-12-sync-tokens-stored-in-plaintext-config)
**Effort:** 5 minutes
**File:** `hmem-config.ts:250-251`

```typescript
if (servers.some(s => s.token)) {
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (e) {
    console.error(`[hmem] WARNING: Could not set permissions on ${configPath} — sync token may be exposed`);
  }
}
```

---

## Priority 3 — Low (Improve When Convenient)

### 9. Parameterize LIMIT Clause
**Finding:** [#13](./findings.md#low-finding-13-sql-limit-clause-string-interpolation)
**Effort:** 10 minutes

### 10. Add Audit Logging for Destructive Operations
**Finding:** [#11](./findings.md#medium-finding-11-no-audit-trail-for-security-events)
**Effort:** 1-2 hours

### 11. Parameterize Hardcoded Tag SQL
**Finding:** [#14](./findings.md#low-finding-14-hardcoded-tag-strings-concatenated-in-sql)
**Effort:** 15 minutes
