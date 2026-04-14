# Hook Configuration on Windows (REQUIRED)

On Windows, hook execution is fragile out of the box. Two issues bite every new user:

**1. Git Bash routing** — On systems with Git for Windows installed, Claude Code may route hook commands through Git Bash (`bash.exe`). Its MSYS2 runtime crashes transiently with `add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1` during cygheap init, killing the hook **before the command is even parsed**. Symptom: `UserPromptSubmit hook error` or `Stop hook error` with a bash.exe stacktrace.

**2. Unix inline env-var syntax** — Commands like `HMEM_PATH=C:/... node ...` work in bash but break in cmd.exe and PowerShell. Symptom: `"HMEM_PATH" is not recognized as a command`.

**The fix for Windows users (apply to every hook + statusLine):**

```json
{
  "env": {
    "HMEM_PATH": "C:/Users/<you>/.hmem/Agents/<AGENT>/<AGENT>.hmem"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js hook-startup",
            "shell": "powershell"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js log-exchange",
            "shell": "powershell"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "clear",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js context-inject",
            "shell": "powershell"
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/<you>/AppData/Roaming/npm/node_modules/hmem-mcp/dist/cli.js statusline",
    "shell": "powershell"
  }
}
```

Two things to notice:
- `"shell": "powershell"` on **every** hook command and on statusLine — forces native PowerShell, bypasses Git Bash entirely.
- `HMEM_PATH` lives in the top-level `env` block, **not** inline in the command. Claude Code inherits the env block to every hook subprocess, regardless of shell.

**Never use inline env-var syntax in hook commands on Windows.** `VAR=value command` is bash-only syntax and will silently break under cmd.exe or PowerShell.

## Troubleshooting matrix

| Symptom | Cause | Fix |
|---------|-------|-----|
| `UserPromptSubmit hook error` (no stacktrace) | Inline `VAR=value` in command + cmd.exe parses it as a command name | Move env vars to `env` block, remove inline prefix |
| `bash.exe: *** fatal error - add_item ... errno 1` | Git Bash MSYS2 runtime crashing at startup | Add `"shell": "powershell"` to every hook command |
| Hooks silently do nothing (no errors) | Wrong shell interpreting the command, or project not active for session logging | Verify `"shell": "powershell"`, call `load_project(id="P00XX")` every session |

**Note on `load_project` per-session:** The `active` flag on a P-entry persists in the database, but the "currently active project for session logging" is a per-session attribute. After every Claude Code restart, the agent must call `load_project(id="P00XX")` again, or exchanges will be logged to O0000 (no-project fallback) instead of the project's O-entry. Consider adding this to your project briefing or session-start routine.
