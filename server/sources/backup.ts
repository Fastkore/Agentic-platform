import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceBlobStore } from './blob-store.js';

/**
 * Consistent backup of the sources subsystem.
 * 1. pause the object collector (no object is deleted while the backup and the object copy run);
 * 2. VACUUM INTO copies of sources.sqlite and state.sqlite (never a copy of a live WAL file);
 * 3. a manifest of every referenced object (key, size, sha256) taken from the copied database;
 * 4. objects are copied by the storage tooling (for example `mc mirror`) while the pause lasts, then the collector is resumed.
 */
export async function backupSources(options: { dataRoot: string; target: string; store?: SourceBlobStore; pauseMs?: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  await mkdir(options.target, { recursive: true, mode: 0o700 });
  const sourcesFile = path.join(options.dataRoot, 'sources.sqlite');
  if (!existsSync(sourcesFile)) throw new Error('sources.sqlite not found in ' + options.dataRoot);
  const live = new DatabaseSync(sourcesFile);
  try {
    live.exec('PRAGMA busy_timeout=5000');
    live.prepare("INSERT INTO maintenance VALUES ('collector_paused_until', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now() + (options.pauseMs ?? 6 * 3600_000)));
    const targetSources = path.join(options.target, 'sources.sqlite');
    if (existsSync(targetSources)) throw new Error('Target already contains a backup');
    live.prepare('VACUUM INTO ?').run(targetSources);
  } finally { live.close(); }
  const stateFile = path.join(options.dataRoot, 'state.sqlite');
  if (existsSync(stateFile)) {
    const state = new DatabaseSync(stateFile, { readOnly: true });
    try { state.prepare('VACUUM INTO ?').run(path.join(options.target, 'state.sqlite')); } finally { state.close(); }
  }
  const copy = new DatabaseSync(path.join(options.target, 'sources.sqlite'), { readOnly: true });
  let objects: { key: string; size: number; sha256: string; kind: string }[];
  try {
    objects = (copy.prepare("SELECT object_key key, size, sha256, kind FROM blobs WHERE state='verified' ORDER BY object_key").all() as typeof objects);
  } finally { copy.close(); }
  const missing: string[] = [];
  if (options.store) for (const object of objects) { const head = await options.store.head(object.key); if (!head || head.size !== object.size) missing.push(object.key); }
  const summary = { createdAt: new Date(now()).toISOString(), objects: objects.length, bytes: objects.reduce((s, o) => s + o.size, 0), missingAtBackup: missing };
  await writeFile(path.join(options.target, 'objects.json'), JSON.stringify(objects), { mode: 0o600 });
  await writeFile(path.join(options.target, 'backup.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}
export function resumeCollector(dataRoot: string) {
  const db = new DatabaseSync(path.join(dataRoot, 'sources.sqlite'));
  try { db.prepare("DELETE FROM maintenance WHERE key='collector_paused_until'").run(); } finally { db.close(); }
}
/** After restoring sources.sqlite and objects: checks presence (and with deep=true content hashes) of every referenced object. */
export async function verifyRestore(options: { dataRoot: string; store: SourceBlobStore; deep?: boolean; reindex?: boolean }) {
  const db = new DatabaseSync(path.join(options.dataRoot, 'sources.sqlite'));
  try {
    const rows = db.prepare("SELECT id, object_key key, size, sha256 FROM blobs WHERE state='verified'").all() as { id: string; key: string; size: number; sha256: string }[];
    const missing: string[] = [], corrupted: string[] = [];
    for (const row of rows) {
      const head = await options.store.head(row.key);
      if (!head || head.size !== row.size) { missing.push(row.id); continue; }
      if (options.deep) {
        const digest = createHash('sha256');
        for await (const chunk of await options.store.stream(row.key)) digest.update(chunk as Buffer);
        if (digest.digest('hex') !== row.sha256) corrupted.push(row.id);
      }
    }
    const broken = new Set([...missing, ...corrupted]);
    const affected = broken.size ? (db.prepare(`SELECT DISTINCT s.id, s.label, s.source_id sourceId FROM snapshots s JOIN snapshot_files f ON f.snapshot_id=s.id
      WHERE s.state='ready' AND (f.blob_id IN (${[...broken].map(() => '?').join(',')}) OR f.text_blob_id IN (${[...broken].map(() => '?').join(',')}))`)
      .all(...broken, ...broken) as { id: string; label: string; sourceId: string }[]) : [];
    let requeued = 0;
    if (options.reindex) {
      // The index is derived data: every ready snapshot gets a new generation; the old one stays active until the switch.
      const ready = db.prepare("SELECT id, index_generation g FROM snapshots WHERE state='ready'").all() as { id: string; g: number }[];
      for (const s of ready) {
        db.prepare(`INSERT INTO index_jobs (snapshot_id, generation, state, attempts, created_at) VALUES (?,?,'queued',0,?)
          ON CONFLICT(snapshot_id) DO UPDATE SET generation=excluded.generation, state='queued', attempts=0, lease_owner=NULL, lease_until=NULL`).run(s.id, s.g + 1, Date.now());
        requeued++;
      }
    }
    return { checked: rows.length, missing, corrupted, affectedSnapshots: affected, requeued, ok: !missing.length && !corrupted.length };
  } finally { db.close(); }
}
