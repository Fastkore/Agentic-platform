import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { libraryStorageFromEnv } from '../server/library/blob-store.js';
import { LibraryRegistry } from '../server/library/registry.js';
import { LibraryIndexer } from '../server/library/indexer.js';
import { LibraryReader } from '../server/library/reader.js';
import { admin, current, libraryFixture, startOperation, transfer, upload } from './library-helpers.js';

/**
 * S3 integration (MinIO or another S3-compatible endpoint). Runs only when BRIDGE_LIBRARY_TEST_S3_ENDPOINT is set:
 *   BRIDGE_LIBRARY_TEST_S3_ENDPOINT=http://127.0.0.1:9000 BRIDGE_LIBRARY_TEST_S3_ACCESS_KEY=... BRIDGE_LIBRARY_TEST_S3_SECRET_KEY=... npx tsx --test tests/library-s3.test.ts
 */
const endpoint = process.env.BRIDGE_LIBRARY_TEST_S3_ENDPOINT;
const env = () => ({
  BRIDGE_LIBRARY_S3_BUCKET: 'library-test-' + randomUUID().slice(0, 8), BRIDGE_LIBRARY_S3_ENDPOINT: endpoint, BRIDGE_LIBRARY_S3_REGION: 'us-east-1',
  BRIDGE_LIBRARY_S3_ACCESS_KEY: process.env.BRIDGE_LIBRARY_TEST_S3_ACCESS_KEY ?? 'test', BRIDGE_LIBRARY_S3_SECRET_KEY: process.env.BRIDGE_LIBRARY_TEST_S3_SECRET_KEY ?? 'test',
  BRIDGE_LIBRARY_S3_CREATE_BUCKET: '1',
});

test('S3: separate bucket required; multipart upload re-verified on the server; restart and resume; update reuses objects; cancel leaves no orphans', { skip: !endpoint }, async () => {
  assert.match(libraryStorageFromEnv({ BRIDGE_S3_BUCKET: 'same', BRIDGE_LIBRARY_S3_BUCKET: 'same' }).problem!, /отдельный/);
  assert.match(libraryStorageFromEnv({}).problem!, /не настроено/);
  const config = libraryStorageFromEnv(env());
  assert.ok(config.store, config.problem);
  await config.store!.check();
  const partBytes = 5 * 1024 * 1024;
  const fixture = await libraryFixture({ store: config.store, limits: { partBytes } });
  const folder = fixture.registry.createFolder(admin, { name: 'S3 folder', profile: 'code' });
  const big = Buffer.concat([Buffer.from(randomBytes(partBytes * 2).toString('base64').replace(/(.{100})/g, '$1\n')), Buffer.from('\nlast line marker\n')]);
  const files = { 'big/data.txt': big, 'small.cs': 'class Small {}\n' };
  const started = startOperation(fixture.registry, admin, folder.id, files);
  const multi = fixture.registry.operationStatus(admin, folder.id, started.operationId).files.find(f => f.partsTotal > 1)!;
  await fixture.registry.putPart(admin, folder.id, started.operationId, multi.fileId, 1, big.subarray(0, partBytes));
  fixture.registry.close();
  const registry = new LibraryRegistry(path.join(fixture.root, 'data'), config, fixture.limits);
  const resumed = await transfer(registry, admin, folder.id, started.operationId, started.entries);
  assert.ok(resumed.parts >= 2 && resumed.parts < 2 + Math.ceil(big.length / partBytes), 'confirmed parts are not re-sent');
  await registry.completeOperation(admin, folder.id, started.operationId, 's3-complete-1');
  const indexer = new LibraryIndexer(registry);
  await indexer.drain();
  const state = current(registry, folder.id);
  const reader = new LibraryReader(registry);
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, 'small.cs')!.file_id, 1, 1)).lines[0].text, 'class Small {}');
  assert.equal(reader.search([{ stateId: state.id, folderId: folder.id }], 'last line marker').hits[0].path, 'big/data.txt');
  // Update: the big file is unchanged and not sent again.
  const updated = await upload({ registry, indexer }, folder.id, { ...files, 'small.cs': 'class Small2 {}\n' });
  assert.equal(updated.transferred.parts, 1);
  // Corrupted multipart content is detected on the server and the object removed.
  const bad = startOperation(registry, admin, folder.id, { 'x.txt': Buffer.alloc(partBytes + 10, 0x42) }, { mode: 'add' });
  const badFile = registry.operationStatus(admin, folder.id, bad.operationId).files[0];
  await registry.putPart(admin, folder.id, bad.operationId, badFile.fileId, 1, bad.entries[0].buffer.subarray(0, partBytes));
  await assert.rejects(registry.putPart(admin, folder.id, bad.operationId, badFile.fileId, 2, Buffer.alloc(badFile.size - partBytes, 0x41)), /изменился/);
  await registry.cancelOperation(admin, folder.id, bad.operationId);
  await registry.collectGarbage({ graceMs: 0 });
  const keys: string[] = [];
  for await (const item of config.store!.list('library/' + folder.id + '/')) keys.push(item.key);
  const live = registry.db.prepare("SELECT object_key FROM blobs WHERE state='verified' AND folder_id=?").all(folder.id) as { object_key: string }[];
  assert.deepEqual(keys.sort(), live.map(r => r.object_key).sort(), 'no orphan objects after replacement, cancel and collection');
  await indexer.stop();
  registry.close();
});

test('S3: accepted Windows-1251 and rejected text both release connections; processing does not exhaust the socket pool', { skip: !endpoint }, async () => {
  const config = libraryStorageFromEnv(env());
  await config.store!.check();
  const fixture = await libraryFixture({ store: config.store, limits: { partBytes: 5 * 1024 * 1024 } });
  const folder = fixture.registry.createFolder(admin, { name: 'cp1251', profile: 'code' });
  const files: Record<string, Buffer | string> = { 'zz/ok.cs': 'class Ok {}\n' };
  // More files than the S3 client's 50 pooled connections; each body is larger than the first network chunk.
  for (let i = 0; i < 80; i++) {
    const prefix = Buffer.from([0xcf, 0xf0, i % 4 === 0 ? 0xe8 : 0x98, 0xe2, 0xe5, 0xf2, 0x0a]);
    files[`legacy/f${i}.cs`] = Buffer.concat([prefix, Buffer.alloc(300 * 1024, 0x61 + (i % 20)), Buffer.from(String(i))]);
  }
  const deadline = AbortSignal.timeout(90_000);
  await Promise.race([upload(fixture, folder.id, files), new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('processing hung'))))]);
  await fixture.indexer.stop();
  const summary = fixture.registry.getFolder(admin, folder.id);
  assert.equal(summary.current!.indexed, 21);
  assert.equal(summary.current!.unsupported, 60);
  const state = current(fixture.registry, folder.id);
  const reader = new LibraryReader(fixture.registry);
  const file = reader.fileByPath(state.id, 'legacy/f0.cs')!;
  assert.equal((await reader.readLines(state.id, file.file_id, 1, 1)).lines[0].text, 'Привет');
});
