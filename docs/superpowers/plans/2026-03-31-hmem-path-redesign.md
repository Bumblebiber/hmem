# hmem Path Resolution & min_role Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `HMEM_AGENT_ID` + magic path resolution with explicit `HMEM_PATH` env var, remove unused `min_role` system, and simplify `HMEM_PROJECT_DIR` into optional fallback.

**Architecture:** New 3-step path priority: (1) `HMEM_PATH` env var → absolute path to `.hmem` file, (2) CWD discovery → glob for `*.hmem`, (3) `~/.hmem/memory.hmem` default. `min_role` column kept in DB (no table rebuild) but removed from all tool schemas and filtering logic. `HMEM_PROJECT_DIR` kept as fallback for company.hmem location only.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-31-hmem-path-and-sync-redesign.md` (Phase 1 + Phase 3 only; Phase 2 is hmem-sync, separate repo)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hmem-store.ts` | Modify | New `resolveHmemPath()` (no args), deprecate old version, keep `openAgentMemory` as thin wrapper |
| `src/mcp-server.ts` | Modify | Replace `HMEM_AGENT_ID`/`PROJECT_DIR` init with `HMEM_PATH`, remove `min_role` from tool schemas |
| `src/cli-env.ts` | Modify | New `resolveEnvDefaults()` using `HMEM_PATH` priority chain |
| `src/cli-context-inject.ts` | Modify | Use new path resolution |
| `src/cli-checkpoint.ts` | Modify | Use new path resolution |
| `src/cli-session-summary.ts` | Modify | Use new path resolution |
| `src/cli-log-exchange.ts` | Modify | Use new path resolution |
| `src/cli-statusline.ts` | Modify | Use new path resolution |
| `src/cli-migrate-o.ts` | Modify | Use new path resolution |
| `src/cli-hook-startup.ts` | Modify | Use new path resolution |
| `src/cli.ts` | Modify | Update help text |
| `tests/path-resolution.test.ts` | Create | Tests for new `resolveHmemPath()` |
| `tests/min-role-removal.test.ts` | Create | Tests confirming min_role removed from tools |

---

## Task 1: New `resolveHmemPath()` with Tests

**Files:**
- Modify: `src/hmem-store.ts:4683-4711`
- Create: `tests/path-resolution.test.ts`

- [ ] **Step 1: Write failing tests for new path resolution**

Create `tests/path-resolution.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// We need to test resolveHmemPath which reads env + CWD
// Import after env setup in each test

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-path-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  // Clean env
  delete process.env.HMEM_PATH;
  delete process.env.HMEM_PROJECT_DIR;
  delete process.env.HMEM_AGENT_ID;
  delete process.env.COUNCIL_AGENT_ID;
  delete process.env.COUNCIL_PROJECT_DIR;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.HMEM_PATH;
  delete process.env.HMEM_PROJECT_DIR;
});

describe("resolveHmemPath", () => {
  // Dynamic import to pick up env changes
  async function getResolver() {
    // Force re-evaluation
    const mod = await import("../src/hmem-store.js");
    return mod.resolveHmemPath;
  }

  it("Priority 1: HMEM_PATH wins over everything", async () => {
    const target = join(TMP, "custom.hmem");
    writeFileSync(target, ""); // file must exist? No, path just needs to resolve
    process.env.HMEM_PATH = target;
    // Also set CWD hmem and PROJECT_DIR — HMEM_PATH should still win
    writeFileSync(join(TMP, "other.hmem"), "");
    process.env.HMEM_PROJECT_DIR = TMP;

    const { resolveHmemPathNew } = await import("../src/hmem-store.js");
    expect(resolveHmemPathNew()).toBe(target);
  });

  it("Priority 1: HMEM_PATH expands ~ to homedir", async () => {
    const os = await import("node:os");
    process.env.HMEM_PATH = "~/.hmem/test.hmem";

    const { resolveHmemPathNew } = await import("../src/hmem-store.js");
    expect(resolveHmemPathNew()).toBe(join(os.homedir(), ".hmem", "test.hmem"));
  });

  it("Priority 2: CWD discovery finds single .hmem file", async () => {
    writeFileSync(join(TMP, "project.hmem"), "");

    const { resolveHmemPathNew } = await import("../src/hmem-store.js");
    expect(resolveHmemPathNew(TMP)).toBe(join(TMP, "project.hmem"));
  });

  it("Priority 2: CWD discovery errors on multiple .hmem files", async () => {
    writeFileSync(join(TMP, "a.hmem"), "");
    writeFileSync(join(TMP, "b.hmem"), "");

    const { resolveHmemPathNew } = await import("../src/hmem-store.js");
    expect(() => resolveHmemPathNew(TMP)).toThrow("Multiple .hmem files");
  });

  it("Priority 3: falls back to ~/.hmem/memory.hmem", async () => {
    const os = await import("node:os");
    // No HMEM_PATH, no .hmem in CWD (use TMP which has no .hmem files)
    // Pass a dir with no .hmem files
    const emptyDir = join(TMP, "empty");
    mkdirSync(emptyDir);

    const { resolveHmemPathNew } = await import("../src/hmem-store.js");
    expect(resolveHmemPathNew(emptyDir)).toBe(join(os.homedir(), ".hmem", "memory.hmem"));
  });
});
```

