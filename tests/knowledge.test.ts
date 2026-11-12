import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeBase } from '../server/knowledge.js';
import { withKnowledge } from '../server/knowledge-tools.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import type { CodexRequest, CodexRunner } from '../server/codex.js';
import { erpBrowser } from './erp-browser.js';

test('knowledge seeds once, indexes entire long documents and atomically rejects stale replacements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-knowledge-'));
  let kb = new KnowledgeBase(root);
  try {
    assert.equal(kb.overview('fastkore').files.length, 4);
    assert.equal(kb.overview('company').files.length, 0);
    const content = Buffer.from('# Начало\n' + 'Рабочий текст '.repeat(2000) + '\n## Завершение\nКварцевый маркер в конце документа.');
    const file = await kb.upload('company', 'Правила.md', content, () => {});
    const results = kb.search('company', 'Кварцевый') as { id: string; part: number }[];
    assert.equal(results.length, 1);
    const part = kb.read('company', file.id, file.revision, results[0].part) as { text: string };
    assert.match(part.text, /Кварцевый маркер/);
    assert.ok(part.text.length <= 4000);
    assert.equal(kb.search('fastkore', 'Кварцевый').length, 0);
    const outcomes = await Promise.allSettled([
      kb.upload('company', file.name, Buffer.from('Обновление А'), () => {}, file),
      kb.upload('company', file.name, Buffer.from('Обновление Б'), () => {}, file),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.throws(() => kb.read('company', file.id, file.revision, 0), /уже обновлён/);
    assert.equal(kb.search('company', 'Кварцевый').length, 0);
    const original = kb.overview('fastkore').files[0];
    await kb.upload('fastkore', original.name, Buffer.from('Локальная редакция'), () => {}, original);
    kb.close(); kb = new KnowledgeBase(root);
    assert.equal(kb.get('fastkore', original.id).content.toString(), 'Локальная редакция');
    assert.equal(kb.overview('fastkore').files.length, 4);
    const current = kb.overview('company').files[0];
    kb.remove('company', current.id, current.revision);
    assert.equal(kb.search('company', 'Обновление').length, 0);
  } finally { kb.close(); }
});

test('knowledge tools recheck authorization and report unsupported binary files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-knowledge-tools-'));
  const kb = new KnowledgeBase(root);
  try {
    const file = await kb.upload('company', 'Архив.zip', Buffer.from([0, 1, 2, 3]), () => {});
    assert.equal(file.extraction, 'unavailable');
    assert.deepEqual(kb.get('company', file.id).content, Buffer.from([0, 1, 2, 3]));
    let revoked = false;
    const tools = withKnowledge(undefined, kb, () => { if (revoked) throw Error('revoked'); });
    const signal = new AbortController().signal;
    assert.equal((await tools.call('knowledge', { action: 'index', section: 'company' }, signal)).success, true);
    assert.equal((await tools.call('knowledge', { action: 'read', section: 'company', id: file.id, revision: file.revision }, signal)).success, false);
    revoked = true;
    await assert.rejects(tools.call('knowledge', { action: 'index', section: 'company' }, signal), /revoked/);
  } finally { kb.close(); }
});

test('ERP employees cannot administer either global knowledge section', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-knowledge-access-'));
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: '', version: '', authentication: 'chatgpt', status: '' }), run: async () => ({ response: '' }) };
  const workspace = new Workspace(new Store(root), runner), erp = erpBrowser(process.env.BRIDGE_PUBLIC_ORIGIN);
  const app = await createApp(workspace, erp.options), request = erp.request(app);
  try {
    const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
    const setup = (await request('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Администратор', password: 'Knowledge-test-password-2026' })).json();
    const enter = await erp.pair(app, setup.token), employee = await enter('Сотрудник');
    for (const section of ['fastkore', 'company']) {
      const url = '/api/admin/knowledge/' + section;
      assert.equal((await request('GET', url, employee.cookie)).statusCode, 403);
      const overview = (await request('GET', url, setup.token)).json();
      assert.equal((await request('PUT', url, employee.cookie, { summary: 'Подмена', revision: overview.revision })).statusCode, 403);
    }
  } finally { await app.close(); }
});

