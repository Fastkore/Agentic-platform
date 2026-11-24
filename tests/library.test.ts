import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LibraryRegistry } from '../server/library/registry.js';
import { LibraryReader } from '../server/library/reader.js';
import { BridgeError } from '../server/store.js';
import { admin, current, libraryFixture, paths, startOperation, transfer, upload } from './library-helpers.js';

const status = (error: unknown) => (error as BridgeError).statusCode;
const rejects = async (work: () => unknown, code: number, message?: RegExp) => {
  await assert.rejects(async () => { await work(); }, (error: unknown) => {
    assert.equal(status(error), code, (error as Error).message);
    if (message) assert.match((error as Error).message, message);
    return true;
  });
};
const contentsProcessed = (registry: LibraryRegistry) => (registry.db.prepare('SELECT count(*) n FROM contents').get() as { n: number }).n;

test('a folder upload keeps structure, Cyrillic names and equal names in different folders; the content is published after processing', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Документация', description: 'Инструкции', profile: 'documents' });
  const files = { 'Заказы/Модуль.cs': 'class Orders {}\n', 'Склад/Модуль.cs': 'class Stock {}\n', 'readme.md': '# Привет\nВторая строка\n' };
  const started = startOperation(f.registry, admin, folder.id, files);
  assert.equal(started.summary.diff!.added, 3);
  await transfer(f.registry, admin, folder.id, started.operationId, started.entries);
  assert.equal(f.registry.currentState(folder.id), undefined, 'nothing is visible before completion');
  await f.registry.completeOperation(admin, folder.id, started.operationId, 'complete-1');
  assert.equal(f.registry.currentState(folder.id), undefined, 'nothing is visible before processing');
  assert.equal(f.registry.getFolder(admin, folder.id).operation!.status, 'preparing');
  await f.indexer.drain();
  const summary = f.registry.getFolder(admin, folder.id);
  assert.equal(summary.operation, undefined);
  assert.equal(summary.current!.files, 3);
  assert.ok(summary.updatedAt);
  assert.deepEqual(paths(f.registry, folder.id), ['readme.md', 'Заказы/Модуль.cs', 'Склад/Модуль.cs'].sort());
  const reader = new LibraryReader(f.registry);
  const state = current(f.registry, folder.id);
  const read = await reader.readLines(state.id, reader.fileByPath(state.id, 'Склад/Модуль.cs')!.file_id, 1, 5);
  assert.equal(read.lines[0].text, 'class Stock {}');
  const hits = reader.search([{ stateId: state.id, folderId: folder.id }], 'вторая строка', { mode: 'exact' });
  assert.deepEqual(hits.hits.map(h => [h.path, h.line]), [['readme.md', 2]]);
  assert.deepEqual(reader.search([{ stateId: state.id, folderId: folder.id }], 'модуль', { mode: 'files' }).hits.map(h => h.path), ['Заказы/Модуль.cs', 'Склад/Модуль.cs']);
  assert.deepEqual(f.registry.tree(state.id, '').entries.map(e => [e.name, e.type]), [['readme.md', 'file'], ['Заказы', 'dir'], ['Склад', 'dir']]);
});

test('"update from folder": the selected folder is the complete content — added, changed and removed; unchanged files are not sent or processed again', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Platform', profile: 'code' });
  const big = 'x'.repeat(5000) + '\n';
  await upload(f, folder.id, { 'a.cs': 'class A {}\n', 'b.cs': 'class B {}\n', 'big.txt': big });
  const first = current(f.registry, folder.id);
  const processed = contentsProcessed(f.registry);
  const update = startOperation(f.registry, admin, folder.id, { 'a.cs': 'class A { int x; }\n', 'big.txt': big, 'c.cs': 'class C {}\n' });
  assert.deepEqual(update.summary.diff, { added: 1, changed: 1, removed: 1 });
  assert.equal(update.summary.files.reused, 1, 'unchanged big.txt is not sent');
  const sent = await transfer(f.registry, admin, folder.id, update.operationId, update.entries);
  assert.equal(sent.files, 2);
  await f.registry.completeOperation(admin, folder.id, update.operationId, 'complete-2');
  assert.equal(current(f.registry, folder.id).id, first.id, 'the previous content stays current while the update is prepared');
  await f.indexer.drain();
  assert.deepEqual(paths(f.registry, folder.id), ['a.cs', 'big.txt', 'c.cs']);
  assert.equal(contentsProcessed(f.registry), processed + 2, 'only the changed and the new content were processed');
  assert.equal(f.registry.stateRow(first.id)!.status, 'superseded');
  // Old states are no longer offered and are removed by the collector; current objects stay.
  await f.registry.collectGarbage({ graceMs: 0 });
  assert.equal(f.registry.stateRow(first.id)!.status as string, 'removed');
  const reader = new LibraryReader(f.registry);
  const now = current(f.registry, folder.id);
  assert.ok((await reader.readLines(now.id, reader.fileByPath(now.id, 'big.txt')!.file_id, 1, 1)).lines[0].text.startsWith('x'.repeat(2000)), 'long lines are shortened on reading');
  assert.deepEqual(reader.search([{ stateId: now.id, folderId: folder.id }], 'class B', {}).hits, [], 'the removed file is not found');
});

