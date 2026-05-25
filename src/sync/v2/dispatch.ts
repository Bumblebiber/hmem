import type Database from 'better-sqlite3';
import { getSchemaMajor } from '../../store/db.js';

export type SyncLane = 'v1' | 'v2';
export function syncLaneFor(db: Database.Database): SyncLane {
  return getSchemaMajor(db) === '2' ? 'v2' : 'v1';
}
