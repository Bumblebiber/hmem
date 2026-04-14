# Windows Hook Troubleshooting

Two specific issues break hooks on Windows. Always run these checks when updating on Windows.

## Check 1 — `shell: powershell` present on every hook command?

Each object in `hooks.*.hooks` and the `statusLine` object must contain `"shell": "powershell"`. Without it, Claude Code may route the command through Git Bash, whose MSYS2 runtime crashes transiently at startup (`bash.exe: *** fatal error - add_item ... errno 1`) before the command is even parsed. Every hook then fails with a generic error.

## Check 2 — No inline env-var syntax in commands?

Commands must NOT contain `VAR=value` prefixes like `HMEM_PATH=C:/... node ...`. That is bash-only syntax; cmd.exe and PowerShell interpret `HMEM_PATH=...` as the command name and fail. All env vars must live in the top-level `env` block of settings.json.

## Correct Windows shape

```json
{
  "env": {
    "HMEM_PATH": "C:/Users/<you>/.hmem/Agents/<AGENT>/<AGENT>.hmem"
  },
  "hooks": {
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
    ]
  }
}
```

## Remediation

If either check fails, offer to fix settings.json automatically. The fix is lossless on other platforms, so it is safe to apply even on shared configs synced across OSes. Point the user to the Windows hook section in `/hmem-config` for the full pattern (UserPromptSubmit, Stop, SessionStart, statusLine).

After fixing, Claude Code must be restarted so the `env` block is re-loaded and hooks are re-registered with the new shell.
