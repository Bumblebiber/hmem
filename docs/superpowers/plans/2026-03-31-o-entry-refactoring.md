# O-Entry Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind O-entries permanently to P-entries (O0048 <-> P0048), use all 5 hmem levels for a clean Session -> Batch -> Exchange -> Raw Messages hierarchy.

**Architecture:** Replace flat O-entry structure (L2->L4->L5) with 5-level hierarchy (L2 Session -> L3 Batch -> L4 Exchange -> L5 User/Agent). O-entries are derived from active P via matching sequence numbers — no more `active` flag on O. Session detection via transcript_path tracking in temp file. Haiku checkpoint rewritten to operate on batches with rolling summaries.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Claude Code hooks (Stop/SessionStart)

**Spec:** `docs/superpowers/specs/2026-03-31-o-entry-refactoring-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hmem-store.ts` | Modify | New methods: `resolveProjectO()`, `resolveSession()`, `resolveBatch()`, `appendExchangeV2()`, `getOEntryExchangesV2()`, `moveNodes()`, `listProjects()`. Remove: `getActiveO()`, `getActiveOId()`. Update: `appendCheckpointSummary()` -> writes L3 body. |
| `src/cli-log-exchange.ts` | Modify | 5-step pipeline: resolveProjectO -> resolveSession -> resolveBatch -> appendExchange -> triggerCheckpoint |
| `src/cli-checkpoint.ts` | Modify | Batch-based checkpoint prompt with P-titles, rolling summaries, exchange tagging, move_nodes |
| `src/cli-session-summary.ts` | Create | New CLI: `hmem summarize-session <session_id>` — async Haiku session summary |
| `src/cli-migrate-o.ts` | Create | New CLI: `hmem migrate-o-entries` — reassign O-IDs to match P-IDs |
| `src/cli.ts` | Modify | Add `summarize-session` and `migrate-o-entries` commands |
| `src/mcp-server.ts` | Modify | New tools: `list_projects`, `move_nodes`. Enhanced `load_project` with O-context. Updated `read_memory` for 5-level O rendering. |
| `src/cli-statusline.ts` | Modify | Update exchange counting for new batch structure |
| `src/cli-init.ts` | Modify | SessionStart hook: check for missing session summary, spawn async |
| `tests/o-entry-refactoring.test.ts` | Create | Tests for all new store methods |

---

## Task 1: Core Store Methods — resolveProjectO + resolveSession + resolveBatch

**Files:**
- Modify: `src/hmem-store.ts` (add 3 new methods, lines ~2805-2847)
- Create: `tests/o-entry-refactoring.test.ts`

- [ ] **Step 1: Write failing tests for resolveProjectO**

```typescript
// tests/o-entry-refactoring.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HmemStore } from "../src/hmem-store.js";
import { DEFAULT_CONFIG } from "../src/hmem-config.js";

const TMP = join(__dirname, ".tmp-o-refactor-test");
const DB_PATH = join(TMP, "test.hmem");

let store: HmemStore;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  store = new HmemStore(DB_PATH, DEFAULT_CONFIG);
});

afterEach(() => {
  store.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("resolveProjectO", () => {
  it("creates O0048 for P0048 if it does not exist", () => {
    // Create P0048 first
    store.writeLinear("P", { l1: "hmem-mcp | Memory for AI" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    expect(oId).toBe("O0048");

    // Verify it was created with correct link
    const entry = store.readEntry("O0048");
    expect(entry).toBeTruthy();
    expect(entry!.links).toContain("P0048");
  });

  it("returns existing O0048 if it already exists", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId1 = store.resolveProjectO(48);
    const oId2 = store.resolveProjectO(48);
    expect(oId1).toBe(oId2);
  });

  it("falls back to O0000 when projectSeq is 0", () => {
    const oId = store.resolveProjectO(0);
    expect(oId).toBe("O0000");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: FAIL — `store.resolveProjectO is not a function`

- [ ] **Step 3: Implement resolveProjectO**

Add to `src/hmem-store.ts` after `getActiveProject()` (line ~2854):

```typescript
/**
 * Find or create the O-entry for a given project sequence number.
 * O0048 belongs to P0048, O0000 is the non-project catch-all.
 * Does NOT use the active flag — O is derived purely from P's seq.
 */
resolveProjectO(projectSeq: number): string {
  const oId = `O${String(projectSeq).padStart(4, "0")}`;
  const existing = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(oId) as any;
  if (existing) return oId;

  // Create new O-entry linked to the P-entry
  const pId = `P${String(projectSeq).padStart(4, "0")}`;
  const pEntry = this.db.prepare("SELECT title FROM memories WHERE id = ?").get(pId) as any;
  const projectName = pEntry?.title?.split("|")[0]?.trim() ?? "Non-Project";
  const timestamp = new Date().toISOString();

  this.db.prepare(`
    INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, links, min_role)
    VALUES (?, 'O', ?, ?, ?, ?, ?, ?, 'worker')
  `).run(oId, projectSeq, timestamp, timestamp, projectName, projectName,
    projectSeq > 0 ? JSON.stringify([pId]) : null);

  return oId;
}
```

- [ ] **Step 4: Run tests to verify resolveProjectO passes**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Write failing tests for resolveSession**

Add to `tests/o-entry-refactoring.test.ts`:

```typescript
describe("resolveSession", () => {
  it("creates a new L2 session node for a new transcript path", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    expect(sessionId).toBe("O0048.1");

    // Verify L2 node was created
    const node = store.readNode(sessionId);
    expect(node).toBeTruthy();
    expect(node!.depth).toBe(2);
  });

  it("returns same session for same transcript path", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const s1 = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    const s2 = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    expect(s1).toBe(s2);
  });

  it("creates new session for different transcript path", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const s1 = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    const s2 = store.resolveSession(oId, "/tmp/transcript-def.jsonl");
    expect(s1).not.toBe(s2);
    expect(s2).toBe("O0048.2");
  });
});
```

- [ ] **Step 6: Implement resolveSession**

Add to `src/hmem-store.ts`:

```typescript
/**
 * Find or create a session (L2 node) under an O-entry.
 * Sessions are tracked via a temp file keyed by hmem path + O-entry ID.
 * A new transcript_path means a new Claude Code session.
 */
resolveSession(oId: string, transcriptPath: string): string {
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const stateFile = `/tmp/.hmem_session_${crypto.createHash("md5").update(oId).digest("hex").substring(0, 8)}.json`;

  // Check temp file for current session
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      if (state.transcript_path === transcriptPath && state.session_l2_id) {
        // Verify the session node still exists
        const exists = this.db.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(state.session_l2_id);
        if (exists) return state.session_l2_id;
      }
    }
  } catch { /* corrupt file — create new session */ }

  // Create new L2 session node
  const today = new Date().toISOString().substring(0, 10);
  const timestamp = new Date().toISOString();

  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(oId + ".", oId + ".%", oId + ".%.%") as any;
  const seq = (maxSeqRow?.m ?? 0) + 1;

  const sessionId = `${oId}.${seq}`;
  const title = `Session ${today}`;

  this.db.prepare(
    "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(sessionId, oId, oId, 2, seq, title, title, timestamp, timestamp);
  this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

  // Write state file
  const state = { transcript_path: transcriptPath, session_l2_id: sessionId, batch_l3_id: "", exchange_count: 0 };
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}

  return sessionId;
}
```

- [ ] **Step 7: Run tests to verify resolveSession passes**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: 6 PASS

- [ ] **Step 8: Write failing tests for resolveBatch**

Add to `tests/o-entry-refactoring.test.ts`:

```typescript
describe("resolveBatch", () => {
  it("creates first batch under a session", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);
    expect(batchId).toBe("O0048.1.1");

    const node = store.readNode(batchId);
    expect(node).toBeTruthy();
    expect(node!.depth).toBe(3);
  });

  it("returns same batch if not full", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    const b1 = store.resolveBatch(sessionId, oId, 5);
    // Add 3 exchanges (under capacity of 5)
    for (let i = 0; i < 3; i++) {
      store.appendExchangeV2(b1, oId, `user msg ${i}`, `agent msg ${i}`);
    }
    const b2 = store.resolveBatch(sessionId, oId, 5);
    expect(b1).toBe(b2);
  });

  it("creates new batch when current is full", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/transcript-abc.jsonl");
    const b1 = store.resolveBatch(sessionId, oId, 3); // batch size 3 for testing
    for (let i = 0; i < 3; i++) {
      store.appendExchangeV2(b1, oId, `user msg ${i}`, `agent msg ${i}`);
    }
    const b2 = store.resolveBatch(sessionId, oId, 3);
    expect(b2).not.toBe(b1);
    expect(b2).toBe("O0048.1.2");
  });
});
```

- [ ] **Step 9: Implement resolveBatch**

Add to `src/hmem-store.ts`:

```typescript
/**
 * Find or create a batch (L3 node) under a session.
 * Creates a new batch if the current one is full (>= batchSize L4 children).
 */
