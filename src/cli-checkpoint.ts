/**
 * cli-checkpoint.ts
 *
 * Automatic checkpoint: reads recent exchanges from the active O-entry,
 * then spawns a Haiku subagent WITH MCP tool access that writes L/D/E entries
 * and updates the project handoff. The subagent follows the hmem-write skill rules.
 *
 * Designed to run in the background (spawned by the Stop hook when checkpointMode is "auto").
 *
 * Usage: hmem checkpoint
 *
 * Requires env:
 *   HMEM_PATH        — path to .hmem file (auto-detected)
 *   HMEM_PROJECT_DIR — directory for config + company.hmem
 */

import fs from "node:fs";
import path from "node:path";
import { HmemStore } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { currentSessionId } from "./session-state.js";
import { runCheckpointAgent } from "./cli-checkpoint-agent.js";

export async function checkpoint(): Promise<void> {
  const projectDir = process.env.HMEM_PROJECT_DIR;
  if (!projectDir) process.exit(0);

  const hmemPath = process.env.HMEM_PATH!;
  if (!fs.existsSync(hmemPath)) process.exit(0);

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  try {
    // 1. Get active project and its O-entry. Tries in order:
    //    (a) HMEM_ACTIVE_PROJECT env (set by log-exchange when it knows the project)
    //    (b) getActiveProject(currentSessionId) — session marker → DB active=1 flag
    //    (c) getMostRecentlyActiveProject() — newest O-entry exchange (heuristic)
    // The previous "silent return on null" hid genuine misrouted exchanges; loud
    // logging + a heuristic fallback prevents the multi-device "session-marker stripped
    // but exchanges still arrive" failure mode.
    const envProjectId = process.env.HMEM_ACTIVE_PROJECT;
    let activeProject = envProjectId
      ? store.getProjectById(envProjectId)
      : store.getActiveProject(currentSessionId());

    if (!activeProject) {
      const recent = store.getMostRecentlyActiveProject();
      if (recent) {
        activeProject = recent;
        console.error(`[hmem checkpoint] No active-project marker — falling back to most recent O-entry activity: ${recent.id}`);
      }
    }

    if (!activeProject) {
      console.error(
        "[hmem checkpoint] No active project found. Tried: " +
        `env(HMEM_ACTIVE_PROJECT)=${envProjectId ?? "(unset)"}, ` +
        `session-marker(sessionId=${currentSessionId() ?? "(none)"})=miss, ` +
        "DB active=1 flag=miss, recent O-entry activity=none. " +
        "Skipping checkpoint — exchanges will accumulate without summary until a project is activated."
      );
      return;
    }

    const projectSeq = parseInt(activeProject.id.replace(/\D/g, ""), 10);
    const oId = store.resolveProjectO(projectSeq);

    // 2. Find the latest full batch (L3 with >= batchSize L4 children)
    const batchSize = config.checkpointInterval || 5;
    const latestFullBatch = store.getLatestFullBatch(oId, batchSize);

    // Determine current session node to exclude from orphan search
    const latestSession = store.getChildNodes(oId)
      .filter(n => n.depth === 2)
      .sort((a, b) => b.seq - a.seq)[0];
    const currentSessionNodeId = latestFullBatch?.sessionId ?? latestSession?.id ?? null;

    // Find orphaned batches from previous sessions that never got summarized.
    // cap=5: catch up backlog without exceeding context budget (~5KB per batch after truncation).
    const orphanedBatches = store.getOrphanedBatches(oId, currentSessionNodeId);

    if (!latestFullBatch && orphanedBatches.length === 0) return;

    // Build orphan section text once — used by both the orphan-only path
    // (when no full batch) and the normal path (as Section 0b alongside the latest batch).
    // Side effect: tags #skill-dialog on matching exchanges.
    const orphanSections = orphanedBatches.map((ob, i) => {
      const exs = store.getOEntryExchangesV2(oId, 20, { sessionScope: [ob.sessionId] });
      const batchExs = exs.filter(ex => ex.nodeId.startsWith(ob.batchId + "."));
      if (batchExs.length === 0) return null;

      const formatted = batchExs.map((ex, j) => {
        let user = ex.userText.replace(/<channel[^>]*>\s*/g, "").replace(/<\/channel>\s*/g, "").trim();
        let agent = (ex.agentText ?? "").replace(/<[^>]+>/g, "").trim();
        user = user.length > 800 ? user.substring(0, 800) + "..." : user;
        agent = agent.length > 1200 ? agent.substring(0, 1200) + "..." : agent;
        return `--- Exchange ${j + 1} (${ex.nodeId}) ---\nUSER: ${user}\nAGENT: ${agent}`;
      }).join("\n\n");

      const listing = batchExs.map(ex => `  ${ex.nodeId}: "${ex.title}"`).join("\n");

      for (const ex of batchExs) {
        if (ex.userText.includes("Base directory for this skill:")) {
          store.addTag(ex.nodeId, "#skill-dialog");
        }
      }

      return `=== Orphan Batch ${i + 1}: ${ob.batchId} | Session ${ob.sessionId} (${ob.sessionDate}) — "${ob.sessionTitle}" ===
Current exchange titles:
${listing}

${formatted}`;
    }).filter((s): s is string => s !== null);

    // Orphan-only path: no full batch but orphaned batches exist
    if (!latestFullBatch) {
      const pName = activeProject.title.split("|")[0].trim();
      const pId = activeProject.id;
      const pList = store.listProjects().map(p => `  ${p.id} ${p.title}`).join("\n");

      if (orphanSections.length === 0) return;

      const orphanPrompt = `You are a checkpoint agent for "${pName}" (${pId}).
Process ${orphanSections.length} orphaned batch(es) — prior sessions too short for a regular checkpoint.

== All Projects ==
${pList}

${orphanSections.join("\n\n")}

## Tasks for EACH batch above (Tasks 1, 2, 5, 6 only):

### 1. Title each exchange
For each: update_memory(id="<nodeId>", content="Descriptive title, max 50 chars, match conversation language")
GOOD: "Fix: cleanTitle strips separators" | BAD: "Projekt laden" or "ok"

### 2. Write rolling summary for each batch
update_memory(id="<batchId>", content="Summary: 2-5 sentences covering this batch. Match conversation language.")

### 5. Tag exchanges
For each exchange, add ONE tag if applicable: #skill-dialog, #irrelevant, #planning, #debugging, #admin, #meta, #repetition

### 6. Update each session title and summary
update_memory(id="<sessionId>", content="Short session title, max 60 chars\\n> 2-5 sentences. Key decisions, outcomes. Written for someone picking up cold.")

## Rules:
- Match language of existing entries
- Tags: lowercase with #
- Do NOT extract L/E/D entries (skip Task 3)
- Do NOT update P-entry (skip Task 4)`;

      await runCheckpointAgent(orphanPrompt, store, config);
      console.log(`[hmem checkpoint] Orphan batches processed: ${orphanSections.length} (${config.checkpointProvider}/${config.checkpointModel})`);
      return;
    }

    const batchId = latestFullBatch.id;
    const sessionId = latestFullBatch.sessionId;

    // 3. Get exchanges from this batch
    const allExchanges = store.getOEntryExchangesV2(oId, batchSize * 3);
    const batchExchanges = allExchanges.filter(ex => ex.nodeId.startsWith(batchId + "."));
    if (batchExchanges.length < 2) return;

    // 3b. Find sessions that never got summarized (too short for a full batch)
    const allSessions = store.getChildNodes(oId)
      .filter(n => n.depth === 2)
      .sort((a, b) => a.seq - b.seq);
    const catchupSessions = allSessions
      .filter(s => s.id !== sessionId && (!s.content || s.content === s.title))
      .slice(-3)
      .map(session => {
        const exs = store.getOEntryExchangesV2(oId, 5, { sessionScope: [session.id] });
        const lines = exs
          .filter(ex => ex.userText || ex.agentText)
          .map((ex, i) => {
            let u = ex.userText.replace(/<channel[^>]*>\s*/g, "").replace(/<\/channel>\s*/g, "").trim();
            let a = (ex.agentText ?? "").replace(/<[^>]+>/g, "").trim();
            u = u.length > 300 ? u.substring(0, 300) + "…" : u;
            a = a.length > 500 ? a.substring(0, 500) + "…" : a;
            return `  [${i + 1}] USER: ${u}\n      AGENT: ${a}`;
          });
        return lines.length > 0
          ? { id: session.id, date: session.created_at.substring(0, 10), title: session.title, body: lines.join("\n") }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    // 4. Tag skill-dialog exchanges
    const skillMarker = "Base directory for this skill:";
    for (const ex of batchExchanges) {
      if (ex.userText.includes(skillMarker)) {
        store.addTag(ex.nodeId, "#skill-dialog");
      }
    }

    // 5. Get previous batch's rolling summary
    const prevBatch = store.getPreviousBatch(sessionId, batchId);

    // 6. Get all P-entry titles
    const allProjects = store.listProjects();

    const projectName = activeProject.title.split("|")[0].trim();
    const projectId = activeProject.id;

    // 7. Build prompt

    const formattedExchanges = batchExchanges.map((ex, i) => {
      // Strip XML channel tags from Telegram messages before passing to Haiku
      let user = ex.userText.replace(/<channel[^>]*>\s*/g, "").replace(/<\/channel>\s*/g, "").trim();
      let agent = ex.agentText.replace(/<[^>]+>/g, "").trim();
      user = user.length > 800 ? user.substring(0, 800) + "..." : user;
      agent = agent.length > 1200 ? agent.substring(0, 1200) + "..." : agent;
      return `--- Exchange ${i + 1} (${ex.nodeId}) ---\nUSER: ${user}\nAGENT: ${agent}`;
    }).join("\n\n");

    const projectList = allProjects.map(p => `  ${p.id} ${p.title}`).join("\n");

    const prevSummaryText = prevBatch && prevBatch.content !== prevBatch.title
      ? `\n## Previous batch rolling summary:\n${prevBatch.content}\n`
      : "";

    const exchangeListing = batchExchanges.map(ex =>
      `  ${ex.nodeId}: "${ex.title}"`
    ).join("\n");

    // Build P-entry section routing table from config (falls back to names-only if no descriptions)
    const pSchema = config.schemas?.P?.sections ?? [];
    const sectionRouting = pSchema.length > 0
      ? pSchema.map((s, i) => {
          const idx = i + 1;
          const desc = s.description ? ` — ${s.description}` : "";
          const policy = s.checkpointPolicy === "readonly" ? " [READONLY — do not write]"
            : s.checkpointPolicy === "pointer" ? " [POINTER ONLY — e.g. → E00XX Title]"
            : "";
          return `  .${idx} ${s.name}${desc}${policy}`;
        }).join("\n")
      : "  (no schema configured — use standard L2 structure)";

    const readonlySections = pSchema
      .map((s, i) => ({ ...s, idx: i + 1 }))
      .filter(s => s.checkpointPolicy === "readonly")
      .map(s => `${projectId}.${s.idx} (${s.name})`)
      .join(", ");

    const catchupSection = catchupSessions.length > 0
      ? `### 0. Catch up on unsummarized sessions
${catchupSessions.length} prior session(s) completed without a summary. Write a brief summary for each.
Call: update_memory(id="<id>", content="Short title\\n> 2-5 sentences. Skip if no meaningful content.")

${catchupSessions.map(d => `Session ${d.id} (${d.date}) — "${d.title}":\n${d.body}`).join("\n\n")}

`
      : "";

    // Section 0b: orphan batches from previous sessions that never got summarized.
    // Applies Tasks 1, 2, 5 to each (title, batch summary, tag) — NOT P-entry updates or knowledge extraction.
    const orphanCatchupSection = orphanSections.length > 0
      ? `### 0b. Catch up unsummarized batches from past sessions
${orphanSections.length} prior batch(es) were never summarized — likely because a newer full batch arrived first. Apply Tasks 1, 2, and 5 to EACH batch below (titles, rolling summary on the batch node, exchange tags). Do NOT extract L/E/D entries from orphans (Task 3) and do NOT update the P-entry (Task 4) from them.

${orphanSections.join("\n\n")}

`
      : "";

    const prompt = `You are a checkpoint agent for "${projectName}" (${projectId}).
Process batch ${batchId} with ${batchExchanges.length} exchanges.

== All Projects ==
${projectList}

== Active Project ==
${projectId} ${projectName}
${prevSummaryText}
== Batch Exchanges ==
${formattedExchanges}

${catchupSection}${orphanCatchupSection}## Tasks (execute ALL in order):

### 1. Title each exchange (REQUIRED)
Current titles (auto-extracted):
${exchangeListing}

For each: update_memory(id="<nodeId>", content="Descriptive title, max 50 chars, match conversation language")

CRITICAL title rules:
- Describe WHAT HAPPENED or WHAT WAS DECIDED, not what was said
- BAD: "Projekt hmem laden" (just repeats user message)
- BAD: "Ja" or "Reconnected" (meaningless)
- GOOD: "Load hmem project, evaluate output quality"
- GOOD: "Fix: cleanTitle strips body separators from titles"
- If the exchange is trivial (greeting, "ok", "yes"), title it as context: "Confirm: proceed with commit"

### 2. Write rolling summary for this batch
update_memory(id="${batchId}", content="Rolling summary: 3-8 sentences covering this batch${prevBatch ? " + previous summary" : ""}. Match conversation language.")
${prevBatch ? "IMPORTANT: Incorporate the previous batch summary — your new summary is cumulative." : "This is the first batch."}

### 3. Extract knowledge (STRICT quality gate — max 1-2)
write_memory(prefix="<any prefix>", content="Concise insight title\n> 2-4 sentence explanation with specific details", tags=[3-5 tags], links=["${projectId}", "${batchId}"])
Valid prefixes: L (lesson), E (error), D (decision), R (rule), C (convention).

Quality gate — SKIP unless the entry passes ALL checks:
- Would a developer find this useful 6 months from now? If not, skip.
- Is it a specific, actionable insight? Vague observations are NOT lessons.
- Does it already exist in memory? Do NOT duplicate known information.
- NEVER write test entries, placeholder entries, or "delete me" entries.
- When in doubt, skip. Writing nothing is better than writing noise.

### 4. Update project P-entry
DEFAULT: do NOT update the P-entry. Skip this task unless the batch contains a concrete, specific outcome that shipped, was fixed, or was definitively decided.

Discussion, planning, brainstorming, and "made progress" batches → skip entirely.

${readonlySections ? `PROTECTED — never write to: ${readonlySections}` : ""}

P-entry section policies:
${sectionRouting}

When you do update, follow these rules strictly:

**Body before children.** Before creating a child node, ask: does this content fit in 3 lines of the parent's body? If yes, put it in the body — do not create a child. Create a child node ONLY when the content is complete, self-contained, and too long for the parent body.

**One topic = one node.** If you'd create 3-4 child nodes about the same topic, write them as body text of a single node instead. Never fragment a single decision or feature into multiple small children.

**Append, don't fragment.** Add new items as L3 children of existing L2 sections — never create new L2 siblings.
  - Correct: append_memory(id="${projectId}.6", content="Bug title\\n> Details")
  - Wrong: write_memory or append_memory(id="${projectId}") creating a second section

**.6 Bugs ↔ E-entries.** If Task #3 already wrote an E-entry, add only a pointer in .6: "→ E00XX Title". No duplication.

**.8 Roadmap completion.** Task done → prefix title with "✓ DONE:". Don't delete.

Max 1 P-entry change per batch. When uncertain, skip — false additions are harder to fix than missing ones.

### 5. Tag exchanges
For each exchange, consider adding ONE tag if applicable:
- #skill-dialog: Skill output (brainstorming, TDD, etc.)
- #irrelevant: No value (greetings, "ok", typo corrections)
- #planning: Design/architecture discussion
- #debugging: Bug hunting/fixing
- #admin: Setup, config, infra work
- #meta: Discussion ABOUT the project's tooling/memory/config, not actual project work (e.g. hmem config, sync issues, memory curation, entry cleanup)
- #repetition: User repeating something already known/stored — redundant exchange, don't include in summary

### 6. Update session ${sessionId} — title AND summary
update_memory(id="${sessionId}", content="Short session title, max 60 chars\n> Cumulative session summary: 3-10 sentences covering ALL batches so far. Key decisions, outcomes, what changed, what's next. This is what load_project shows — make it count.")

### 7. Project relevance check
Do ALL exchanges belong to ${projectName}?
Check against the project list above. If an exchange belongs elsewhere, call:
move_nodes(node_ids=["<exchange_id>"], target_o_id="O00XX")

### 8. Update O-entry project state (${oId})
1. read_memory(id="${oId}") — read the CURRENT body first
2. Synthesize: keep what's still true, drop what's outdated, add what changed this session
3. update_memory(id="${oId}", content="<fresh replacement, max 4 sentences>")

The result must be a REPLACEMENT, not an addition. Cap at 4 sentences total regardless of how much is in the old body.
Content: current project status, what just shipped/changed, top open item or next step.
Written for someone picking up cold — concrete specifics, no jargon.
Skip if this session was purely admin/infra with no meaningful project-level change.
This body is injected verbatim into every load_project briefing.

## Rules:
- read_memory() FIRST to see current state
- Match language of existing entries
- Tags: 3-5 per entry, lowercase with #
- Only save what's valuable in 6 months`;

    // 8. Run checkpoint agent (actual provider chosen by runCheckpointAgent based on harness — see its diagnostic logs)
    await runCheckpointAgent(prompt, store, config, hmemPath);
    console.log(`[hmem checkpoint] Done (batch ${batchId}, ${batchExchanges.length} exchanges)`);

  } catch (e) {
    console.error(`[hmem checkpoint] ${e}`);
  } finally {
    try { store.close(); } catch {}
  }
}
