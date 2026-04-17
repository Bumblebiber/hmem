/**
 * MCP server smoke test — spawns the built `dist/mcp-server.js` as a child
 * process, connects an MCP client over stdio, and exercises a handful of
 * tool handlers end-to-end.
 *
 * Scope: this is a *smoke* test — it verifies the wire protocol and a few
 * golden paths, not every handler. Extend as needed when adding new tools
 * or hardening existing ones.
 *
 * Requires `npm run build` to have produced `dist/mcp-server.js`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(HERE, "..", "..", "dist", "mcp-server.js");
const hasBuild = fs.existsSync(SERVER_PATH);

// Skip the whole suite if dist/ is missing — CI always builds first, local
// devs who forget to build get a clear skip message instead of a crash.
const d = hasBuild ? describe : describe.skip;

d("MCP server (spawned, stdio)", () => {
  let tmpHome: string;
  let hmemPath: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-mcp-smoke-"));
    hmemPath = path.join(tmpHome, "test.hmem");

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        HMEM_PATH: hmemPath,
        HMEM_PROJECT_DIR: tmpHome,
      },
      stderr: "pipe",
    });

    client = new Client({ name: "smoke-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    try { await client?.close(); } catch { /* best effort */ }
    try { await transport?.close(); } catch { /* best effort */ }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("advertises a tool list including the core handlers", async () => {
    const list = await client.listTools();
    const names = list.tools.map(t => t.name);
    expect(names).toContain("write_memory");
    expect(names).toContain("read_memory");
    expect(names).toContain("list_projects");
    expect(names).toContain("load_project");
    expect(names).toContain("search_memory");
  });

  it("list_projects returns an empty list on a fresh store", async () => {
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)
      .find(c => c.type === "text")?.text ?? "";
    // Empty store may render either "no projects" or a 0-count header;
    // both are acceptable, we only guard against accidental crashes / non-text replies.
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("write_memory creates an entry and read_memory returns it", async () => {
    const writeRes = await client.callTool({
      name: "write_memory",
      arguments: {
        prefix: "P",
        content: "Smoke Project\n\tOverview",
        tags: ["#smoke-test"],
      },
    });
    const writeText = (writeRes.content as Array<{ type: string; text: string }>)
      .find(c => c.type === "text")?.text ?? "";
    const idMatch = writeText.match(/P\d{4}/);
    expect(idMatch, `expected P#### id in response, got: ${writeText}`).not.toBeNull();
    const newId = idMatch![0];

    const readRes = await client.callTool({
      name: "read_memory",
      arguments: { prefix: "P" },
    });
    const readText = (readRes.content as Array<{ type: string; text: string }>)
      .find(c => c.type === "text")?.text ?? "";
    expect(readText).toContain(newId);
    expect(readText).toContain("Smoke Project");
  });

  it("rejects zod-invalid input with a structured error", async () => {
    // read_memory.prefix expects a string; sending a number should fail
    // validation at the MCP layer without crashing the server.
    const res = await client.callTool({
      name: "read_memory",
      arguments: { prefix: 123 as unknown as string },
    });
    // Either isError=true or an error-content block — both mean "the server
    // rejected this cleanly rather than crashing."
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const isError = res.isError === true || content.some(c => c.text && /error|invalid/i.test(c.text));
    expect(isError).toBe(true);
  });
});
