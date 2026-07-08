/**
 * Script:    cli-mcp-add-curate.ts
 * Purpose:   Register the hmem-curate MCP server with Claude Code.
 *            Curation tools are destructive (bulk obsolete, delete, merge),
 *            so this is an explicit opt-in step separate from `hmem init`.
 */

import { spawnSync } from "node:child_process";

export function runMcpAddCurate(): void {
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["claude"],
    { encoding: "utf8" },
  );
  if (which.status !== 0) {
    console.error("Error: `claude` CLI not found in PATH.");
    console.error("");
    console.error("This command registers the hmem-curate MCP server with Claude Code.");
    console.error("For other MCP clients, add a server with:");
    console.error("  name:    hmem-curate");
    console.error("  command: npx hmem-curate");
    process.exit(1);
  }

  const list = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  const entries = `${list.stdout || ""}\n${list.stderr || ""}`;
  if (/(^|\s)hmem-curate\b/m.test(entries)) {
    console.log("✓ hmem-curate is already registered with Claude Code.");
    console.log("  Toggle it via `/mcp` when you want to curate, deactivate when done.");
    return;
  }

  const add = spawnSync(
    "claude",
    ["mcp", "add", "hmem-curate", "-s", "user", "--", "npx", "hmem-curate"],
    { encoding: "utf8" },
  );
  if (add.status !== 0) {
    const msg = (add.stderr || add.stdout || "").trim();
    console.error(`Error: \`claude mcp add hmem-curate\` failed (exit ${add.status}).`);
    if (msg) console.error(msg);
    process.exit(add.status ?? 1);
  }

  console.log("✓ hmem-curate MCP server registered (user scope).");
  console.log("");
  console.log("  Activate via `/mcp` in Claude Code only when curating —");
  console.log("  it provides destructive bulk operations (obsolete, delete, merge).");
  console.log("  Then invoke `/hmem-curate` to start a curation session.");
}
