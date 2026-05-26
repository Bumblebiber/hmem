/**
 * Catch-all safety guard: the v1 `HmemStore` class must REFUSE to open a
 * schema_major=2 (v2) file. HmemStore's constructor runs `this.db.exec(SCHEMA)`
 * (the v1 `memories`/`memory_nodes` schema) immediately on open, so pointing it
 * at a v2 file would inject the v1 schema and CORRUPT it.
 *
 * Several manual commands (cli-stats, cli-delete, cli-session-summary,
 * cli-migrate-o, cli-checkpoint-agent) still construct HmemStore; this guard
 * protects every one of them at the root. Uses /tmp — never touches ~/.hmem.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { HmemStore } from "../src/hmem-store.js";
import { openDb } from "../src/store/db.js";
import { DEFAULT_CONFIG } from "../src/hmem-config.js";

const V2_DB = "/tmp/hmem-store-guard-v2.hmem";
const NEW_DB = "/tmp/hmem-store-guard-new.hmem";
const ALL = [V2_DB, NEW_DB].flatMap((f) => [f, f + "-wal", f + "-shm"]);

function cleanup() {
  for (const f of ALL) if (existsSync(f)) rmSync(f);
}

function tableExists(store: HmemStore, name: string): boolean {
  return (
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

describe("HmemStore v2-file guard", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("(a) THROWS when constructed on a freshly-created schema_major=2 file", () => {
    // Create a real v2 store (stamps schema_major=2) via the v2 db helper.
    openDb(V2_DB).close();

    expect(() => new HmemStore(V2_DB, DEFAULT_CONFIG)).toThrow(
      /refusing to open a schema_major=2 \(v2\) store/,
    );
    // Path is included in the message.
    expect(() => new HmemStore(V2_DB, DEFAULT_CONFIG)).toThrow(V2_DB);

    // Corruption guard: the v1 tables must NOT have been injected into the v2 file.
    const probe = openDb(V2_DB);
    try {
      const v1Tables = probe
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories','memory_nodes')",
        )
        .all();
      expect(v1Tables).toEqual([]);
    } finally {
      probe.close();
    }
  });

  it("(b) still works on a fresh path (new v1 store) and creates the v1 schema", () => {
    const store = new HmemStore(NEW_DB, DEFAULT_CONFIG);
    try {
      // No regression: a brand-new file (no schema_version table) opens fine
      // and gets the v1 schema installed.
      expect(tableExists(store, "memories")).toBe(true);
      expect(tableExists(store, "memory_nodes")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("(c) still works on an existing v1 file (re-open)", () => {
    // First open creates the v1 store + writes an entry.
    const first = new HmemStore(NEW_DB, DEFAULT_CONFIG);
    first.writeLinear("P", { l1: "hmem | guard regression fixture" }, ["#project"]);
    first.close();

    // Re-opening the existing v1 file must NOT throw.
    const second = new HmemStore(NEW_DB, DEFAULT_CONFIG);
    try {
      expect(tableExists(second, "memories")).toBe(true);
      const row = second.db
        .prepare("SELECT prefix FROM memories WHERE seq > 0 LIMIT 1")
        .get() as { prefix: string } | undefined;
      expect(row?.prefix).toBe("P");
    } finally {
      second.close();
    }
  });
});
