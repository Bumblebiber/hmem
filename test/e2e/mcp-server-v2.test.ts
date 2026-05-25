import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(HERE, '..', '..', 'dist', 'mcp-server.js');
const d = fs.existsSync(SERVER_PATH) ? describe : describe.skip;

function textOf(res: any): string {
  return (res.content as Array<{ type: string; text: string }>).find(c => c.type === 'text')?.text ?? '';
}

d('MCP server v2 (spawned, stdio)', () => {
  let tmpHome: string, hmemPath: string, client: Client, transport: StdioClientTransport;
  const sessionId = '01ABCSESSIONV2TEST0000000';

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hmem-mcp-v2-'));
    hmemPath = path.join(tmpHome, 'test.hmem');
    transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER_PATH],
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, HMEM_PATH: hmemPath, HMEM_PROJECT_DIR: tmpHome, HMEM_SESSION_ID: sessionId },
      stderr: 'pipe',
    });
    client = new Client({ name: 'v2-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });
  afterAll(async () => {
    try { await client?.close(); } catch { /* */ }
    try { await transport?.close(); } catch { /* */ }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('advertises activate + get_session_log and no O-routing tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('activate');
    expect(names).toContain('get_session_log');
    expect(names).not.toContain('flush_context');
    expect(names).not.toContain('move_nodes');
  });

  it('activate binds the session to a created project, get_session_log reads events', async () => {
    const create = await client.callTool({ name: 'create_project', arguments: { name: 'Wire Proj', tech: 'TS', description: 'x' } });
    const pid = textOf(create).match(/P\d{4}/)![0];
    const act = await client.callTool({ name: 'activate', arguments: { project: pid } });
    expect(textOf(act)).toContain(pid);
    const log = await client.callTool({ name: 'get_session_log', arguments: { session_id: sessionId } });
    // No user/agent events exist yet, but the response must echo back the session_id
    // (verifies the call was routed with the correct arg and didn't silently error).
    expect(textOf(log)).toContain(sessionId);
  });
});
