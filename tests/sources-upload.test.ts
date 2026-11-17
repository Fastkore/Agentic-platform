import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { SourceRegistry } from '../server/sources/registry.js';
import { SourceReader } from '../server/sources/reader.js';
import { pathKey, pathProblem } from '../shared/sources.js';
import { BridgeError } from '../server/store.js';
import { admin, sha, sourceFixture, transfer, uploadDirectory } from './sources-helpers.js';

const status = (error: unknown) => (error as BridgeError).statusCode;
const rejects = async (work: () => unknown, code: number, message?: RegExp) => {
  await assert.rejects(async () => { await work(); }, (error: unknown) => {
    assert.equal(status(error), code, (error as Error).message);
    if (message) assert.match((error as Error).message, message);
    return true;
  });
};
async function countObjects(root: string) {
  let n = 0;
  const walk = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { if (e.name.startsWith('.')) continue; if (e.isDirectory()) await walk(path.join(dir, e.name)); else if (!e.name.endsWith('.tmp')) n++; } };
  await walk(root);
  return n;
}

test('AC01: nested folders, Cyrillic names and equal file names in different folders keep paths and contents', async () => {
  const { registry, indexer } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Fastkore Business', kind: 'code', classification: 'shared' });
  const files = {
    'Заказы/Расчёт/Модуль.cs': 'namespace Fk.Orders {\n  public class Расчёт {\n    public decimal Total(decimal a) { return a * 2; }\n  }\n}\n',
    'Склад/Модуль.cs': 'namespace Fk.Stock {\n  public class Остатки { }\n}\n',
    'README.md': '# Документация\nТекст\n',
    'big/data.txt': Array.from({ length: 3000 }, (_, i) => `line ${i + 1} value`).join('\n'),
  };
  const { snapshotId, uploadId } = await uploadDirectory(registry, admin, source.id, files, { label: 'Business A' });
  assert.equal(registry.snapshotRow(snapshotId)!.state, 'uploading');
  const done = await registry.completeUpload(admin, source.id, uploadId, 'complete-key-1');
  assert.equal(done.snapshotState, 'indexing');
  await indexer.drain();
  const snapshot = registry.snapshotRow(snapshotId)!;
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.total_files, 4);
  const reader = new SourceReader(registry);
  const a = reader.fileByPath(snapshotId, 'Заказы/Расчёт/Модуль.cs')!, b = reader.fileByPath(snapshotId, 'Склад/Модуль.cs')!;
  assert.notEqual(a.file_id, b.file_id);
  assert.equal(a.sha256, sha(files['Заказы/Расчёт/Модуль.cs']));
  assert.equal((await reader.readLines(snapshotId, a.file_id, 2, 1)).lines[0].text, '  public class Расчёт {');
  assert.equal((await reader.readLines(snapshotId, b.file_id, 2, 1)).lines[0].text, '  public class Остатки { }');
  const tree = registry.tree(snapshotId, '');
  assert.deepEqual(tree.entries.map(e => e.name + ':' + e.type), ['README.md:file', 'big:dir', 'Заказы:dir', 'Склад:dir']);
  assert.deepEqual(registry.tree(snapshotId, 'Заказы').entries.map(e => e.name), ['Расчёт']);
  // Line index lets reads start deep in a file and stop at the requested count.
  const big = reader.fileByPath(snapshotId, 'big/data.txt')!;
  const deep = await reader.readLines(snapshotId, big.file_id, 2501, 3);
  assert.deepEqual(deep.lines.map(l => l.text), ['line 2501 value', 'line 2502 value', 'line 2503 value']);
  assert.equal(deep.totalLines, 3000);
  const t = { snapshotId, generation: snapshot.index_generation };
  assert.equal(reader.search([t], 'line 2999 value').hits[0].line, 2999);
  assert.equal(reader.symbols([t], 'Расчёт')[0].path, 'Заказы/Расчёт/Модуль.cs');
  assert.equal(reader.symbols([t], 'Total')[0].line, 3);
});

