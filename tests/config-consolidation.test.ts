import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadHmemConfig, DEFAULT_CONFIG } from "../src/hmem-config.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-config-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadHmemConfig", () => {
  it("loads legacy flat format", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ maxL1Chars: 300 }));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(300);
    expect(cfg.sync).toBeUndefined();
  });

  it("returns defaults when no config file exists", () => {
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel).toEqual(DEFAULT_CONFIG.maxCharsPerLevel);
    expect(cfg.sync).toBeUndefined();
  });

  it("loads unified format with memory + sync sections", () => {
    const config = {
      memory: { maxL1Chars: 400 },
      sync: {
        serverUrl: "https://example.com",
        userId: "testuser",
        salt: "abc123",
        token: "tok_secret",
        syncSecrets: true,
        lastPushAt: null,
        lastPullAt: "2026-01-01T00:00:00Z"
      }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(400);
    expect(cfg.sync).toBeDefined();
    expect(cfg.sync!.serverUrl).toBe("https://example.com");
    expect(cfg.sync!.token).toBe("tok_secret");
    expect(cfg.sync!.lastPullAt).toBe("2026-01-01T00:00:00Z");
  });

  it("loads unified format without sync section", () => {
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify({ memory: { maxL1Chars: 250 } }));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.maxCharsPerLevel[0]).toBe(250);
    expect(cfg.sync).toBeUndefined();
  });

  it("preserves syncSecrets: false (not defaulted to true)", () => {
    const config = {
      memory: {},
      sync: { serverUrl: "x", userId: "y", salt: "z", token: "t", syncSecrets: false }
    };
    writeFileSync(join(TMP, "hmem.config.json"), JSON.stringify(config));
    const cfg = loadHmemConfig(TMP);
    expect(cfg.sync!.syncSecrets).toBe(false);
  });
});