resolveBatch(sessionId: string, oId: string, batchSize: number): string {
  // Find latest L3 batch under this session
  const latestBatch = this.db.prepare(
    "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq DESC LIMIT 1"
  ).get(sessionId) as { id: string } | undefined;

  if (latestBatch) {
    // Count L4 exchanges in this batch
    const count = (this.db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
    ).get(latestBatch.id) as any)?.n ?? 0;

    if (count < batchSize) return latestBatch.id;
  }

  // Create new L3 batch
  const timestamp = new Date().toISOString();
  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(sessionId + ".", sessionId + ".%", sessionId + ".%.%") as any;
  const seq = (maxSeqRow?.m ?? 0) + 1;

  const batchId = `${sessionId}.${seq}`;
  const title = `Batch ${seq}`;

  this.db.prepare(
    "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(batchId, sessionId, oId, 3, seq, title, title, timestamp, timestamp);
  this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);

  return batchId;
}
```

- [ ] **Step 10: Run all tests**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: 9 PASS

- [ ] **Step 11: Commit**

```bash
git add src/hmem-store.ts tests/o-entry-refactoring.test.ts
git commit -m "feat: add resolveProjectO, resolveSession, resolveBatch store methods

Core building blocks for project-bound O-entry hierarchy.
O-entries now derived from P-entry seq numbers (O0048 <-> P0048)."
```

---

## Task 2: appendExchangeV2 — 5-Level Exchange Storage

**Files:**
- Modify: `src/hmem-store.ts` (add new method near line ~2264)
- Modify: `tests/o-entry-refactoring.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/o-entry-refactoring.test.ts`:

```typescript
describe("appendExchangeV2", () => {
  it("creates L4 exchange with L5.1 user + L5.2 agent under a batch", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    const result = store.appendExchangeV2(batchId, oId, "What is hmem?", "hmem is a memory system.");
    expect(result.id).toBe("O0048.1.1.1"); // first exchange in first batch

    // Verify L4 exchange node
    const l4 = store.readNode(result.id);
    expect(l4).toBeTruthy();
    expect(l4!.depth).toBe(4);

    // Verify L5 children (user + agent)
    const children = store.getChildNodes(result.id);
    expect(children).toHaveLength(2);
    expect(children[0].content).toBe("What is hmem?");
    expect(children[0].depth).toBe(5);
    expect(children[0].seq).toBe(1);
    expect(children[1].content).toBe("hmem is a memory system.");
    expect(children[1].depth).toBe(5);
    expect(children[1].seq).toBe(2);
  });

  it("increments exchange seq within a batch", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    store.appendExchangeV2(batchId, oId, "msg1", "resp1");
    const r2 = store.appendExchangeV2(batchId, oId, "msg2", "resp2");
    expect(r2.id).toBe("O0048.1.1.2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: FAIL — `store.appendExchangeV2 is not a function`

- [ ] **Step 3: Implement appendExchangeV2**

Add to `src/hmem-store.ts` after current `appendExchange()`:

```typescript
/**
 * Append an exchange in the new 5-level format:
 *   L4 (exchange, title auto-extracted) under batchId (L3)
 *     L5 seq=1 (user message, raw)
 *     L5 seq=2 (agent response, raw)
 */
appendExchangeV2(batchId: string, oId: string, userText: string, agentText: string): { id: string } {
  this.guardCorrupted();
  const timestamp = new Date().toISOString();

  // Next seq under batch
  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(batchId + ".", batchId + ".%", batchId + ".%.%") as any;
  const seq = (maxSeqRow?.m ?? 0) + 1;

  const title = this.autoExtractTitle(userText.split("\n")[0].replace(/[<>\[\]]/g, ""));
  const l4Id = `${batchId}.${seq}`;
  const l5UserId = `${l4Id}.1`;
  const l5AgentId = `${l4Id}.2`;

  const insertNode = this.db.prepare(
    "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  this.db.transaction(() => {
    insertNode.run(l4Id, batchId, oId, 4, seq, title, title, timestamp, timestamp);
    insertNode.run(l5UserId, l4Id, oId, 5, 1, this.autoExtractTitle(userText), userText, timestamp, timestamp);
    insertNode.run(l5AgentId, l4Id, oId, 5, 2, this.autoExtractTitle(agentText), agentText, timestamp, timestamp);
    this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(timestamp, oId);
  })();

  return { id: l4Id };
}
```

- [ ] **Step 4: Add helper if missing — getChildNodes**

Check if `getChildNodes` exists. If not, add:

```typescript
getChildNodes(parentId: string): MemoryNode[] {
  return this.db.prepare(
    "SELECT * FROM memory_nodes WHERE parent_id = ? ORDER BY seq"
  ).all(parentId) as MemoryNode[];
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/hmem-store.ts tests/o-entry-refactoring.test.ts
git commit -m "feat: add appendExchangeV2 for 5-level exchange storage

L4 exchange node with L5.1 user + L5.2 agent under L3 batch."
```

---

## Task 3: getOEntryExchangesV2 — Read New Format

**Files:**
- Modify: `src/hmem-store.ts`
- Modify: `tests/o-entry-refactoring.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("getOEntryExchangesV2", () => {
  it("reads exchanges from new 5-level format", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    store.appendExchangeV2(batchId, oId, "question 1", "answer 1");
    store.appendExchangeV2(batchId, oId, "question 2", "answer 2");

    const exchanges = store.getOEntryExchangesV2(oId, 5);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].userText).toBe("question 1");
    expect(exchanges[0].agentText).toBe("answer 1");
    expect(exchanges[1].userText).toBe("question 2");
  });

  it("skips #irrelevant exchanges", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    const e1 = store.appendExchangeV2(batchId, oId, "important question", "important answer");
    const e2 = store.appendExchangeV2(batchId, oId, "ok", "ok");
    store.addTag(e2.id, "#irrelevant");

    const exchanges = store.getOEntryExchangesV2(oId, 5, { skipIrrelevant: true });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userText).toBe("important question");
  });

  it("returns only title for #skill-dialog exchanges when requested", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    const e1 = store.appendExchangeV2(batchId, oId, "normal q", "normal a");
    const e2 = store.appendExchangeV2(batchId, oId, "brainstorm session with long content", "skill output");
    store.addTag(e2.id, "#skill-dialog");

    const exchanges = store.getOEntryExchangesV2(oId, 5, { titleOnlyTags: ["#skill-dialog"] });
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].userText).toBe("normal q");
    expect(exchanges[1].userText).toBe(""); // title-only, raw text suppressed
    expect(exchanges[1].title).toBeTruthy();
  });

  it("reads across multiple batches and sessions", () => {
    store.writeLinear("P", { l1: "hmem-mcp" }, ["#project"]);
    const oId = store.resolveProjectO(48);

    // Session 1, batch 1
    const s1 = store.resolveSession(oId, "/tmp/t1.jsonl");
    const b1 = store.resolveBatch(s1, oId, 2);
    store.appendExchangeV2(b1, oId, "s1 q1", "s1 a1");
    store.appendExchangeV2(b1, oId, "s1 q2", "s1 a2");

    // Session 1, batch 2
    const b2 = store.resolveBatch(s1, oId, 2);
    store.appendExchangeV2(b2, oId, "s1 q3", "s1 a3");

    // Session 2
    const s2 = store.resolveSession(oId, "/tmp/t2.jsonl");
    const b3 = store.resolveBatch(s2, oId, 5);
    store.appendExchangeV2(b3, oId, "s2 q1", "s2 a1");

    const exchanges = store.getOEntryExchangesV2(oId, 10);
    expect(exchanges).toHaveLength(4);
    // Chronological order
    expect(exchanges[0].userText).toBe("s1 q1");
    expect(exchanges[3].userText).toBe("s2 q1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement getOEntryExchangesV2**

```typescript
/**
 * Get recent exchanges from a 5-level O-entry.
 * Reads L4 exchange nodes (with L5 user/agent children), newest first, then reverses.
 * Options:
 *   skipIrrelevant: exclude #irrelevant tagged L4 nodes
 *   titleOnlyTags: for these tags, return only the title (empty userText/agentText)
 */
getOEntryExchangesV2(
  oId: string,
  limit: number,
  opts?: { skipIrrelevant?: boolean; titleOnlyTags?: string[] }
): { nodeId: string; title: string; userText: string; agentText: string; created_at: string }[] {
  if (limit <= 0) return [];

  // Build exclusion list
  const excludeTags: string[] = [];
  if (opts?.skipIrrelevant) excludeTags.push("#irrelevant");

  const titleOnlyTags = opts?.titleOnlyTags ?? [];

  // Get L4 exchange nodes (depth=4) across all sessions/batches, newest first
  let query = `SELECT id, title, created_at FROM memory_nodes WHERE root_id = ? AND depth = 4`;
  if (excludeTags.length > 0) {
    const tagList = excludeTags.map(t => `'${t}'`).join(",");
    query += ` AND id NOT IN (SELECT entry_id FROM memory_tags WHERE tag IN (${tagList}))`;
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;

  const l4Nodes = this.db.prepare(query).all(oId, limit) as { id: string; title: string; created_at: string }[];

  const exchanges: { nodeId: string; title: string; userText: string; agentText: string; created_at: string }[] = [];

  for (const l4 of l4Nodes) {
    // Check if this is a title-only tag
    let isTitleOnly = false;
    if (titleOnlyTags.length > 0) {
      const tagList = titleOnlyTags.map(t => `'${t}'`).join(",");
      const hasTag = this.db.prepare(
        `SELECT 1 FROM memory_tags WHERE entry_id = ? AND tag IN (${tagList}) LIMIT 1`
      ).get(l4.id);
      if (hasTag) isTitleOnly = true;
    }

    if (isTitleOnly) {
      exchanges.push({ nodeId: l4.id, title: l4.title, userText: "", agentText: "", created_at: l4.created_at });
    } else {
      // Read L5 children: seq=1 is user, seq=2 is agent
      const l5User = this.db.prepare(
        "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 5 AND seq = 1 LIMIT 1"
      ).get(l4.id) as { content: string } | undefined;
      const l5Agent = this.db.prepare(
        "SELECT content FROM memory_nodes WHERE parent_id = ? AND depth = 5 AND seq = 2 LIMIT 1"
      ).get(l4.id) as { content: string } | undefined;

      exchanges.push({
        nodeId: l4.id,
        title: l4.title,
        userText: l5User?.content ?? "",
        agentText: l5Agent?.content ?? "",
        created_at: l4.created_at,
      });
    }
  }

  return exchanges.reverse(); // chronological order
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/hmem-store.ts tests/o-entry-refactoring.test.ts
git commit -m "feat: add getOEntryExchangesV2 with tag filtering

Reads 5-level format exchanges across sessions/batches.
Supports #irrelevant skip and title-only rendering for tagged exchanges."
```

---

## Task 4: listProjects + moveNodes Store Methods

**Files:**
- Modify: `src/hmem-store.ts`
- Modify: `tests/o-entry-refactoring.test.ts`

- [ ] **Step 1: Write failing tests for listProjects**

```typescript
describe("listProjects", () => {
  it("returns all active non-obsolete P-entries with id + title", () => {
    store.writeLinear("P", { l1: "Non-Project" }, ["#project"]);
    store.writeLinear("P", { l1: "hmem-mcp | Memory for AI" }, ["#project"]);

    const projects = store.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0]).toEqual({ id: "P0001", title: "Non-Project" });
    expect(projects[1]).toEqual({ id: "P0002", title: "hmem-mcp | Memory for AI" });
  });

  it("excludes obsolete entries", () => {
    store.writeLinear("P", { l1: "Active project" }, ["#project"]);
    store.writeLinear("P", { l1: "Old project" }, ["#project"]);
    store.markObsolete("P0002");

    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement listProjects**

```typescript
/**
 * List all active, non-obsolete P-entries (id + title only).
 * Designed for Haiku checkpoint: minimal token overhead.
 */
listProjects(): { id: string; title: string }[] {
  return this.db.prepare(
    "SELECT id, title FROM memories WHERE prefix = 'P' AND obsolete != 1 ORDER BY seq"
  ).all() as { id: string; title: string }[];
}
```

- [ ] **Step 3: Write failing tests for moveNodes**

```typescript
describe("moveNodes", () => {
  it("moves an L4 exchange to a different O-entry", () => {
    // Setup: two projects
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    // Create exchange in O0001
    const sA = store.resolveSession(oA, "/tmp/tA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    const ex = store.appendExchangeV2(bA, oA, "belongs to B", "response");

    // Move to O0002
    const result = store.moveNodes([ex.id], oB);
    expect(result.moved).toBe(1);

    // Verify exchange is now in O0002
    const exchangesA = store.getOEntryExchangesV2(oA, 10);
    const exchangesB = store.getOEntryExchangesV2(oB, 10);
    expect(exchangesA).toHaveLength(0);
    expect(exchangesB).toHaveLength(1);
    expect(exchangesB[0].userText).toBe("belongs to B");
  });

  it("moves an L2 session with all children", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    const sA = store.resolveSession(oA, "/tmp/tA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    store.appendExchangeV2(bA, oA, "q1", "a1");
    store.appendExchangeV2(bA, oA, "q2", "a2");

    const result = store.moveNodes([sA], oB);
    expect(result.moved).toBe(1);

    const exchangesB = store.getOEntryExchangesV2(oB, 10);
    expect(exchangesB).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Implement moveNodes**

```typescript
/**
 * Move nodes (L2 sessions, L3 batches, or L4 exchanges) to a different O-entry.
 * Handles ID rewriting for node + all children + tags + FTS.
 * Inserts chronologically into target O-entry (finds/creates appropriate session + batch).
 */
moveNodes(nodeIds: string[], targetOId: string): { moved: number; errors: string[] } {
  let moved = 0;
  const errors: string[] = [];

  // Ensure target O exists
  const targetExists = this.db.prepare("SELECT id FROM memories WHERE id = ?").get(targetOId);
  if (!targetExists) {
    return { moved: 0, errors: [`Target ${targetOId} does not exist`] };
  }

  for (const nodeId of nodeIds) {
    try {
      const node = this.db.prepare(
        "SELECT id, depth, root_id, created_at FROM memory_nodes WHERE id = ?"
      ).get(nodeId) as { id: string; depth: number; root_id: string; created_at: string } | undefined;

      if (!node) { errors.push(`Node ${nodeId} not found`); continue; }
      if (node.root_id === targetOId) { errors.push(`Node ${nodeId} already in ${targetOId}`); continue; }

      const sourceOId = node.root_id;

      this.db.transaction(() => {
        if (node.depth === 2) {
          // Moving entire session (L2): re-parent under target O
          this._moveSubtree(nodeId, sourceOId, targetOId, targetOId, 2);
        } else if (node.depth === 3) {
          // Moving batch (L3): find/create session in target, re-parent
          const targetSession = this._findOrCreateSessionForDate(targetOId, node.created_at);
          this._moveSubtree(nodeId, sourceOId, targetOId, targetSession, 3);
        } else if (node.depth === 4) {
          // Moving exchange (L4): find/create session + batch in target
          const targetSession = this._findOrCreateSessionForDate(targetOId, node.created_at);
          const targetBatch = this._findOrCreateBatchForDate(targetSession, targetOId, node.created_at);
          this._moveSubtree(nodeId, sourceOId, targetOId, targetBatch, 4);
        } else {
          errors.push(`Cannot move node at depth ${node.depth}`);
          return;
        }

        // Clean up empty parents in source
        this._cleanupEmptyParents(sourceOId);
      })();

      moved++;
    } catch (e: any) {
      errors.push(`Failed to move ${nodeId}: ${e.message}`);
    }
  }

  return { moved, errors };
}

/** Internal: find or create a session in target O matching a date. */
private _findOrCreateSessionForDate(oId: string, dateIso: string): string {
  const date = dateIso.substring(0, 10);
  // Look for existing session on this date
  const existing = this.db.prepare(
    "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 2 AND created_at LIKE ? LIMIT 1"
  ).get(oId, `${date}%`) as { id: string } | undefined;
  if (existing) return existing.id;

  // Create new session
  const timestamp = new Date().toISOString();
  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(oId + ".", oId + ".%", oId + ".%.%") as any;
  const seq = (maxSeqRow?.m ?? 0) + 1;
  const sessionId = `${oId}.${seq}`;

  this.db.prepare(
    "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(sessionId, oId, oId, 2, seq, `Session ${date}`, `Session ${date}`, dateIso, timestamp);

  return sessionId;
}

/** Internal: find or create a batch in target session. */
private _findOrCreateBatchForDate(sessionId: string, oId: string, dateIso: string): string {
  // Use the latest batch if it has room, otherwise create new
  const latestBatch = this.db.prepare(
    "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq DESC LIMIT 1"
  ).get(sessionId) as { id: string } | undefined;

  if (latestBatch) {
    const count = (this.db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
    ).get(latestBatch.id) as any)?.n ?? 0;
    if (count < (this.cfg.checkpointInterval || 5)) return latestBatch.id;
  }

  const timestamp = new Date().toISOString();
  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(sessionId + ".", sessionId + ".%", sessionId + ".%.%") as any;
  const seq = (maxSeqRow?.m ?? 0) + 1;
  const batchId = `${sessionId}.${seq}`;

  this.db.prepare(
    "INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(batchId, sessionId, oId, 3, seq, `Batch ${seq}`, `Batch ${seq}`, dateIso, timestamp);

  return batchId;
}

/** Internal: move a subtree (node + all descendants) to a new parent/root. */
private _moveSubtree(nodeId: string, sourceOId: string, targetOId: string, newParentId: string, depth: number): void {
  // Get all nodes in this subtree
  const subtreeNodes = this.db.prepare(
    "SELECT id, parent_id FROM memory_nodes WHERE id = ? OR id LIKE ?"
  ).all(nodeId, `${nodeId}.%`) as { id: string; parent_id: string }[];

  // Assign new seq under parent
  const maxSeqRow = this.db.prepare(
    `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as m
     FROM memory_nodes WHERE id LIKE ? AND id NOT LIKE ?`
  ).get(newParentId + ".", newParentId + ".%", newParentId + ".%.%") as any;
  const newSeq = (maxSeqRow?.m ?? 0) + 1;

  // Build old prefix -> new prefix mapping
  const oldPrefix = nodeId;
  const newNodeId = `${newParentId}.${newSeq}`;

  for (const n of subtreeNodes) {
    const updatedId = n.id === oldPrefix ? newNodeId : n.id.replace(oldPrefix, newNodeId);
    const updatedParent = n.parent_id === sourceOId ? targetOId
      : n.parent_id === oldPrefix ? newNodeId
      : n.parent_id.replace(oldPrefix, newNodeId);

    this.db.prepare(
      "UPDATE memory_nodes SET id = ?, parent_id = ?, root_id = ? WHERE id = ?"
    ).run(updatedId, updatedParent === oldPrefix ? newParentId : updatedParent, targetOId, n.id);

    // Update tags
    const tags = this.db.prepare(
      "SELECT tag FROM memory_tags WHERE entry_id = ?"
    ).all(n.id) as { tag: string }[];
    for (const t of tags) {
      this.db.prepare("DELETE FROM memory_tags WHERE entry_id = ? AND tag = ?").run(n.id, t.tag);
      this.db.prepare("INSERT OR IGNORE INTO memory_tags (entry_id, tag) VALUES (?, ?)").run(updatedId, t.tag);
    }

    // Update FTS
    this.db.prepare("UPDATE hmem_fts_rowid_map SET root_id = ?, node_id = ? WHERE node_id = ?")
      .run(targetOId, updatedId, n.id);
  }

  // Fix the root node's parent
  this.db.prepare("UPDATE memory_nodes SET parent_id = ?, seq = ? WHERE id = ?")
    .run(newParentId, newSeq, newNodeId);

  this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), targetOId);
  this.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), sourceOId);
}

/** Internal: remove empty session/batch nodes from an O-entry. */
private _cleanupEmptyParents(oId: string): void {
  // Remove empty L3 batches (no L4 children)
  const emptyBatches = this.db.prepare(
    `SELECT mn.id FROM memory_nodes mn
     WHERE mn.root_id = ? AND mn.depth = 3
     AND NOT EXISTS (SELECT 1 FROM memory_nodes c WHERE c.parent_id = mn.id)`
  ).all(oId) as { id: string }[];
  for (const b of emptyBatches) {
    this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(b.id);
  }

  // Remove empty L2 sessions (no L3 children)
  const emptySessions = this.db.prepare(
    `SELECT mn.id FROM memory_nodes mn
     WHERE mn.root_id = ? AND mn.depth = 2
     AND NOT EXISTS (SELECT 1 FROM memory_nodes c WHERE c.parent_id = mn.id)`
  ).all(oId) as { id: string }[];
  for (const s of emptySessions) {
    this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(s.id);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/bbbee/projects/hmem && npx vitest run tests/o-entry-refactoring.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/hmem-store.ts tests/o-entry-refactoring.test.ts
git commit -m "feat: add listProjects and moveNodes store methods

listProjects returns minimal P-entry list for Haiku.
moveNodes relocates L2/L3/L4 nodes between O-entries with full ID rewriting."
```

---

## Task 5: Rewrite cli-log-exchange.ts — 5-Step Pipeline

**Files:**
- Modify: `src/cli-log-exchange.ts`

- [ ] **Step 1: Rewrite logExchange() with new pipeline**

Replace the section in `logExchange()` from `const store = new HmemStore(...)` (line ~163) through the `finally` block with:

```typescript
const store = new HmemStore(hmemPath, hmemConfig);
try {
  // Auto-purge irrelevant entries older than 30 days (~1% chance)
  if (Math.random() < 0.01) {
    const purged = store.purgeIrrelevant(30);
    if (purged > 0) console.error(`[hmem] purged ${purged} irrelevant entries`);
  }

  // Step 1: Resolve project O-entry
  const activeProject = store.getActiveProject();
  const projectSeq = activeProject ? parseInt(activeProject.id.replace(/\D/g, ""), 10) : 0;
  const oId = store.resolveProjectO(projectSeq);

  // Step 2: Resolve session (transcript_path tracking)
  const sessionId = store.resolveSession(oId, input.transcript_path!);

  // Step 3: Resolve batch (create new if full)
  const batchSize = hmemConfig.checkpointInterval || 5;
  const batchId = store.resolveBatch(sessionId, oId, batchSize);

  // Step 4: Append exchange (L4 + L5.1 user + L5.2 agent)
  store.appendExchangeV2(batchId, oId, userMessage, input.last_assistant_message!);

  // Step 5: Trigger checkpoint if batch just became full
  const checkpointMode = hmemConfig.checkpointMode;
  if (batchSize > 0) {
    const exchangeCount = (store.db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
    ).get(batchId) as any)?.n ?? 0;

    if (exchangeCount >= batchSize) {
      if (checkpointMode === "auto") {
        const child = spawn(process.execPath, [HMEM_BIN, "checkpoint"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, HMEM_PROJECT_DIR: projectDir, HMEM_AGENT_ID: agentId },
        });
        child.unref();
      } else {
        const nudge = {
          decision: "block",
          reason: `Batch ${batchId} ist voll (${exchangeCount} exchanges). Schreibe wichtige Erkenntnisse in den Speicher (write_memory). Aktueller Batch: ${batchId}`,
        };
        process.stdout.write(JSON.stringify(nudge));
      }
    }
  }

} catch (e) {
  console.error(`[hmem log-exchange] ${e}`);
} finally {
  store.close();
}
```

- [ ] **Step 2: Expose db for direct query in logExchange**

The `store.db` property needs to be accessible. Check if it's public — if not, add a method:

```typescript
// In hmem-store.ts, add if db is private:
countBatchExchanges(batchId: string): number {
  return (this.db.prepare(
    "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
  ).get(batchId) as any)?.n ?? 0;
}
```

Then use `store.countBatchExchanges(batchId)` instead of direct db access.

- [ ] **Step 3: Build and verify no compile errors**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add src/cli-log-exchange.ts src/hmem-store.ts
git commit -m "feat: rewrite log-exchange with 5-step pipeline

resolveProjectO -> resolveSession -> resolveBatch -> appendExchangeV2 -> triggerCheckpoint"
```

---

## Task 6: Rewrite cli-checkpoint.ts — Batch-Based Checkpoint

**Files:**
- Modify: `src/cli-checkpoint.ts`

- [ ] **Step 1: Update checkpoint() to work with new structure**

Key changes to `checkpoint()`:

```typescript
export async function checkpoint(): Promise<void> {
  // ... (env setup stays the same, lines 66-76)

  let mcpConfigPath = "";

  try {
    // 1. Get active project and its O-entry
    const activeProject = store.getActiveProject();
    if (!activeProject) return;

    const projectSeq = parseInt(activeProject.id.replace(/\D/g, ""), 10);
    const oId = store.resolveProjectO(projectSeq);

    // 2. Find the latest full batch (L3 node with >= batchSize L4 children)
    const batchSize = config.checkpointInterval || 5;
    const latestFullBatch = store.db.prepare(
      `SELECT mn.id, mn.parent_id as sessionId FROM memory_nodes mn
       WHERE mn.root_id = ? AND mn.depth = 3
       AND (SELECT COUNT(*) FROM memory_nodes c WHERE c.parent_id = mn.id AND c.depth = 4) >= ?
       ORDER BY mn.created_at DESC LIMIT 1`
    ).get(oId, batchSize) as { id: string; sessionId: string } | undefined;

    if (!latestFullBatch) return;
    const batchId = latestFullBatch.id;
    const sessionId = latestFullBatch.sessionId;

    // 3. Get exchanges from this batch (L4 -> L5 children)
    const exchanges = store.getOEntryExchangesV2(oId, batchSize * 2);
    const batchExchanges = exchanges.filter(ex => ex.nodeId.startsWith(batchId + "."));
    if (batchExchanges.length < 2) return;

    // 4. Tag skill-dialog exchanges
    const skillMarker = "Base directory for this skill:";
    for (const ex of batchExchanges) {
      if (ex.userText.includes(skillMarker)) {
        store.addTag(ex.nodeId, "#skill-dialog");
      }
    }

    // 5. Get previous batch's rolling summary (L3 body)
    const prevBatch = store.db.prepare(
      `SELECT id, content FROM memory_nodes
       WHERE parent_id = ? AND depth = 3 AND id != ? ORDER BY seq DESC LIMIT 1`
    ).get(sessionId, batchId) as { id: string; content: string } | undefined;

    // 6. Get all P-entry titles for project classification
    const allProjects = store.listProjects();

    const projectName = activeProject.title.split("|")[0].trim();
    const projectId = activeProject.id;

    // Close store before spawning subagent
    store.close();

    // 7. Build prompt
    mcpConfigPath = buildMcpConfig(projectDir, agentId);

    const formattedExchanges = batchExchanges.map((ex, i) => {
      const user = ex.userText.length > 800 ? ex.userText.substring(0, 800) + "..." : ex.userText;
      const agent = ex.agentText.length > 1200 ? ex.agentText.substring(0, 1200) + "..." : ex.agentText;
      return `--- Exchange ${i + 1} (${ex.nodeId}) ---\nUSER: ${user}\nAGENT: ${agent}`;
    }).join("\n\n");

    const projectList = allProjects.map(p => `  ${p.id} ${p.title}`).join("\n");

    const prevSummaryText = prevBatch && prevBatch.content !== prevBatch.id
      ? `\n## Previous batch rolling summary:\n${prevBatch.content}\n`
      : "";

    const exchangeListing = batchExchanges.map(ex =>
      `  ${ex.nodeId}: "${ex.title}"`
    ).join("\n");

    const prompt = `You are a checkpoint agent for "${projectName}" (${projectId}).
Process batch ${batchId} with ${batchExchanges.length} exchanges.

== All Projects ==
${projectList}

== Active Project ==
${projectId} ${projectName}
${prevSummaryText}
== Batch Exchanges ==
${formattedExchanges}

## Tasks (execute ALL in order):

### 1. Title each exchange (REQUIRED)
Current titles (auto-extracted):
${exchangeListing}

For each: update_memory(id="<nodeId>", content="Descriptive title, max 50 chars, match conversation language")

### 2. Write rolling summary for this batch
update_memory(id="${batchId}", content="Rolling summary: 3-8 sentences covering this batch${prevBatch ? " + previous summary" : ""}. Match conversation language.")
${prevBatch ? "IMPORTANT: Incorporate the previous batch summary — your new summary is cumulative." : "This is the first batch."}

### 3. Extract knowledge (non-obvious only, max 2-3)
write_memory(prefix="<any prefix>", content="...", tags=[3-5 tags], links=["${projectId}", "${batchId}"])
Valid prefixes: L (lesson), E (error), D (decision), R (rule), C (convention), or any other.
Skip if nothing non-obvious happened.

### 4. Update project P-entry
read_memory(id="${projectId}") first, then update relevant sections:
- Protocol (.7): append session summary
- Bugs (.6), Open Tasks (.8): update as needed
- Overview (.1): if architecture changed significantly

### 5. Tag exchanges
For each exchange, add ONE tag if applicable:
- #skill-dialog: Skill output (brainstorming, TDD, etc.) — check for "Base directory for this skill:"
- #irrelevant: No value (greetings, "ok", typo corrections, short confirmations)
- #planning: Design/architecture discussion
- #debugging: Bug hunting/fixing
- #admin: Setup, config, infra work
Use: No direct tagging tool — note tags in the summary. (Tags will be applied by the checkpoint runner.)

### 6. Title session ${sessionId} (if generic)
update_memory(id="${sessionId}", content="Session title summarizing key topics, max 60 chars")

### 7. Project relevance check
Do ALL exchanges belong to ${projectName}?
Check against the project list above. If an exchange belongs elsewhere, call:
move_nodes(node_ids=["<exchange_id>"], target_o_id="O00XX")

## Rules:
- read_memory() FIRST to see current state
- Match language of existing entries
- Tags: 3-5 per entry, lowercase with #
- Only save what's valuable in 6 months`;

    // 8. Spawn Haiku
    const allowedTools = [
      "mcp__hmem__read_memory",
      "mcp__hmem__write_memory",
      "mcp__hmem__append_memory",
      "mcp__hmem__update_memory",
      "mcp__hmem__list_projects",
      "mcp__hmem__move_nodes",
    ].join(" ");
    const disallowedTools = "mcp__hmem__flush_context";

    try {
      const output = execSync(
        `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --disallowedTools "${disallowedTools}" --dangerously-skip-permissions 2>/dev/null`,
        { input: prompt, encoding: "utf8", timeout: 120_000 }
      ).trim();
      console.log(`[hmem checkpoint] Haiku: ${output.substring(0, 300)}`);
    } catch (e: any) {
      console.error(`[hmem checkpoint] Failed (exit ${e.status}): ${e.stdout?.toString()?.substring(0, 200) || ""}`);
    }

  } catch (e) {
    console.error(`[hmem checkpoint] ${e}`);
  } finally {
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch {}
    }
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/cli-checkpoint.ts
git commit -m "feat: rewrite checkpoint for batch-based 5-level structure

Haiku now gets: batch exchanges, previous rolling summary, all P-titles.
New tasks: rolling summary, project classification, exchange tagging."
```

---

## Task 7: New MCP Tools — list_projects + move_nodes

**Files:**
- Modify: `src/mcp-server.ts`

- [ ] **Step 1: Add list_projects tool**

Find the tool registration section in `mcp-server.ts` (after other `server.tool()` calls) and add:

```typescript
server.tool(
  "list_projects",
  "List all projects (P-entries) with their IDs and titles. Minimal output for checkpoint agents.",
  { store: storeParam },
  async ({ store: storeName }) => {
    const hmemStore = getStore(storeName);
    const projects = hmemStore.listProjects();
    const text = projects.map(p => `${p.id} ${p.title}`).join("\n");
    return { content: [{ type: "text", text: text || "No projects found." }] };
  }
);
```

- [ ] **Step 2: Add move_nodes tool**

```typescript
server.tool(
  "move_nodes",
  "Move session (L2), batch (L3), or exchange (L4) nodes between O-entries. Handles ID rewriting, tag migration, and cleanup of empty parents.",
  {
    node_ids: z.array(z.string()).describe("IDs of nodes to move (L2, L3, or L4)"),
    target_o_id: z.string().describe("Target O-entry ID (e.g. O0048)"),
    store: storeParam,
  },
  async ({ node_ids, target_o_id, store: storeName }) => {
    const hmemStore = getStore(storeName);
    const result = hmemStore.moveNodes(node_ids, target_o_id);
    let text = `Moved ${result.moved} node(s) to ${target_o_id}.`;
    if (result.errors.length > 0) {
      text += `\nErrors:\n${result.errors.join("\n")}`;
    }
    return { content: [{ type: "text", text }] };
  }
);
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat: add list_projects and move_nodes MCP tools

list_projects: minimal P-entry list for Haiku checkpoint.
move_nodes: relocate L2/L3/L4 nodes between O-entries."
```

---

## Task 8: Enhanced load_project + read_memory Rendering

**Files:**
- Modify: `src/mcp-server.ts` (load_project ~line 1769, renderEntryFormatted ~line 2599, formatRecentOEntries ~line 364)

- [ ] **Step 1: Rewrite formatRecentOEntries for 5-level format**

Replace `formatRecentOEntries()` (lines ~364-408):

```typescript
function formatRecentOEntries(
  store: HmemStore,
  limit: number,
  exchangeCount: number,
  linkedTo?: string,
  expandAll?: boolean,
): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];

  // Find O-entries linked to the project
  const oEntries = linkedTo
    ? store.db.prepare(
        "SELECT id, title, created_at, links FROM memories WHERE prefix = 'O' AND obsolete != 1 AND links LIKE ? ORDER BY updated_at DESC LIMIT ?"
      ).all(`%${linkedTo}%`, limit) as any[]
    : store.db.prepare(
        "SELECT id, title, created_at FROM memories WHERE prefix = 'O' AND obsolete != 1 AND irrelevant != 1 ORDER BY updated_at DESC LIMIT ?"
      ).all(limit) as any[];

  for (let i = 0; i < oEntries.length; i++) {
    const o = oEntries[i];
    ids.push(o.id);

    // Get sessions (L2 nodes)
    const sessions = store.db.prepare(
      "SELECT id, title, content, created_at FROM memory_nodes WHERE root_id = ? AND depth = 2 ORDER BY seq DESC LIMIT 3"
    ).all(o.id) as any[];

    lines.push(`  ${o.id}  ${o.created_at.substring(0, 10)}  ${o.title}`);

    if (expandAll || i === 0) {
      for (const session of sessions) {
        lines.push(`    ${session.id} ${session.title}`);

        // Show session summary if it exists (body != title)
        if (session.content && session.content !== session.title && session.content.length > session.title.length + 10) {
          const summary = session.content.length > 500 ? session.content.substring(0, 500) + "..." : session.content;
          lines.push(`    [Summary] ${summary}`);
        }

        // Show last batch's rolling summary
        const lastBatch = store.db.prepare(
          "SELECT id, content, title FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq DESC LIMIT 1"
        ).get(session.id) as any;
        if (lastBatch && lastBatch.content !== lastBatch.title) {
          const batchSummary = lastBatch.content.length > 300 ? lastBatch.content.substring(0, 300) + "..." : lastBatch.content;
          lines.push(`    [Batch] ${batchSummary}`);
        }
      }

      // Show last N exchanges (from newest, across all sessions/batches)
      const VERBATIM_WINDOW = Math.min(exchangeCount, 5);
      const exchanges = store.getOEntryExchangesV2(o.id, VERBATIM_WINDOW, {
        skipIrrelevant: true,
        titleOnlyTags: ["#skill-dialog", "#admin"],
      });

      for (const ex of exchanges) {
        if (!ex.userText && !ex.agentText) {
          // Title-only (skill-dialog etc.)
          lines.push(`    [${ex.nodeId}] ${ex.title}`);
        } else {
          const userShort = ex.userText.length > 300 ? ex.userText.substring(0, 300) + "..." : ex.userText;
          const agentShort = ex.agentText.length > 500 ? ex.agentText.substring(0, 500) + "..." : ex.agentText;
          lines.push(`    USER: ${userShort}`);
          if (agentShort) lines.push(`    AGENT: ${agentShort}`);
        }
      }
    }
    lines.push("");
  }

  return { text: lines.join("\n"), ids };
}
```

- [ ] **Step 2: Update load_project O-entry injection**

In `load_project` tool (around line 1769), update the O-entry injection to use project-linked O:

```typescript
// Inject recent O-entries linked to THIS project
const projectSeq = parseInt(id.replace(/\D/g, ""), 10);
const oId = `O${String(projectSeq).padStart(4, "0")}`;
const oExists = hmemStore.db.prepare("SELECT id FROM memories WHERE id = ?").get(oId);
if (oExists) {
  const { text: oText } = formatRecentOEntries(hmemStore, 1, 5, id);
  if (oText.trim()) {
    lines.push("--- Recent Session Context ---");
    lines.push(oText);
  }
}
```

- [ ] **Step 3: Update renderEntryFormatted for 5-level O-entries**

Update the O-entry special case (line ~2600) to show session hierarchy:

```typescript
if (e.prefix === "O" && !expand) {
  const mmdd = e.created_at.substring(5, 10);
  // Count sessions (L2) instead of flat exchanges
  const sessionCount = e.children?.length ?? 0;
  lines.push(`${e.id} ${mmdd}  ${e.title}${sessionCount > 0 ? ` (${sessionCount} sessions)` : ""}`);
  lines.push("");
  return;
}
```

- [ ] **Step 4: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat: update load_project and read_memory for 5-level O-entries

load_project now shows session summary + batch summary + recent exchanges.
read_memory shows session count and hierarchical drill-down."
```

---

## Task 9: Update cli-statusline.ts

**Files:**
- Modify: `src/cli-statusline.ts` (lines ~140-154)

- [ ] **Step 1: Update exchange counting for batch structure**

Replace the exchange counting section (around line 140):

```typescript
if (oRow) {
  // Count exchanges in current batch (L4 nodes under latest L3)
  // First find the latest L3 batch
  const latestBatch = db.prepare(
    `SELECT id FROM memory_nodes WHERE root_id = ? AND depth = 3 ORDER BY created_at DESC LIMIT 1`
  ).get(oRow.id) as { id: string } | undefined;

  if (latestBatch) {
    const batchExchanges = (db.prepare(
      "SELECT COUNT(*) as n FROM memory_nodes WHERE parent_id = ? AND depth = 4"
    ).get(latestBatch.id) as any)?.n ?? 0;

    const interval = hmemConfig.checkpointInterval;
    exchanges = batchExchanges;
    status = { project, exchanges, interval };
  } else {
    status = { project, exchanges: 0, interval: hmemConfig.checkpointInterval };
  }
}
```

- [ ] **Step 2: Update O-entry lookup to use project-based O**

Replace the O-entry query (around line 140):

```typescript
// Find O-entry matching active project
let oRow: { id: string } | undefined;
if (projRow) {
  const projSeq = parseInt(projRow.id.replace(/\D/g, ""), 10);
  const oId = `O${String(projSeq).padStart(4, "0")}`;
  oRow = db.prepare("SELECT id FROM memories WHERE id = ?").get(oId) as { id: string } | undefined;
}
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add src/cli-statusline.ts
git commit -m "feat: update statusline for batch-based exchange counting

Counts L4 exchanges in latest L3 batch instead of flat L2 children."
```

---

## Task 10: SessionStart Hook — Async Session Summary

**Files:**
- Create: `src/cli-session-summary.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli-init.ts` (context-inject section)

- [ ] **Step 1: Create cli-session-summary.ts**

```typescript
/**
 * cli-session-summary.ts
 *
 * Spawns Haiku to write a session summary (L2 body) for a completed session.
 * Called async from SessionStart hook when previous session lacks a summary.
 *
 * Usage: hmem summarize-session O0048.3
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

function buildMcpConfig(projectDir: string, agentId: string): string {
  let hmemServerPath: string;
  try {
    hmemServerPath = execSync("which hmem", { encoding: "utf8" }).trim();
    const realPath = fs.realpathSync(hmemServerPath);
    hmemServerPath = path.join(path.dirname(realPath), "mcp-server.js");
    if (!fs.existsSync(hmemServerPath)) {
      hmemServerPath = path.join(path.dirname(path.dirname(realPath)), "dist", "mcp-server.js");
    }
  } catch {
    hmemServerPath = path.join(
      process.env.HOME || "/home",
      ".nvm/versions/node", process.version,
      "lib/node_modules/hmem-mcp/dist/mcp-server.js"
    );
  }

  const config = {
    mcpServers: {
      hmem: {
        command: process.execPath,
        args: [hmemServerPath],
        env: { HMEM_PROJECT_DIR: projectDir, HMEM_AGENT_ID: agentId, HMEM_NO_SESSION: "1" },
      },
    },
  };

  const tmpPath = path.join("/tmp", `hmem-session-summary-${process.pid}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf8");
  return tmpPath;
}

