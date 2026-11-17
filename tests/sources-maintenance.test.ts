import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupSources, resumeCollector, verifyRestore } from '../server/sources/backup.js';
import { applyLegacyMigration, importServerDirectory, legacyReport, type LegacyDirectory } from '../server/sources/legacy.js';
import { SourcePolicy, type PlatformDirectory } from '../server/sources/policy.js';
import { SourceRegistry } from '../server/sources/registry.js';
import { BridgeError } from '../server/store.js';
import type { AgentProfile, Dataset, WorkRole } from '../shared/types.js';
import { admin, sourceFixture, uploadDirectory } from './sources-helpers.js';

const directory = (projects: string[]): PlatformDirectory => ({
  projectExists: id => projects.includes(id), projectName: id => id, canAccessProject: () => true,
  connectedProfiles: () => [{ id: 'universal', name: 'Помощник' }], canUseProfile: () => true, closedAnalysisVerified: () => false,
});
const code = (error: unknown) => (error as BridgeError).statusCode;

test('AC13/F3: consistent backup, collector pause, restore verification and index rebuild', async () => {
  const f = await sourceFixture({ limits: { orphanGraceMs: 0 } });
  const source = f.registry.createSource(admin, { name: 'Backup', kind: 'code', classification: 'shared' });
  const up = await uploadDirectory(f.registry, admin, source.id, { 'a.cs': 'class A {}\n', 'b.cs': 'class B {}\n' });
  await f.registry.completeUpload(admin, source.id, up.uploadId, 'complete-backup');
  await f.indexer.drain();
  const target = path.join(f.root, 'backup');
  const summary = await backupSources({ dataRoot: path.join(f.root, 'data'), target, store: f.store });
  assert.equal(summary.objects, 2);
  assert.deepEqual(summary.missingAtBackup, []);
  assert.ok(f.registry.collectorPaused(), 'the running server sees the pause');
  // While paused, a cancelled upload's objects are not deleted.
  const cancelled = await uploadDirectory(f.registry, admin, source.id, { 'c.cs': 'class C {}\n' });
  await f.registry.cancelUpload(admin, source.id, cancelled.uploadId);
  assert.ok((f.registry.db.prepare("SELECT count(*) n FROM blobs WHERE state='orphan'").get() as { n: number }).n >= 1);
  resumeCollector(path.join(f.root, 'data'));
  assert.equal((await f.registry.collectGarbage({ graceMs: 0 })).deleted, 1);
  // Restore: the database copy is consistent and every referenced object is present.
  const restored = path.join(f.root, 'restored');
  await mkdir(restored);
  await cp(path.join(target, 'sources.sqlite'), path.join(restored, 'sources.sqlite'));
  const ok = await verifyRestore({ dataRoot: restored, store: f.store, deep: true, reindex: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 2);
  assert.equal(ok.requeued, 1);
  // A missing object is reported with the affected snapshot.
  const objects = JSON.parse(await readFile(path.join(target, 'objects.json'), 'utf8')) as { key: string }[];
  await unlink(path.join(f.root, 'objects', ...objects[0].key.split('/')));
  const broken = await verifyRestore({ dataRoot: restored, store: f.store });
  assert.equal(broken.ok, false);
  assert.equal(broken.affectedSnapshots[0].id, up.snapshotId);
  const reopened = new SourceRegistry(restored, { store: f.store }, f.limits);
  assert.equal(reopened.snapshotRow(up.snapshotId)!.state, 'ready');
  reopened.close();
});

test('AC13/F2: used sources and snapshots are protected; retention archives only old unbound versions; shared objects survive', async () => {
  const f = await sourceFixture({ limits: { orphanGraceMs: 0 } });
  const policy = new SourcePolicy(f.registry, directory(['p1', 'p2']));
  const source = f.registry.createSource(admin, { name: 'Ret', kind: 'code', classification: 'shared' });
  const versions: string[] = [];
  for (const [i, content] of ['v1', 'v2', 'v3', 'v4'].entries()) {
    const up = await uploadDirectory(f.registry, admin, source.id, { 'same.cs': 'shared\n', 'v.cs': content + '\n' }, { label: 'v' + (i + 1) });
    await f.registry.completeUpload(admin, source.id, up.uploadId, 'complete-ret-' + i);
    versions.push(up.snapshotId);
  }
  await f.indexer.drain();
  f.registry.db.prepare('UPDATE snapshots SET uploaded_at=? WHERE id IN (?,?)').run('2020-01-01T00:00:00.000Z', versions[0], versions[1]);
  const p1 = policy.attach(admin, 'p1', { sourceId: source.id, selector: 'pinned', snapshotId: versions[0] });
  policy.attach(admin, 'p2', { sourceId: source.id, selector: 'pinned', snapshotId: versions[3] });
  assert.throws(() => f.registry.archiveSnapshot(admin, source.id, versions[0], id => policy.isBound(id)), (e: unknown) => code(e) === 409);
  f.registry.archiveSource(admin, source.id, 1);
  assert.throws(() => f.registry.deleteSource(admin, source.id), (e: unknown) => code(e) === 409 && /подключён к проектам: 2/.test((e as Error).message));
  // Retention keeps the newest one, skips v1 (bound to p1) and v3 (too new), archives v2.
  const result = f.registry.applyRetention({ keep: 1, minAgeDays: 30 }, id => policy.isBound(id));
  assert.deepEqual(result.archived, [versions[1]]);
  await f.registry.collectGarbage({ graceMs: 0 });
  const live = (f.registry.db.prepare("SELECT count(*) n FROM blobs WHERE state='verified'").get() as { n: number }).n;
  assert.equal(live, 4, 'shared same.cs and v1/v3/v4 objects remain; only v2.cs object is collected');
  // Detaching everything allows deletion; objects with zero references are collected.
  policy.detach(admin, 'p1', p1.id, policy.binding(p1.id)!.revision);
  const p2 = (f.registry.db.prepare("SELECT id, revision FROM bindings WHERE project_id='p2'").get() as { id: string; revision: number });
  policy.detach(admin, 'p2', p2.id, p2.revision);
  f.registry.deleteSource(admin, source.id);
  assert.equal((await f.registry.collectGarbage({ graceMs: 0 })).deleted, 4);
});

test('F5: legacy datasets migrate once into sources with disabled bindings and no grants; registered server folder is imported without following links', async () => {
  const f = await sourceFixture();
  const policy = new SourcePolicy(f.registry, directory(['p1']));
  const folder = path.join(f.root, 'legacy');
  await mkdir(path.join(folder, 'src'), { recursive: true });
  await writeFile(path.join(folder, 'src', 'Order.cs'), 'class Order {}\n');
  await writeFile(path.join(folder, '.env'), 'SECRET=1');
  const datasets: Dataset[] = [{ id: 'erp', name: 'ERP', directory: folder, projectIds: ['p1', 'gone'], classification: 'restricted', revision: 1 }];
  const legacy: LegacyDirectory = { datasets: () => datasets, projectExists: id => id === 'p1',
    profiles: () => [{ id: 'estimator', datasetIds: ['erp'] } as AgentProfile], roles: () => [{ id: 'employee', readDatasetIds: ['erp'] } as WorkRole] };
  const report = legacyReport(legacy, f.registry);
  assert.deepEqual(report.items[0].plan.bindings, ['p1']);
  assert.deepEqual(report.items[0].missingProjects, ['gone']);
  assert.equal(report.items[0].plan.grants, 0);
  assert.throws(() => applyLegacyMigration({ id: 'pm', admin: false }, legacy, f.registry, policy), (e: unknown) => code(e) === 403);
  const applied = applyLegacyMigration(admin, legacy, f.registry, policy);
  assert.throws(() => applyLegacyMigration(admin, legacy, f.registry, policy), (e: unknown) => code(e) === 409);
  const sourceId = applied.created[0].sourceId;
  const binding = policy.binding(applied.created[0].bindings[0])!;
  assert.equal(binding.enabled, 0, 'bindings start disabled');
  assert.equal(f.registry.db.prepare('SELECT count(*) n FROM grants').get()!.n, 0, 'old read rights are not widened into grants');
  assert.equal(f.registry.sourceInfo(sourceId)!.classification, 'restricted');
  const dry = await importServerDirectory(admin, f.registry, folder, sourceId, 'legacy-1', { dryRun: true });
  assert.equal(dry.preview.files, 1);
  assert.ok(dry.preview.skipped.some(s => s.path === '.env'));
  const imported = await importServerDirectory(admin, f.registry, folder, sourceId, 'legacy-1');
  await f.indexer.drain();
  assert.equal(f.registry.snapshotRow(imported.upload!.snapshotId)!.state, 'ready');
  await assert.rejects(importServerDirectory({ id: 'pm', admin: false }, f.registry, folder, sourceId, 'x'), (e: unknown) => code(e) === 403);
});

test('migrations are versioned and repeatable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sources-migrate-'));
  const first = new SourceRegistry(root, {});
  assert.equal(first.schemaVersion, 5);
  first.close();
  const second = new SourceRegistry(root, {});
  assert.equal(second.schemaVersion, 5);
  second.db.exec('PRAGMA user_version=99');
  second.close();
  assert.throws(() => new SourceRegistry(root, {}), /более новой версией/);
});
