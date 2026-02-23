---
name: save
description: >
  End-of-session save routine. Use when the user types /save or asks to
  "save", "save session", or "save progress".
  Saves session learnings to memory via write_memory, commits git changes,
  then compacts the conversation context.
---

# Save Session

Execute these steps in order. Report results after all complete.

## Step 0 — First-time setup check

Before saving, verify that hmem is ready.

**Check 1: Is write_memory available?**

Try calling `write_memory` (or check if the tool exists in your tool list).

If `write_memory` is NOT available:
- Tell the user: "The hmem MCP server is not connected. Run `npx hmem-mcp init` in your terminal to set it up, then restart your AI tool."
- **STOP. Do not continue.**

**Check 2: Does a memory file exist?**

Call `read_memory()`. If it returns entries → memory exists, skip to Step 1.

If `read_memory()` returns an **empty memory** (no entries at all) for the first time, this is likely a fresh setup. Ask the user:

> "No memory found yet. Where should hmem store your memories?
> 1) Global — works in any directory (`~/.hmem/`)
> 2) Project-local — only in this directory (current folder)
>
> Recommendation: Global for personal assistants. Project-local for team projects."

After the user chooses, walk them through the config setup:

> "Let me set up your `hmem.config.json`. I'll explain each setting — press Enter to accept the recommendation or type a new value."

Go through these parameters one by one:

| Parameter | Recommendation | Question to ask |
|-----------|---------------|-----------------|
| `maxL1Chars` | 120 | "How long should memory summaries be? (60–200 characters — shorter loads faster at startup)" |
| `maxDepth` | 5 | "How many detail levels do you want? (2–5 — 5 gives the most flexibility)" |
| `recentDepthTiers` | [{count:10,depth:2},{count:3,depth:3}] | "Auto-expand recent entries? This shows extra detail for your newest memories without extra tool calls. Recommended: yes" |
| `prefixes` | default | "Do you want custom memory categories beyond the defaults (P/L/E/D/M/S/F/T)? If yes, name them (e.g. R=Research, B=Bookmark). Otherwise press Enter." |

Write the resulting `hmem.config.json` to the chosen directory.
Tell the user: "Config saved to `<path>/hmem.config.json`. You can adjust settings anytime with `/hmem-config`."

## Step 1 — Write Memory

**IMPORTANT:** You MUST use the `write_memory` MCP tool. NEVER write directly to `.hmem` files via sqlite3 or shell commands — this bypasses WAL journaling, integrity checks, and tree logic, causing corruption or data loss.

Your L1 memory summaries are already in your context (injected at session start).
**Check them first** — do not re-write anything that already exists.

Only write what is **new since the last `/save` or session start**:

| Prefix | When to use |
|--------|-------------|
| `P` | What was worked on this session — decisions made, outcome |
| `L` | Lessons learned applicable beyond this session |
| `E` | Error patterns — root cause + fix |
| `D` | Architectural or design decisions |

Quality over quantity. Skip trivial things and anything already captured.

**Example calls:**

```
write_memory(prefix="P", content="Implemented auth flow with JWT
	Chose short-lived access tokens + refresh token rotation
	Decision: store refresh tokens in httpOnly cookie, not localStorage")

write_memory(prefix="L", content="Always restart MCP server after recompiling TypeScript
	Running process holds the old dist — tool calls return stale results otherwise")

write_memory(prefix="E", content="write_memory returned HMEM_PROJECT_DIR not set
	Cause: relative path in .mcp.json env — must be absolute
	Fix: replace with full absolute path, restart AI tool")
```

## Step 2 — Commit & Push

If in a git repository:

```bash
git add -A
git commit -m "concise imperative summary of this session's changes"
git push
```

Skip if there are no changes or no git repo.

## Step 3 — Compact (Claude only)

If you are running on **Claude** (Claude Code, claude.ai): run `/compact` to compress the conversation context. The next interaction starts fresh with your updated memories already loaded.

If you are running on **Gemini CLI, OpenCode, or another tool**: skip this step — `/compact` is a Claude-specific command.
