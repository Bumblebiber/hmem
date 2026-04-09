# Per-Session Active Project State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active-project state per-Claude-session via marker files keyed by `session_id`, eliminating cross-session contamination and silent `O0000` fallbacks, with full observability.

**Architecture:** New `session-state.ts` module manages `~/.hmem/sessions/<session_id>.json` marker files. `getActiveProject` gains optional `sessionId` parameter that reads marker first, falls back to legacy DB flag for backward compatibility. `log-exchange` and `statusline` pass their hook-provided `session_id` to resolve the active project. All fallback paths to `O0000` or "no project" emit loud warnings and append to `~/.hmem/diagnostics.log`.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-09-per-session-active-state-design.md`

**Out of scope (deferred):** HMEM_PATH session anchor (Priority 0 in resolveEnvDefaults), Phase 2 Haiku cross-check agent, auto-migration of already-misrouted exchanges.

---

## File Structure

**Create:**
- `src/session-state.ts` — marker file read/write/cleanup
- `src/diagnostics.ts` — append-only JSONL diagnostic log with rotation
- `test/session-state.test.ts` — unit tests
- `test/e2e/parallel-sessions.test.ts` — integration test

**Modify:**
- `src/hmem-store.ts` — `getActiveProject(sessionId?)` signature + marker-aware resolution; `setActiveProject(id, sessionId?)` also writes marker
- `src/cli-log-exchange.ts` — pass `input.session_id` to `getActiveProject`, emit diagnostics, loud-warn on O0000
- `src/cli-statusline.ts` — per-session cache file, consume `session_id` from stdin JSON, remove "most recently updated" fallback
- `src/cli-hook-startup.ts` — write initial marker file, purge stale markers (>7 days)
- `src/mcp-server.ts` — `load_project` and write/append/update auto-activation paths call `setActiveProject(id, HMEM_SESSION_ID)`
- `src/cli-checkpoint.ts` — read `HMEM_SESSION_ID` env, pass to `getActiveProject`

---

## Task 1: Session-state module

**Files:**
- Create: `src/session-state.ts`
- Test: `test/session-state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/session-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeSessionMarker,
  readSessionMarker,
  clearSessionMarker,
  purgeStaleSessionMarkers,
  sessionMarkerDir,
} from "../src/session-state.js";