- [ ] **Step 2: Run tests — expect failure (function doesn't exist yet)**

```bash
cd /home/bbbee/projects/hmem && npx vitest run tests/path-resolution.test.ts
```

Expected: FAIL — `resolveHmemPathNew` is not exported.

- [ ] **Step 3: Implement `resolveHmemPathNew()` in hmem-store.ts**

Add after the existing `resolveHmemPath` function at line ~4695 in `src/hmem-store.ts`:

```typescript
/**
 * New path resolution (v6.0+): HMEM_PATH > CWD discovery > ~/.hmem/memory.hmem
 *
 * @param cwdOverride - Override CWD for testing (default: process.cwd())
 */
export function resolveHmemPathNew(cwdOverride?: string): string {
  // Priority 1: HMEM_PATH env var (absolute path to .hmem file)
  const hmemPath = process.env.HMEM_PATH;
  if (hmemPath) {
    const expanded = hmemPath.startsWith("~")
      ? path.join(os.homedir(), hmemPath.slice(1))
      : hmemPath;
    return path.resolve(expanded);
  }

  // Priority 2: CWD discovery — find *.hmem in working directory
  const cwd = cwdOverride || process.cwd();
  try {
    const files = fs.readdirSync(cwd).filter(f => f.endsWith(".hmem"));
    if (files.length === 1) return path.resolve(cwd, files[0]);
    if (files.length > 1) {
      throw new Error(`Multiple .hmem files in ${cwd}: ${files.join(", ")}. Set HMEM_PATH to pick one.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Multiple")) throw e;
    // Directory not readable — fall through to default
  }

  // Priority 3: default location
  return path.resolve(os.homedir(), ".hmem", "memory.hmem");
}
```

Also add the `os` import if not present at the top of hmem-store.ts:
```typescript
import os from "node:os";
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /home/bbbee/projects/hmem && npx vitest run tests/path-resolution.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/path-resolution.test.ts src/hmem-store.ts
git commit -m "feat: add resolveHmemPathNew() with HMEM_PATH priority chain"
```

---

## Task 2: Update `cli-env.ts` to use new resolution

**Files:**
- Modify: `src/cli-env.ts`

The old `resolveEnvDefaults()` sets `HMEM_PROJECT_DIR` and auto-detects `HMEM_AGENT_ID`. The new version resolves `HMEM_PATH` using `resolveHmemPathNew()` and derives `HMEM_PROJECT_DIR` from it.

- [ ] **Step 1: Rewrite `resolveEnvDefaults()`**

Replace the entire content of `src/cli-env.ts` with:

```typescript
/**
 * cli-env.ts
 *
 * Shared environment variable resolution for all hmem CLI commands.
 * Resolves HMEM_PATH (new) and HMEM_PROJECT_DIR (for company.hmem + config).
 */

