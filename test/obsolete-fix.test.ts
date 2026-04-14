import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HmemStore, SimilarEntriesError } from "../src/hmem-store.js";
import { loadHmemConfig } from "../src/hmem-config.js";

const tmpHome = path.join(os.tmpdir(), `hmem-obsolete-${process.pid}`);
let store: HmemStore;
let hmemPath: string;

beforeEach(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  hmemPath = path.join(tmpHome, "test.hmem");
  store = new HmemStore(hmemPath, loadHmemConfig(tmpHome));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("issue #23 — obsolete=true does not crash on memory_nodes.links", () => {
  it("marking an entry obsolete with a correction reference succeeds", () => {
    const correction = store.write("L", "Correct approach", undefined, undefined, undefined, ["#hmem", "#fix", "#a"]);
    const wrong = store.write("L", "Wrong approach", undefined, undefined, undefined, ["#hmem", "#fix", "#b"]);
    const ok = store.updateNode(
      wrong.id,
      `Wrong — see [✓${correction.id}]`,
      undefined,
      true, // obsolete=true
    );
    expect(ok).toBe(true);
  });
});

describe("issue #12 — duplicate-detection threshold is at least 3 shared tags", () => {
  it("allows a write that shares only 2 tags with an existing entry", () => {
    store.write("E", "First bug", undefined, undefined, undefined, ["#python", "#pyobjc", "#specific-topic-a"]);
    expect(() => {
      store.write("E", "Second unrelated bug", undefined, undefined, undefined, ["#python", "#pyobjc", "#specific-topic-b"]);
    }).not.toThrow();
  });

  it("blocks a write that shares 3+ tags with an existing entry", () => {
    store.write("E", "First", undefined, undefined, undefined, ["#a", "#b", "#c", "#d"]);
    expect(() => {
      store.write("E", "Second", undefined, undefined, undefined, ["#a", "#b", "#c", "#e"]);
    }).toThrow(SimilarEntriesError);
  });
});