test('an identical folder gives "Библиотека актуальна": no new content, no processing, no duplicates', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Docs' });
  const files = { 'one.txt': 'один\n', 'two/two.txt': 'два\n' };
  await upload(f, folder.id, files);
  const before = current(f.registry, folder.id).id;
  const processed = contentsProcessed(f.registry);
  const again = startOperation(f.registry, admin, folder.id, files);
  assert.equal(again.summary.status, 'unchanged');
  assert.equal(again.summary.reservedBytes, 0);
  await f.registry.completeOperation(admin, folder.id, again.operationId, 'complete-unchanged');
  await f.indexer.drain();
  assert.equal(current(f.registry, folder.id).id, before);
  assert.equal(contentsProcessed(f.registry), processed);
  assert.equal((f.registry.db.prepare("SELECT count(*) n FROM states WHERE folder_id=?").get(folder.id) as { n: number }).n, 1);
  assert.equal(f.registry.getFolder(admin, folder.id).operation, undefined, 'the folder is free for the next operation');
});

test('"add files" keeps the other materials and replaces files with the same path; "remove file" respects rights and publishes at once', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Договоры', managers: [{ userId: 'viewer', actions: ['manage'] }] });
  await upload(f, folder.id, { '2025/a.txt': 'a\n', '2025/b.txt': 'b\n' });
  const added = await upload(f, folder.id, { '2025/b.txt': 'b2\n', '2026/c.txt': 'c\n' }, { mode: 'add' });
  assert.deepEqual(added.summary.diff, { added: 1, changed: 1, removed: 0 });
  assert.deepEqual(paths(f.registry, folder.id), ['2025/a.txt', '2025/b.txt', '2026/c.txt']);
  const reader = new LibraryReader(f.registry);
  const state = current(f.registry, folder.id);
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, '2025/b.txt')!.file_id, 1, 1)).lines[0].text, 'b2');
  await rejects(() => f.registry.removeFiles({ id: 'viewer', admin: false }, folder.id, { paths: ['2025/a.txt'] }), 403);
  await rejects(() => f.registry.removeFiles({ id: 'stranger', admin: false }, folder.id, { paths: ['2025/a.txt'] }), 404);
  const removed = f.registry.removeFiles(admin, folder.id, { paths: ['2025/a.txt'] });
  assert.equal(removed.removed, 1);
  assert.equal(removed.operation.status, 'complete');
  assert.deepEqual(paths(f.registry, folder.id), ['2025/b.txt', '2026/c.txt']);
  await rejects(() => f.registry.removeFiles(admin, folder.id, { paths: ['missing.txt'] }), 404);
});

test('one operation per folder: a second one gets 409; an update based on replaced content is rejected; cancel frees the folder', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Shared', managers: [{ userId: 'm2', actions: ['upload'] }] });
  await upload(f, folder.id, { 'a.txt': 'a\n' });
  const first = startOperation(f.registry, admin, folder.id, { 'a.txt': 'a1\n' });
  await rejects(() => startOperation(f.registry, { id: 'm2', admin: false }, folder.id, { 'a.txt': 'a2\n' }), 409, /уже обновляется/);
  await rejects(() => f.registry.removeFiles(admin, folder.id, { paths: ['a.txt'] }), 409);
  // Idempotent retry of the same request returns the same operation.
  await f.registry.cancelOperation(admin, folder.id, first.operationId);
  const second = startOperation(f.registry, { id: 'm2', admin: false }, folder.id, { 'a.txt': 'a2\n' });
  await transfer(f.registry, { id: 'm2', admin: false }, folder.id, second.operationId, second.entries);
  // Meanwhile the content changes (simulated by publishing another state directly): the stale update is rejected.
  f.registry.db.prepare('UPDATE operations SET base_state=? WHERE id=?').run('st_other', second.operationId);
  await rejects(() => f.registry.completeOperation({ id: 'm2', admin: false }, folder.id, second.operationId, 'complete-stale'), 409, /уже обновлена/);
  assert.equal(paths(f.registry, folder.id).length, 1);
});