import path from "node:path";
import os from "node:os";
import { resolveHmemPathNew } from "./hmem-store.js";

/**
 * Resolve HMEM_PATH and HMEM_PROJECT_DIR environment variables.
 *
 * - HMEM_PATH: resolved via 3-step priority (env > CWD > ~/.hmem/memory.hmem)
 * - HMEM_PROJECT_DIR: directory containing the resolved .hmem file
 *   (used for company.hmem and hmem.config.json location)
 *
 * Call this early in any CLI command that needs these env vars.
 */
export function resolveEnvDefaults(): void {
  // Resolve the personal memory path
  if (!process.env.HMEM_PATH) {
    process.env.HMEM_PATH = resolveHmemPathNew();
  }

  // Derive HMEM_PROJECT_DIR from the resolved path
  if (!process.env.HMEM_PROJECT_DIR) {
    process.env.HMEM_PROJECT_DIR = path.dirname(process.env.HMEM_PATH);
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli-env.ts
git commit -m "refactor: cli-env uses resolveHmemPathNew instead of HMEM_AGENT_ID auto-detect"
```

---

## Task 3: Update all CLI commands to use `HMEM_PATH`

**Files:**
- Modify: `src/cli-context-inject.ts`
- Modify: `src/cli-checkpoint.ts`
- Modify: `src/cli-session-summary.ts`
- Modify: `src/cli-log-exchange.ts`
- Modify: `src/cli-statusline.ts`
- Modify: `src/cli-migrate-o.ts`
- Modify: `src/cli-hook-startup.ts`
- Modify: `src/cli.ts`

Each CLI file currently does:
```typescript
const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
const templateName = agentId.replace(/_\d+$/, "");
const hmemPath = resolveHmemPath(projectDir, templateName);
```

Replace with:
```typescript
const hmemPath = process.env.HMEM_PATH!;
const projectDir = process.env.HMEM_PROJECT_DIR!;
```

Since `resolveEnvDefaults()` is called at the top of each CLI command, both vars are guaranteed set.

- [ ] **Step 1: Update `cli-context-inject.ts`**

In `src/cli-context-inject.ts`, find the block that reads `HMEM_AGENT_ID`, derives `templateName`, and calls `resolveHmemPath()`. Replace it with reading `HMEM_PATH` directly. Remove the `HMEM_AGENT_ID` / `COUNCIL_AGENT_ID` references. The `openAgentMemory()` call changes to `new HmemStore(hmemPath, config)`.

Read the file first to see exact lines, then apply targeted edits:
- Remove `agentId` / `templateName` derivation
- Replace `openAgentMemory(projectDir, templateName, config)` with `new HmemStore(process.env.HMEM_PATH!, config)`
- Replace `resolveHmemPath(projectDir, templateName)` with `process.env.HMEM_PATH!`

- [ ] **Step 2: Update `cli-checkpoint.ts`**

Same pattern: replace `agentId`/`templateName`/`resolveHmemPath` with `process.env.HMEM_PATH!`.

Also update the `child_process.spawn()` env — replace `HMEM_AGENT_ID: agentId` with `HMEM_PATH: process.env.HMEM_PATH`.

- [ ] **Step 3: Update `cli-session-summary.ts`**

Same pattern. Also update spawn env from `HMEM_AGENT_ID` to `HMEM_PATH`.

- [ ] **Step 4: Update `cli-log-exchange.ts`**

Same pattern. Also update spawn env from `HMEM_AGENT_ID` to `HMEM_PATH`.

- [ ] **Step 5: Update `cli-statusline.ts`**

Same pattern — replace path resolution.

- [ ] **Step 6: Update `cli-migrate-o.ts`**

Same pattern. Remove `COUNCIL_AGENT_ID` fallback.

- [ ] **Step 7: Update `cli-hook-startup.ts`**

Same pattern.

- [ ] **Step 8: Update `cli.ts` help text**

In the help text (~line 95), replace:
```
HMEM_PROJECT_DIR   Root directory for .hmem files (required)
HMEM_AGENT_ID      Agent identity (optional, for multi-agent)
```
With:
```
HMEM_PATH          Path to .hmem file (optional, auto-detected)
HMEM_PROJECT_DIR   Directory for config + company.hmem (derived from HMEM_PATH)
```

- [ ] **Step 9: Verify compilation**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 10: Run all tests**

```bash
cd /home/bbbee/projects/hmem && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/cli-*.ts src/cli.ts
git commit -m "refactor: all CLI commands use HMEM_PATH instead of HMEM_AGENT_ID"
```

---

## Task 4: Update `mcp-server.ts` — Path Resolution

**Files:**
- Modify: `src/mcp-server.ts:33-59, 60-76, 574-652, 2980-2997`

The MCP server is the most critical file. It has its own env reading (doesn't use cli-env.ts) and uses `PROJECT_DIR`/`AGENT_ID` throughout.

- [ ] **Step 1: Replace env block (lines 33-59)**

Replace the current env block:
```typescript
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR || "";
if (!PROJECT_DIR) {
  console.error("FATAL: HMEM_PROJECT_DIR not set");
  process.exit(1);
}
let AGENT_ID = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
let DEPTH = parseInt(process.env.HMEM_DEPTH || process.env.COUNCIL_DEPTH || "0", 10);
let ROLE = process.env.HMEM_AGENT_ROLE || process.env.COUNCIL_AGENT_ROLE || "worker";
// PID-based override block...
```

With:
```typescript
import { resolveHmemPathNew } from "./hmem-store.js";

const HMEM_PATH = process.env.HMEM_PATH || resolveHmemPathNew();
const PROJECT_DIR = process.env.HMEM_PROJECT_DIR || path.dirname(HMEM_PATH);
let DEPTH = parseInt(process.env.HMEM_DEPTH || "0", 10);

// Legacy: PID-based identity override (Das Althing orchestrator)
const ppid = process.ppid;
const ctxFile = path.join(PROJECT_DIR, "orchestrator", ".mcp_contexts", `${ppid}.json`);
try {
  if (fs.existsSync(ctxFile)) {
    const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf-8"));
    DEPTH = ctx.depth ?? DEPTH;
  }
} catch {}
```

- [ ] **Step 2: Update store opening throughout mcp-server.ts**

Search and replace all occurrences of:
- `openAgentMemory(PROJECT_DIR, templateName, hmemConfig)` → `new HmemStore(HMEM_PATH, hmemConfig)`
- `resolveHmemPath(PROJECT_DIR, templateName)` → `HMEM_PATH`
- `const templateName = AGENT_ID.replace(/_\d+$/, "");` → remove (no longer needed)
- `openCompanyMemory(PROJECT_DIR, hmemConfig)` → keep as-is (company.hmem uses PROJECT_DIR)

- [ ] **Step 3: Update the `main()` startup log (line ~2997)**

Replace:
```typescript
log(`MCP Server running on stdio | Agent: ${templateName || "(none)"} | Role: ${ROLE || "worker"} | DB: ${hmemPath}...`);
```
With:
```typescript
const dbName = path.basename(HMEM_PATH, ".hmem");
log(`MCP Server running on stdio | DB: ${HMEM_PATH}${dbExists ? ` (${entryCount} entries)` : " [NOT FOUND]"}`);
```

- [ ] **Step 4: Update session-start mtime snapshot (lines 67-76)**

Replace:
```typescript
const _tmpl = AGENT_ID.replace(/_\d+$/, "");
const _hmemPathAtStart = resolveHmemPath(PROJECT_DIR, _tmpl);
```
With:
```typescript
const _hmemPathAtStart = HMEM_PATH;
```

- [ ] **Step 5: Remove `AGENT_ID` and `ROLE` variables**

Remove all remaining references to `AGENT_ID` and `ROLE` variables. The `log()` function uses `AGENT_ID`:
```typescript
function log(msg: string) {
  console.error(`[hmem:${AGENT_ID || "default"}] ${msg}`);
}
```
Replace with:
```typescript
function log(msg: string) {
  const name = path.basename(HMEM_PATH, ".hmem");
  console.error(`[hmem:${name}] ${msg}`);
}
```

- [ ] **Step 6: Remove first-time HMEM_AGENT_ID hint (line 651)**

Remove the line:
```typescript
const firstTimeNote = isFirstTime
  ? `\nMemory store created: ${hmemPath}\nTo use a custom name, set HMEM_AGENT_ID in your .mcp.json.`
  : "";
```
Replace with:
```typescript
const firstTimeNote = isFirstTime
  ? `\nMemory store created: ${HMEM_PATH}`
  : "";
```

- [ ] **Step 7: Verify compilation**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server.ts
git commit -m "refactor: mcp-server uses HMEM_PATH, removes HMEM_AGENT_ID"
```

---

## Task 5: Remove `min_role` from Tool Schemas & Logic

**Files:**
- Modify: `src/mcp-server.ts` (tool schemas, role checks)
- Modify: `src/hmem-store.ts` (role filtering, display)
- Create: `tests/min-role-removal.test.ts`

The `min_role` column stays in the DB (SQLite table rebuild is risky), but is no longer exposed or used.

- [ ] **Step 1: Write tests confirming min_role is removed from tool output**

Create `tests/min-role-removal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HmemStore } from "../src/hmem-store.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-minrole-test");
const DB = join(TMP, "test.hmem");

import { beforeEach, afterEach } from "vitest";

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("min_role removal", () => {
  it("write() still works with default min_role", () => {
    const store = new HmemStore(DB);
    const result = store.write("L", "Test lesson");
    expect(result.id).toMatch(/^L\d+$/);
    store.close();
  });

  it("read() returns entries without role filtering", () => {
    const store = new HmemStore(DB);
    store.write("L", "Lesson for workers");
    // Manually set min_role via raw SQL to verify it's ignored
    store.db.prepare("UPDATE memories SET min_role = 'ceo' WHERE prefix = 'L'").run();
    const entries = store.read({}); // No role filter
    expect(entries.length).toBe(1);
    store.close();
  });

  it("formatEntryLine does not include role marker", () => {
    const store = new HmemStore(DB);
    store.write("L", "Test entry");
    store.db.prepare("UPDATE memories SET min_role = 'ceo'").run();
    const entries = store.read({});
    // The formatted output should not contain [ceo+]
    const formatted = store.formatEntryLine(entries[0]);
    expect(formatted).not.toContain("[ceo+]");
    store.close();
  });
});
```

- [ ] **Step 2: Run tests — expect some failures**

```bash
cd /home/bbbee/projects/hmem && npx vitest run tests/min-role-removal.test.ts
```

- [ ] **Step 3: Remove `min_role` from `write_memory` tool schema in mcp-server.ts**

Remove the `min_role` parameter from the `write_memory` tool (line 566-568):
```typescript
// DELETE these lines:
    min_role: z.enum(["worker", "al", "pl", "ceo"]).default("worker").describe(
      "Minimum role to see this entry"
    ),
```

Update the destructured params (line 574) — remove `min_role: minRole`.

Replace `effectiveMinRole` usage (line 643) with hardcoded `"worker"`:
```typescript
const result = hmemStore.write(prefix, content, links, "worker" as AgentRole, favorite, tags, pinned, force);
```

- [ ] **Step 4: Remove `min_role` from `update_memory` / `fix_agent_memory` tool schemas**

In `update_memory` (line 2321): remove the `min_role` parameter.
In `fix_agent_memory` (line 2306): remove `min_role` from description.

Update the handler — remove `min_role` from the fields object construction.

- [ ] **Step 5: Remove company store role gate in `write_memory`**

Remove the company store AL+ check (lines 615-623):
```typescript
// DELETE this block:
    if (storeName === "company") {
      const ROLE_LEVEL: Record<string, number> = { worker: 0, al: 1, pl: 2, ceo: 3 };
      if ((ROLE_LEVEL[agentRole] || 0) < 1) {
        return { ... "ERROR: Only AL, PL, and CEO roles can write to company memory." ... };
      }
    }
```

- [ ] **Step 6: Remove role display from read output**

In `mcp-server.ts`, remove role display:
- Line 2269: `const role = e.min_role !== "worker" ? ...` → delete
- Line 2733: `const roleTag = e.min_role !== "worker" ? ...` → delete

In `hmem-store.ts`, remove role display:
- Line 1424: `const role = row.min_role !== "worker" ? ...` → delete

- [ ] **Step 7: Remove `buildRoleFilter()` from hmem-store.ts**

Remove the `buildRoleFilter` method (~line 2758) and the `allowedRoles` function (~line 200). Remove the `AgentRole` type and `ROLE_LEVEL` constant if no longer used elsewhere.

Keep the `min_role` column in the schema — no migration needed.

- [ ] **Step 8: Remove `ROLE` / `HMEM_AGENT_ROLE` env var from mcp-server.ts**

Already partially done in Task 4. Ensure no remaining references to `ROLE`, `HMEM_AGENT_ROLE`, or `COUNCIL_AGENT_ROLE`.

- [ ] **Step 9: Run tests**

```bash
cd /home/bbbee/projects/hmem && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 10: Verify compilation**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit
```

- [ ] **Step 11: Commit**

```bash
git add src/mcp-server.ts src/hmem-store.ts tests/min-role-removal.test.ts
git commit -m "refactor: remove min_role from tool schemas and filtering logic"
```

---

## Task 6: Deprecate Old Functions & Clean Up Exports

**Files:**
- Modify: `src/hmem-store.ts`
- Modify: `src/index.ts` (if it re-exports)

- [ ] **Step 1: Deprecate old `resolveHmemPath(projectDir, templateName)`**

Keep the function but add a deprecation warning:

```typescript
/**
 * @deprecated Use resolveHmemPathNew() instead. Will be removed in v7.0.
 */
export function resolveHmemPath(projectDir: string, templateName: string): string {
  console.error("[hmem] DEPRECATED: resolveHmemPath(projectDir, templateName) — use HMEM_PATH env var instead");
  if (!templateName || templateName === "UNKNOWN") {
    return path.join(projectDir, "memory.hmem");
  }
  let agentDir = path.join(projectDir, "Agents", templateName);
  if (!fs.existsSync(agentDir)) {
    const alt = path.join(projectDir, "Assistenten", templateName);
    if (fs.existsSync(alt)) agentDir = alt;
  }
  return path.join(agentDir, `${templateName}.hmem`);
}
```

- [ ] **Step 2: Rename `resolveHmemPathNew` → `resolveHmemPath` (swap)**

Now that no internal code calls the old version, rename:
- Old `resolveHmemPath(projectDir, templateName)` → `resolveHmemPathLegacy`
- `resolveHmemPathNew()` → `resolveHmemPath()`

Update all imports/usages accordingly.

- [ ] **Step 3: Update `openAgentMemory` to use new resolution**

```typescript
/**
 * @deprecated Use `new HmemStore(resolveHmemPath(), config)` instead.
 */
export function openAgentMemory(projectDir: string, templateName: string, config?: HmemConfig): HmemStore {
  console.error("[hmem] DEPRECATED: openAgentMemory() — use new HmemStore(resolveHmemPath(), config)");
  const hmemPath = resolveHmemPathLegacy(projectDir, templateName);
  return new HmemStore(hmemPath, config);
}
```

- [ ] **Step 4: Verify compilation + tests**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/hmem-store.ts src/index.ts
git commit -m "refactor: rename resolveHmemPathNew to resolveHmemPath, deprecate legacy version"
```

---

## Task 7: Update `routeTask()` and Remaining Store Functions

**Files:**
- Modify: `src/hmem-store.ts` (routeTask function, ~line 4729)

The `routeTask()` function scans `Agents/` directory for agent .hmem files. This function may still be useful but should be updated to not depend on `Agents/` structure.

- [ ] **Step 1: Check if `routeTask` is used anywhere**

Search for `routeTask` in mcp-server.ts. If it's exposed as an MCP tool, update it. If only used internally, simplify.

- [ ] **Step 2: Update or deprecate `routeTask`**

If it's an MCP tool (`route_task`): update the description and keep the `Agents/` scanning as one source, but also support a `files` list from config.

If it's unused in practice: mark as deprecated.

- [ ] **Step 3: Verify compilation + tests**

```bash
cd /home/bbbee/projects/hmem && npx tsc --noEmit && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/hmem-store.ts
git commit -m "refactor: update routeTask to work without HMEM_AGENT_ID"
```

---

## Task 8: Integration Test — Full Server Start

**Files:**
- No new files — manual verification

- [ ] **Step 1: Build the project**

```bash
cd /home/bbbee/projects/hmem && npx tsc
```

- [ ] **Step 2: Test MCP server start with HMEM_PATH**

```bash
HMEM_PATH=~/.hmem/DEVELOPER/DEVELOPER.hmem node dist/mcp-server.js 2>&1 | head -5
```

Expected: Server starts without FATAL error, logs `[hmem:DEVELOPER] MCP Server running on stdio | DB: ...`

- [ ] **Step 3: Test CLI commands**

```bash
HMEM_PATH=~/.hmem/DEVELOPER/DEVELOPER.hmem hmem statusline
```

Expected: Status line output, no errors.

- [ ] **Step 4: Test backward compat — HMEM_PROJECT_DIR + HMEM_AGENT_ID still work**

```bash
HMEM_PROJECT_DIR=~/.hmem HMEM_AGENT_ID=DEVELOPER hmem statusline
```

Expected: Works via legacy path resolution (with deprecation warning).

- [ ] **Step 5: Run full test suite**

```bash
cd /home/bbbee/projects/hmem && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 6: Final commit (version bump)**

Update `package.json` version from `5.3.1` to `6.0.0` (breaking change: HMEM_AGENT_ID removed from tool schemas).

```bash
git add -A
git commit -m "feat!: v6.0.0 — HMEM_PATH replaces HMEM_AGENT_ID, min_role removed

BREAKING CHANGES:
- HMEM_AGENT_ID env var deprecated (use HMEM_PATH instead)
- min_role parameter removed from write_memory and update_memory tools
- Company store no longer role-gated
- HMEM_AGENT_ROLE env var removed"
```

---

## Scope Note: Phase 2 (hmem-sync) and Phase 3 (Skills)

This plan covers **Phase 1** (hmem-mcp changes) only. After this is shipped:

- **Phase 2** (hmem-sync): Separate plan needed for filename-based sync namespacing, new config format, `hmem-sync connect` wizard. Different repo (`~/projects/hmem-sync`).
- **Phase 3** (Skills + cleanup): Update hmem-setup, hmem-sync-setup, hmem-config skills. Create new `hmem-create-agent` skill. Remove `Agents/` directory structure support.
