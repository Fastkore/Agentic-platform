import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditEvent } from '../shared/types.js';

const retention = 30 * 86_400_000;
export const auditPageSize = 1000;
export type AuditCursor = { at: number; id: string };
export type NewAuditEvent = Omit<AuditEvent, 'id' | 'createdAt'>;
export const compareAudit = (a: AuditEvent, b: AuditEvent) => b.createdAt.localeCompare(a.createdAt) ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function publishAudit(event: AuditEvent | undefined) {
  if (event && process.env.NODE_ENV === 'production') console.info(JSON.stringify({ event: 'platform.audit', ...event }));
}

export class AuditJournal {
  private nextCleanup = 0;
  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS detailed_audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS detailed_audit_time ON detailed_audit(at DESC,id DESC);');
    this.prune();
  }
  prune(now = Date.now()) {
    if (now < this.nextCleanup) return;
    this.db.prepare('DELETE FROM detailed_audit WHERE at<=?').run(now - retention);
    this.db.exec('DELETE FROM detailed_audit WHERE id IN (SELECT id FROM detailed_audit ORDER BY at DESC,id DESC LIMIT -1 OFFSET 50000)');
    this.nextCleanup = now + 60_000;
  }
  insert(input: NewAuditEvent) {
    const now = Date.now();
    const event = { ...input, id: randomUUID(), createdAt: new Date(now).toISOString() };
    this.db.prepare('INSERT INTO detailed_audit VALUES (?, ?, ?)').run(event.id, now, JSON.stringify(event));
    return event;
  }
  page(before?: AuditCursor, limit = auditPageSize) {
    const now = Date.now();
    this.prune(now);
    const rows = this.db.prepare('SELECT payload FROM detailed_audit WHERE at > ? AND (at,id) < (?,?) ORDER BY at DESC,id DESC LIMIT ?')
      .all(now - retention, before?.at ?? now + 1, before?.id ?? '', limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as AuditEvent);
  }
}
