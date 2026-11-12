import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import type { CodexRunner } from '../server/codex.js';
const session = '87db344a-98f3-42c8-bba8-c7d9f3dcff11';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { const deadline = Date.now() + 7000; while (!check()) { if (Date.now() > deadline) throw Error('timeout'); await pause(10); } }
function runner(calls: string[] = []): CodexRunner {
  return { inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async (r, onEvent, signal) => {
    calls.push(r.prompt); if (calls.length > 1) assert.equal(r.sessionId, session);
    await onEvent({ kind: 'session', text: session });
    if (r.prompt === 'BLOCK') await new Promise<void>((resolve, reject) => { if (signal.aborted) reject(Error('aborted')); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    await pause(80); return { sessionId: session, response: r.prompt };
  } };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-queue-')); await mkdir(path.join(root, 'project'));
  const store = new Store(path.join(root, 'data')), calls: string[] = [], workspace = new Workspace(store, runner(calls));
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(path.join(root, 'project')), chat = await workspace.addChat(project.id);
  return { root, store, calls, workspace, project, chat };
}
test('durable queue serializes turns and concurrent idempotency survives reload', async () => {
  const f = await fixture();
  try {
    const [a, duplicate, b] = await Promise.all([
      f.workspace.send(f.project.id, f.chat.id, 'first', [], 'request-a'),
      f.workspace.send(f.project.id, f.chat.id, 'first', [], 'request-a'),
      f.workspace.send(f.project.id, f.chat.id, 'second', [], 'request-b')
    ]);
    assert.equal(a.id, duplicate.id); assert.equal(b.status, 'queued'); assert.equal(f.store.state.jobs!.length, 2);
    await assert.rejects(f.workspace.send(f.project.id, f.chat.id, 'different', [], 'request-a'), /другим содержимым/);
    await until(() => !f.workspace.busy); assert.deepEqual(f.calls, ['first', 'second']); assert.equal(f.chat.messages.length, 4);
    await f.workspace.shutdown();
    const store = new Store(f.store.root), next = new Workspace(store, runner());
    try { const same = await next.send(f.project.id, f.chat.id, 'first', [], 'request-a'); assert.equal(same.id, a.id); assert.equal(store.state.runs.length, 2); }
    finally { await next.shutdown(); }
  } finally { await f.workspace.shutdown(); }
});
test('queued work survives shutdown; cancelled queue entries never execute', async () => {
  const f = await fixture();
  const a = await f.workspace.send(f.project.id, f.chat.id, 'BLOCK', []);
  await until(() => f.calls.length === 1);
  const b = await f.workspace.send(f.project.id, f.chat.id, 'resume after restart', []);
  const c = await f.workspace.send(f.project.id, f.chat.id, 'never run', []);
  await f.workspace.cancel(c.id); await f.workspace.shutdown();
  const store = new Store(f.store.root), calls: string[] = [], workspace = new Workspace(store, runner(calls));
  try {
    assert.equal(workspace.getRun(a.id).status, 'cancelled'); assert.equal(workspace.getRun(b.id).status, 'queued');
    workspace.start(); await until(() => !workspace.busy);
    assert.deepEqual(calls, ['resume after restart']); assert.equal(workspace.getRun(b.id).status, 'complete'); assert.equal(workspace.getRun(c.id).status, 'cancelled');
  } finally { await workspace.shutdown(); }
});
test('failed SQLite transaction does not partially overwrite persisted history', async () => {
  const f = await fixture(); const original = f.project.id;
  f.store.state.projects.push(structuredClone(f.project));
  await assert.rejects(f.store.save());
  const reader = new DatabaseSync(f.store.file, { readOnly: true });
  try { assert.equal((reader.prepare('SELECT count(*) as n FROM projects').get() as { n: number }).n, 1); }
  finally { reader.close(); }
  f.store.state.projects.pop(); await f.workspace.shutdown();
  const reloaded = new Store(f.store.root); assert.equal(reloaded.state.projects[0].id, original); await reloaded.close();
});
test('legacy migration keeps original JSON and existing SQLite never falls back to stale JSON', async () => {
  const f = await fixture(); const state = structuredClone(f.store.state); await f.workspace.shutdown();
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-legacy-')), source = path.join(root, 'state.json');
  const bytes = JSON.stringify(state); await writeFile(source, bytes);
  const store = new Store(root); assert.equal(store.state.projects[0].id, f.project.id); await store.close();
  assert.equal(await readFile(source, 'utf8'), bytes);
  await writeFile(store.file, 'corrupt SQLite'); assert.throws(() => new Store(root), /SQLite/);
  assert.equal(await readFile(source, 'utf8'), bytes);
});

test('access audit expires in SQLite at startup and while the server is idle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-audit-'));
  const original = new Store(root), now = Date.now();
  const event = (id: string, offset: number) => ({ id, action: 'login', actorId: 'admin', targetId: 'admin', createdAt: new Date(now + offset).toISOString() });
  original.state.security = { users: [], credentials: [], audit: [event('recent', 0), event('next', -1000), event('old', -2000)] };
  await original.save();
  await original.close();

  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: now + 7 * 86_400_000 - 1001 });
  const store = new Store(root), db = new DatabaseSync(store.file, { readOnly: true });
  const persisted = () => {
    const { value } = db.prepare("SELECT value FROM metadata WHERE key='security'").get() as { value: string };
    return JSON.parse(value).audit.map(({ id }: { id: string }) => id);
  };
  try {
    assert.deepEqual(persisted(), ['recent', 'next']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(persisted(), ['recent']);
    assert.deepEqual(store.auditEvents().map(event => event.id), ['recent']);
  } finally { db.close(); await store.close(); }
});

test('external identity key is unique per installation and survives reload without granting permissions', async () => {
  const f = await fixture();
  f.store.state.externalIdentities = [{ installationId: 'office-a', externalUserId: '42', userId: 'alice' }, { installationId: 'office-b', externalUserId: '42', userId: 'boris' }];
  await f.store.save();
  f.store.state.externalIdentities.push({ installationId: 'office-a', externalUserId: '42', userId: 'mallory' });
  await assert.rejects(f.store.save()); f.store.state.externalIdentities.pop(); await f.workspace.shutdown();
  const reloaded = new Store(f.store.root);
  assert.equal(reloaded.state.externalIdentities!.length, 2); assert.equal(reloaded.state.security, undefined); await reloaded.close();
});