test('AC02: interrupted transfer resumes after restart without re-sending confirmed objects; partial snapshot stays invisible', async () => {
  const fixture = await sourceFixture();
  const source = fixture.registry.createSource(admin, { name: 'Platform', kind: 'code', classification: 'shared' });
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < 6; i++) files[`src/f${i}.txt`] = Buffer.from(`file ${i}\n`.repeat(200 + i));
  const first = await uploadDirectory(fixture.registry, admin, source.id, files, { stopAfterFiles: 3 });
  assert.equal(first.transferred.files, 3);
  const objectsBefore = await countObjects(path.join(fixture.root, 'objects'));
  // Server restart: a new registry on the same database and object store.
  fixture.registry.close();
  const registry = new SourceRegistry(path.join(fixture.root, 'data'), { store: fixture.store }, fixture.limits);
  await assert.rejects(registry.completeUpload(admin, source.id, first.uploadId, 'complete-key-2'), (e: unknown) => status(e) === 409);
  assert.equal(registry.snapshotRow(first.snapshotId)!.state, 'uploading');
  const status1 = registry.uploadStatus(admin, source.id, first.uploadId);
  assert.equal(status1.upload.files.verified, 3);
  const resumed = await transfer(registry, admin, source.id, first.uploadId, first.entries);
  assert.equal(resumed.files, 3, 'only remaining files are sent');
  await registry.completeUpload(admin, source.id, first.uploadId, 'complete-key-2');
  assert.equal(await countObjects(path.join(fixture.root, 'objects')), objectsBefore + 3);
  const blobs = registry.db.prepare("SELECT count(*) n FROM blobs WHERE state='verified'").get() as { n: number };
  assert.equal(blobs.n, 6, 'no duplicate objects');
});

