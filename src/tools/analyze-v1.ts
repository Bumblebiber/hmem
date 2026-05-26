/**
 * analyze-v1.ts — Phase 0 read-only decomposition spike (throwaway-ok).
 *
 * Reports the v1 .hmem shape the v2 migrator must consume, and VERIFIES the
 * "deepest node = raw exchange" assumption on real data before Phase 3 codes
 * the O-entry decomposition. Operates on the SQLite operational store
 * (memories + memory_nodes), matching what the migrator reads.
 *
 * Run:  node --experimental-strip-types src/tools/analyze-v1.ts [fixture.hmem]
 *       (default fixture: /tmp/v1-sqlite-fixture.hmem)
 */
import Database from "better-sqlite3";

const fixture = process.argv[2] ?? "/tmp/v1-sqlite-fixture.hmem";
const db = new Database(fixture, { readonly: true });
// deno-lint-ignore no-explicit-any
const all = (sql: string, ...p: unknown[]): any[] => db.prepare(sql).all(...p);
const one = (sql: string, ...p: unknown[]): any => db.prepare(sql).get(...p);
const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);
const snip = (s: string, n = 90) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

console.log(`# v1 → v2 decomposition analysis\n# fixture: ${fixture}\n# generated: ${new Date().toISOString()}`);

// ── 1. Per-prefix census ────────────────────────────────────────────────────
section("1. PER-PREFIX CENSUS");
const census = all("SELECT prefix, COUNT(*) c FROM memories GROUP BY prefix ORDER BY c DESC");
for (const r of census) console.log(`  ${String(r.prefix).padEnd(3)} ${r.c}`);
const totalRoots = one("SELECT COUNT(*) c FROM memories").c;
const totalNodes = one("SELECT COUNT(*) c FROM memory_nodes").c;
console.log(`  ── total roots=${totalRoots}  sub-nodes=${totalNodes}`);
const fRoots = all("SELECT id, coalesce(title,level_1,'') t FROM memories WHERE prefix='F' ORDER BY seq");
console.log(`\n  F-class (undocumented prefix — FF tombstones, ${fRoots.length}):`);
for (const r of fRoots) console.log(`    ${r.id}  "${snip(r.t, 60)}"`);

// ── 2. Global node depth ─────────────────────────────────────────────────────
section("2. NODE DEPTH (global)");
console.log(`  max depth observed = ${one("SELECT MAX(depth) d FROM memory_nodes").d}`);
for (const r of all("SELECT depth, COUNT(*) c FROM memory_nodes GROUP BY depth ORDER BY depth"))
  console.log(`  depth ${r.depth}: ${r.c}`);

// ── 3. O-root decomposition ──────────────────────────────────────────────────
section("3. O-ROOT DECOMPOSITION (the 75% to move into `events`)");
const oRoots = all("SELECT id, seq, coalesce(title,level_1,'') t, links FROM memories WHERE prefix='O' ORDER BY seq");
let oNodeTotal = 0, ragged = 0, sessionShaped = 0;
console.log("  id       seq  nodes  chunks  loneChunks  depthHist          shape");
for (const o of oRoots) {
  const nodes = one("SELECT COUNT(*) c FROM memory_nodes WHERE root_id=?", o.id).c;
  oNodeTotal += nodes;
  const hist = all("SELECT depth, COUNT(*) c FROM memory_nodes WHERE root_id=? GROUP BY depth ORDER BY depth", o.id)
    .map((d: any) => `${d.depth}:${d.c}`).join(",");
  const chunks = one("SELECT COUNT(*) c FROM memory_nodes WHERE root_id=? AND depth=2", o.id).c;
  // lone chunk = depth-2 node with no direct children = single-exchange (D0137 "ragged")
  const lone = one(
    "SELECT COUNT(*) c FROM memory_nodes d2 WHERE d2.root_id=? AND d2.depth=2 " +
    "AND NOT EXISTS (SELECT 1 FROM memory_nodes ch WHERE ch.parent_id=d2.id)", o.id).c;
  const shape = chunks > 0 && lone / chunks > 0.5 ? "RAGGED" : "session";
  if (shape === "RAGGED") ragged++; else sessionShaped++;
  console.log(
    `  ${o.id.padEnd(8)} ${String(o.seq).padStart(3)} ${String(nodes).padStart(6)} ` +
    `${String(chunks).padStart(7)} ${String(lone).padStart(11)}  ${hist.padEnd(18)} ${shape}  "${snip(o.t, 30)}"`);
}
console.log(`\n  O-roots: ${oRoots.length}  |  session-shaped: ${sessionShaped}  ragged: ${ragged}`);
console.log(`  total sub-nodes under O-roots: ${oNodeTotal} (${(oNodeTotal / totalNodes * 100).toFixed(1)}% of all nodes)`);
const oDeep = all(
  "SELECT depth, COUNT(*) c FROM memory_nodes WHERE root_id IN (SELECT id FROM memories WHERE prefix='O') GROUP BY depth ORDER BY depth");
