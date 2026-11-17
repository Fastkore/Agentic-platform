import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemSourceBlobStore, type SourceBlobStore } from '../server/sources/blob-store.js';
import { SourceIndexer } from '../server/sources/indexer.js';
import { SourceRegistry, sourceLimitsFromEnv, type SourceActor, type SourceLimits } from '../server/sources/registry.js';
import { defaultExclusions } from '../shared/sources.js';

export const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const admin: SourceActor = { id: 'boss', admin: true };
export async function sourceFixture(options: { limits?: Partial<SourceLimits>; store?: SourceBlobStore; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(path.join(tmpdir(), 'sources-'));
  const store = options.store ?? new FilesystemSourceBlobStore(path.join(root, 'objects'));
  const limits = { ...sourceLimitsFromEnv({}), partBytes: 1024, ...options.limits };
  const registry = new SourceRegistry(path.join(root, 'data'), { store }, limits);
  const indexer = new SourceIndexer(registry, { leaseMs: 5000, workerId: 'test-worker' });
  return { root, store, registry, indexer, limits };
}
export type Files = Record<string, Buffer | string>;
/** Runs the upload protocol the way the browser client does; returns ids for assertions. */
export async function uploadDirectory(registry: SourceRegistry, actor: SourceActor, sourceId: string, files: Files, options: {
  label?: string; validFrom?: string; validTo?: string; baseSnapshotId?: string; stopAfterFiles?: number; idempotencyKey?: string; pageSize?: number;
} = {}) {
  const entries = Object.entries(files).map(([p, data]) => { const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data); return { path: p, size: buffer.length, sha256: sha(buffer), buffer }; });
  const upload = registry.createUpload(actor, sourceId, { idempotencyKey: options.idempotencyKey ?? randomUUID().replaceAll('-', ''), label: options.label ?? 'v' + Date.now() + Math.random(),
    validFrom: options.validFrom, validTo: options.validTo, totalFiles: entries.length, totalBytes: entries.reduce((s, e) => s + e.size, 0), exclusions: defaultExclusions, baseSnapshotId: options.baseSnapshotId });
  const pageSize = options.pageSize ?? 1000;
  for (let page = 0; page * pageSize < entries.length; page++) {
    const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
    registry.putManifest(actor, sourceId, upload.id, { page, last: (page + 1) * pageSize >= entries.length, entries: slice.map(({ path, size, sha256 }) => ({ path, size, sha256 })) });
  }
  const transferred = await transfer(registry, actor, sourceId, upload.id, entries, options.stopAfterFiles);
  return { uploadId: upload.id, snapshotId: upload.snapshotId, entries, transferred };
}
export async function transfer(registry: SourceRegistry, actor: SourceActor, sourceId: string, uploadId: string, entries: { path: string; buffer: Buffer }[], stopAfterFiles?: number) {
  const byPath = new Map(entries.map(e => [e.path, e.buffer]));
  let files = 0, parts = 0;
  let cursor = -1;
  for (;;) {
    const status = registry.uploadStatus(actor, sourceId, uploadId, cursor);
    for (const file of status.files) {
      if (stopAfterFiles !== undefined && files >= stopAfterFiles) return { files, parts };
      if (file.state === 'failed') continue;
      const data = byPath.get(file.path)!;
      const partBytes = status.upload.partBytes;
      for (let part = 1; part <= file.partsTotal; part++) {
        if (file.partsReceived.includes(part)) continue;
        await registry.putPart(actor, sourceId, uploadId, file.fileId, part, data.subarray((part - 1) * partBytes, part * partBytes));
        parts++;
      }
      files++;
    }
    if (status.next === undefined) return { files, parts };
    cursor = status.next;
  }
}