export async function summarizeSession(sessionId: string): Promise<void> {
  resolveEnvDefaults();
  const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const hmemPath = resolveHmemPath(projectDir, templateName);
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  let mcpConfigPath = "";

  try {
    const oId = sessionId.split(".")[0]; // O0048.3 -> O0048

    // Get all L3 batch summaries for this session
    const batches = store.db.prepare(
      "SELECT id, title, content FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq"
    ).get(sessionId) ? store.db.prepare(
      "SELECT id, title, content FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq"
    ).all(sessionId) as { id: string; title: string; content: string }[] : [];

    if (batches.length === 0) return;

    const batchSummaries = batches
      .filter(b => b.content !== b.title) // only batches with actual summaries
      .map(b => `${b.id}: ${b.content}`)
      .join("\n\n");

    if (!batchSummaries) return; // no summaries to work with

    store.close();

    mcpConfigPath = buildMcpConfig(projectDir, agentId);

    const prompt = `Summarize session ${sessionId}.

== Batch Summaries ==
${batchSummaries}

## Task
Write a compact session summary (max 200 words) as the body of ${sessionId}.
What was achieved? What's still open?
Match the language of the batch summaries.

update_memory(id="${sessionId}", content="Session summary text here")`;

    const allowedTools = "mcp__hmem__update_memory mcp__hmem__read_memory";

    execSync(
      `claude -p --model haiku --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --dangerously-skip-permissions 2>/dev/null`,
      { input: prompt, encoding: "utf8", timeout: 60_000 }
    );

    console.log(`[hmem] Session summary written for ${sessionId}`);

  } catch (e) {
    console.error(`[hmem summarize-session] ${e}`);
  } finally {
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch {}
  }
}
```

- [ ] **Step 2: Add CLI commands to cli.ts**

Add to the switch statement in `src/cli.ts`:

```typescript
case "summarize-session": {
  const { summarizeSession } = await import("./cli-session-summary.js");
  await summarizeSession(process.argv[3] || "");
  break;
}
case "migrate-o-entries": {
  const { migrateOEntries } = await import("./cli-migrate-o.js");
  await migrateOEntries();
  break;
}
```

- [ ] **Step 3: Add session summary check to context-inject**

In the context-inject/hook-startup flow (cli-init.ts or wherever the SessionStart hook logic lives), add after the existing O-entry display:

```typescript
// Check if last session needs a summary (async, non-blocking)
const activeProject = store.getActiveProject();
if (activeProject) {
  const projSeq = parseInt(activeProject.id.replace(/\D/g, ""), 10);
  const oId = `O${String(projSeq).padStart(4, "0")}`;
  const lastSession = store.db.prepare(
    "SELECT id, title, content FROM memory_nodes WHERE root_id = ? AND depth = 2 ORDER BY seq DESC LIMIT 1 OFFSET 1"
  ).get(oId) as any; // OFFSET 1 = previous session, not current

  if (lastSession && lastSession.content === lastSession.title) {
    // No summary yet — spawn async
    const { spawn } = require("node:child_process");
    const HMEM_BIN = path.resolve(__dirname, "../dist/cli.js");
    const child = spawn(process.execPath, [HMEM_BIN, "summarize-session", lastSession.id], {
      detached: true, stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
  }
}
```

- [ ] **Step 4: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add src/cli-session-summary.ts src/cli.ts src/cli-init.ts
git commit -m "feat: add async session summary on SessionStart

Spawns Haiku to summarize previous session if no summary exists.
New CLI: hmem summarize-session <session_id>"
```

---

## Task 11: Migration Script — cli-migrate-o.ts

**Files:**
- Create: `src/cli-migrate-o.ts`

- [ ] **Step 1: Create migration script**

```typescript
/**
 * cli-migrate-o.ts
 *
 * One-time migration: reassign O-entry IDs to match their linked P-entry IDs.
 * O0042 linked to P0048 becomes O0048. Unlinked O-entries go to O0000.
 *
 * Usage: hmem migrate-o-entries
 */

import fs from "node:fs";
import path from "node:path";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

export async function migrateOEntries(): Promise<void> {
  resolveEnvDefaults();
  const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
  if (!projectDir) {
    console.error("HMEM_PROJECT_DIR not set");
    process.exit(1);
  }

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const hmemPath = resolveHmemPath(projectDir, templateName);
  if (!fs.existsSync(hmemPath)) {
    console.error(`hmem file not found: ${hmemPath}`);
    process.exit(1);
  }

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  try {
    console.log("=== hmem O-Entry Migration ===\n");

    // Step 1: Ensure P0000 exists
    const p0000 = store.db.prepare("SELECT id FROM memories WHERE id = 'P0000'").get();
    if (!p0000) {
      console.log("Creating P0000 (Non-Project)...");
      store.db.prepare(`
        INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, min_role)
        VALUES ('P0000', 'P', 0, ?, ?, 'Non-Project', 'Non-Project | Catch-all for unassigned exchanges', 'worker')
      `).run(new Date().toISOString(), new Date().toISOString());
      // Add required tag
      store.addTag("P0000", "#project");
    }

    // Step 2: Ensure O0000 exists
    const o0000 = store.db.prepare("SELECT id FROM memories WHERE id = 'O0000'").get();
    if (!o0000) {
      console.log("Creating O0000 (Non-Project catch-all)...");
      store.db.prepare(`
        INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, min_role)
        VALUES ('O0000', 'O', 0, ?, ?, 'Non-Project', 'Non-Project', 'worker')
      `).run(new Date().toISOString(), new Date().toISOString());
    }

    // Step 3: Get all O-entries
    const oEntries = store.db.prepare(
      "SELECT id, title, links, seq FROM memories WHERE prefix = 'O' ORDER BY seq"
    ).all() as { id: string; title: string; links: string | null; seq: number }[];

    console.log(`Found ${oEntries.length} O-entries to process.\n`);

    // Step 4: Build migration plan
    const plan: { oldId: string; newId: string; reason: string }[] = [];
    const targetIds = new Set<string>();

    for (const o of oEntries) {
      // Parse links to find P-entry
      let linkedP: string | null = null;
      if (o.links) {
        try {
          const links = JSON.parse(o.links) as string[];
          linkedP = links.find(l => l.startsWith("P")) || null;
        } catch {}
      }

      if (linkedP) {
        const pSeq = parseInt(linkedP.replace(/\D/g, ""), 10);
        const targetId = `O${String(pSeq).padStart(4, "0")}`;

        if (o.id === targetId) {
          console.log(`  ${o.id} -> OK (already matches ${linkedP})`);
        } else if (targetIds.has(targetId)) {
          // Conflict — another O already wants this target
          console.log(`  ${o.id} -> CONFLICT (${targetId} already claimed, will tag #legacy)`);
          plan.push({ oldId: o.id, newId: "", reason: `conflict for ${targetId}` });
        } else {
          plan.push({ oldId: o.id, newId: targetId, reason: `linked to ${linkedP}` });
          targetIds.add(targetId);
          console.log(`  ${o.id} -> ${targetId} (${linkedP} ${o.title})`);
        }
      } else {
        if (o.id === "O0000") {
          console.log(`  ${o.id} -> OK (catch-all)`);
        } else {
          console.log(`  ${o.id} -> #legacy (no P-link)`);
          plan.push({ oldId: o.id, newId: "", reason: "no P-link" });
        }
      }
    }

    if (plan.length === 0) {
      console.log("\nNothing to migrate.");
      return;
    }

    console.log(`\nMigration plan: ${plan.filter(p => p.newId).length} renames, ${plan.filter(p => !p.newId).length} legacy tags.\n`);

    // Step 5: Execute — first clear the `active` flag from all O-entries
    store.db.prepare("UPDATE memories SET active = 0 WHERE prefix = 'O' AND active = 1").run();

    // Renames first (may need temp IDs to avoid conflicts)
    const renames = plan.filter(p => p.newId);
    for (const r of renames) {
      // Check if target ID is currently occupied by another entry
      const blocker = store.db.prepare("SELECT id FROM memories WHERE id = ?").get(r.newId);
      if (blocker) {
        // Move blocker to a temp ID first
        const tempId = `O9${r.newId.substring(1)}`; // O0048 -> O9048
        console.log(`  Moving blocker ${r.newId} -> ${tempId}`);
        const tempResult = store.renameId(r.newId, tempId);
        if (!tempResult.ok) {
          console.error(`  FAILED to move blocker: ${tempResult.error}`);
          continue;
        }
      }

      const result = store.renameId(r.oldId, r.newId);
      if (result.ok) {
        console.log(`  Renamed ${r.oldId} -> ${r.newId} (${result.affected} records)`);
        store.addTag(r.newId, "#legacy");
      } else {
        console.error(`  FAILED ${r.oldId} -> ${r.newId}: ${result.error}`);
      }
    }

    // Tag remaining as #legacy
    const legacyOnly = plan.filter(p => !p.newId);
    for (const l of legacyOnly) {
      store.addTag(l.oldId, "#legacy");
      console.log(`  Tagged ${l.oldId} as #legacy (${l.reason})`);
    }

    console.log("\nMigration complete. Run 'hmem self-curate' to review #legacy entries.");

  } catch (e) {
    console.error(`Migration failed: ${e}`);
    process.exit(1);
  } finally {
    store.close();
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: Clean compile

- [ ] **Step 3: Commit**

```bash
git add src/cli-migrate-o.ts
git commit -m "feat: add hmem migrate-o-entries CLI command

Reassigns O-entry IDs to match P-entry seq numbers.
Tags unlinked entries as #legacy. Creates P0000/O0000 if missing."
```

---

## Task 12: Remove Old O-Entry Methods + Dual-Format Support

**Files:**
- Modify: `src/hmem-store.ts`

- [ ] **Step 1: Deprecate getActiveO and getActiveOId**

Mark the old methods as deprecated (do not delete yet — other code may still reference them during transition):

```typescript
/** @deprecated Use resolveProjectO() instead. */
getActiveO(): string {
  // Fallback: use old logic for backward compatibility during migration
  // ...existing code...
}

/** @deprecated Use resolveProjectO() instead. */
getActiveOId(): string | null {
  // ...existing code...
}
```

- [ ] **Step 2: Update getOEntryExchanges to handle both formats**

The existing `getOEntryExchanges()` reads L2->L4->L5 (old format). Add detection for new format:

```typescript
getOEntryExchanges(oEntryId: string, limit: number, skipSkillDialogs = false): { nodeId: string; seq: number; userText: string; agentText: string }[] {
  // Check if this O-entry uses the new 5-level format (has L3 nodes)
  const hasL3 = this.db.prepare(
    "SELECT 1 FROM memory_nodes WHERE root_id = ? AND depth = 3 LIMIT 1"
  ).get(oEntryId);

  if (hasL3) {
    // New format: delegate to V2
    const opts = skipSkillDialogs ? { titleOnlyTags: ["#skill-dialog"] } : {};
    const v2 = this.getOEntryExchangesV2(oEntryId, limit, opts);
    return v2.map(ex => ({
      nodeId: ex.nodeId,
      seq: 0, // seq is per-batch in new format, not globally meaningful
      userText: ex.userText,
      agentText: ex.agentText,
    }));
  }

  // Legacy format: original logic
  // ...existing code...
}
```

- [ ] **Step 3: Build and run all tests**

Run: `cd /home/bbbee/projects/hmem && npm run build && npx vitest run`
Expected: Clean compile, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/hmem-store.ts
git commit -m "feat: dual-format support for O-entry reads

getOEntryExchanges auto-detects new 5-level format via L3 presence.
Old methods deprecated but preserved for migration period."
```

---

## Task 13: Integration Test — Full Pipeline

**Files:**
- Modify: `tests/o-entry-refactoring.test.ts`

- [ ] **Step 1: Write end-to-end integration test**

```typescript
describe("Full pipeline integration", () => {
  it("simulates 7 exchanges across 2 sessions with batch rotation", () => {
    // Setup project
    store.writeLinear("P", { l1: "Test Project | Integration test" }, ["#project"]);
    const oId = store.resolveProjectO(1);

    // Session 1: 5 exchanges (fills 1 batch of size 3 + starts second)
    const s1 = store.resolveSession(oId, "/tmp/session1.jsonl");

    for (let i = 1; i <= 5; i++) {
      const batchId = store.resolveBatch(s1, oId, 3);
      store.appendExchangeV2(batchId, oId, `question ${i}`, `answer ${i}`);
    }

    // Verify: 2 batches (3 + 2)
    const batches1 = store.db.prepare(
      "SELECT id FROM memory_nodes WHERE parent_id = ? AND depth = 3 ORDER BY seq"
    ).all(s1) as { id: string }[];
    expect(batches1).toHaveLength(2);

    // Session 2: 2 more exchanges
    const s2 = store.resolveSession(oId, "/tmp/session2.jsonl");
    const b3 = store.resolveBatch(s2, oId, 3);
    store.appendExchangeV2(b3, oId, "question 6", "answer 6");
    store.appendExchangeV2(b3, oId, "question 7", "answer 7");

    // Read all exchanges
    const all = store.getOEntryExchangesV2(oId, 20);
    expect(all).toHaveLength(7);
    expect(all[0].userText).toBe("question 1");
    expect(all[6].userText).toBe("question 7");

    // Verify dual-format compatibility
    const legacy = store.getOEntryExchanges(oId, 20);
    expect(legacy).toHaveLength(7);

    // Verify listProjects
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("P0001");
  });

  it("moves exchanges between projects", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    const sA = store.resolveSession(oA, "/tmp/sA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    const e1 = store.appendExchangeV2(bA, oA, "for project B", "moved");
    const e2 = store.appendExchangeV2(bA, oA, "for project A", "stays");

    // Move first exchange to project B
    const result = store.moveNodes([e1.id], oB);
    expect(result.moved).toBe(1);
    expect(result.errors).toHaveLength(0);

    const exA = store.getOEntryExchangesV2(oA, 10);
    const exB = store.getOEntryExchangesV2(oB, 10);
    expect(exA).toHaveLength(1);
    expect(exA[0].userText).toBe("for project A");
    expect(exB).toHaveLength(1);
    expect(exB[0].userText).toBe("for project B");
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/o-entry-refactoring.test.ts
git commit -m "test: add integration tests for full O-entry pipeline

Covers batch rotation, session switching, dual-format reads, and cross-project moves."
```

---

## Task 14: Run Migration + Smoke Test

- [ ] **Step 1: Build the project**

Run: `cd /home/bbbee/projects/hmem && npm run build`

- [ ] **Step 2: Run migration on the live database**

Run: `cd /home/bbbee/projects/hmem && HMEM_PROJECT_DIR=/home/bbbee/projects/hmem node dist/cli.js migrate-o-entries`

Review the output carefully. Note which O-entries were renamed and which were tagged #legacy.

- [ ] **Step 3: Verify statusline still works**

Run: `echo '{}' | hmem statusline`
Expected: Should show project + exchange counter

- [ ] **Step 4: Verify load_project still works**

Use the MCP server to call `load_project(id="P0048")` and check that O-context is displayed.

- [ ] **Step 5: Test a real exchange cycle**

In a new Claude Code session with hmem enabled:
1. Send a test message
2. Check that the exchange landed in the correct O-entry (O0048 for P0048)
3. Verify the 5-level structure: O0048 -> L2 session -> L3 batch -> L4 exchange -> L5 user + L5 agent

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: post-migration adjustments"
```
