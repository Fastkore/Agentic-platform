import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemLibraryBlobStore, type LibraryBlobStore } from '../server/library/blob-store.js';
import { LibraryIndexer } from '../server/library/indexer.js';
import { LibraryRegistry, libraryLimitsFromEnv, type LibraryActor, type LibraryLimits } from '../server/library/registry.js';
import { profileExclusions } from '../shared/library.js';

export const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const admin: LibraryActor = { id: 'boss', admin: true };
export type Files = Record<string, Buffer | string>;

export async function libraryFixture(options: { limits?: Partial<LibraryLimits>; store?: LibraryBlobStore; root?: string; fileTimeoutMs?: number } = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), 'library-'));
  const store = options.store ?? new FilesystemLibraryBlobStore(path.join(root, 'objects'));
  const limits = { ...libraryLimitsFromEnv({}), partBytes: 1024, ...options.limits };
  const registry = new LibraryRegistry(path.join(root, 'data'), { store }, limits);
  const indexer = new LibraryIndexer(registry, { leaseMs: 5000, workerId: 'test-worker', fileTimeoutMs: options.fileTimeoutMs });
  return { root, store, registry, indexer, limits };
}

/** Sends the file list of an operation; returns the summary after the last page. */
export function startOperation(registry: LibraryRegistry, actor: LibraryActor, folderId: string, files: Files, options: { mode?: 'replace' | 'add'; idempotencyKey?: string; pageSize?: number } = {}) {
  const entries = Object.entries(files).map(([p, data]) => { const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data); return { path: p, size: buffer.length, sha256: sha(buffer), buffer }; });
  const profile = registry.folderRow(folderId)?.profile ?? 'code';
  const operation = registry.createOperation(actor, folderId, { idempotencyKey: options.idempotencyKey ?? randomUUID().replaceAll('-', ''), mode: options.mode ?? 'replace',
    totalFiles: entries.length, totalBytes: entries.reduce((s, e) => s + e.size, 0), exclusions: profileExclusions(profile) });
  const pageSize = options.pageSize ?? 1000;
  let summary = operation;
  for (let page = 0; page * pageSize < entries.length; page++) {
    const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
    summary = registry.putManifest(actor, folderId, operation.id, { page, last: (page + 1) * pageSize >= entries.length, entries: slice.map(({ path, size, sha256 }) => ({ path, size, sha256 })) });
  }
  return { operationId: operation.id, summary, entries };
}
/** Transfers the parts the server still needs, in manifest order. */
export async function transfer(registry: LibraryRegistry, actor: LibraryActor, folderId: string, operationId: string, entries: { path: string; buffer: Buffer }[], stopAfterFiles?: number) {
  const byPath = new Map(entries.map(e => [e.path, e.buffer]));
  let files = 0, parts = 0, cursor = -1;
  for (;;) {
    const status = registry.operationStatus(actor, folderId, operationId, cursor);
    for (const file of status.files) {
      if (stopAfterFiles !== undefined && files >= stopAfterFiles) return { files, parts };
      const data = byPath.get(file.path)!;
      const partBytes = status.operation.partBytes;
      for (let part = 1; part <= file.partsTotal; part++) {
        if (file.partsReceived.includes(part)) continue;
        await registry.putPart(actor, folderId, operationId, file.fileId, part, data.subarray((part - 1) * partBytes, part * partBytes));
        parts++;
      }
      files++;
    }
    if (status.next === undefined) return { files, parts };
    cursor = status.next;
  }
}
/** Full upload: list, transfer, completion and processing. Returns the operation summary after processing. */
export async function upload(fixture: { registry: LibraryRegistry; indexer: LibraryIndexer }, folderId: string, files: Files, options: { mode?: 'replace' | 'add'; actor?: LibraryActor } = {}) {
  const actor = options.actor ?? admin;
  const started = startOperation(fixture.registry, actor, folderId, files, options);
  if (started.summary.status === 'unchanged') return { ...started, transferred: { files: 0, parts: 0 }, result: started.summary };
  const transferred = await transfer(fixture.registry, actor, folderId, started.operationId, started.entries);
  await fixture.registry.completeOperation(actor, folderId, started.operationId, 'complete-' + started.operationId.slice(0, 8));
  await fixture.indexer.drain();
  return { ...started, transferred, result: fixture.registry.operationSummary(started.operationId) };
}
export const current = (registry: LibraryRegistry, folderId: string) => registry.currentState(folderId)!;
export const paths = (registry: LibraryRegistry, folderId: string) =>
  (registry.db.prepare('SELECT path FROM state_files WHERE state_id=? ORDER BY path').all(current(registry, folderId).id) as { path: string }[]).map(r => r.path);