const tmpHome = path.join(os.tmpdir(), `hmem-test-${process.pid}`);
const oldHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("session-state", () => {
  it("writes and reads a marker file", () => {
    writeSessionMarker("abc-123", { projectId: "P0048", hmemPath: "/x/memory.hmem" });
    const marker = readSessionMarker("abc-123");
    expect(marker?.projectId).toBe("P0048");
    expect(marker?.hmemPath).toBe("/x/memory.hmem");
    expect(marker?.sessionId).toBe("abc-123");
    expect(marker?.updatedAt).toBeDefined();
  });

  it("returns null when marker does not exist", () => {
    expect(readSessionMarker("nope")).toBeNull();
  });

  it("updates an existing marker preserving hmemPath when omitted", () => {
    writeSessionMarker("s1", { projectId: "P0001", hmemPath: "/a/x.hmem" });
    writeSessionMarker("s1", { projectId: "P0002" });
    const m = readSessionMarker("s1");
    expect(m?.projectId).toBe("P0002");
    expect(m?.hmemPath).toBe("/a/x.hmem");
  });

  it("clearSessionMarker removes the file", () => {
    writeSessionMarker("s2", { projectId: "P0003", hmemPath: "/b.hmem" });
    clearSessionMarker("s2");
    expect(readSessionMarker("s2")).toBeNull();
  });

  it("purges markers older than N days", () => {
    writeSessionMarker("old", { projectId: "P1", hmemPath: "/x" });
    writeSessionMarker("new", { projectId: "P2", hmemPath: "/x" });
    const oldPath = path.join(sessionMarkerDir(), "old.json");
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, oldTime, oldTime);

    const removed = purgeStaleSessionMarkers(7);
    expect(removed).toBe(1);
    expect(readSessionMarker("old")).toBeNull();
    expect(readSessionMarker("new")).not.toBeNull();
  });

  it("tolerates corrupt JSON by returning null", () => {
    const dir = sessionMarkerDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(readSessionMarker("bad")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /home/bbbee/projects/hmem
npx vitest run test/session-state.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/session-state.ts`**

```ts
/**
 * session-state.ts
 *
 * Per-Claude-session active-project marker files.
 * Located in ~/.hmem/sessions/<session_id>.json and keyed by the session_id
 * that Claude Code passes in every hook's stdin JSON.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionMarker {
  sessionId: string;
  projectId: string | null;
  hmemPath: string;
  updatedAt: string;
  pid: number;
}

export interface SessionMarkerInput {
  projectId?: string | null;
  hmemPath?: string;
}

function safeHomedir(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
  return process.env.HOME || os.homedir();
}

export function sessionMarkerDir(): string {
  return path.join(safeHomedir(), ".hmem", "sessions");
}

function markerPath(sessionId: string): string {
  // sanitize: only allow safe chars to avoid path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(sessionMarkerDir(), `${safe}.json`);
}

export function writeSessionMarker(sessionId: string, input: SessionMarkerInput): void {
  if (!sessionId) return;
  const dir = sessionMarkerDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = markerPath(sessionId);

  // Preserve existing hmemPath if caller didn't supply one
  let existing: Partial<SessionMarker> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionMarker>;
  } catch { /* ignore */ }

  const marker: SessionMarker = {
    sessionId,
    projectId: input.projectId !== undefined ? input.projectId : (existing.projectId ?? null),
    hmemPath: input.hmemPath ?? existing.hmemPath ?? "",
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };

  // Atomic write: temp file + rename
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, file);
}

export function readSessionMarker(sessionId: string): SessionMarker | null {
  if (!sessionId) return null;
  try {
    const raw = fs.readFileSync(markerPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as SessionMarker;
    if (!parsed.sessionId) parsed.sessionId = sessionId;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSessionMarker(sessionId: string): void {
  try { fs.unlinkSync(markerPath(sessionId)); } catch { /* ignore */ }
}

export function purgeStaleSessionMarkers(maxAgeDays: number): number {
  const dir = sessionMarkerDir();
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch { /* ignore */ }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx vitest run test/session-state.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-state.ts test/session-state.test.ts
git commit -m "feat: add session-state module for per-session marker files"
```

---

## Task 2: Diagnostics log module

**Files:**
- Create: `src/diagnostics.ts`
- Test: `test/diagnostics.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/diagnostics.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDiagnostic, diagnosticsLogPath } from "../src/diagnostics.js";

const tmpHome = path.join(os.tmpdir(), `hmem-diag-${process.pid}`);
const oldHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("diagnostics", () => {
  it("appends a JSONL entry", () => {
    writeDiagnostic({ op: "log-exchange", sessionId: "s1", activeProjectId: "P0048" });
    const lines = fs.readFileSync(diagnosticsLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.op).toBe("log-exchange");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.ts).toBeDefined();
  });

  it("rotates when file exceeds max size", () => {
    const logPath = diagnosticsLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "x".repeat(1024 * 1024 + 10));
    writeDiagnostic({ op: "test", sessionId: "s2" });
    expect(fs.existsSync(logPath + ".1")).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(1024);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run test/diagnostics.test.ts
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/diagnostics.ts`**

```ts
/**
 * diagnostics.ts
 *
 * Append-only JSONL diagnostic log at ~/.hmem/diagnostics.log.
 * Rotated to .1 when the file exceeds 1 MB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;

function safeHomedir(): string {
  if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
  return process.env.HOME || os.homedir();
}

export function diagnosticsLogPath(): string {
  return path.join(safeHomedir(), ".hmem", "diagnostics.log");
}

export interface DiagnosticEntry {
  op: string;
  sessionId?: string;
  hmemPath?: string;
  activeProjectId?: string | null;
  oId?: string | null;
  batchId?: string | null;
  markerSource?: "session-marker" | "db-fallback" | "none";
  warning?: string;
  [key: string]: unknown;
}

export function writeDiagnostic(entry: DiagnosticEntry): void {
  try {
    const logPath = diagnosticsLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Rotate if oversized
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_BYTES) {
        const rotated = logPath + ".1";
        try { fs.unlinkSync(rotated); } catch { /* ignore */ }
        fs.renameSync(logPath, rotated);
      }
    } catch { /* no existing file */ }

    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(logPath, line);
  } catch {
    // diagnostics must never crash the caller
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx vitest run test/diagnostics.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics.ts test/diagnostics.test.ts
git commit -m "feat: add diagnostics.log module with rotation"
```

---

## Task 3: Refactor `getActiveProject` to accept sessionId

**Files:**
- Modify: `src/hmem-store.ts` (lines ~2822 and ~2926)
- Test: add cases to `test/session-state.test.ts` or new `test/hmem-store-active.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/hmem-store-active.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../src/hmem-store.js";
import { writeSessionMarker } from "../src/session-state.js";
import { loadHmemConfig } from "../src/hmem-config.js";

const tmpHome = path.join(os.tmpdir(), `hmem-active-${process.pid}`);
const oldHome = process.env.HOME;
let store: HmemStore;
let hmemPath: string;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
  hmemPath = path.join(tmpHome, "test.hmem");
  store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
  // Seed two P-entries
  store.write({ id: "P0001", title: "Alpha", content: "a" });
  store.write({ id: "P0002", title: "Beta", content: "b" });
});
afterEach(() => {
  store.close();
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("getActiveProject with sessionId", () => {
  it("prefers marker file over DB flag", () => {
    store.setActiveProject("P0001"); // sets DB flag
    writeSessionMarker("sX", { projectId: "P0002", hmemPath });
    const active = store.getActiveProject("sX");
    expect(active?.id).toBe("P0002");
  });

  it("falls back to DB flag when no marker", () => {
    store.setActiveProject("P0001");
    const active = store.getActiveProject("sUnknown");
    expect(active?.id).toBe("P0001");
  });

  it("returns null when marker has null projectId", () => {
    writeSessionMarker("sY", { projectId: null, hmemPath });
    expect(store.getActiveProject("sY")).toBeNull();
  });

  it("setActiveProject(id, sessionId) writes marker", () => {
    store.setActiveProject("P0002", "sZ");
    const { readSessionMarker } = require("../src/session-state.js");
    expect(readSessionMarker("sZ").projectId).toBe("P0002");
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run test/hmem-store-active.test.ts
```
Expected: FAIL — `getActiveProject` doesn't accept sessionId.

- [ ] **Step 3: Modify `src/hmem-store.ts`**

Add import at top of file (near other imports):

```ts
import { readSessionMarker, writeSessionMarker } from "./session-state.js";
```

Replace `setActiveProject` (around line 2822):

```ts
  setActiveProject(id: string, sessionId?: string): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET active = 0, updated_at = ? WHERE prefix = 'P' AND active = 1 AND id != ?").run(now, id);
      this.db.prepare("UPDATE memories SET active = 1, updated_at = ? WHERE id = ?").run(now, id);
    });
    tx();
    // Mirror to per-session marker file
    if (sessionId) {
      writeSessionMarker(sessionId, { projectId: id, hmemPath: this.dbPath });
    }
  }
```

Make sure `HmemStore` exposes `dbPath` (check constructor — if not already a property, add `public readonly dbPath: string` assignment in constructor).

Replace `getActiveProject` (around line 2926):

```ts
  getActiveProject(sessionId?: string): { id: string; title: string } | null {
    // Priority 1: session marker (if sessionId supplied)
    if (sessionId) {
      const marker = readSessionMarker(sessionId);
      if (marker) {
        if (marker.projectId === null) return null;
        const row = this.db.prepare(
          "SELECT id, title FROM memories WHERE id = ? AND prefix = 'P' AND obsolete != 1 LIMIT 1"
        ).get(marker.projectId) as { id: string; title: string } | undefined;
        if (row) return row;
        // Marker points to non-existent project: fall through to DB flag
      }
    }
    // Priority 2: legacy DB flag (backward compat for sessions without markers)
    return (this.db.prepare(
      "SELECT id, title FROM memories WHERE prefix = 'P' AND active = 1 AND obsolete != 1 LIMIT 1"
    ).get() as { id: string; title: string } | undefined) ?? null;
  }
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx vitest run test/hmem-store-active.test.ts
npx vitest run  # full suite to catch call-site compilation errors
```
Expected: new tests PASS. Existing suite compilation errors are expected in call sites — fix in Task 4 and 5.

- [ ] **Step 5: Commit**

```bash
git add src/hmem-store.ts test/hmem-store-active.test.ts
git commit -m "feat(hmem-store): getActiveProject accepts sessionId, reads marker"
```

---

## Task 4: Wire `cli-log-exchange` to session marker + diagnostics

**Files:**
- Modify: `src/cli-log-exchange.ts`

- [ ] **Step 1: Write failing integration test**

Create `test/log-exchange-routing.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../src/hmem-store.js";
import { writeSessionMarker } from "../src/session-state.js";
import { loadHmemConfig } from "../src/hmem-config.js";
import { diagnosticsLogPath } from "../src/diagnostics.js";

const tmpHome = path.join(os.tmpdir(), `hmem-logex-${process.pid}`);
const oldHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("log-exchange routing by sessionId", () => {
  it("two sessions with different markers route to different O-entries", () => {
    const hmemPath = path.join(tmpHome, "test.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    store.write({ id: "P0001", title: "A", content: "a" });
    store.write({ id: "P0002", title: "B", content: "b" });

    writeSessionMarker("s-one", { projectId: "P0001", hmemPath });
    writeSessionMarker("s-two", { projectId: "P0002", hmemPath });

    const aOne = store.getActiveProject("s-one");
    const aTwo = store.getActiveProject("s-two");
    expect(aOne?.id).toBe("P0001");
    expect(aTwo?.id).toBe("P0002");
    store.close();
  });
});
```

- [ ] **Step 2: Run, verify pass** (this mostly exercises Task 3, but establishes the routing contract)

```bash
npx vitest run test/log-exchange-routing.test.ts
```
Expected: PASS.

- [ ] **Step 3: Modify `src/cli-log-exchange.ts`**

At top, add import:

```ts
import { writeDiagnostic } from "./diagnostics.js";
import { readSessionMarker } from "./session-state.js";
```

Update `HookInput` interface to include `session_id`:

```ts
interface HookInput {
  transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  session_id?: string;
}
```

Replace the section starting at `// Step 1: Resolve project O-entry` (around line 188) with:

```ts
    // Step 1: Resolve project O-entry (per-session)
    const sessionId = input.session_id;
    const marker = sessionId ? readSessionMarker(sessionId) : null;
    const markerSource: "session-marker" | "db-fallback" | "none" =
      marker ? "session-marker" : (sessionId ? "db-fallback" : "none");

    const activeProject = store.getActiveProject(sessionId);
    const projectSeq = activeProject ? parseInt(activeProject.id.replace(/\D/g, ""), 10) : 0;
    const oId = store.resolveProjectO(projectSeq);

    // Loud warnings for fallback cases
    if (!activeProject) {
      console.error(`[hmem] WARNING: no active project for session ${sessionId ?? "(none)"}, writing to O0000`);
    }
    if (markerSource === "db-fallback") {
      console.error(`[hmem] WARNING: session ${sessionId} has no marker file, using legacy DB flag`);
    }
    if (marker && marker.hmemPath && marker.hmemPath !== hmemPath) {
      console.error(`[hmem] DRIFT: marker hmemPath=${marker.hmemPath} resolved=${hmemPath}`);
    }

    // Step 2: Resolve session (transcript_path tracking)
    const sessionIdInternal = store.resolveSession(oId, input.transcript_path!);

    // Step 3: Resolve batch
    const batchSize = hmemConfig.checkpointInterval || 5;
    const batchId = store.resolveBatch(sessionIdInternal, oId, batchSize);

    // Diagnostics
    writeDiagnostic({
      op: "log-exchange",
      sessionId,
      hmemPath,
      activeProjectId: activeProject?.id ?? null,
      oId,
      batchId,
      markerSource,
      warning: !activeProject ? "no-active-project-O0000" : undefined,
    });

    // Step 4: Append exchange
    store.appendExchangeV2(batchId, oId, userMessage, input.last_assistant_message!);
```

Note: renamed the internal `sessionId` variable (from `store.resolveSession`) to `sessionIdInternal` to avoid shadowing the Claude session id. Update the checkpoint spawn block accordingly — pass `HMEM_SESSION_ID: sessionId` in the env:

```ts
          const child = spawn(process.execPath, [HMEM_BIN, "checkpoint"], {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              HMEM_PROJECT_DIR: projectDir,
              HMEM_PATH: process.env.HMEM_PATH,
              ...(sessionId ? { HMEM_SESSION_ID: sessionId } : {}),
              ...(activeProject ? { HMEM_ACTIVE_PROJECT: activeProject.id } : {}),
            },
          });
```

- [ ] **Step 4: Build and run full test suite**

```bash
npm run build
npx vitest run
```
Expected: build succeeds, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli-log-exchange.ts test/log-exchange-routing.test.ts
git commit -m "feat(log-exchange): route by session_id, emit diagnostics"
```

---

## Task 5: Update `cli-statusline` — per-session cache, remove fallback

**Files:**
- Modify: `src/cli-statusline.ts`

- [ ] **Step 1: Write failing test**

Create `test/statusline.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../src/hmem-store.js";
import { writeSessionMarker } from "../src/session-state.js";
import { loadHmemConfig } from "../src/hmem-config.js";

// Note: cli-statusline reads stdin. For this test we exercise the DB query logic
// directly by importing getActiveProject via HmemStore.

const tmpHome = path.join(os.tmpdir(), `hmem-sl-${process.pid}`);

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("statusline session isolation", () => {
  it("two concurrent sessions see their own active project", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    store.write({ id: "P0001", title: "A", content: "a" });
    store.write({ id: "P0002", title: "B", content: "b" });
    writeSessionMarker("sess-A", { projectId: "P0001", hmemPath });
    writeSessionMarker("sess-B", { projectId: "P0002", hmemPath });
    expect(store.getActiveProject("sess-A")?.id).toBe("P0001");
    expect(store.getActiveProject("sess-B")?.id).toBe("P0002");
    store.close();
  });
});
```

- [ ] **Step 2: Run, verify pass**

```bash
npx vitest run test/statusline.test.ts
```
Expected: PASS (contract test).

- [ ] **Step 3: Modify `src/cli-statusline.ts`**

Update `StatusInput` interface (line 20):

```ts
interface StatusInput {
  session_id?: string;
  context_window?: {
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}
```

Remove the global cache constant (line 42) and make it a function:

```ts
function cacheFile(sessionId: string | undefined): string {
  const key = sessionId ? sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") : "global";
  return `/tmp/.hmem_statusline_${key}.cache`;
}
```

Change `getHmemStatus()` signature to accept `sessionId`:

```ts
async function getHmemStatus(sessionId: string | undefined): Promise<HmemStatus> {
  const empty: HmemStatus = { project: "", exchanges: 0, interval: 0 };
  const CACHE_FILE = cacheFile(sessionId);

  // Check cache
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf-8");
      const newline = raw.indexOf("\n");
      if (newline > 0) {
        const cacheTs = parseInt(raw.substring(0, newline), 10);
        const age = Math.floor(Date.now() / 1000) - cacheTs;
        if (age < CACHE_TTL) {
          return JSON.parse(raw.substring(newline + 1)) as HmemStatus;
        }
      }
    }
  } catch { /* ignore */ }
  // ... (rest of function, with changes below)
```

In the DB query section, **remove** the fallback block (lines 109-111: "most recently updated P-entry"). Replace with session-marker lookup. Replace the existing `projRow` logic with:

```ts
    const { readSessionMarker } = await import("./session-state.js");
    const marker = sessionId ? readSessionMarker(sessionId) : null;

    let projRow: { id: string; title: string } | undefined;
    if (marker && marker.projectId) {
      projRow = db.prepare(
        "SELECT id, title FROM memories WHERE id = ? AND prefix='P' AND obsolete!=1 LIMIT 1"
      ).get(marker.projectId) as { id: string; title: string } | undefined;
    } else if (!marker) {
      // Legacy fallback — session without marker, read global active flag
      projRow = db.prepare(
        "SELECT id, title FROM memories WHERE prefix='P' AND active=1 AND obsolete!=1 LIMIT 1"
      ).get() as { id: string; title: string } | undefined;
    }
    // If marker exists but projectId is null → projRow stays undefined → "no project"
```

Pass `sessionId` into `writeCache`:

```ts
function writeCache(value: HmemStatus, sessionId: string | undefined): HmemStatus {
  try {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(cacheFile(sessionId), `${now}\n${JSON.stringify(value)}\n`);
  } catch { /* ignore */ }
  return value;
}
```

Update all `writeCache(x)` calls to `writeCache(x, sessionId)`.

In `statusline()` function (line 167), extract session id and pass through:

```ts
export async function statusline(): Promise<void> {
  let input: StatusInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch { /* no input */ }

  const parts: string[] = [];
  const ctxBar = buildContextBar(input);
  if (ctxBar) parts.push(ctxBar);

  const status = await getHmemStatus(input.session_id);
  // ... rest unchanged
}
```

- [ ] **Step 4: Build + test**

```bash
npm run build
npx vitest run
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli-statusline.ts test/statusline.test.ts
git commit -m "feat(statusline): per-session cache and marker-based active lookup"
```

---

## Task 6: SessionStart hook writes marker + purges stale

**Files:**
- Modify: `src/cli-hook-startup.ts`

- [ ] **Step 1: Modify `src/cli-hook-startup.ts`**

Add imports at top:

```ts
import { writeSessionMarker, purgeStaleSessionMarkers, readSessionMarker } from "./session-state.js";
```

After `resolveEnvDefaults()` and the `hmemPath` read (around line 49-57), add marker initialization:

```ts
  // Initialize session marker (idempotent — don't clobber existing projectId)
  if (sessionId && sessionId !== "global" && hmemPath) {
    const existing = readSessionMarker(sessionId);
    if (!existing) {
      writeSessionMarker(sessionId, { projectId: null, hmemPath });
    }
    // Purge stale markers on first message only (cheap)
    if (count === 0) {  // count is read below; adjust ordering if needed
      try { purgeStaleSessionMarkers(7); } catch { /* ignore */ }
    }
  }
```

Because `count` is read further down, move the marker+purge block to after the counter read. Full replacement for the block starting at "// Counter file" through the end of first-message handling — keep logic sequence but inject marker init after counter increment:

```ts
  // Counter file (session-scoped)
  const counterFile = path.join(os.tmpdir(), `claude-hmem-counter-${sessionId}`);
  let count = 0;
  try {
    count = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0;
  } catch {}

  count++;
  fs.writeFileSync(counterFile, String(count), "utf8");

  // Initialize session marker (first message only)
  if (sessionId && sessionId !== "global" && hmemPath && count === 1) {
    const existing = readSessionMarker(sessionId);
    if (!existing) {
      writeSessionMarker(sessionId, { projectId: null, hmemPath });
    }
    try { purgeStaleSessionMarkers(7); } catch { /* ignore */ }
  }
```

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: success.

- [ ] **Step 3: Manual smoke test**

```bash
echo '{"session_id":"smoke-1"}' | node dist/cli.js hook-startup
ls ~/.hmem/sessions/smoke-1.json && cat ~/.hmem/sessions/smoke-1.json
rm ~/.hmem/sessions/smoke-1.json
rm /tmp/claude-hmem-counter-smoke-1
```
Expected: marker file exists with `projectId: null` and correct `hmemPath`.

- [ ] **Step 4: Commit**

```bash
git add src/cli-hook-startup.ts
git commit -m "feat(hook-startup): initialize session marker and purge stale"
```

---

## Task 7: MCP server — `load_project` and auto-activation pass sessionId

**Files:**
- Modify: `src/mcp-server.ts` (line ~1978 setActiveProject call, and the auto-activation paths in write/append/update)

- [ ] **Step 1: Find all setActiveProject call sites**

```bash
grep -n "setActiveProject" src/mcp-server.ts
```

- [ ] **Step 2: Update each call**

Replace every `hmemStore.setActiveProject(id)` with `hmemStore.setActiveProject(id, process.env.HMEM_SESSION_ID)`.

Example at line ~1978:

```ts
        hmemStore.setActiveProject(id, process.env.HMEM_SESSION_ID);
        activeProjectId = id;
```

Also update `src/cli-checkpoint.ts:86`:

```ts
      : store.getActiveProject(process.env.HMEM_SESSION_ID);
```

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server.ts src/cli-checkpoint.ts
git commit -m "feat(mcp): pass HMEM_SESSION_ID to setActiveProject and getActiveProject"
```

---

## Task 8: MCP server session-id injection — document current behavior

**Files:**
- Modify: `docs/superpowers/specs/2026-04-09-per-session-active-state-design.md` (resolve Open Question)

- [ ] **Step 1: Check whether Claude Code passes session_id to MCP launches**

Spawn a test MCP server that logs `process.env`:

```bash
# In a scratch file, add to an existing MCP tool or create a minimal server:
console.error("[env-dump] HMEM_SESSION_ID=", process.env.HMEM_SESSION_ID);
console.error("[env-dump] CLAUDE_SESSION_ID=", process.env.CLAUDE_SESSION_ID);
```

Restart Claude Code, check stderr output of MCP handshake.

- [ ] **Step 2: Document findings in spec Open Questions section**

If Claude Code **does** export it → update the spec to remove the wrapper-script workaround.
If Claude Code **does not** → add a SessionStart-hook step that writes `~/.hmem/sessions/<id>.env` and document a wrapper script for `hmem serve` that sources it.

For Phase 1 we accept a graceful degradation: if `HMEM_SESSION_ID` is not set in the MCP server process, `setActiveProject(id, undefined)` writes only the DB flag (current behavior), and log-exchange still routes correctly because it passes its own `session_id` from the Stop hook JSON. The only loss is that `load_project` in Session A could still flip the DB flag visible to legacy-fallback sessions. That's OK because once every session has a marker file, the DB flag is unused.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/superpowers/specs/2026-04-09-per-session-active-state-design.md
git commit -m "docs: resolve MCP session-id injection question"
```

---

## Task 9: End-to-end parallel sessions test

**Files:**
- Create: `test/e2e/parallel-sessions.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../../src/hmem-store.js";
import { loadHmemConfig } from "../../src/hmem-config.js";
import { writeSessionMarker } from "../../src/session-state.js";

const tmpHome = path.join(os.tmpdir(), `hmem-e2e-${process.pid}`);

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("parallel sessions do not contaminate each other", () => {
  it("session A load_project does not change session B active project", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    store.write({ id: "P0001", title: "A", content: "" });
    store.write({ id: "P0002", title: "B", content: "" });

    // Session A activates P0001
    store.setActiveProject("P0001", "sess-A");
    // Session B activates P0002
    store.setActiveProject("P0002", "sess-B");

    // Despite DB flag now being P0002, each session sees its own:
    expect(store.getActiveProject("sess-A")?.id).toBe("P0001");
    expect(store.getActiveProject("sess-B")?.id).toBe("P0002");
    store.close();
  });

  it("session without marker falls through to DB flag", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    store.write({ id: "P0001", title: "A", content: "" });
    store.setActiveProject("P0001");
    expect(store.getActiveProject("legacy-session")?.id).toBe("P0001");
    store.close();
  });
});
```

- [ ] **Step 2: Run, verify pass**

```bash
npx vitest run test/e2e/parallel-sessions.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/parallel-sessions.test.ts
git commit -m "test(e2e): verify parallel sessions stay isolated"
```

---

## Task 10: Update project documentation and release notes

**Files:**
- Modify: `README.md` (if it mentions active flag)
- Modify: `CHANGELOG.md` or equivalent
- Memory: update `P0048.1.1` Overview via MCP `update_memory` after release

- [ ] **Step 1: Add CHANGELOG entry**

```markdown
## 6.2.0 — 2026-04-09

### Fixed
- **Per-session active project state** — parallel Claude Code sessions no longer contaminate each other's active project. Each session now has its own marker file at `~/.hmem/sessions/<session_id>.json`. Fixes symptoms where exchanges were silently written to `O0000` or to a parallel session's O-entry.
- **Statusline cache** was global, causing two sessions to share the same cached project for 30 seconds. Now per-session.
- **Statusline no longer guesses** "most recently updated project" when nothing is active — shows `no project` instead.

### Added
- `~/.hmem/diagnostics.log` — JSONL log of every `log-exchange` call with active project resolution, rotated at 1 MB.
- Loud `console.error` warnings when log-exchange falls through to O0000 or legacy DB flag.

### Deferred
- HMEM_PATH session anchor (CWD-discovery trap) — follow-up for users who start `claude` from project directories with `.hmem` files.
- Haiku checkpoint cross-check agent — Phase 2.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for 6.2.0 per-session active state"
```

- [ ] **Step 3: Post-release hmem updates (after publish, not in this plan)**
  - Update `P0048.1.1` Overview entry via `update_memory`
  - Log this session's work
  - R0008 check: last publish was 2026-04-08 (6.1.1) — 6.2.0 can publish today per R0008

---

## Self-review checklist (completed by plan author)

- ✅ Spec coverage: marker files (Task 1), diagnostics (Task 2), getActiveProject refactor (Task 3), log-exchange routing (Task 4), statusline isolation + fallback removal (Task 5), SessionStart marker init (Task 6), MCP setActiveProject wiring (Task 7), MCP session-id injection resolved (Task 8), parallel E2E (Task 9), docs (Task 10).
- ✅ No placeholders: all code blocks are complete.
- ✅ Type consistency: `SessionMarker.projectId: string | null`, `getActiveProject(sessionId?: string)`, `setActiveProject(id: string, sessionId?: string)` used consistently across tasks.
- ⚠️  Task 8 (MCP env injection) has an intentional investigation step — acceptable because we have a documented graceful-degradation fallback for both outcomes.
- ✅ Deferred items (HMEM_PATH anchor, Phase 2 Haiku, auto-migration of O0000 entries) explicitly out of scope.
