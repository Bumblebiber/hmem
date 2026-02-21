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
   → Empty → write a short summary to a LAST_CURATION.md file and terminate
   → Not empty → take the FIRST agent from the list

2. read_agent_memory(agent_name, depth=3)
   → Study all entries carefully

3. Fix every issue found:
   - L1 too long (>2 sentences)  → fix_agent_memory(agent_name, entry_id, level_1="shorter")
   - Duplicate entry              → delete_agent_memory(agent_name, weaker_entry_id)
   - Factually wrong              → delete_agent_memory, optionally write correct entry
   - Vague/useless content        → delete_agent_memory

4. mark_audited(agent_name)

5. Append one line to LAST_CURATION.md:
   "- **AGENTNAME**: N entries — [OK | fixed L0003 L1 | deleted E0002 (dup of E0001)]"

6. Terminate.
```

---

## Quality Criteria

| Check | Rule |
|-------|------|
| L1 length | Single concise sentence, ~15–20 tokens |
| L2 | Adds context, does not repeat L1 |
| Duplicates | Keep the better entry, delete the weaker |
| Prefix | P=Project L=Lesson E=Error T=Task D=Decision M=Milestone F=Favorite S=Skill (+ custom prefixes from hmem.config.json) |
| Personal limit | 300 entries max |
| Company limit | 200 entries max |

**Over limit → triage order:**
1. Delete duplicates and vague entries
2. Merge similar lessons (fix keeper, delete rest)
3. Apply access curve: delete entries that are old (>3 months) + rarely accessed (count 0–1) + generic

---

## Company Store

After processing all personal queues:

```
read_memory(store="company")
```

→ Remove outdated company entries, update clearance levels if needed.

---

## Rules

- Never invent or fabricate memories.
- Skip yourself (the curator agent) if you appear in the queue.
- One agent per run — be called again for the next agent.
- Always write to LAST_CURATION.md, even for clean runs ("OK — nothing to fix").
