import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveHmemPathNew } from "../src/hmem-store.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-path-test");

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.HMEM_PATH;
});

describe("resolveHmemPathNew", () => {
  it("HMEM_PATH wins over everything", () => {
    process.env.HMEM_PATH = "/custom/path/my.hmem";
    // Even with a .hmem file in CWD, HMEM_PATH takes priority
    writeFileSync(join(TMP, "local.hmem"), "");
    const result = resolveHmemPathNew(TMP);
    expect(result).toBe("/custom/path/my.hmem");
  });

  it("HMEM_PATH expands ~ to homedir", () => {
    process.env.HMEM_PATH = "~/my-memories/test.hmem";
    const result = resolveHmemPathNew();
    expect(result).toBe(resolve(homedir(), "my-memories/test.hmem"));
  });

  it("CWD discovery finds single .hmem file", () => {
    writeFileSync(join(TMP, "project.hmem"), "");
    writeFileSync(join(TMP, "readme.txt"), "");
    const result = resolveHmemPathNew(TMP);
    expect(result).toBe(resolve(TMP, "project.hmem"));
  });

  it("CWD discovery errors on multiple .hmem files", () => {
    writeFileSync(join(TMP, "a.hmem"), "");
    writeFileSync(join(TMP, "b.hmem"), "");
    expect(() => resolveHmemPathNew(TMP)).toThrowError(/Multiple .hmem files/);
  });

  it("falls back to ~/.hmem/memory.hmem when no env and no CWD files", () => {
    // TMP has no .hmem files
    const result = resolveHmemPathNew(TMP);
    expect(result).toBe(resolve(homedir(), ".hmem", "memory.hmem"));
  });
});
