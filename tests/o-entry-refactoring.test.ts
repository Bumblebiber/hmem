import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
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
  it("creates O0001 for P0001 if it does not exist", () => {
    store.writeLinear("P", { l1: "hmem-mcp | Memory for AI" }, ["#project"]);
    // writeLinear auto-assigns seq=1, so P0001 is created.
    const oId = store.resolveProjectO(1); // matches P0001
    expect(oId).toBe("O0001");
    // Verify entry was created
    const entry = store.readEntry("O0001");
    expect(entry).toBeTruthy();
    const rawLinks = store.readEntry("O0001")?.links;
    expect(rawLinks).toBeTruthy();
    expect(JSON.parse(rawLinks!)).toContain("P0001");
  });

  it("returns existing O if already exists", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const o1 = store.resolveProjectO(1);
    const o2 = store.resolveProjectO(1);
    expect(o1).toBe(o2);
  });

  it("creates O0000 for non-project", () => {
    const oId = store.resolveProjectO(0);
    expect(oId).toBe("O0000");
  });
});

describe("resolveSession", () => {
  it("creates new L2 session for new transcript path", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t1.jsonl");
    expect(sid).toBe("O0001.1");
  });

  it("returns same session for same transcript", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const s1 = store.resolveSession(oId, "/tmp/t1.jsonl");
    const s2 = store.resolveSession(oId, "/tmp/t1.jsonl");
    expect(s1).toBe(s2);
  });

  it("creates new session for different transcript", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const s1 = store.resolveSession(oId, "/tmp/t1.jsonl");
    const s2 = store.resolveSession(oId, "/tmp/t2.jsonl");
    expect(s1).not.toBe(s2);
    expect(s2).toBe("O0001.2");
  });
});

describe("resolveBatch", () => {
  it("creates first batch under session", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t.jsonl");
    const bid = store.resolveBatch(sid, oId, 5);
    expect(bid).toBe("O0001.1.1");
  });

  it("returns same batch if not full", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t.jsonl");
    const b1 = store.resolveBatch(sid, oId, 5);
    const b2 = store.resolveBatch(sid, oId, 5);
    expect(b1).toBe(b2);
  });
});

describe("appendExchangeV2", () => {
  it("creates L4 exchange with L5.1 user + L5.2 agent under a batch", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    const result = store.appendExchangeV2(batchId, oId, "What is hmem?", "hmem is a memory system.");
    expect(result.id).toBe("O0001.1.1.1"); // first exchange in first batch

    // Verify L4 node
    const l4 = store.readNode(result.id);
    expect(l4).toBeTruthy();
    expect(l4!.depth).toBe(4);

    // Verify L5 children
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
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const batchId = store.resolveBatch(sessionId, oId, 5);

    store.appendExchangeV2(batchId, oId, "msg1", "resp1");
    const r2 = store.appendExchangeV2(batchId, oId, "msg2", "resp2");
    expect(r2.id).toBe("O0001.1.1.2");
  });
});

describe("resolveBatch (with appendExchangeV2)", () => {
  it("creates new batch when current is full", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sessionId = store.resolveSession(oId, "/tmp/t.jsonl");
    const b1 = store.resolveBatch(sessionId, oId, 3); // batch size 3
    for (let i = 0; i < 3; i++) {
      store.appendExchangeV2(b1, oId, `user ${i}`, `agent ${i}`);
    }
    const b2 = store.resolveBatch(sessionId, oId, 3);
    expect(b2).not.toBe(b1);
    expect(b2).toBe("O0001.1.2"); // second batch
  });
});
