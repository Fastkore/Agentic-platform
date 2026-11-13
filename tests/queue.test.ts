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
async function fixture(storageBudget?: { user: number; project: number; platform: number }) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-queue-')); await mkdir(path.join(root, 'project'));
  const store = new Store(path.join(root, 'data')), calls: string[] = [], workspace = new Workspace(store, runner(calls), undefined, undefined, storageBudget);
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(path.join(root, 'project')), chat = await workspace.addChat(project.id);
  return { root, store, calls, workspace, project, chat };
}
test('file quota counts durable uploads and releases expired unattached files', async () => {
  const f = await fixture({ user: 8, project: 20, platform: 20 });
  try {
    const first = await f.workspace.addAttachment(f.project.id, 'draft.txt', Buffer.from('123456'), () => 'employee');
    const library = await f.workspace.addProjectFile(f.project.id, 'library.txt', Buffer.from('abc'), () => 'admin');
    await assert.rejects(f.workspace.addAttachment(f.project.id, 'second.txt', Buffer.from('abc'), () => 'employee'),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 413);
    await f.workspace.expireUnusedUploads(Date.parse(first.uploadedAt!) + 25 * 60 * 60_000);
    await until(() => f.store.pendingChatFileDeletions().length === 0);
    await assert.rejects(readFile(first.path!), { code: 'ENOENT' });
    assert.deepEqual(f.project.attachments.map(file => file.id), [library.id]);
    assert.equal((await f.workspace.addAttachment(f.project.id, 'new.txt', Buffer.from('abc'), () => 'employee')).size, 3);
  } finally { await f.workspace.shutdown(); }
});
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
    assert.equal(f.store.state.jobs!.length, 0);
    await f.workspace.shutdown();
    const store = new Store(f.store.root), next = new Workspace(store, runner());
    try {
      const same = await next.send(f.project.id, f.chat.id, 'first', [], 'request-a');
      assert.equal(same.id, a.id);
      assert.equal(store.state.runs.length, 2);
      assert.equal(store.state.jobs!.length, 0);
      assert.deepEqual(next.chat(f.project.id, f.chat.id).messages.map(message => message.text), ['first', 'first', 'second', 'second']);
    }
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

test('provider lanes run different chats concurrently but preserve FIFO across models in the same chat', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-chat-lanes-'));
  const store = new Store(root), started: string[] = [];
  const releases = new Map<string, () => void>();
  const fake: CodexRunner = {
    inspect: async (_path, _signal, model) => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '',
      accountId: model?.startsWith('glm') ? 'glm-account' : 'google-account' }),
    run: async (request, _event, signal) => {
      started.push(request.prompt);
      await new Promise<void>((resolve, reject) => {
        releases.set(request.prompt, resolve);
        signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      });
      return { response: request.prompt };
    },
  };
  const workspace = new Workspace(store, fake);
  try {
    await workspace.settings({ cliPath: process.execPath });
    const project = await workspace.addProject(root);
    const a = await workspace.addChat(project.id), b = await workspace.addChat(project.id), c = await workspace.addChat(project.id);
    a.model = 'glm/model'; b.model = 'glm/model'; c.model = 'antigravity/model';
    const first = await workspace.send(project.id, a.id, 'first', []);
    await until(() => started.includes('first'));
    const queued = await workspace.send(project.id, b.id, 'second', []); // GLM lane occupied.
    b.model = 'antigravity/model';
    const later = await workspace.send(project.id, b.id, 'third', []); // Cannot leapfrog second.
    const independent = await workspace.send(project.id, c.id, 'independent', []);
    await until(() => started.includes('independent'));
    assert.equal(queued.status, 'queued'); assert.equal(later.status, 'queued');
    releases.get('independent')!(); await until(() => independent.status === 'complete');
    assert.ok(!started.includes('third'));
    releases.get('first')!(); await until(() => started.includes('second'));
    assert.equal(first.status, 'complete'); assert.ok(!started.includes('third'));
    releases.get('second')!(); await until(() => started.includes('third'));
    assert.equal(queued.status, 'complete');
    releases.get('third')!(); await until(() => !workspace.busy);
    assert.deepEqual(workspace.chat(project.id, b.id).messages.map(message => message.text), ['second', 'second', 'third', 'third']);
    assert.match(b.sessionScope!, /google-account/);
  } finally { for (const release of releases.values()) release(); await workspace.shutdown(); }
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
test('saving new turns and settings does not rewrite old message rows', async () => {
  const f = await fixture();
  try {
    await f.workspace.send(f.project.id, f.chat.id, 'first', []);
    await until(() => !f.workspace.busy);
    const db = new DatabaseSync(f.store.file);
    try {
      db.exec(`CREATE TRIGGER preserve_history_delete BEFORE DELETE ON messages
        WHEN json_extract(OLD.payload,'$.text') = 'first' BEGIN SELECT RAISE(ABORT,'old message deleted'); END;
        CREATE TRIGGER preserve_history_update BEFORE UPDATE ON messages
        WHEN json_extract(OLD.payload,'$.text') = 'first' BEGIN SELECT RAISE(ABORT,'old message updated'); END;`);
      const second = await f.workspace.send(f.project.id, f.chat.id, 'second', []);
      await until(() => !f.workspace.busy);
      assert.equal(second.status, 'complete');
      await f.workspace.settings({ includePreviews: true });
      assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n, 4);
    } finally { db.close(); }
  } finally { await f.workspace.shutdown(); }
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
