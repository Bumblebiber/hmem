import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { HmemStore } from "../src/hmem-store.js";
import { importFromStaging } from "../src/sync-bridge.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-sync-bridge-ts");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function seedDb(hmemPath: string, level1: string, updatedAt: string): void {
  const store = new HmemStore(hmemPath);
  store.close();
  const db = new Database(hmemPath);
  db.prepare(
    `INSERT INTO memories (id, prefix, seq, created_at, level_1, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("P0001", "P", 1, "2026-05-01T00:00:00Z", level1, updatedAt);
  db.close();
}

function readLocal(hmemPath: string): { level_1: string; updated_at: string } {
  const db = new Database(hmemPath, { readonly: true });
  const row = db
    .prepare("SELECT level_1, updated_at FROM memories WHERE id = ?")
    .get("P0001") as { level_1: string; updated_at: string };
  db.close();
  return row;
}

function writeStaging(stagingPath: string, level1: string, updatedAt: string): void {
  const blob = {
    client_proposed_id: "P0001",
    data: JSON.stringify({
      _table: "memories",
      id: "P0001",
      prefix: "P",
      seq: 1,
      created_at: "2026-05-01T00:00:00Z",
      level_1: level1,
      updated_at: updatedAt,
    }),
    updated_at: updatedAt,
  };
  writeFileSync(stagingPath, JSON.stringify([blob]));
}

describe("importFromStaging — timestamp guard", () => {
  it("keeps local row when incoming updated_at is older", async () => {
    const hmemPath = join(TMP, "test.hmem");
    const stagingPath = join(TMP, "staging.json");

    seedDb(hmemPath, "Local newer", "2026-05-13T10:00:00Z");
    writeStaging(stagingPath, "Incoming older", "2026-05-12T10:00:00Z");

    await importFromStaging(stagingPath, hmemPath);

    const row = readLocal(hmemPath);
    expect(row.level_1).toBe("Local newer");
    expect(row.updated_at).toBe("2026-05-13T10:00:00Z");
  });

  it("applies incoming row when updated_at is newer", async () => {
    const hmemPath = join(TMP, "test.hmem");
    const stagingPath = join(TMP, "staging.json");

    seedDb(hmemPath, "Local older", "2026-05-12T10:00:00Z");
    writeStaging(stagingPath, "Incoming newer", "2026-05-13T10:00:00Z");

    await importFromStaging(stagingPath, hmemPath);

    const row = readLocal(hmemPath);
    expect(row.level_1).toBe("Incoming newer");
    expect(row.updated_at).toBe("2026-05-13T10:00:00Z");
  });

  it("applies incoming when local row has NULL updated_at", async () => {
    const hmemPath = join(TMP, "test.hmem");
    const stagingPath = join(TMP, "staging.json");

    const store = new HmemStore(hmemPath);
    store.close();
    const db = new Database(hmemPath);
    db.prepare(
      `INSERT INTO memories (id, prefix, seq, created_at, level_1, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run("P0001", "P", 1, "2026-05-01T00:00:00Z", "Local pre-migration");
    db.close();

    writeStaging(stagingPath, "Incoming with ts", "2026-05-13T10:00:00Z");

    await importFromStaging(stagingPath, hmemPath);

    const row = readLocal(hmemPath);
    expect(row.level_1).toBe("Incoming with ts");
    expect(row.updated_at).toBe("2026-05-13T10:00:00Z");
  });

  it("inserts new row when id not present locally", async () => {
    const hmemPath = join(TMP, "test.hmem");
    const stagingPath = join(TMP, "staging.json");

    const store = new HmemStore(hmemPath);
    store.close();
    writeStaging(stagingPath, "Brand new", "2026-05-13T10:00:00Z");

    await importFromStaging(stagingPath, hmemPath);

    const row = readLocal(hmemPath);
    expect(row.level_1).toBe("Brand new");
  });

  it("rejects equal updated_at (strictly newer wins)", async () => {
    const hmemPath = join(TMP, "test.hmem");
    const stagingPath = join(TMP, "staging.json");

    const ts = "2026-05-13T10:00:00Z";
    seedDb(hmemPath, "Local at T", ts);
    writeStaging(stagingPath, "Incoming at same T", ts);

    await importFromStaging(stagingPath, hmemPath);

    const row = readLocal(hmemPath);
    expect(row.level_1).toBe("Local at T");
  });
});
