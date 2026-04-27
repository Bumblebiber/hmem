import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export async function setupHook(): Promise<void> {
  const HOME = os.homedir();
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  const hooksDir = path.join(HOME, ".claude", "hooks");
  const scriptDst = path.join(hooksDir, "hmem-session-inject.sh");
  const scriptSrc = path.join(import.meta.dirname, "..", "scripts", "hmem-session-inject.sh");

  // Read current settings
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    console.error(`  [error] Could not read ${settingsPath}`);
    console.error(`  Run 'hmem init' first to set up Claude Code integration.`);
    process.exit(1);
  }

  // Check if hook already registered
  const alreadyRegistered = (settings.hooks?.SessionStart || []).some((entry: any) =>
    entry.hooks?.some((h: any) => h.command?.includes("hmem-session-inject"))
  );

  if (alreadyRegistered) {
    console.log(`  [ok] hmem-session-inject hook already registered in settings.json`);
    return;
  }

  // Copy script to hooks dir
  if (!fs.existsSync(scriptSrc)) {
    console.error(`  [error] Source script not found: ${scriptSrc}`);
    process.exit(1);
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(scriptSrc, scriptDst);
  fs.chmodSync(scriptDst, 0o755);
  console.log(`  [ok] Copied hook script: ${scriptDst}`);

  // Add SessionStart hook entry
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  settings.hooks.SessionStart.unshift({
    matcher: "startup|clear|compact",
    hooks: [{ type: "command", command: `bash ${scriptDst}`, timeout: 5 }],
  });

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  console.log(`  [ok] Registered SessionStart hook in: ${settingsPath}`);
  console.log(`\n  Restart Claude Code to activate the hmem-using-hmem meta-skill injection.`);
}
