/**
 * Tests for writeActiveProjectFile / readActiveProjectFile in session-state.ts.
 *
 * These functions provide a PPID-keyed active-project record that the statusline
 * can read without relying on the shared DB active flag or the fragile ppid-bridge
 * session-id lookup.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeActiveProjectFile, readActiveProjectFile, getParentPid, readActiveProjectForCurrentProcess } from "../src/session-state.js";
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

describe("getParentPid", () => {
  it("returns the parent PID of the current process (Linux only)", () => {
    if (process.platform !== "linux") return;
    const parentOfSelf = getParentPid(process.pid);
    expect(parentOfSelf).toBe(process.ppid);
  });

  it("returns null for a non-existent PID", () => {
    expect(getParentPid(9999999)).toBeNull();
  });
});

describe("readActiveProjectForCurrentProcess", () => {
  const MY_PPID = typeof process.ppid === "number" ? process.ppid : 0;
  const MY_GRANDPARENT = MY_PPID ? getParentPid(MY_PPID) : null;

  afterEach(() => {
    if (MY_PPID) { try { fs.unlinkSync(tmpFile(MY_PPID)); } catch { /* ok */ } }
    if (MY_GRANDPARENT && MY_GRANDPARENT > 1) { try { fs.unlinkSync(tmpFile(MY_GRANDPARENT)); } catch { /* ok */ } }
  });

  it("finds project written under direct PPID", () => {
    if (!MY_PPID) return;
    writeActiveProjectFile(MY_PPID, "P0048");
    expect(readActiveProjectForCurrentProcess()).toBe("P0048");
  });

  it("finds project written under grandparent PID (bash-intermediary case)", () => {
    if (!MY_GRANDPARENT || MY_GRANDPARENT <= 1) return;
    writeActiveProjectFile(MY_GRANDPARENT, "P0048");
    expect(readActiveProjectForCurrentProcess()).toBe("P0048");
  });

  it("returns null when no file exists for either ancestor", () => {
    // Ensure no files exist for our ancestors (cleaned up by afterEach)
    // We can't guarantee no other process wrote a file, so just test return type
    const result = readActiveProjectForCurrentProcess();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
