import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inheritHmemMcpEnv } from "../src/cli-mcp-env.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "hmem-cli-mcp-env-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeMcpConfig(directory: string, env: Record<string, string>): void {
  writeFileSync(path.join(directory, ".mcp.json"), JSON.stringify({
    mcpServers: { hmem: { command: "node", args: ["mcp-server.js"], env } },
  }));
}

describe("inheritHmemMcpEnv", () => {
  it("maps legacy project and agent settings to the same memory file for hooks", () => {
    writeMcpConfig(tmpDir, {
      HMEM_PROJECT_DIR: "./memory",
      HMEM_AGENT_ID: "DEVELOPER",
      HMEM_AGENT_ROLE: "worker",
    });

    const env: NodeJS.ProcessEnv = {};
    inheritHmemMcpEnv(tmpDir, env);

    const projectDir = path.resolve(tmpDir, "memory");
    expect(env.HMEM_PROJECT_DIR).toBe(projectDir);
    expect(env.HMEM_PATH).toBe(path.join(projectDir, "Agents", "DEVELOPER", "DEVELOPER.hmem"));
    expect(env.HMEM_AGENT_ID).toBe("DEVELOPER");
    expect(env.HMEM_AGENT_ROLE).toBe("worker");
  });

  it("uses direct HMEM_PATH from config and derives project dir when omitted", () => {
    writeMcpConfig(tmpDir, { HMEM_PATH: "./memory/custom.hmem" });

    const env: NodeJS.ProcessEnv = {};
    inheritHmemMcpEnv(tmpDir, env);

    const hmemPath = path.resolve(tmpDir, "memory/custom.hmem");
    expect(env.HMEM_PATH).toBe(hmemPath);
    expect(env.HMEM_PROJECT_DIR).toBe(path.dirname(hmemPath));
  });

  it("keeps explicit process environment ahead of MCP config", () => {
    writeMcpConfig(tmpDir, {
      HMEM_PATH: "./configured.hmem",
      HMEM_PROJECT_DIR: "./configured-dir",
      HMEM_AGENT_ID: "CONFIGURED",
    });

    const env: NodeJS.ProcessEnv = {
      HMEM_PATH: "/explicit/custom.hmem",
      HMEM_PROJECT_DIR: "/explicit",
      HMEM_AGENT_ID: "EXPLICIT",
    };
    inheritHmemMcpEnv(tmpDir, env);

    expect(env.HMEM_PATH).toBe("/explicit/custom.hmem");
    expect(env.HMEM_PROJECT_DIR).toBe("/explicit");
    expect(env.HMEM_AGENT_ID).toBe("EXPLICIT");
  });

  it("finds project config when hook runs from a nested directory", () => {
    const nestedDir = path.join(tmpDir, "packages", "app");
    const projectDir = path.join(tmpDir, "memory");
    writeMcpConfig(tmpDir, { HMEM_PROJECT_DIR: projectDir });
    const env: NodeJS.ProcessEnv = {};

    inheritHmemMcpEnv(nestedDir, env);

    expect(env.HMEM_PROJECT_DIR).toBe(projectDir);
    expect(env.HMEM_PATH).toBe(path.join(projectDir, "memory.hmem"));
  });
});
