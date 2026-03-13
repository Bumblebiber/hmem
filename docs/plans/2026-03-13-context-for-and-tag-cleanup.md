# Context-For + Tag Display Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `context_for` parameter to `read_memory` that finds all entries related to a given entry via per-node weighted tag scoring + direct links, and hide tags from non-curator read output to save tokens.

**Architecture:** New `findContext()` method in hmem-store.ts does per-node tag matching with IDF-style tier weights (rare=3, medium=2, common=1). A score threshold (default 4) replaces fixed overlap counts. Bidirectional link resolution adds directly linked entries. MCP layer adds two new params (`context_for`, `min_tag_score`) and a new rendering section.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), MCP SDK, Zod

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hmem-store.ts` | Modify | Add `findContext()` method, add `contextFor`/`minTagScore` to `ReadOptions` |
| `src/mcp-server.ts` | Modify | Conditional tag display, new params, handler branch, rendering |

---

### Task 1: Hide tags from non-curator read output

**Files:**
- Modify: `src/mcp-server.ts:1563-1567` (formatTagSuffix)
- Modify: `src/mcp-server.ts:1592,1610` (formatTitlesOnly)
- Modify: `src/mcp-server.ts:1695` (renderEntryFormatted)
- Modify: `src/mcp-server.ts:1814` (related entries)
- Modify: `src/mcp-server.ts:1825` (renderChildrenFormatted)

**Approach:** The `curator` boolean already flows through all render functions. Add it as a parameter to `formatTagSuffix()` and return empty string when `curator=false`. Exception: `formatTitlesOnly()` doesn't receive `curator` currently — thread it through.

- [ ] **Step 1: Update `formatTagSuffix` signature**

```typescript
/** Format tags as a compact suffix: "  #hmem #curation" or "" if no tags. Only shown in curator mode. */
function formatTagSuffix(tags?: string[], curator: boolean = false): string {
  if (!curator || !tags || tags.length === 0) return "";
  return "  " + [...new Set(tags)].join(" ");
}
```

- [ ] **Step 2: Update `formatTitlesOnly` to accept curator param**

In `formatGroupedOutput()` (line ~1655), the call is:
```typescript
// Before:
const titlesBlock = formatTitlesOnly(entries, config);
// After:
const titlesBlock = formatTitlesOnly(entries, config, curator);
```

Update `formatTitlesOnly` signature (line ~1569):
```typescript
// Before:
function formatTitlesOnly(entries: MemoryEntry[], config: HmemConfig): string {
// After:
function formatTitlesOnly(entries: MemoryEntry[], config: HmemConfig, curator: boolean = false): string {
```

And thread curator to all `formatTagSuffix` calls inside it (lines ~1592, ~1610).

- [ ] **Step 3: Update all `formatTagSuffix` call sites**

In `renderEntryFormatted` (line ~1695):
```typescript
// Before:
const tagStr = formatTagSuffix(e.tags);
// After:
const tagStr = formatTagSuffix(e.tags, curator);
```

In related entries rendering (line ~1814):
```typescript
// Before:
lines.push(`  ${rel.id} ${rmmdd}  ${rel.title}${formatTagSuffix(rel.tags)}`);
// After:
lines.push(`  ${rel.id} ${rmmdd}  ${rel.title}${formatTagSuffix(rel.tags, curator)}`);
```

In `renderChildrenFormatted` (line ~1829):
```typescript
// Before:
const ctags = formatTagSuffix(child.tags);
// After:
const ctags = formatTagSuffix(child.tags, curator);
```

In `renderChildrenExpanded` — find all `formatTagSuffix` calls and add `curator` param. The `curator` param needs to be threaded into `renderChildrenExpanded()` as well.

- [ ] **Step 4: Compile and verify**

```bash
cd /home/bbbee/hmem && npx tsc
```

- [ ] **Step 5: Smoke test**

Kill MCP, reconnect, do a `read_memory()` — verify no tags shown. Then `read_memory(curator=true)` — verify tags appear.

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat: hide tags from non-curator read output to save tokens"
```

---

### Task 2: Add `findContext()` method to hmem-store.ts

**Files:**
- Modify: `src/hmem-store.ts:117-164` (ReadOptions interface — add contextFor, minTagScore)
- Modify: `src/hmem-store.ts` (new method after findRelatedCombined ~line 2840)

**Algorithm (per-node weighted tag scoring):**

```
1. Get source entry's node IDs: [P0029, P0029.1, P0029.2, ..., P0029.45]
2. Fetch tags per node: Map<nodeId, string[]>
3. Get global tag frequencies: Map<tag, entryCount>
4. Collect all unique source tags → query memory_tags for candidate entries sharing any
5. Group candidate tags by root_id: Map<candidateRoot, Set<tag>>
6. For each candidate:
     For each source node:
       score = Σ weight(shared_tag)  where weight = freq≤5→3, freq≤20→2, else→1
       bestScore = max(bestScore, score)
     If bestScore >= minTagScore → include candidate
7. Get bidirectional links → always include (score=9999)
8. Filter obsolete + irrelevant
9. Sort by score DESC, limit results
```

- [ ] **Step 1: Add fields to ReadOptions**

After `staleDays` in ReadOptions (line ~163):
```typescript
  /** Find all entries related to a given entry via per-node tag scoring + direct links. */
  contextFor?: string;
  /** Minimum weighted tag score for context_for matches. Default: 4. Tier weights: rare(≤5)=3, medium(6-20)=2, common(>20)=1. */
  minTagScore?: number;
```

- [ ] **Step 2: Implement `findContext()` method**

Add after `findRelatedCombined` (~line 2840):

```typescript
/**
 * Find all entries contextually related to a given entry.
 * Uses per-node weighted tag scoring: for each node of the source entry,
 * compute weighted overlap with each candidate entry's full tag set.
 * Tier weights: rare (≤5 entries) = 3, medium (6-20) = 2, common (>20) = 1.
 * A candidate matches if ANY source node scores >= minTagScore against it.
 * Bidirectional direct links are always included.
 */
findContext(
  entryId: string,
  minTagScore: number = 4,
  limit: number = 30
): { linked: MemoryEntry[]; tagRelated: { entry: MemoryEntry; score: number; matchNode: string }[] } {
  this.guardCorrupted();

  // 1. Source node IDs
  const childRows = this.db.prepare(
    "SELECT id FROM memory_nodes WHERE root_id = ?"
  ).all(entryId) as { id: string }[];
  const nodeIds = [entryId, ...childRows.map(r => r.id)];

  // 2. Tags per source node
  const nodeTagMap = this.fetchTagsBulk(nodeIds);

  // 3. All unique source tags
  const allSourceTags = new Set<string>();
  for (const tags of nodeTagMap.values()) {
    if (tags) tags.forEach(t => allSourceTags.add(t));
  }
  if (allSourceTags.size === 0 ) {
    return { linked: this.resolveDirectLinks(entryId), tagRelated: [] };
  }

  // 4. Global tag frequencies (count distinct root entries per tag)
  const freqRows = this.db.prepare(`
    SELECT tag, COUNT(DISTINCT
      CASE WHEN entry_id LIKE '%.%'
      THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
      ELSE entry_id END
    ) as freq
    FROM memory_tags GROUP BY tag
  `).all() as { tag: string; freq: number }[];
  const tagFreq = new Map<string, number>();
  for (const r of freqRows) tagFreq.set(r.tag, r.freq);

  // 5. Find candidate entries sharing any source tag
  const srcTagArr = [...allSourceTags];
  const placeholders = srcTagArr.map(() => "?").join(", ");
  const candidateRows = this.db.prepare(`
    SELECT
      CASE WHEN entry_id LIKE '%.%'
      THEN SUBSTR(entry_id, 1, INSTR(entry_id, '.') - 1)
      ELSE entry_id END as root_id,
      tag
    FROM memory_tags
    WHERE tag IN (${placeholders})
  `).all(...srcTagArr) as { root_id: string; tag: string }[];

  // 6. Group candidate tags by root_id (skip self)
  const candidateTagMap = new Map<string, Set<string>>();
  for (const r of candidateRows) {
    if (r.root_id === entryId) continue;
    let set = candidateTagMap.get(r.root_id);
    if (!set) { set = new Set(); candidateTagMap.set(r.root_id, set); }
    set.add(r.tag);
  }

  // 7. Score each candidate per source node
  const scored: { id: string; score: number; matchNode: string }[] = [];
  for (const [candidateId, candidateTags] of candidateTagMap) {
    let bestScore = 0;
    let bestNode = "";
    for (const [nodeId, nodeTags] of nodeTagMap) {
      if (!nodeTags) continue;
      let score = 0;
      for (const tag of nodeTags) {
        if (candidateTags.has(tag)) {
          const freq = tagFreq.get(tag) ?? 999;
          if (freq <= 5) score += 3;
          else if (freq <= 20) score += 2;
          else score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestNode = nodeId;
      }
    }
    if (bestScore >= minTagScore) {
      scored.push({ id: candidateId, score: bestScore, matchNode: bestNode });
    }
  }

  // Sort by score DESC
  scored.sort((a, b) => b.score - a.score);
  const topScored = scored.slice(0, limit);

  // 8. Fetch full entries, filter obsolete + irrelevant
  const tagRelated: { entry: MemoryEntry; score: number; matchNode: string }[] = [];
  for (const s of topScored) {
    const row = this.db.prepare(
      "SELECT * FROM memories WHERE id = ? AND obsolete != 1 AND irrelevant != 1"
    ).get(s.id) as any;
    if (!row) continue;
    const children = this.fetchChildren(row.id);
    const entry = this.rowToEntry(row, children);
    entry.tags = this.fetchTags(row.id);
    tagRelated.push({ entry, score: s.score, matchNode: s.matchNode });
  }

  // 9. Direct links (bidirectional)
  const linked = this.resolveDirectLinks(entryId);

  return { linked, tagRelated };
}

/** Resolve bidirectional direct links for an entry, filtering obsolete/irrelevant. */
private resolveDirectLinks(entryId: string): MemoryEntry[] {
  const linkIds = new Set<string>();

  // Forward links
  const row = this.db.prepare("SELECT links FROM memories WHERE id = ?").get(entryId) as any;
  if (row?.links) {
    try { JSON.parse(row.links).forEach((id: string) => linkIds.add(id)); } catch {}
  }

  // Reverse links: entries whose links field contains this ID
  const reverseRows = this.db.prepare(
    "SELECT id, links FROM memories WHERE links LIKE ? AND id != ?"
  ).all(`%${entryId}%`, entryId) as { id: string; links: string }[];
  for (const r of reverseRows) {
    try {
      if (JSON.parse(r.links).includes(entryId)) linkIds.add(r.id);
    } catch {}
  }

  // Fetch entries
  const results: MemoryEntry[] = [];
  for (const lid of linkIds) {
    const lr = this.db.prepare(
      "SELECT * FROM memories WHERE id = ? AND obsolete != 1 AND irrelevant != 1"
    ).get(lid) as any;
    if (!lr) continue;
    const children = this.fetchChildren(lr.id);
    const entry = this.rowToEntry(lr, children);
    entry.tags = this.fetchTags(lr.id);
    results.push(entry);
  }
  return results;
}
```

- [ ] **Step 3: Compile**

```bash
cd /home/bbbee/hmem && npx tsc
```

- [ ] **Step 4: Commit**

```bash
git add src/hmem-store.ts
git commit -m "feat: findContext() — per-node weighted tag scoring + bidirectional links"
```

---

### Task 3: Wire `context_for` into MCP read_memory tool

**Files:**
- Modify: `src/mcp-server.ts` (Zod schema ~line 625, handler ~line 628, rendering)

- [ ] **Step 1: Add Zod parameters**

After `stale_days` param in the read_memory schema:
```typescript
    context_for: z.string().optional().describe(
      "Load full context for an entry: the entry itself (expanded) + all related entries. " +
      "Related = directly linked OR sharing weighted tag overlap with any node of the source. " +
      "Tag weights: rare(<=5 uses)=3, medium(6-20)=2, common(>20)=1. " +
      "Example: read_memory({ context_for: 'P0029' }) — loads P0029 + all contextually related entries."
    ),
    min_tag_score: z.number().optional().describe(
      "Minimum weighted tag score for context_for matches (default: 4). " +
      "Score 4 = e.g. 2 medium tags, or 1 rare + 1 common. Lower = more results, higher = stricter."
    ),
```

- [ ] **Step 2: Add to handler destructuring**

```typescript
async ({ id, depth, prefix, ..., stale_days, context_for, min_tag_score }) => {
```

- [ ] **Step 3: Add handler branch (before bulk listing logic)**

After the stale_days handler and before the main `isBulkListing` dispatch, add:

```typescript
    // Context-for: load source entry expanded + all related entries
    if (context_for) {
      const sourceEntries = hmemStore.read({
        id: context_for,
        expand: true,
        agentRole: effectiveRole,
      });
      if (sourceEntries.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Entry not found: ${context_for}` }],
          isError: true,
        };
      }
      const source = sourceEntries[0];
      hmemStore.assignBulkTags([source]);

      const { linked, tagRelated } = hmemStore.findContext(
        context_for,
        min_tag_score ?? 4,
        maxResults ?? 30
      );

      // Render
      const lines: string[] = [];
      const totalRelated = linked.length + tagRelated.length;
      lines.push(`## Context for ${context_for}: ${source.title} (${totalRelated} related entries)\n`);

      // Source entry (expanded)
      lines.push("### Source entry\n");
      renderEntryFormatted(lines, source, curator ?? false, true);
      lines.push("");

      // Direct links
      if (linked.length > 0) {
        lines.push(`### Directly linked (${linked.length})\n`);
        for (const e of linked) {
          renderEntryFormatted(lines, e, curator ?? false);
        }
        lines.push("");
      }

      // Tag-related
      if (tagRelated.length > 0) {
        lines.push(`### Tag-related (${tagRelated.length} entries, score >= ${min_tag_score ?? 4})\n`);
        for (const { entry, score, matchNode } of tagRelated) {
          // Skip entries already shown as direct links
          if (linked.some(l => l.id === entry.id)) continue;
          const scoreInfo = curator ? ` [score=${score} via ${matchNode}]` : "";
          renderEntryFormatted(lines, entry, curator ?? false);
          if (scoreInfo) lines.push(`  ${scoreInfo}`);
        }
      }

      const output = lines.join("\n");
      return {
        content: [{ type: "text" as const, text: output }],
      };
    }