test('AC03: idempotent parts and completion, hash/size substitution, changed file, and parallel quota reservation', async () => {
  const { registry, root } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Docs', kind: 'documents', classification: 'shared', quotaBytes: 10_000 });
  const data = Buffer.from('x'.repeat(2500));
  const upload = registry.createUpload(admin, source.id, { idempotencyKey: 'key-0000001', label: 'D1', totalFiles: 2, totalBytes: 2600, exclusions: [] });
  // Same key and body → same session; same key, other body → 409.
  assert.equal(registry.createUpload(admin, source.id, { idempotencyKey: 'key-0000001', label: 'D1', totalFiles: 2, totalBytes: 2600, exclusions: [] }).id, upload.id);
  await rejects(() => registry.createUpload(admin, source.id, { idempotencyKey: 'key-0000001', label: 'D2', totalFiles: 2, totalBytes: 2600, exclusions: [] }), 409);
  const manifest = { page: 0, last: true, entries: [{ path: 'a.txt', size: 2500, sha256: sha(data) }, { path: 'b.txt', size: 100, sha256: sha('y'.repeat(100)) }] };
  registry.putManifest(admin, source.id, upload.id, manifest);
  registry.putManifest(admin, source.id, upload.id, manifest); // identical retry
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { ...manifest, entries: manifest.entries.slice(0, 1) }), 409);
  const files = registry.uploadStatus(admin, source.id, upload.id).files;
  const a = files.find(f => f.path === 'a.txt')!, b = files.find(f => f.path === 'b.txt')!;
  assert.equal(a.partsTotal, 3);
  await registry.putPart(admin, source.id, upload.id, a.fileId, 1, data.subarray(0, 1024));
  assert.equal((await registry.putPart(admin, source.id, upload.id, a.fileId, 1, data.subarray(0, 1024))).duplicate, true);
  await rejects(() => registry.putPart(admin, source.id, upload.id, a.fileId, 1, Buffer.alloc(1024, 1)), 409);
  await rejects(() => registry.putPart(admin, source.id, upload.id, a.fileId, 2, data.subarray(1024, 2000)), 400, /Размер части/);
  await rejects(() => registry.putPart(admin, source.id, upload.id, a.fileId, 2, data.subarray(1024, 2048), sha('other')), 400);
  // File changed on disk during transfer: last part differs, server re-reads the object and rejects it.
  await registry.putPart(admin, source.id, upload.id, a.fileId, 2, data.subarray(1024, 2048));
  await rejects(() => registry.putPart(admin, source.id, upload.id, a.fileId, 3, Buffer.alloc(452, 0x7a)), 409, /изменился/);
  assert.equal(registry.uploadStatus(admin, source.id, upload.id).files.find(f => f.fileId === a.fileId)!.state, 'failed');
  // Size substitution for a single-part file.
  await rejects(() => registry.putPart(admin, source.id, upload.id, b.fileId, 1, Buffer.from('y'.repeat(99))), 400);
  await rejects(() => registry.putPart(admin, source.id, upload.id, b.fileId, 1, Buffer.from('z'.repeat(100))), 409, /Хеш файла/);
  await rejects(() => registry.completeUpload(admin, source.id, upload.id, 'complete-0001'), 409);
  // Retransmission of failed files succeeds; completion is idempotent per key.
  for (let part = 1; part <= 3; part++) await registry.putPart(admin, source.id, upload.id, a.fileId, part, data.subarray((part - 1) * 1024, part * 1024));
  await registry.putPart(admin, source.id, upload.id, b.fileId, 1, Buffer.from('y'.repeat(100)));
  const done = await registry.completeUpload(admin, source.id, upload.id, 'complete-0001');
  assert.equal((await registry.completeUpload(admin, source.id, upload.id, 'complete-0001')).snapshotId, done.snapshotId);
  await rejects(() => registry.completeUpload(admin, source.id, upload.id, 'complete-0002'), 409);
  assert.equal(registry.snapshotRow(done.snapshotId)!.state, 'indexing');
  // Two parallel sessions cannot reserve more than the quota.
  const quotaSource = registry.createSource(admin, { name: 'Q', kind: 'code', classification: 'shared', quotaBytes: 5000 });
  registry.createUpload(admin, quotaSource.id, { idempotencyKey: 'quota-0001', label: 'Q1', totalFiles: 1, totalBytes: 3000, exclusions: [] });
  await rejects(() => registry.createUpload({ id: 'other-admin', admin: true }, quotaSource.id, { idempotencyKey: 'quota-0002', label: 'Q2', totalFiles: 1, totalBytes: 3000, exclusions: [] }), 413);
  assert.equal(registry.getSource(admin, quotaSource.id).reservedBytes, 3000);
  assert.ok(root);
});

test('AC04: hostile paths, encoded separators, Unicode and case collisions are rejected', async () => {
  for (const bad of ['../x', 'a/../b', '/etc/passwd', 'C:/Windows/x', 'a//b', 'a/./b', 'a\\b', 'a%2fb', 'a\u2215b', 'a\u0000b', 'a\nb', 'con.txt', 'dir./x', '']) {
    assert.ok(pathProblem(bad), bad);
  }
  assert.equal(pathProblem('Каталог/файл.cs'), undefined);
  assert.equal(pathProblem('e\u0301.txt'), 'not_normalized');
  assert.equal(pathProblem(Array.from({ length: 65 }, () => 'd').join('/')), 'too_deep');
  assert.equal(pathKey('Readme.MD'), pathKey('README.md'));
  const { registry } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'S', kind: 'code', classification: 'shared' });
  const upload = registry.createUpload(admin, source.id, { idempotencyKey: 'paths-0001', label: 'P', totalFiles: 3, totalBytes: 30, exclusions: ['.git/'] });
  const entry = (p: string) => ({ path: p, size: 10, sha256: sha(p) });
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 0, last: false, entries: [entry('ok.txt'), entry('../escape.txt')] }), 400, /escape/);
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 0, last: false, entries: [entry('.git/config')] }), 400, /excluded/);
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 0, last: false, entries: [entry('Dir/A.cs'), entry('dir/a.cs')] }), 409, /регистром/);
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 0, last: false, entries: [{ path: 'x', size: -1, sha256: sha('x') }] }), 400);
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 1, last: false, entries: [entry('x.txt')] }), 409, /страница/);
  await rejects(() => registry.putManifest(admin, source.id, upload.id, { page: 0, last: false, entries: [entry('1'), entry('2'), entry('3'), entry('4')] }), 413);
  // Nothing from rejected pages was stored.
  assert.equal(registry.uploadStatus(admin, source.id, upload.id).upload.files.total, 0);
});

