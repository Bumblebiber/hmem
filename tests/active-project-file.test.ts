/**
 * Tests for writeActiveProjectFile / readActiveProjectFile in session-state.ts.
 *
 * These functions provide a PPID-keyed active-project record that the statusline
 * can read without relying on the shared DB active flag or the fragile ppid-bridge
 * session-id lookup.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeActiveProjectFile, readActiveProjectFile } from "../src/session-state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PID_A = 9900001;
const TEST_PID_B = 9900002;
const TEST_PID_C = 9900003;

function tmpFile(pid: number): string {
  return path.join(os.tmpdir(), `hmem-active-${pid}.txt`);
}

afterEach(() => {
  for (const pid of [TEST_PID_A, TEST_PID_B, TEST_PID_C]) {
    try { fs.unlinkSync(tmpFile(pid)); } catch { /* ignore */ }
  }
});

describe("writeActiveProjectFile", () => {
  it("creates a file keyed by the given PID", () => {
    writeActiveProjectFile(TEST_PID_A, "P0048");
    expect(fs.existsSync(tmpFile(TEST_PID_A))).toBe(true);
  });

  it("stores the project ID in the file", () => {
    writeActiveProjectFile(TEST_PID_A, "P0048");
    expect(fs.readFileSync(tmpFile(TEST_PID_A), "utf8").trim()).toBe("P0048");
  });

  it("overwrites with a new project when called again", () => {
    writeActiveProjectFile(TEST_PID_A, "P0048");
    writeActiveProjectFile(TEST_PID_A, "P0054");
    expect(fs.readFileSync(tmpFile(TEST_PID_A), "utf8").trim()).toBe("P0054");
  });
});

describe("readActiveProjectFile", () => {
  it("returns the project ID written by writeActiveProjectFile", () => {
    writeActiveProjectFile(TEST_PID_B, "P0048");
    expect(readActiveProjectFile(TEST_PID_B)).toBe("P0048");
  });

  it("returns null when no file exists for the given PID", () => {
    expect(readActiveProjectFile(TEST_PID_C)).toBeNull();
  });

  it("returns the latest value after overwrite", () => {
    writeActiveProjectFile(TEST_PID_B, "P0048");
    writeActiveProjectFile(TEST_PID_B, "P0054");
    expect(readActiveProjectFile(TEST_PID_B)).toBe("P0054");
  });
});