```

- [ ] **Step 4: Make `assignBulkTags` public**

In hmem-store.ts, change:
```typescript
// Before:
private assignBulkTags(entries: MemoryEntry[]): void {
// After:
assignBulkTags(entries: MemoryEntry[]): void {
```

- [ ] **Step 5: Compile**

```bash
cd /home/bbbee/hmem && npx tsc
```

- [ ] **Step 6: Smoke test**

Kill MCP, reconnect, test:
```
read_memory({ context_for: "P0029" })
read_memory({ context_for: "P0029", min_tag_score: 6 })
read_memory({ context_for: "P0029", curator: true })
```

Verify:
- Source entry shown expanded
- Direct links shown
- Tag-related entries shown with reasonable relevance
- No obsolete/irrelevant entries leak through
- Curator mode shows tags + scores

- [ ] **Step 7: Commit**

```bash
git add src/hmem-store.ts src/mcp-server.ts
git commit -m "feat: context_for parameter — load entry + all related via weighted tag scoring"
```

---

### Task 4: Version bump + publish

- [ ] **Step 1: Bump version**

In `package.json`:
```json
"version": "2.7.0"
```

- [ ] **Step 2: Commit, push, publish**

```bash
cd /home/bbbee/hmem
git add -A
git commit -m "chore: bump to v2.7.0 (context_for + tag display cleanup)"
git push
npm publish
```

---

## Design Notes

**Why per-node matching (not union)?**
Union-matching would let a candidate score high by matching one tag from node A and another from node B — a weak, coincidental connection. Per-node matching requires concentrated overlap with a single thematic unit.

**Why score threshold instead of count?**
Two rare tags (#nachkalkulation + #fleetboard, both ≤5 entries) scoring 6 is much more meaningful than three common tags (#hmem + #bug + #performance) scoring 3. The threshold captures semantic relevance better.

**Why bidirectional links?**
Entry A linking to B doesn't mean B links back. Both directions are intentional connections and should be surfaced.

**Token impact:**
- Tag removal from non-curator reads: saves ~500-800 tokens per bulk read
- context_for replaces 3-4 manual read_memory calls with one, reducing round-trips