test('AC05: a new snapshot reuses unchanged objects, records added/changed/removed, old snapshot stays readable', async () => {
  const { registry, indexer, root } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Biz', kind: 'code', classification: 'shared' });
  const v1 = await uploadDirectory(registry, admin, source.id, { 'a.cs': 'class A {}\n', 'b.cs': 'class B {}\n', 'c.cs': 'class C {}\n' }, { label: '1.0' });
  await registry.completeUpload(admin, source.id, v1.uploadId, 'complete-v1');
  await indexer.drain();
  const objects = await countObjects(path.join(root, 'objects'));
  const v2 = await uploadDirectory(registry, admin, source.id, { 'a.cs': 'class A {}\n', 'b.cs': 'class B { int x; }\n', 'd.cs': 'class D {}\n' }, { label: '2.0', baseSnapshotId: v1.snapshotId });
  const st = registry.uploadStatus(admin, source.id, v2.uploadId);
  assert.deepEqual(st.diff, { baseSnapshotId: v1.snapshotId, added: 1, changed: 1, removed: 1 });
  assert.equal(st.upload.files.reused, 1);
  assert.equal(v2.transferred.files, 2, 'unchanged a.cs is not transferred');
  await registry.completeUpload(admin, source.id, v2.uploadId, 'complete-v2');
  await indexer.drain();
  assert.equal(await countObjects(path.join(root, 'objects')), objects + 2);
  const reader = new SourceReader(registry);
  assert.equal(reader.fileByPath(v2.snapshotId, 'c.cs'), undefined);
  const old = reader.fileByPath(v1.snapshotId, 'b.cs')!;
  assert.equal((await reader.readLines(v1.snapshotId, old.file_id, 1, 1)).lines[0].text, 'class B {}');
  assert.equal(reader.fileByPath(v2.snapshotId, 'a.cs')!.blob_id, reader.fileByPath(v1.snapshotId, 'a.cs')!.blob_id);
});

