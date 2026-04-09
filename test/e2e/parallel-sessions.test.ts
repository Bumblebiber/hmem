import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../../src/hmem-store.js";
import { loadHmemConfig } from "../../src/hmem-config.js";
import { writeSessionMarker } from "../../src/session-state.js";

const tmpHome = path.join(os.tmpdir(), `hmem-e2e-${process.pid}`);
const oldHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("parallel sessions do not contaminate each other", () => {
  it("each session sees its own active project via setActiveProject with sessionId", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    const idP1 = store.writeLinear("P", { l1: "Alpha" }, ["#project"]).id;
    const idP2 = store.writeLinear("P", { l1: "Beta" }, ["#project"]).id;

    store.setActiveProject(idP1, "sess-A");
    store.setActiveProject(idP2, "sess-B");

    // DB flag is now P2 (last writer wins), but each session marker is independent
    expect(store.getActiveProject("sess-A")?.id).toBe(idP1);
    expect(store.getActiveProject("sess-B")?.id).toBe(idP2);

    store.close();
  });

  it("session without marker falls through to DB flag", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    const idP1 = store.writeLinear("P", { l1: "Alpha" }, ["#project"]).id;

    store.setActiveProject(idP1);
    expect(store.getActiveProject("legacy-session")?.id).toBe(idP1);

    store.close();
  });

  it("marker with projectId=null falls through to DB flag", () => {
    const hmemPath = path.join(tmpHome, "m.hmem");
    const store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
    const idP1 = store.writeLinear("P", { l1: "Alpha" }, ["#project"]).id;

    store.setActiveProject(idP1);
    writeSessionMarker("legacy", { projectId: null, hmemPath });
    expect(store.getActiveProject("legacy")?.id).toBe(idP1);

    store.close();
  });
});