test('knowledge HTTP upload and replacement use admin access and revision checks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-knowledge-http-'));
  const runner: CodexRunner = { inspect: async () => ({ path: '', version: '', authentication: 'chatgpt', status: '' }), run: async () => ({ response: '' }) };
  const workspace = new Workspace(new Store(root), runner), app = await createApp(workspace);
  try {
    const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.token },
      payload: { username: 'admin', name: 'Администратор', password: 'Knowledge-test-password-2026' } })).json();
    const headers = { authorization: 'Bearer ' + admin.token };
    const route = '/api/admin/knowledge/company';
    assert.equal((await app.inject({ url: route })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/admin/knowledge/invalid', headers })).statusCode, 400);
    const multipart = (text: string) => '--kb\r\nContent-Disposition: form-data; name="file"; filename="rules.md"\r\nContent-Type: text/markdown\r\n\r\n' + text + '\r\n--kb--\r\n';
    const upload = await app.inject({ method: 'POST', url: route + '/files', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=kb' }, payload: multipart('Original') });
    assert.equal(upload.statusCode, 201, upload.body);
    const file = upload.json();
    assert.equal((await app.inject({ url: route + '/files/' + file.id, headers })).body, 'Original');
    const replace = () => app.inject({ method: 'PUT', url: route + '/files/' + file.id + '?revision=' + file.revision,
      headers: { ...headers, 'content-type': 'multipart/form-data; boundary=kb' }, payload: multipart('Updated') });
    const db = new DatabaseSync(path.join(root, 'knowledge.sqlite'));
    try {
      db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON detailed_audit BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
      assert.equal((await replace()).statusCode, 500);
      assert.equal((await app.inject({ url: route + '/files/' + file.id, headers })).body, 'Original');
      db.exec('DROP TRIGGER fail_audit');
    } finally { db.close(); }
    assert.equal((await replace()).statusCode, 200);
    assert.equal((await replace()).statusCode, 409);
    const current = (await app.inject({ url: route, headers })).json();
    assert.equal(current.files.length, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: route + '/files/' + file.id, headers, payload: { revision: current.files[0].revision } })).statusCode, 200);
    const events = (await app.inject({ url: '/api/audit', headers })).json();
    const recorded = events.filter((event: { targetId: string }) => event.targetId === file.id);
    assert.deepEqual(new Set(recorded.map((event: { action: string }) => event.action)), new Set(['knowledge.upload', 'knowledge.replace', 'knowledge.delete']));
    const replaced = recorded.find((event: { action: string }) => event.action === 'knowledge.replace');
    assert.equal(replaced.actorId, admin.user.id);
    assert.deepEqual(replaced.details, { section: 'company', previousRevision: file.revision, revision: current.files[0].revision });
    assert.ok(!JSON.stringify(recorded).includes('Updated'));
    const before = encodeURIComponent(events[0].createdAt + '/' + events[0].id);
    const page = (await app.inject({ url: '/api/audit?before=' + before, headers })).json();
    assert.deepEqual(page, events.slice(1));
  } finally { await app.close(); }
});

test('agent receives a compact catalog once and gets updated versions without losing its session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-knowledge-session-'));
  await mkdir(path.join(root, 'project'));
  const calls: CodexRequest[] = [];
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: '', version: '', authentication: 'chatgpt', status: '' }),
    run: async (request, onEvent) => {
      calls.push(request);
      await onEvent({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
      return { sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', response: 'OK' };
    } };
  const workspace = new Workspace(new Store(path.join(root, 'data')), runner);
  try {
    const project = await workspace.addProject(path.join(root, 'project')), chat = await workspace.addChat(project.id);
    async function send() {
      await workspace.send(project.id, chat.id, 'Расскажи о системе', []);
      const deadline = Date.now() + 5000;
      while (workspace.busy) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.equal(workspace.store.state.runs.at(-1)?.status, 'complete');
    }
    await send(); await send();
    assert.match(calls[0].prompt, /Актуальная база знаний/);
    assert.ok(calls[0].prompt.length < 5000);
    assert.doesNotMatch(calls[1].prompt, /Актуальная база знаний/);
    assert.ok(calls[1].sessionId);
    assert.ok(calls[0].tools?.definitions.some(tool => tool.name === 'knowledge'));
    await workspace.knowledge.upload('company', 'Справочник.md', Buffer.from('Новый регламент'), () => {});
    await send();
    assert.match(calls[2].prompt, /Справочник.md/);
    assert.equal(calls[2].sessionId, calls[1].sessionId);
    await send();
    assert.doesNotMatch(calls[3].prompt, /Актуальная база знаний/);
  } finally { await workspace.shutdown(); }
});
