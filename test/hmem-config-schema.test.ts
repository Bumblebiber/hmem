import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadHmemConfig } from "../src/hmem-config.js";

describe("schema parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-schema-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown) {
    fs.writeFileSync(path.join(tmpDir, "hmem.config.json"), JSON.stringify(obj));
  }

  it("parses valid schema with sections", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { name: "Overview", loadDepth: 3, defaultChildren: ["Goals", "State"] },
              { name: "Bugs", loadDepth: 2 },
            ],
            createLinkedO: true,
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas).toBeDefined();
    expect(cfg.schemas!.P.sections).toHaveLength(2);
    expect(cfg.schemas!.P.sections[0].name).toBe("Overview");
    expect(cfg.schemas!.P.sections[0].loadDepth).toBe(3);
    expect(cfg.schemas!.P.sections[0].defaultChildren).toEqual(["Goals", "State"]);
    expect(cfg.schemas!.P.sections[1].defaultChildren).toBeUndefined();
    expect(cfg.schemas!.P.createLinkedO).toBe(true);
  });

  it("returns undefined schemas when key is missing", () => {
    writeConfig({ memory: { checkpointInterval: 10 } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas).toBeUndefined();
  });

  it("skips sections with invalid loadDepth", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { name: "Good", loadDepth: 2 },
              { name: "Bad", loadDepth: -1 },
              { name: "TooHigh", loadDepth: 5 },
              { name: "NoDepth" },
            ],
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toHaveLength(1);
    expect(cfg.schemas!.P.sections[0].name).toBe("Good");
  });

  it("skips sections with missing name", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { loadDepth: 2 },
              { name: "Valid", loadDepth: 1 },
            ],
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toHaveLength(1);
    expect(cfg.schemas!.P.sections[0].name).toBe("Valid");
  });

  it("accepts empty sections array", () => {
    writeConfig({ memory: { schemas: { P: { sections: [] } } } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toEqual([]);
  });

  it("supports multiple prefix schemas", () => {
    writeConfig({
      memory: {
        schemas: {
          P: { sections: [{ name: "Overview", loadDepth: 3 }] },
          E: { sections: [{ name: "Root Cause", loadDepth: 2 }] },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections[0].name).toBe("Overview");
    expect(cfg.schemas!.E.sections[0].name).toBe("Root Cause");
  });

  it("defaults createLinkedO to false", () => {
    writeConfig({ memory: { schemas: { P: { sections: [] } } } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.createLinkedO).toBeFalsy();
  });
});
