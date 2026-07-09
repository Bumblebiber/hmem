import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "dist", "cli.js");

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("hmem help", () => {
  it("prints the Quick Tips header", () => {
    const out = runCli(["help"]);
    expect(out).toContain("🧠 hmem — Quick Tips");
  });

  it("mentions /hmem-wipe in tips", () => {
    const out = runCli(["help"]);
    expect(out).toContain("/hmem-wipe");
  });

  it("mentions hmem sync setup in tips", () => {
    const out = runCli(["help"]);
    expect(out).toContain("hmem sync setup");
  });

  it("mentions Rules in tips", () => {
    const out = runCli(["help"]);
    expect(out).toMatch(/merk dir als Regel|remember as a rule/);
  });

  it("mentions new project trigger in tips", () => {
    const out = runCli(["help"]);
    expect(out).toMatch(/neues Projekt|new project/);
  });

  it("includes the full commands table after tips", () => {
    const out = runCli(["help"]);
    expect(out).toContain("hmem — Humanlike Memory for AI Agents");
    expect(out).toContain("hmem serve");
    const tipsIdx = out.indexOf("🧠 hmem — Quick Tips");
    const commandsIdx = out.indexOf("hmem — Humanlike Memory for AI Agents");
    expect(tipsIdx).toBeGreaterThanOrEqual(0);
    expect(commandsIdx).toBeGreaterThan(tipsIdx);
  });

  it("--help is an alias", () => {
    const out = runCli(["--help"]);
    expect(out).toContain("🧠 hmem — Quick Tips");
  });

  it("-h is an alias", () => {
    const out = runCli(["-h"]);
    expect(out).toContain("🧠 hmem — Quick Tips");
  });

  it("default output (no args) still prints commands table without Tips", () => {
    const out = runCli([]);
    expect(out).toContain("hmem — Humanlike Memory for AI Agents");
    expect(out).not.toContain("🧠 hmem — Quick Tips");
  });
});