test('an interrupted transfer resumes after a restart without re-sending confirmed parts; a changed file is detected', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Resume' });
  const data = Buffer.from('0123456789'.repeat(400));
  const started = startOperation(f.registry, admin, folder.id, { 'big.bin.txt': data, 'small.txt': 'small\n' });
  const file = f.registry.operationStatus(admin, folder.id, started.operationId).files.find(x => x.path === 'big.bin.txt')!;
  await f.registry.putPart(admin, folder.id, started.operationId, file.fileId, 1, data.subarray(0, 1024));
  await rejects(() => f.registry.putPart(admin, folder.id, started.operationId, file.fileId, 1, Buffer.alloc(1024, 1)), 409, /другим содержимым/);
  const small = f.registry.operationStatus(admin, folder.id, started.operationId).files.find(x => x.path === 'small.txt')!;
  await rejects(() => f.registry.putPart(admin, folder.id, started.operationId, small.fileId, 1, Buffer.from('SMALL\n')), 409, /изменился/);
  f.registry.close();
  const registry = new LibraryRegistry(path.join(f.root, 'data'), { store: f.store }, f.limits);
  const resumed = await transfer(registry, admin, folder.id, started.operationId, started.entries);
  assert.ok(resumed.parts < Math.ceil(data.length / 1024) + 1, 'confirmed parts are not sent again');
  await registry.completeOperation(admin, folder.id, started.operationId, 'complete-resume');
  await registry.completeOperation(admin, folder.id, started.operationId, 'complete-resume');
  await rejects(() => registry.completeOperation(admin, folder.id, started.operationId, 'complete-other'), 409);
});

test('hostile paths, encoded separators, Unicode and case collisions are rejected before any byte is accepted', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Paths' });
  const attempt = async (files: Record<string, string>, code: number) => {
    const operation = f.registry.createOperation(admin, folder.id, { idempotencyKey: 'k' + Math.random().toString(36).slice(2, 12), mode: 'replace', totalFiles: Object.keys(files).length,
      totalBytes: 2, exclusions: [] });
    await rejects(() => f.registry.putManifest(admin, folder.id, operation.id, { page: 0, last: true, entries: Object.keys(files).map(p => ({ path: p, size: 1, sha256: 'a'.repeat(64) })) }), code);
    await f.registry.cancelOperation(admin, folder.id, operation.id);
  };
  for (const bad of ['../x.txt', '/etc/passwd', 'C:/x.txt', 'a%2Fb', 'a\\b', 'CON.txt', 'a//b']) await attempt({ [bad]: 'x' }, 400);
  await attempt({ 'Docs/A.txt': 'a', 'docs/a.txt': 'b' }, 409);
});

test('quota: the logical size of the new content is checked in full, physical space is reserved only for missing objects', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Quota', quotaBytes: 3000 });
  const big = 'q'.repeat(1400) + '\n';
  await upload(f, folder.id, { 'a.txt': big, 'b.txt': big.replace(/q/g, 'w') });
  // 2.8 KB stored: an update that adds a small file still fits, because unchanged files reserve nothing.
  const update = startOperation(f.registry, admin, folder.id, { 'a.txt': big, 'b.txt': big.replace(/q/g, 'w'), 'c.txt': 'c\n' });
  assert.equal(update.summary.reservedBytes, 2);
  await f.registry.cancelOperation(admin, folder.id, update.operationId);
  await rejects(() => startOperation(f.registry, admin, folder.id, { 'a.txt': big, 'b.txt': big, 'c.txt': big }), 413);
});

