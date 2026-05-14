import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { HmemStore } from "../src/hmem-store.js";
import { countLocalEntries, clearLocalTables } from "../src/cli-sync-setup.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-onboarding");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function seedDb(hmemPath: string, count: number): void {
  const store = new HmemStore(hmemPath);
  store.close();
  const db = new Database(hmemPath);
  const stmt = db.prepare(
    `INSERT INTO memories (id, prefix, seq, created_at, level_1) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    stmt.run(`P${String(i).padStart(4, "0")}`, "P", i, "2026-05-01T00:00:00Z", `Entry ${i}`);
  }
  const nodeStmt = db.prepare(
    `INSERT INTO memory_nodes (id, parent_id, root_id, depth, seq, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  nodeStmt.run("P0001.1", "P0001", "P0001", 2, 1, "sub-node content", "2026-05-01T00:00:00Z");
  db.close();
}

describe("countLocalEntries", () => {
  it("returns 0 for non-existent file", () => {
    expect(countLocalEntries(join(TMP, "missing.hmem"))).toBe(0);
  });

  it("returns 0 for empty database", () => {
    const path = join(TMP, "empty.hmem");
    const store = new HmemStore(path);
    store.close();
    expect(countLocalEntries(path)).toBe(0);
  });

  it("returns count of seeded entries", () => {
    const path = join(TMP, "seeded.hmem");
    seedDb(path, 5);
    expect(countLocalEntries(path)).toBe(5);
  });

  it("ignores seq=0 placeholder rows", () => {
    const path = join(TMP, "with-placeholder.hmem");
    const store = new HmemStore(path);
    store.close();
    const db = new Database(path);
    db.prepare(
      `INSERT INTO memories (id, prefix, seq, created_at, level_1) VALUES (?, ?, ?, ?, ?)`,
    ).run("PLACEHOLDER", "P", 0, "2026-05-01T00:00:00Z", "placeholder");
    db.close();
    expect(countLocalEntries(path)).toBe(0);
  });
});

describe("clearLocalTables", () => {
  it("removes all memories and memory_nodes", () => {
    const path = join(TMP, "to-clear.hmem");
    seedDb(path, 3);
    expect(countLocalEntries(path)).toBe(3);

    clearLocalTables(path);

    expect(countLocalEntries(path)).toBe(0);
    const db = new Database(path, { readonly: true });
    const nodes = db.prepare("SELECT COUNT(*) as c FROM memory_nodes").get() as { c: number };
    db.close();
    expect(nodes.c).toBe(0);
  });

  it("backup + clear preserves original file for recovery", () => {
    const path = join(TMP, "to-backup.hmem");
    const backupPath = `${path}.before-sync.test.hmem`;
    seedDb(path, 4);

    copyFileSync(path, backupPath);
    clearLocalTables(path);

    expect(existsSync(backupPath)).toBe(true);
    expect(countLocalEntries(path)).toBe(0);
    expect(countLocalEntries(backupPath)).toBe(4);
  });
});
