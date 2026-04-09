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