test('a file over the processing budget gets "timeout", the rest is processed, the current content stays; retry or explicit acceptance publish it', async () => {
  const f = await libraryFixture({ limits: { partBytes: 8 * 1024 * 1024 }, fileTimeoutMs: 75 });
  const folder = f.registry.createFolder(admin, { name: 'Budget' });
  await upload(f, folder.id, { 'a.txt': 'old\n' });
  const before = current(f.registry, folder.id).id;
  const opened: { destroyed: boolean }[] = [];
  const stream = f.store.stream.bind(f.store);
  f.store.stream = (async (...args: Parameters<typeof stream>) => { const s = await stream(...args); opened.push(s); return s; }) as typeof stream;
  const huge = Buffer.from('строка с текстом для индекса номер\n'.repeat(400_000));
  const files: Record<string, Buffer | string> = { 'a.txt': 'new\n', 'big/huge.txt': huge };
  // Neither UTF-8 nor Windows-1251 (0x98 is undefined there): rejected files.
  for (let i = 0; i < 60; i++) files[`legacy/cp${i}.cs`] = Buffer.concat([Buffer.from([0xcf, 0xf0, 0x98, 0xe2, 0xe5, 0xf2, 0x0a]), Buffer.from(String(i))]);
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 1);
  await upload(f, folder.id, files);
  clearInterval(heartbeat);
  assert.ok(beats > 0, 'the main thread stays responsive');
  assert.ok(opened.length > 60 && opened.every(s => s.destroyed), 'every object stream is closed, also for rejected files');
  const summary = f.registry.getFolder(admin, folder.id);
  assert.equal(current(f.registry, folder.id).id, before, 'a failed update does not leave the folder half updated');
  assert.equal(summary.failed!.failure, 'partial_index');
  assert.deepEqual(f.registry.problems(summary.failed!.stateId).counts, { timeout: 1, unsupported_encoding: 60 });
  await f.indexer.stop();
  // «Повторить обработку» with the normal budget.
  const { LibraryIndexer } = await import('../server/library/indexer.js');
  const normal = new LibraryIndexer(f.registry, { workerId: 'normal' });
  f.registry.retry(admin, folder.id);
  await normal.drain();
  await normal.stop();
  const after = f.registry.getFolder(admin, folder.id);
  assert.equal(after.failed, undefined);
  assert.equal(after.current!.files, 62);
  assert.equal(after.current!.unsupported, 60);
  const reader = new LibraryReader(f.registry);
  const state = current(f.registry, folder.id);
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, 'big/huge.txt')!.file_id, 399_999, 1)).lines[0].text, 'строка с текстом для индекса номер');
});

test('encodings: UTF-16 with BOM, invalid UTF-8, binary, scanned PDF and unsupported formats get honest per-file statuses', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Mixed', profile: 'documents' });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Цена = 42\r\nИтог\r\n', 'utf16le')]);
  await upload(f, folder.id, {
    'u16.txt': utf16, 'bom.cs': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class Bom {}\n')]),
    'cp1251.txt': Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3b, 0x31, 0x0a]), 'koi8.txt': Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4, 0x81, 0x98, 0x0a]),
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]),
    'slides.pptx': Buffer.from('PK fake'), 'noext': Buffer.from([1, 2, 0, 3]),
  });
  const state = current(f.registry, folder.id);
  const reader = new LibraryReader(f.registry);
  const st = (p: string) => reader.fileByPath(state.id, p)!.extraction_state;
  assert.equal(st('u16.txt'), 'indexed');
  assert.equal(st('bom.cs'), 'indexed');
  assert.equal(st('cp1251.txt'), 'indexed', 'Windows-1251 text is converted');
  assert.equal(st('koi8.txt'), 'unsupported_encoding');
  assert.equal(st('logo.png'), 'unsupported_format');
  assert.equal(st('slides.pptx'), 'unsupported_format');
  assert.equal(st('noext'), 'unsupported_format');
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, 'u16.txt')!.file_id, 1, 2)).lines[0].text, 'Цена = 42');
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, 'bom.cs')!.file_id, 1, 1)).lines[0].text, 'class Bom {}');
  assert.equal((await reader.readLines(state.id, reader.fileByPath(state.id, 'cp1251.txt')!.file_id, 1, 1)).lines[0].text, 'Привет;1');
  assert.equal(reader.search([{ stateId: state.id, folderId: folder.id }], 'привет').hits[0].path, 'cp1251.txt');
  await rejects(() => reader.readLines(state.id, reader.fileByPath(state.id, 'koi8.txt')!.file_id, 1, 1), 422);
  assert.equal(f.registry.getFolder(admin, folder.id).current!.unsupported, 4, 'unsupported files are coverage, not failures');
});

test('a replaced content is kept while a running answer reads it and removed afterwards; the current objects are never removed', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Held' });
  await upload(f, folder.id, { 'a.txt': 'first\n' });
  const first = current(f.registry, folder.id);
  f.registry.db.prepare('INSERT INTO run_scopes VALUES (?,?,?,?,?,?,NULL)').run('run-1', 'p', 'u', 'prof', JSON.stringify({ entries: [{ folderId: folder.id, stateId: first.id }] }), Date.now());
  await upload(f, folder.id, { 'a.txt': 'second\n' });
  await f.registry.collectGarbage({ graceMs: 0 });
  const reader = new LibraryReader(f.registry);
  assert.equal((await reader.readLines(first.id, reader.fileByPath(first.id, 'a.txt')!.file_id, 1, 1)).lines[0].text, 'first', 'the running answer finishes with its content');
  f.registry.db.prepare('UPDATE run_scopes SET finished_at=? WHERE run_id=?').run(Date.now(), 'run-1');
  const result = await f.registry.collectGarbage({ graceMs: 0 });
  assert.ok(result.deleted >= 1);
  assert.equal(reader.fileByPath(first.id, 'a.txt'), undefined);
  const now = current(f.registry, folder.id);
  assert.equal((await reader.readLines(now.id, reader.fileByPath(now.id, 'a.txt')!.file_id, 1, 1)).lines[0].text, 'second');
  assert.equal((await f.registry.verifyObjects(folder.id)).missing.length, 0);
});