console.log(`  by depth: ${oDeep.map((d: any) => `${d.depth}:${d.c}`).join(" ")}`);

// ── 4. L5-IS-RAW VERIFICATION (blocking for Phase 3 boundary rule) ───────────
section("4. L5-IS-RAW VERIFICATION — sample chunk level→text chains");
console.log("Expectation: depth-2 = short session summary; deepest = long raw exchange text.\n");
for (const rootId of ["O0048", "O0054", "O0000"]) {
  const md = one("SELECT MAX(depth) d FROM memory_nodes WHERE root_id=?", rootId)?.d;
  if (!md) { console.log(`  [${rootId}] no nodes\n`); continue; }
  const leaf = one("SELECT id FROM memory_nodes WHERE root_id=? AND depth=? LIMIT 1", rootId, md);
  console.log(`  --- ${rootId} (max depth ${md}) sample chain ---`);
  let cur: any = one("SELECT id,parent_id,depth,coalesce(title,'') t,coalesce(content,'') c FROM memory_nodes WHERE id=?", leaf.id);
  const chain: any[] = [];
  while (cur) {
    chain.unshift(cur);
    if (!cur.parent_id) break;
    cur = one("SELECT id,parent_id,depth,coalesce(title,'') t,coalesce(content,'') c FROM memory_nodes WHERE id=?", cur.parent_id);
  }
  for (const n of chain)
    console.log(`    d${n.depth} titleLen=${String(n.t.length).padStart(3)} contentLen=${String(n.c.length).padStart(5)}  "${snip(n.c || n.t, 80)}"`);
  console.log();
}

// ── 5. In-prose O-id references in NON-O bodies → o_redirects workload ────────
section("5. IN-PROSE O-REFS IN NON-O BODIES (o_redirects workload)");
const oRefRe = /O\d{4}(?:\.\d+)*/g;
const refs = new Map<string, number>();
const addRefs = (txt: string) => { for (const m of (txt ?? "").matchAll(oRefRe)) refs.set(m[0], (refs.get(m[0]) ?? 0) + 1); };
for (const r of all(
  "SELECT coalesce(level_1,'')||' '||coalesce(level_2,'')||' '||coalesce(level_3,'')||' '||" +
  "coalesce(level_4,'')||' '||coalesce(level_5,'')||' '||coalesce(title,'') txt FROM memories WHERE prefix!='O'")) addRefs(r.txt);
for (const r of all(
  "SELECT coalesce(mn.content,'')||' '||coalesce(mn.title,'') txt FROM memory_nodes mn " +
  "JOIN memories m ON mn.root_id=m.id WHERE m.prefix!='O'")) addRefs(r.txt);
const totalOcc = [...refs.values()].reduce((a, b) => a + b, 0);
console.log(`  distinct O-ids referenced in prose: ${refs.size}  |  total occurrences: ${totalOcc}`);
console.log("  top 15 (id × count):");
for (const [id, c] of [...refs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${id.padEnd(14)} ${c}`);

// ── 6. Link resolution (pre-existing dangling refs) ──────────────────────────
section("6. LINK-COLUMN RESOLUTION (pre-existing dangling)");
// In v1 a node's id IS its dotted path ("O0048.1.1", parent_id="O0048.1"),
// and roots are ids like "P0048". So a ref resolves iff it exists as an
// entry id or a node id — no seq-walk needed, the id is the path.
const idSet = new Set<string>([
  ...all("SELECT id FROM memories").map((r: any) => r.id),
  ...all("SELECT id FROM memory_nodes").map((r: any) => r.id),
]);
const resolves = (ref: string): boolean => idSet.has(ref);
const parseLinks = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
let linkTotal = 0;
const dangling: string[] = [];
for (const r of all("SELECT id, links FROM memories WHERE links IS NOT NULL AND links NOT IN ('','[]')"))
  for (const ref of parseLinks(r.links)) { linkTotal++; if (!resolves(ref)) dangling.push(`${r.id} → ${ref}`); }
for (const r of all("SELECT id, links FROM memory_nodes WHERE links IS NOT NULL AND links NOT IN ('','[]')"))
  for (const ref of parseLinks(r.links)) { linkTotal++; if (!resolves(ref)) dangling.push(`${r.id} → ${ref}`); }
console.log(`  total link refs: ${linkTotal}  |  dangling: ${dangling.length}`);
for (const d of dangling.slice(0, 30)) console.log(`    DANGLING  ${d}`);
if (dangling.length > 30) console.log(`    … +${dangling.length - 30} more`);

db.close();
console.log("\n# done");
