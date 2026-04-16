/**
 * hmem OpenCode plugin
 *
 * Bridges OpenCode's plugin event system into hmem's CLI hook commands.
 * Drop this file into ~/.config/opencode/plugins/ (global) or
 * .opencode/plugins/ (project-local) and OpenCode will auto-load it.
 *
 * Mapping:
 *   chat.message                       → capture user prompt + write session marker
 *   event: message.part.updated        → accumulate assistant text per session
 *   event: session.idle                → spawn `hmem log-exchange` + `hmem checkpoint`
 *   experimental.session.compacting    → inject hmem context into compaction prompt
 *
 * Requires `hmem` CLI on PATH and HMEM_PATH env var (auto-detected if unset).
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Bug 4: Ensure HMEM env vars are set for all spawned child processes.
// On Windows, OpenCode may not propagate these from the launch environment.
if (!process.env.HMEM_PROJECT_DIR) {
  process.env.HMEM_PROJECT_DIR = join(homedir(), ".hmem");
}
if (!process.env.HMEM_PATH) {
  process.env.HMEM_PATH = join(homedir(), ".hmem", "memory.hmem");
}

// Bug 3: On Windows, detached + shell spawns a visible console window per call.
// Use platform-specific spawn options to avoid that.
const isWindows = process.platform === "win32";

function spawnHmem(args, stdinJson) {
  try {
    // Bug 2: On Windows, npm global installs expose "hmem.ps1" / "hmem.cmd" wrappers
    // that Node's spawn cannot execute without shell: true.
    const options = isWindows
      ? {
          stdio: ["pipe", "ignore", "ignore"],
          env: process.env,
          shell: true,
          windowsHide: true,
        }
      : {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
          env: process.env,
        };
    const child = spawn("hmem", args, options);
    if (stdinJson) {
      child.stdin.end(stdinJson);
    } else {
      child.stdin.end();
    }
    if (!isWindows) child.unref();
  } catch {
    // hmem not installed or not on PATH — silently no-op
  }
}

function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(p => p && p.type === "text" && typeof p.text === "string")
    .map(p => p.text)
    .join("\n")
    .trim();
}

export default {
  id: "hmem",
  server: async () => {
    const userMessages = new Map();
    const assistantBuffers = new Map();

    return {
      "chat.message": async ({ sessionID }, { parts }) => {
        const text = partsToText(parts);
        if (text) userMessages.set(sessionID, text);
        assistantBuffers.set(sessionID, "");
        spawnHmem(["hook-startup"], JSON.stringify({ session_id: sessionID }));
      },

      event: async ({ event }) => {
        if (!event || typeof event !== "object") return;

        if (event.type === "message.part.updated") {
          const part = event.properties?.part;
          if (!part || part.type !== "text" || typeof part.text !== "string") return;
          const sid = part.sessionID;
          if (!sid) return;
          assistantBuffers.set(sid, part.text);
          return;
        }

        if (event.type === "session.idle") {
          const sid = event.properties?.sessionID;
          if (!sid) return;
          const userMessage = userMessages.get(sid);
          const assistantMessage = assistantBuffers.get(sid);
          if (!userMessage || !assistantMessage) return;
          userMessages.delete(sid);
          assistantBuffers.delete(sid);
          spawnHmem(["log-exchange"], JSON.stringify({
            session_id: sid,
            last_user_message: userMessage,
            last_assistant_message: assistantMessage,
          }));
          spawnHmem(["checkpoint"], JSON.stringify({ session_id: sid }));
        }
      },

      "experimental.session.compacting": async ({ sessionID }, output) => {
        try {
          const result = spawnSync("hmem", ["context-inject"], {
            input: JSON.stringify({ session_id: sessionID }),
            encoding: "utf8",
            timeout: 5000,
            env: process.env,
            // Bug 2+3: same shell/windowsHide treatment for spawnSync on Windows
            ...(isWindows ? { shell: true, windowsHide: true } : {}),
          });
          const text = (result.stdout || "").trim();
          if (text) output.context.push(text);
        } catch {
          // hmem not available — skip
        }
      },
    };
  },
};