test('AC12 (index): UTF-16 with BOM, invalid UTF-8, binary and unsupported formats get honest statuses; failed extraction is not reported as ready', async () => {
  const { registry, indexer } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Mixed', kind: 'mixed', classification: 'shared' });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Цена = 42\r\nИтог\r\n', 'utf16le')]);
  const files = {
    'u16.txt': utf16, 'bom.cs': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class Bom {}\n')]),
    'cp1251.txt': Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]), 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]),
    'spec.docx': Buffer.from('PK fake'), 'broken.xlsx': Buffer.from('not a zip'),
    'tail.txt': Buffer.concat([Buffer.from('valid line\n'.repeat(500)), Buffer.from([0xff, 0xfe, 0x0a])]),
  };
  const up = await uploadDirectory(registry, admin, source.id, files);
  await registry.completeUpload(admin, source.id, up.uploadId, 'complete-mixed');
  await indexer.drain();
  const reader = new SourceReader(registry);
  const state = (p: string) => reader.fileByPath(up.snapshotId, p)!.extraction_state;
  assert.equal(state('u16.txt'), 'indexed');
  assert.equal(state('bom.cs'), 'indexed');
  assert.equal(state('cp1251.txt'), 'unsupported_encoding');
  assert.equal(state('logo.png'), 'unsupported_format');
  assert.equal(state('spec.docx'), 'unsupported_format');
  assert.equal(state('broken.xlsx'), 'failed');
  assert.equal(state('tail.txt'), 'unsupported_encoding');
  assert.equal((registry.db.prepare('SELECT count(*) n FROM chunks WHERE file_id=?').get(reader.fileByPath(up.snapshotId, 'tail.txt')!.file_id) as { n: number }).n, 0, 'no partial rows of an unreadable file');
  const snapshot = registry.snapshotRow(up.snapshotId)!;
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.failure, 'partial_index');
  assert.equal(snapshot.unsupported_files, 4);
  assert.equal((await reader.readLines(up.snapshotId, reader.fileByPath(up.snapshotId, 'u16.txt')!.file_id, 1, 2)).lines[0].text, 'Цена = 42');
  assert.equal((await reader.readLines(up.snapshotId, reader.fileByPath(up.snapshotId, 'bom.cs')!.file_id, 1, 1)).lines[0].text, 'class Bom {}');
  await assert.rejects(reader.readLines(up.snapshotId, reader.fileByPath(up.snapshotId, 'cp1251.txt')!.file_id, 1, 1), (e: unknown) => status(e) === 422);
  // Partial coverage is an explicit, audited manager decision.
  registry.acceptCoverage(admin, source.id, up.snapshotId);
  assert.equal(registry.snapshotRow(up.snapshotId)!.state, 'ready');
  assert.ok(registry.auditPage().some(e => e.action === 'source.snapshot.accept_partial'));
});

test('AC12 (crash): an indexer that stops mid-way is resumed by another worker after lease expiry; storage outage keeps the job queued', async () => {
  const fixture = await sourceFixture();
  const { registry } = fixture;
  const source = registry.createSource(admin, { name: 'Crash', kind: 'code', classification: 'shared' });
  const up = await uploadDirectory(registry, admin, source.id, { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  await registry.completeUpload(admin, source.id, up.uploadId, 'complete-crash');
  // Simulate a worker that claimed the job and died.
  registry.db.prepare("UPDATE index_jobs SET state='running', lease_owner='dead', lease_until=? WHERE snapshot_id=?").run(Date.now() - 1, up.snapshotId);
  // Storage outage: indexing fails and is retried later without marking the snapshot ready.
  const broken = new SourceRegistry(path.join(fixture.root, 'data'), { store: { ...fixture.store, kind: 'filesystem-dev', stream: async () => { throw new BridgeError('down', 503); } } as never }, fixture.limits);
  const { SourceIndexer } = await import('../server/sources/indexer.js');
  await new SourceIndexer(broken, { workerId: 'w2' }).runOnce();
  assert.equal(registry.snapshotRow(up.snapshotId)!.state, 'indexing');
  assert.equal((registry.db.prepare('SELECT state FROM index_jobs WHERE snapshot_id=?').get(up.snapshotId) as { state: string }).state, 'queued');
  registry.db.prepare('UPDATE index_jobs SET lease_until=NULL WHERE snapshot_id=?').run(up.snapshotId);
  await fixture.indexer.drain();
  assert.equal(registry.snapshotRow(up.snapshotId)!.state, 'ready');
  const chunks = registry.db.prepare('SELECT count(*) n FROM chunks WHERE snapshot_id=?').get(up.snapshotId) as { n: number };
  assert.equal(chunks.n, 2, 'no duplicate rows after retries');
});

test('AC13 (uploads): cancel and expiry release reservation and delete only unreferenced objects', async () => {
  const { registry, root, indexer } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'GC', kind: 'code', classification: 'shared', quotaBytes: 100_000 });
  const kept = await uploadDirectory(registry, admin, source.id, { 'shared.txt': 'same content\n' });
  await registry.completeUpload(admin, source.id, kept.uploadId, 'complete-gc1');
  await indexer.drain();
  const before = await countObjects(path.join(root, 'objects'));
  const cancelled = await uploadDirectory(registry, admin, source.id, { 'shared.txt': 'same content\n', 'new.txt': 'new content\n', 'big.txt': 'z'.repeat(5000) });
  assert.equal(await countObjects(path.join(root, 'objects')), before + 2);
  await registry.cancelUpload(admin, source.id, cancelled.uploadId);
  assert.equal(registry.getSource(admin, source.id).reservedBytes, 0);
  assert.equal(registry.snapshotRow(cancelled.snapshotId)!.state, 'cancelled');
  assert.equal(await countObjects(path.join(root, 'objects')), before, 'reused object of the ready snapshot is kept');
  // Expiry of an abandoned session.
  let now = Date.now();
  const clock = new SourceRegistry(path.join(root, 'data2'), { store: registry.storage.store }, { ...registry.limits, uploadTtlMs: 1000, orphanGraceMs: 0 }, () => now);
  const s2 = clock.createSource(admin, { name: 'Exp', kind: 'code', classification: 'shared' });
  const abandoned = clock.createUpload(admin, s2.id, { idempotencyKey: 'expire-0001', label: 'E', totalFiles: 1, totalBytes: 10, exclusions: [] });
  now += 5000;
  await clock.collectGarbage();
  assert.equal(clock.uploadSummary(abandoned.id).state, 'expired');
  assert.equal(clock.getSource(admin, s2.id).reservedBytes, 0);
});

