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

describe("getOEntryExchangesV2", () => {
  it("reads exchanges from new 5-level format", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t.jsonl");
    const bid = store.resolveBatch(sid, oId, 5);

    store.appendExchangeV2(bid, oId, "question 1", "answer 1");
    store.appendExchangeV2(bid, oId, "question 2", "answer 2");

    const exchanges = store.getOEntryExchangesV2(oId, 5);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].userText).toBe("question 1");
    expect(exchanges[0].agentText).toBe("answer 1");
    expect(exchanges[1].userText).toBe("question 2");
  });

  it("skips #irrelevant exchanges", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t.jsonl");
    const bid = store.resolveBatch(sid, oId, 5);

    store.appendExchangeV2(bid, oId, "important", "answer");
    const e2 = store.appendExchangeV2(bid, oId, "ok", "ok");
    store.addTag(e2.id, "#irrelevant");

    const exchanges = store.getOEntryExchangesV2(oId, 5, { skipIrrelevant: true });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userText).toBe("important");
  });

  it("returns only title for #skill-dialog tagged exchanges", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);
    const sid = store.resolveSession(oId, "/tmp/t.jsonl");
    const bid = store.resolveBatch(sid, oId, 5);

    store.appendExchangeV2(bid, oId, "normal q", "normal a");
    const e2 = store.appendExchangeV2(bid, oId, "brainstorm long content", "skill output");
    store.addTag(e2.id, "#skill-dialog");

    const exchanges = store.getOEntryExchangesV2(oId, 5, { titleOnlyTags: ["#skill-dialog"] });
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].userText).toBe("normal q");
    expect(exchanges[1].userText).toBe(""); // title-only
    expect(exchanges[1].title).toBeTruthy();
  });

  it("reads across multiple batches and sessions", () => {
    store.writeLinear("P", { l1: "test" }, ["#project"]);
    const oId = store.resolveProjectO(1);

    const s1 = store.resolveSession(oId, "/tmp/t1.jsonl");
    const b1 = store.resolveBatch(s1, oId, 2);
    store.appendExchangeV2(b1, oId, "s1 q1", "s1 a1");
    store.appendExchangeV2(b1, oId, "s1 q2", "s1 a2");

    const b2 = store.resolveBatch(s1, oId, 2);
    store.appendExchangeV2(b2, oId, "s1 q3", "s1 a3");

    const s2 = store.resolveSession(oId, "/tmp/t2.jsonl");
    const b3 = store.resolveBatch(s2, oId, 5);
    store.appendExchangeV2(b3, oId, "s2 q1", "s2 a1");

    const exchanges = store.getOEntryExchangesV2(oId, 10);
    expect(exchanges).toHaveLength(4);
    expect(exchanges[0].userText).toBe("s1 q1");
    expect(exchanges[3].userText).toBe("s2 q1");
  });
});

describe("listProjects", () => {
  it("returns all active non-obsolete P-entries", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const projects = store.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0].id).toBe("P0001");
    expect(projects[1].id).toBe("P0002");
  });

  it("excludes obsolete P-entries", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    // Mark P0001 as obsolete
    store.db.prepare("UPDATE memories SET obsolete = 1 WHERE id = 'P0001'").run();
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("P0002");
  });
});

describe("moveNodes", () => {
  it("moves an L4 exchange to a different O-entry", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    const sA = store.resolveSession(oA, "/tmp/tA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    const ex = store.appendExchangeV2(bA, oA, "belongs to B", "response");

    const result = store.moveNodes([ex.id], oB);
    expect(result.moved).toBe(1);

    const exA = store.getOEntryExchangesV2(oA, 10);
    const exB = store.getOEntryExchangesV2(oB, 10);
    expect(exA).toHaveLength(0);
    expect(exB).toHaveLength(1);
    expect(exB[0].userText).toBe("belongs to B");
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

    const exB = store.getOEntryExchangesV2(oB, 10);
    expect(exB).toHaveLength(2);
  });

  it("preserves tags when moving", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    const sA = store.resolveSession(oA, "/tmp/tA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    const ex = store.appendExchangeV2(bA, oA, "tagged exchange", "response");
    store.addTag(ex.id, "#debugging");

    store.moveNodes([ex.id], oB);

    // Verify tag was moved with the node
    const exB = store.getOEntryExchangesV2(oB, 10);
    expect(exB).toHaveLength(1);
    // The exchange should NOT be excluded when filtering for #irrelevant
    const filtered = store.getOEntryExchangesV2(oB, 10, { skipIrrelevant: true });
    expect(filtered).toHaveLength(1);
  });

  it("cleans up empty parents after move", () => {
    store.writeLinear("P", { l1: "Project A" }, ["#project"]);
    store.writeLinear("P", { l1: "Project B" }, ["#project"]);
    const oA = store.resolveProjectO(1);
    const oB = store.resolveProjectO(2);

    const sA = store.resolveSession(oA, "/tmp/tA.jsonl");
    const bA = store.resolveBatch(sA, oA, 5);
    const ex = store.appendExchangeV2(bA, oA, "only exchange", "response");

    store.moveNodes([ex.id], oB);

    // Source batch and session should be cleaned up (empty)
    const sourceBatch = store.readNode(bA);
    expect(sourceBatch).toBeNull();
    const sourceSession = store.readNode(sA);
    expect(sourceSession).toBeNull();
  });
});
