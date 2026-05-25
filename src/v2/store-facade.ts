import type Database from 'better-sqlite3';
import { openDb } from '../store/db.js';
import { createEntriesApi } from '../store/entries.js';
import { createLinksApi } from '../store/links.js';
import { createFtsApi } from '../store/fts.js';
import { createEventsApi } from '../store/events.js';
import { createEventsFtsApi } from '../store/events-fts.js';
import { createSessionsApi } from '../store/sessions.js';
import { createSummarizer } from '../summarize/loop.js';
import { pickSummarizer } from '../hooks/summarizer-pick.js';
import type { HmemConfig } from '../hmem-config.js';

export interface V2Store {
  db: Database.Database;
  entries: ReturnType<typeof createEntriesApi>;
  links: ReturnType<typeof createLinksApi>;
  fts: ReturnType<typeof createFtsApi>;
  events: ReturnType<typeof createEventsApi>;
  eventsFts: ReturnType<typeof createEventsFtsApi>;
  sessions: ReturnType<typeof createSessionsApi>;
  summarizer: ReturnType<typeof createSummarizer>;
  config: HmemConfig;
  path: string;
  close(): void;
}

export function createV2Store(path: string, config: HmemConfig): V2Store {
  const db = openDb(path);
  const entries = createEntriesApi(db);
  const links = createLinksApi(db, entries);
  const fts = createFtsApi(db);
  const events = createEventsApi(db);
  const eventsFts = createEventsFtsApi(db);

  // Cycle break (Phase 2 D5): summarizer references sessions via a late-bound closure;
  // sessions' onSegmentClose calls into the summarizer constructed just below.
  let sessions: ReturnType<typeof createSessionsApi>;
  const cadence = config.checkpointInterval && config.checkpointInterval > 0 ? config.checkpointInterval : 20;
  const summarizer = createSummarizer({
    db, entries, events,
    sessions: { updateSessionSummary: (id, summary, nodeUid) => sessions.updateSessionSummary(id, summary, nodeUid) },
    summarize: pickSummarizer(config),
    cadence,
  });
  sessions = createSessionsApi(db, { onSegmentClose: (c) => { void summarizer.flushSegment(c); } });

  return {
    db, entries, links, fts, events, eventsFts, sessions, summarizer, config, path,
    close() { db.close(); },
  };
}
