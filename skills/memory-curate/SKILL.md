---
name: memory-curate
description: >
  Memory curation workflow. Use when asked to curate, audit, or clean up agent memories.
  Processes one agent at a time — read, fix, mark audited, summarize, terminate.
  Requires role: ceo.
---

# /memory-curate — hmem Curation Workflow

You are the memory curator. Process **one agent per run**, then terminate.

---

## Step-by-Step

```
1. get_audit_queue()
   → Empty → write a short summary to LAST_CURATION.md and terminate
   → Not empty → take the FIRST agent from the list

2. read_agent_memory(agent_name, depth=3)
   → Study all entries carefully

3. Fix every issue found (see criteria below)

4. mark_audited(agent_name)

5. Append one line to LAST_CURATION.md:
   "- **AGENTNAME**: N entries — [OK | fixed L0003 | deleted E0002 (dup) | consolidated P0004+P0007→P0004]"

6. Terminate.
```

---

## Quality Criteria

### L1 Quality
| Check | Rule |
|-------|------|
| Too long | Single concise sentence, ~15–20 tokens. Fix with `fix_agent_memory(agent_name, id, content="shorter")` |
| Too vague | "Fixed a bug" → delete. "SQLite failed due to wrong path in .mcp.json" → keep |
| Factually wrong | Fix content or mark obsolete. Do not silently delete unless it has zero learning value |
| Duplicate of another entry | Keep the better one, delete the weaker with `delete_agent_memory` |

### Compound Node IDs
Memory content lives in `memory_nodes` — not in flat `level_2/3` fields.
To fix an L2 or deeper node, use the compound ID: `fix_agent_memory(agent_name, "L0003.2", content="corrected text")`.
To navigate the tree: `read_memory` shows node IDs like `L0003.2`, `L0003.2.1` — use those directly.

### Obsolete entries
Entries marked `[⚠ OBSOLETE]` are known to be outdated.
They can be deleted if they have zero learning value left. If they contain a useful lesson about *why* something was wrong, keep them.

### P entries — consolidate fragmented sessions
If an agent has multiple P entries about the **same project** (e.g. 5 entries all about "hmem"), consolidate:
1. Pick the oldest or most informative entry as the **keeper**
2. `fix_agent_memory(agent_name, keeper_id, content="Updated L1 — broad project title")` if needed
3. For each fragment to merge: copy its key content into the keeper using `fix_agent_memory` on the relevant nodes if possible; otherwise accept the loss of low-value detail
4. `delete_agent_memory(agent_name, fragment_id)` for the duplicates

*Goal: one P entry per project, growing over time.*

### N entries — flag stale code pointers
Navigator entries go stale when code moves. Check: does the file/line referenced still exist?
If stale and the agent hasn't updated it: mark obsolete via `fix_agent_memory(agent_name, id, obsolete=true)`.
Do NOT fix stale N entries yourself — the agent who wrote them must verify and update.

---

## Limits

| Store | Max entries | Action when over |
|-------|-------------|-----------------|
| Personal | 300 | Triage: duplicates → low-access old entries → generic lessons |
| Company | 200 | Same |

**Triage order (over limit):**
1. Delete exact duplicates
2. Delete vague/useless entries (access_count 0, >3 months old, no learning value)
3. Consolidate fragmented P entries
4. Mark borderline entries as obsolete (let the agent decide next time)

---

## Company Store

After processing all personal queues:

```
read_memory(store="company")
```

→ Remove outdated entries, update clearance levels if needed, mark stale entries obsolete.

---

## Rules

- Never invent or fabricate memories.
- Never add new content — only delete, fix, consolidate, or mark obsolete.
- Skip yourself (the curator agent) if you appear in the queue.
- One agent per run — be called again for the next agent.
- Always write to LAST_CURATION.md, even for clean runs ("OK — nothing to fix").
