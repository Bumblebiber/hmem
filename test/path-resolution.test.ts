import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveHmemPath } from "../src/hmem-store.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-path-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.HMEM_PATH;
});

describe("resolveHmemPath", () => {
  it("HMEM_PATH wins over everything", () => {
    // Use a platform-native absolute path so the assertion holds on Windows too.
    const custom = resolve(TMP, "..", "custom-hmem-target", "my.hmem");
    process.env.HMEM_PATH = custom;
    // Even with a .hmem file in CWD, HMEM_PATH takes priority
    writeFileSync(join(TMP, "local.hmem"), "");
    const result = resolveHmemPath(TMP);
    expect(result).toBe(custom);
  });

  it("HMEM_PATH expands ~ to homedir", () => {
    process.env.HMEM_PATH = "~/my-memories/test.hmem";
    const result = resolveHmemPath();
    expect(result).toBe(resolve(homedir(), "my-memories/test.hmem"));
  });

  it("CWD discovery finds single .hmem file", () => {
    writeFileSync(join(TMP, "project.hmem"), "");
    writeFileSync(join(TMP, "readme.txt"), "");
    const result = resolveHmemPath(TMP);
    expect(result).toBe(resolve(TMP, "project.hmem"));
  });

  it("CWD discovery errors on multiple .hmem files", () => {
    writeFileSync(join(TMP, "a.hmem"), "");
    writeFileSync(join(TMP, "b.hmem"), "");
    expect(() => resolveHmemPath(TMP)).toThrowError(/Multiple .hmem files/);
  });

  it("falls back to ~/.hmem/memory.hmem when no env and no CWD files", () => {
    // TMP has no .hmem files
    const result = resolveHmemPath(TMP);
    expect(result).toBe(resolve(homedir(), ".hmem", "memory.hmem"));
  });
});
