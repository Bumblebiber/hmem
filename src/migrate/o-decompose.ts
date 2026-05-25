import Database from 'better-sqlite3';
import { newUlid } from '../store/ulid.js';
import { allRoots, nodesForRoot, parseLinks, V1Node } from './v1-reader.js';
import { mergeNodeText, MigrateMaps } from './tree.js';

const TWIN = /^O9\d{4}$/;
const GARBAGE = new Set(['O0000.66']);                 // Phase 0: synthetic stress-test chunk
const ROLLING_RE = /^(Batch\s+)?Rolling summary/i;

export interface Decomposition {
  sessionsReconstructed: number;
  unattributedSessions: number;
  eventsWritten: number;
  skippedTwins: string[];
  emptyORoots: string[];
  oNodeToLoc: Record<string, { session_id: string; seq: number | null }>;
}

/** numeric dotted-path sort key: 'O0001.1.1.2' -> [1,1,2] (root token dropped) */
function pathKey(id: string): number[] {
  return id.split('.').slice(1).map(Number);
}
function cmpPath(a: string, b: string): number {
  const pa = pathKey(a), pb = pathKey(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1); // missing segment => shorter path sorts first (ancestor before descendant)
    if (d) return d;
  }
  return 0;
}

function resolveProject(rootLinks: string | null, maps: MigrateMaps): string | null {
  for (const label of parseLinks(rootLinks)) {
    if (label.startsWith('P')) {
      const uid = maps.labelToUid.get(label);
      if (uid) return uid;                              // links + must be a migrated P entry
    }
  }
  return null;                                          // unresolved -> unattributed (never seq-pair)
}

export function decomposeORoots(v1: Database.Database, v2: Database.Database, maps: MigrateMaps): Decomposition {
  const insSession = v2.prepare(`INSERT INTO sessions
    (session_id,device_id,harness,summary,summary_node_uid,started_at,last_active_at,ended_at,updated_at)
    VALUES (@session_id,NULL,'migrated',@summary,NULL,@started_at,@last_active_at,@ended_at,@updated_at)`);
  const insBinding = v2.prepare(`INSERT INTO session_bindings
    (session_id,project_uid,from_seq,to_seq,created_at)
    VALUES (?,?,1,NULL,?)`);
  const insEvent = v2.prepare(`INSERT INTO events
    (event_uid,session_id,seq,ts,role,content) VALUES (@event_uid,@session_id,@seq,@ts,@role,@content)`);

  const out: Decomposition = {
    sessionsReconstructed: 0, unattributedSessions: 0, eventsWritten: 0,
    skippedTwins: [], emptyORoots: [], oNodeToLoc: {},
  };

  for (const r of allRoots(v1)) {
    if (r.prefix !== 'O') continue;
    if (TWIN.test(r.id)) { out.skippedTwins.push(r.id); continue; }

    const nodes = nodesForRoot(v1, r.id);
    const projectUid = resolveProject(r.links, maps);
    const isUnattributed = r.seq === 0 || projectUid === null;

    if (nodes.length === 0) {                            // empty O-root
      out.emptyORoots.push(r.id);
      const sid = newUlid();
      insSession.run({ session_id: sid, summary: r.level_1 || '',
        started_at: r.created_at, last_active_at: r.created_at,
        ended_at: r.updated_at ?? r.created_at, updated_at: r.updated_at ?? r.created_at });
      if (projectUid) insBinding.run(sid, projectUid, r.created_at);
      out.sessionsReconstructed++; if (isUnattributed) out.unattributedSessions++;
      continue;
    }

    const chunks = nodes.filter(n => n.depth === 2);
    for (const c of chunks) {
      if (GARBAGE.has(c.id)) continue;                   // skip stress-test chunk
      const subtree = nodes.filter(n => n.id === c.id || n.id.startsWith(c.id + '.'));
      const maxDepth = Math.max(...subtree.map(n => n.depth));

      const sid = newUlid();
      out.sessionsReconstructed++;
      if (isUnattributed) out.unattributedSessions++;

      // summary: prefer a rolling-summary child, else the chunk's own text
      const isRollingSummary = (n: V1Node) =>
        [n.title, n.content].some(s => !!s && ROLLING_RE.test(s));
      const summaryNode = subtree.find(isRollingSummary);
      // Use the field that carries the rolling-summary marker directly (avoids merging a
      // short label title into the summary text when content holds the real marker).
      const summary = summaryNode
        ? (ROLLING_RE.test(summaryNode.content ?? '') ? summaryNode.content! : mergeNodeText(summaryNode.title, summaryNode.content))
        : mergeNodeText(c.title, c.content);

      const eventNodes = (maxDepth === 2 ? [] : subtree.filter(n => n.depth === maxDepth && n.id !== summaryNode?.id))
        .sort((a, b) => cmpPath(a.id, b.id));

      const lastTs = eventNodes.length ? eventNodes[eventNodes.length - 1].created_at : c.created_at;
      insSession.run({ session_id: sid, summary,
        started_at: c.created_at, last_active_at: lastTs,
        ended_at: lastTs, updated_at: lastTs });
      if (projectUid) insBinding.run(sid, projectUid, c.created_at);

      let seq = 0;
      for (const n of eventNodes) {
        seq++;
        insEvent.run({
          event_uid: newUlid(), session_id: sid, seq, ts: n.created_at,
          role: n.seq % 2 === 1 ? 'user' : 'assistant',
          content: mergeNodeText(n.title, n.content),
        });
        out.eventsWritten++;
        out.oNodeToLoc[n.id] = { session_id: sid, seq };
      }
      // map non-event subtree nodes (incl. the chunk root) to the session (seq=null)
      for (const n of subtree) {
        if (!(n.id in out.oNodeToLoc)) out.oNodeToLoc[n.id] = { session_id: sid, seq: null };
      }
    }
  }
  return out;
}
