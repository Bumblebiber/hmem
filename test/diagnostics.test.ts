import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDiagnostic, diagnosticsLogPath } from "../src/diagnostics.js";

const tmpHome = path.join(os.tmpdir(), `hmem-diag-${process.pid}`);
const oldHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  fs.mkdirSync(tmpHome, { recursive: true });
});
afterEach(() => {
  process.env.HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("diagnostics", () => {
  it("appends a JSONL entry", () => {
    writeDiagnostic({ op: "log-exchange", sessionId: "s1", activeProjectId: "P0048" });
    const lines = fs.readFileSync(diagnosticsLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.op).toBe("log-exchange");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.ts).toBeDefined();
  });

  it("rotates when file exceeds max size", () => {
    const logPath = diagnosticsLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "x".repeat(1024 * 1024 + 10));
    writeDiagnostic({ op: "test", sessionId: "s2" });
    expect(fs.existsSync(logPath + ".1")).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(1024);
  });
});
