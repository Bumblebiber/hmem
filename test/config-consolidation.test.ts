import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadHmemConfig, saveHmemConfig, DEFAULT_CONFIG, getSyncServers } from "../src/hmem-config.js";

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
    const srv = getSyncServers(cfg)[0];
    expect(srv.serverUrl).toBe("https://example.com");
    expect(srv.token).toBe("tok_secret");
    expect(srv.lastPullAt).toBe("2026-01-01T00:00:00Z");
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
    expect(getSyncServers(cfg)[0].syncSecrets).toBe(false);
  });
});

describe("saveHmemConfig", () => {
  it("saves and reloads unified config with roundtrip fidelity", () => {
    const cfg = loadHmemConfig(TMP); // defaults, no file
    cfg.maxCharsPerLevel[0] = 350;
    cfg.sync = {
      serverUrl: "https://test.com",
      userId: "me",
      salt: "salt123",
      token: "secret_token",
      syncSecrets: true,
      lastPushAt: null,
      lastPullAt: null,
    };
    saveHmemConfig(TMP, cfg);

    const reloaded = loadHmemConfig(TMP);
    expect(reloaded.maxCharsPerLevel[0]).toBe(350);
    expect(reloaded.maxDepth).toBe(cfg.maxDepth);
    const srv = getSyncServers(reloaded)[0];
    expect(srv.serverUrl).toBe("https://test.com");
    expect(srv.token).toBe("secret_token");
  });

  it("saves config with chmod 600 when token present", () => {
    const cfg = loadHmemConfig(TMP);
    cfg.sync = { serverUrl: "x", userId: "y", salt: "z", token: "secret" };
    saveHmemConfig(TMP, cfg);

    const stat = statSync(join(TMP, "hmem.config.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("saves config without sync section when sync is undefined", () => {
    const cfg = loadHmemConfig(TMP);
    saveHmemConfig(TMP, cfg);

    const raw = JSON.parse(readFileSync(join(TMP, "hmem.config.json"), "utf8"));
    expect(raw.memory).toBeDefined();
    expect(raw.sync).toBeUndefined();
  });
});