test('deleting a folder removes it from every project and collects its objects', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Gone', managers: [{ userId: 'm', actions: ['manage'] }] });
  await upload(f, folder.id, { 'a.txt': 'a\n' });
  f.registry.db.prepare("INSERT INTO connections VALUES ('p1', ?, 1, 'explanation_only', 1, 'now')").run(folder.id);
  await rejects(() => f.registry.deleteFolder({ id: 'm', admin: false }, folder.id, folder.revision), 403);
  const deleted = f.registry.deleteFolder(admin, folder.id, f.registry.getFolder(admin, folder.id).revision);
  assert.deepEqual(deleted.projects, ['p1']);
  assert.equal((f.registry.db.prepare('SELECT count(*) n FROM connections').get() as { n: number }).n, 0);
  await rejects(() => f.registry.getFolder(admin, folder.id), 404);
  await f.registry.collectGarbage({ graceMs: 0 });
  assert.equal((f.registry.db.prepare("SELECT count(*) n FROM blobs WHERE state='verified' AND folder_id=?").get(folder.id) as { n: number }).n, 0);
});

test('search: an extra word does not empty the result; lines with more words come first; several files are visible on the first page', async () => {
  const f = await libraryFixture();
  const folder = f.registry.createFolder(admin, { name: 'Поиск', profile: 'documents' });
  const noisy = Array.from({ length: 60 }, (_, i) => `Строка ${i}: Suspended флаг в журнале`).join('\n') + '\n';
  await upload(f, folder.id, {
    'A/log.md': noisy,
    'B/notes.md': 'Приостановка операции: статус Suspended не высвобождает станок.\n',
    'Z/guide.md': 'Обычная строка\nПриостановленная операция Suspended сохраняет ресурс станок за собой.\n',
    'Z/brief.md': 'Особый код: ЁЖ.\n',
  });
  const reader = new LibraryReader(f.registry);
  const target = [{ stateId: current(f.registry, folder.id).id, folderId: folder.id }];
  const single = reader.search(target, 'станок', { mode: 'fulltext' });
  const extra = reader.search(target, 'станок абракадабра', { mode: 'fulltext' });
  assert.equal(single.hits.length, 2);
  assert.deepEqual(extra.hits.map(h => h.path), single.hits.map(h => h.path), 'a word with no matches does not remove matches of the other');
  const ranked = reader.search(target, 'Suspended станок', { mode: 'fulltext' });
  assert.deepEqual(ranked.hits.slice(0, 2).map(h => h.path).sort(), ['B/notes.md', 'Z/guide.md'], 'lines with both words first');
  const exact = reader.search(target, 'Suspended');
  assert.equal(exact.filesMatched, 3);
  assert.deepEqual([...new Set(exact.hits.map(h => h.path))].sort(), ['A/log.md', 'B/notes.md', 'Z/guide.md'], 'a file sorted last is still on the first page');
  assert.equal(exact.hits.length, 20);
  const rest: string[] = [];
  for (let cursor = exact.next; cursor !== undefined;) { const page = reader.search(target, 'Suspended', { offset: cursor }); rest.push(...page.hits.map(h => h.path + ':' + h.line)); cursor = page.next; }
  const all = [...exact.hits.map(h => h.path + ':' + h.line), ...rest];
  assert.equal(all.length, 62); assert.equal(new Set(all).size, 62, 'pages continue without repeats or gaps');
  assert.deepEqual(reader.search(target, 'станок ёж', { mode: 'fulltext' }).hits.map(h => h.path), ['B/notes.md', 'Z/brief.md', 'Z/guide.md']);
  assert.equal(reader.search(target, 'ёж').hits[0]?.path, 'Z/brief.md');
  const allowed = [{ ...target[0], allow: new Set(['Z/guide.md']) }];
  assert.deepEqual(reader.search(allowed, 'Suspended').hits.map(h => h.path), ['Z/guide.md']);
});
