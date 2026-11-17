import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import { sourceStorageFromEnv } from '../server/sources/blob-store.js';
import { SourceRegistry } from '../server/sources/registry.js';
import { SourceIndexer } from '../server/sources/indexer.js';
import { SourceReader } from '../server/sources/reader.js';
import { backupSources, resumeCollector, verifyRestore } from '../server/sources/backup.js';
import { admin, sourceFixture, transfer, uploadDirectory } from './sources-helpers.js';

/**
 * S3 integration (MinIO or another S3-compatible endpoint). Runs only when BRIDGE_SOURCES_TEST_S3_ENDPOINT is set:
 *   BRIDGE_SOURCES_TEST_S3_ENDPOINT=http://127.0.0.1:9000 BRIDGE_SOURCES_TEST_S3_ACCESS_KEY=... BRIDGE_SOURCES_TEST_S3_SECRET_KEY=... npx tsx --test tests/sources-s3.test.ts
 */
const endpoint = process.env.BRIDGE_SOURCES_TEST_S3_ENDPOINT;
const env = () => ({
  BRIDGE_SOURCES_S3_BUCKET: 'sources-test-' + randomUUID().slice(0, 8), BRIDGE_SOURCES_S3_ENDPOINT: endpoint, BRIDGE_SOURCES_S3_REGION: 'us-east-1',
  BRIDGE_SOURCES_S3_ACCESS_KEY: process.env.BRIDGE_SOURCES_TEST_S3_ACCESS_KEY ?? 'test', BRIDGE_SOURCES_S3_SECRET_KEY: process.env.BRIDGE_SOURCES_TEST_S3_SECRET_KEY ?? 'test',
  BRIDGE_SOURCES_S3_CREATE_BUCKET: '1',
});

test('S3: separate bucket required, multipart upload with server-side re-verification, restart and resume, cancel cleanup', { skip: !endpoint }, async () => {
  assert.match(sourceStorageFromEnv({ BRIDGE_S3_BUCKET: 'same', BRIDGE_SOURCES_S3_BUCKET: 'same' }).problem!, /отдельный/);
  assert.match(sourceStorageFromEnv({}).problem!, /не настроено/);
  const config = sourceStorageFromEnv(env());
  assert.ok(config.store, config.problem);
  await config.store!.check();
  const partBytes = 5 * 1024 * 1024;
  const fixture = await sourceFixture({ store: config.store, limits: { partBytes } });
  const source = fixture.registry.createSource(admin, { name: 'S3 source', kind: 'code', classification: 'shared' });
  const big = Buffer.concat([randomBytes(partBytes * 2), Buffer.from('\nlast line marker\n')]);
  const files = { 'big/data.bin.txt': Buffer.from(big.toString('base64').replace(/(.{100})/g, '$1\n')), 'small.cs': 'class Small {}\n' };
  const first = await uploadDirectory(fixture.registry, admin, source.id, files, { stopAfterFiles: 0 });
  // Send the first part of the multipart file only, then "restart".
  const status = fixture.registry.uploadStatus(admin, source.id, first.uploadId);
  const multi = status.files.find(f => f.partsTotal > 1)!;
  const data = first.entries.find(e => e.path === multi.path)!.buffer;
  await fixture.registry.putPart(admin, source.id, first.uploadId, multi.fileId, 1, data.subarray(0, partBytes));
  fixture.registry.close();
  const registry = new SourceRegistry(path.join(fixture.root, 'data'), config, fixture.limits);
  const resumed = await transfer(registry, admin, source.id, first.uploadId, first.entries);
  assert.ok(resumed.parts >= 2 && resumed.parts < 2 + Math.ceil(data.length / partBytes), 'confirmed parts are not re-sent');
  await registry.completeUpload(admin, source.id, first.uploadId, 's3-complete-1');
  await new SourceIndexer(registry).drain();
  assert.equal(registry.snapshotRow(first.snapshotId)!.state, 'ready');
  const verify = await registry.verifyObjects(source.id);
  assert.equal(verify.missing.length, 0);
  const reader = new SourceReader(registry);
  const file = reader.fileByPath(first.snapshotId, 'small.cs')!;
  assert.equal((await reader.readLines(first.snapshotId, file.file_id, 1, 1)).lines[0].text, 'class Small {}');
  // Corrupted multipart content is detected on the server and the object removed.
  const bad = await uploadDirectory(registry, admin, source.id, { 'x.txt': Buffer.alloc(partBytes + 10, 0x42) }, { stopAfterFiles: 0 });
  const badFile = registry.uploadStatus(admin, source.id, bad.uploadId).files[0];
  const badData = bad.entries[0].buffer;
  await registry.putPart(admin, source.id, bad.uploadId, badFile.fileId, 1, badData.subarray(0, partBytes));
  await assert.rejects(registry.putPart(admin, source.id, bad.uploadId, badFile.fileId, 2, Buffer.alloc(badFile.size - partBytes, 0x41)), /изменился/);
  await registry.cancelUpload(admin, source.id, bad.uploadId);
  const keys: string[] = [];
  for await (const item of config.store!.list('sources/' + source.id + '/')) keys.push(item.key);
  const live = registry.db.prepare("SELECT object_key FROM blobs WHERE state='verified'").all() as { object_key: string }[];
  assert.deepEqual(keys.sort(), live.map(r => r.object_key).sort(), 'no orphan objects after cancel and cleanup');

  const restoredConfig = sourceStorageFromEnv(env());
  assert.ok(restoredConfig.store);
  assert.notEqual(restoredConfig.bucket, config.bucket);
  const restoredStore = restoredConfig.store;
  await restoredStore.check();
  const dataRoot = path.join(fixture.root, 'data');
  const backup = path.join(fixture.root, 'restore');
  try {
    const summary = await backupSources({ dataRoot, target: backup, store: config.store });
    assert.ok(summary.objects >= 2);
    assert.deepEqual(summary.missingAtBackup, []);
    const beforeCopy = await verifyRestore({ dataRoot: backup, store: restoredStore, deep: true });
    assert.equal(beforeCopy.ok, false, 'a different empty bucket cannot verify the backup');
    const manifest = JSON.parse(await readFile(path.join(backup, 'objects.json'), 'utf8')) as { key: string }[];
    for (const { key } of manifest) {
      await restoredStore.put(key, await buffer(await config.store.stream(key)));
    }
    const verified = await verifyRestore({ dataRoot: backup, store: restoredStore, deep: true });
    assert.equal(verified.ok, true);
    assert.equal(verified.checked, summary.objects);
  } finally {
    resumeCollector(dataRoot);
    restoredStore.close();
  }
  registry.close();
});
