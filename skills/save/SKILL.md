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

## Step 1 — Write Memory

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
