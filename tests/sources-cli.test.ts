import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import { FilesystemSourceBlobStore } from '../server/sources/blob-store.js';
import type { CodexRunner } from '../server/codex.js';
import { defaultExclusions } from '../shared/sources.js';
// @ts-expect-error plain ESM utility without type declarations
import { DEFAULT_EXCLUSIONS, run, scan } from '../tools/source-upload.mjs';

async function server() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sources-cli-'));
  await mkdir(path.join(root, 'project'));
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async () => ({ response: 'OK' }) };
  const workspace = new Workspace(new Store(path.join(root, 'data')), runner);
  workspace.useSourceStorage({ store: new FilesystemSourceBlobStore(path.join(root, 'objects')) });
  const app = await createApp(workspace);
  const local = { host: 'localhost', 'x-bridge-local': '1' };
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: local })).json();
  const admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.token }, payload: { username: 'admin', name: 'Руководитель', password: 'Cli-test-password-2026' } })).json().token as string;
  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: 'Bearer ' + token }, ...(payload === undefined ? {} : { payload }) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  return { root, app, workspace, admin, req, url: `http://127.0.0.1:${address.port}` };
}

test('local utility: same exclusions, no symlinks or junctions, scoped short-lived token, dry-run, upload, resume and report', async () => {
  assert.deepEqual(DEFAULT_EXCLUSIONS, defaultExclusions);
  const s = await server();
  try {
    const folder = path.join(s.root, 'Business'), outside = path.join(s.root, 'outside');
    await mkdir(path.join(folder, 'Orders'), { recursive: true }); await mkdir(path.join(folder, '.git')); await mkdir(outside);
    await writeFile(path.join(folder, 'Orders', 'Discount.cs'), 'class Discount { decimal CalculateDiscount() => 0; }\n');
    await writeFile(path.join(folder, 'Orders', 'Big.txt'), 'x'.repeat(12 * 1024 * 1024));
    await writeFile(path.join(folder, '.git', 'config'), '[core]');
    await writeFile(path.join(folder, 'appsettings.json'), '{ "password": "VerySecret123" }');
    await writeFile(path.join(folder, 'Settings.export'), 'password = "SyntheticSample123"');
    await writeFile(path.join(outside, 'secret.txt'), 'outside root');
    await symlink(outside, path.join(folder, 'linked-dir'), 'dir');
    await symlink(path.join(outside, 'secret.txt'), path.join(folder, 'linked.txt'));
    const preview = await scan(folder);
    assert.deepEqual(preview.files.map((f: { path: string }) => f.path), ['Orders/Big.txt', 'Orders/Discount.cs']);
    const reasons = Object.fromEntries(preview.skipped.map((x: { path: string; reason: string }) => [x.path, x.reason]));
    assert.equal(reasons['linked-dir'], 'symlink');
    assert.equal(reasons['linked.txt'], 'symlink');
    assert.equal(reasons['.git/'], 'excluded:.git/');
    assert.match(reasons['appsettings.json'], /^secret:/);
    assert.match(reasons['Settings.export'], /^secret:/);
    const dry = await run({ folder, dryRun: true });
    assert.equal(dry.files, 2);
    assert.equal(dry.dryRun, true);

    const { source } = (await s.req('POST', '/api/admin/sources', s.admin, { name: 'CLI', kind: 'code', classification: 'shared' })).json();
    const issued = await s.req('POST', `/api/admin/sources/${source.id}/upload-tokens`, s.admin, { ttlMinutes: 30 });
    assert.equal(issued.statusCode, 201, issued.body);
    const token = issued.json().token as string;
    // The token works only for upload routes of its source.
    assert.equal((await s.req('GET', '/api/admin/sources', token)).statusCode, 401);
    assert.equal((await s.req('GET', '/api/status', token)).statusCode, 401);
    assert.equal((await s.req('POST', `/api/admin/sources/${source.id}/upload-tokens`, token, {})).statusCode, 401);
    const other = (await s.req('POST', '/api/admin/sources', s.admin, { name: 'Other', kind: 'code', classification: 'shared' })).json().source;
    assert.equal((await s.req('POST', `/api/admin/sources/${other.id}/uploads`, token, { idempotencyKey: 'abcdefgh12', label: 'x', totalFiles: 1, totalBytes: 1, exclusions: [] })).statusCode, 401);

    // Interrupted after the first part; the second run resumes from the state file without resending confirmed parts.
    const state = path.join(s.root, 'state.json');
    let parts = 0;
    await assert.rejects(run({ folder, server: s.url, source: source.id, label: '1.0', token, state, concurrency: 1,
      progress: () => { if (++parts === 1) throw new Error('connection lost'); } }), /connection lost/);
    const resumed = await run({ folder, server: s.url, source: source.id, label: '1.0', token, state, concurrency: 1 });
    assert.equal(resumed.files, 2);
    assert.ok(resumed.partsSent < 3, 'already confirmed parts are not resent: ' + resumed.partsSent);
    await s.workspace.sources.indexer.drain();
    assert.equal(s.workspace.sources.registry.snapshotRow(resumed.snapshotId)!.state, 'ready');
    // Refreshing unchanged contents reuses the exact snapshot and does not trigger another indexing job.
    const again = await run({ folder, server: s.url, source: source.id, update: true, token, state: path.join(s.root, 'state2.json') });
    assert.equal(again.partsSent, 0);
    assert.equal(again.reused, 2);
    assert.equal(again.snapshotId, resumed.snapshotId);
    assert.equal(again.unchanged, true);
    const base = { id: 'boss', admin: true };
    assert.equal(s.workspace.sources.registry.listSnapshots(base, source.id).filter(row => row.state !== 'cancelled').length, 1);
    await writeFile(path.join(folder, 'Orders', 'Discount.cs'), 'class Discount { decimal CalculateDiscount() => 10; }\n');
    const changed = await run({ folder, server: s.url, source: source.id, update: true, token, state: path.join(s.root, 'state-changed.json') });
    assert.equal(changed.unchanged, false);
    assert.notEqual(changed.snapshotId, resumed.snapshotId);
    assert.equal(changed.partsSent, 1);
    assert.equal(changed.reused, 1);
    // Revoked and expired tokens stop working.
    assert.equal((await s.req('DELETE', `/api/admin/sources/${source.id}/upload-tokens`, s.admin)).statusCode, 200);
    await assert.rejects(run({ folder, server: s.url, source: source.id, label: '1.2', token, state: path.join(s.root, 'state3.json') }), /недействителен|истёк/);
    assert.ok(s.workspace.sources.registry.auditPage().some(e => e.action === 'source.token.issue'));
    await rm(path.join(folder, 'linked-dir'));
  } finally { await s.app.close(); }
});