test('authorization: managers see only delegated sources; unknown and foreign ids are indistinguishable', async () => {
  const { registry } = await sourceFixture();
  const mine = registry.createSource(admin, { name: 'Mine', kind: 'code', classification: 'shared', managers: [{ userId: 'pm', actions: ['manage_source', 'upload_snapshot'] }] });
  const other = registry.createSource(admin, { name: 'Other', kind: 'code', classification: 'restricted' });
  const pm = { id: 'pm', admin: false };
  assert.deepEqual(registry.listSources(pm).map(s => s.id), [mine.id]);
  await rejects(() => registry.getSource(pm, other.id), 404);
  await rejects(() => registry.getSource(pm, 'src_' + randomUUID().replaceAll('-', '')), 404);
  await rejects(() => registry.createSource(pm, { name: 'X', kind: 'code', classification: 'shared' }), 403);
  await rejects(() => registry.deleteSource(pm, mine.id), 403);
  await rejects(() => registry.updateSource(pm, mine.id, { revision: 1, classification: 'restricted' }), 403);
  assert.equal(registry.updateSource(pm, mine.id, { revision: 1, description: 'ok' }).policyRevision, 2);
  await rejects(() => registry.updateSource(pm, mine.id, { revision: 1, description: 'stale' }), 409);
  assert.ok(registry.auditPage().some(e => e.action === 'source.denied'));
});

test('secrets: suspicious content pauses the file until excluded or an audited manager decision', async () => {
  const { registry } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Sec', kind: 'code', classification: 'shared' });
  const data = Buffer.from('const password = "SuperSecret123";\n');
  const upload = registry.createUpload(admin, source.id, { idempotencyKey: 'secret-0001', label: 'S', totalFiles: 1, totalBytes: data.length, exclusions: [] });
  registry.putManifest(admin, source.id, upload.id, { page: 0, last: true, entries: [{ path: 'cfg.ts', size: data.length, sha256: sha(data) }] });
  const file = registry.uploadStatus(admin, source.id, upload.id).files[0];
  await rejects(() => registry.putPart(admin, source.id, upload.id, file.fileId, 1, data), 409, /секрет/);
  await rejects(() => registry.putPart(admin, source.id, upload.id, file.fileId, 1, data), 409);
  registry.secretDecision(admin, source.id, upload.id, file.fileId, 'include');
  await registry.putPart(admin, source.id, upload.id, file.fileId, 1, data);
  assert.ok(registry.auditPage().some(e => e.action === 'source.upload.secret_include'));
});
