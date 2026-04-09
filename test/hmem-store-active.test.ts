import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore } from "../src/hmem-store.js";
import { writeSessionMarker, readSessionMarker } from "../src/session-state.js";
import { loadHmemConfig } from "../src/hmem-config.js";

const tmpHome = path.join(os.tmpdir(), `hmem-active-${process.pid}`);
const oldHome = process.env.HOME;
let store: HmemStore;
let hmemPath: string;
let idP1: string;
let idP2: string;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
  hmemPath = path.join(tmpHome, "test.hmem");
  store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
  idP1 = store.writeLinear("P", { l1: "Alpha" }, ["#project"]).id;
  idP2 = store.writeLinear("P", { l1: "Beta" }, ["#project"]).id;
});
afterEach(() => {
  store.close();
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("getActiveProject with sessionId", () => {
  it("prefers marker file over DB flag", () => {
    store.setActiveProject(idP1);
    writeSessionMarker("sX", { projectId: idP2, hmemPath });
    const active = store.getActiveProject("sX");
    expect(active?.id).toBe(idP2);
  });

  it("falls back to DB flag when no marker", () => {
    store.setActiveProject(idP1);
    const active = store.getActiveProject("sUnknown");
    expect(active?.id).toBe(idP1);
  });

  it("returns null when marker has null projectId", () => {
    writeSessionMarker("sY", { projectId: null, hmemPath });
    expect(store.getActiveProject("sY")).toBeNull();
  });

  it("setActiveProject(id, sessionId) writes marker", () => {
    store.setActiveProject(idP2, "sZ");
    const marker = readSessionMarker("sZ");
    expect(marker?.projectId).toBe(idP2);
  });
});
