import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError } from '../server/store.js';
import { admin, sourceFixture } from './sources-helpers.js';
import { fixture, grantedSource, idle, json } from './sources-app.js';

const code = 'class Pricing {\n  decimal Margin(decimal cost) {\n    return cost * 1.35m; // standard margin for wholesale customers in the north region\n  }\n}\n';

test('E1: view, download, upload, manage and delete are separate delegated actions', async () => {
  const { registry } = await sourceFixture();
  const source = registry.createSource(admin, { name: 'Rights', kind: 'code', classification: 'restricted', managers: [
    { userId: 'uploader', actions: ['upload_snapshot'] }, { userId: 'viewer', actions: ['view_original'] }, { userId: 'owner', actions: ['manage_source', 'delete_source', 'download_original'] }] });
  const status = (work: () => unknown) => { try { work(); return 200; } catch (error) { return (error as BridgeError).statusCode; } };
  const as = (id: string) => ({ id, admin: false });
  assert.equal(status(() => registry.requireSource(as('uploader'), source.id, 'upload_snapshot')), 200);
  assert.equal(status(() => registry.requireSource(as('uploader'), source.id, 'view_original')), 403);
  assert.equal(status(() => registry.requireSource(as('uploader'), source.id, 'manage_source')), 403);
  assert.equal(status(() => registry.requireSource(as('viewer'), source.id, 'view_original')), 200);
  assert.equal(status(() => registry.requireSource(as('viewer'), source.id, 'download_original')), 403);
  assert.equal(status(() => registry.requireSource(as('owner'), source.id, 'download_original')), 200);
  assert.equal(status(() => registry.requireSource(as('owner'), source.id, 'use_for_analysis')), 403, 'analysis is granted only through project bindings');
  assert.equal(status(() => registry.requireSource(as('stranger'), source.id, 'view_original')), 404);
  assert.equal(status(() => registry.requireSource(admin, source.id, 'use_for_analysis')), 403, 'even an administrator does not read through the registry');
  assert.equal(status(() => registry.deleteSource(as('owner'), source.id)), 409, 'archive first');
  registry.archiveSource(as('owner'), source.id, 1);
  assert.equal(status(() => registry.deleteSource(as('viewer'), source.id)), 403);
  assert.equal(status(() => registry.deleteSource(as('owner'), source.id)), 200);
});

test('E2/E4/AC10: explanation-only runs get no output files; code blocks, encoded copies and verbatim lines are blocked; excerpts mode allows short quotes', async () => {
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'source_read')) return 'Без источников';
    const list = json((await request.tools.call('sources_list', {}, signal)).text).sources;
    const read = json((await request.tools.call('source_read', { source: list[0].source, path: 'Pricing.cs' }, signal)).text);
    const source = read.lines.map((l: string) => l.replace(/^\d+: /, '')).join('\n');
    if (request.prompt.includes('BLOCK')) return 'Вот код:\n```csharp\n' + source + '\n```';
    if (request.prompt.includes('BASE64')) return 'Содержимое: ' + Buffer.from(source).toString('base64');
    if (request.prompt.includes('LINES')) return source;
    if (request.prompt.includes('QUOTE')) return 'Наценка задаётся строкой `return cost * 1.35m;` (Pricing.cs:3).';
    return 'Наценка равна 35% от себестоимости (Pricing.cs, строка 3).';
  }, { workerFiles: true });
  try {
    await f.workspace.settings({ allowWrite: true });
    f.workspace.corporate.data.profiles.find(p => p.id === 'universal')!.allowWrite = true;
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const ask = async (text: string) => {
      await f.req('POST', route, f.token, { text }); await idle(f.workspace);
      return { text: (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string, call: f.calls.at(-1)! };
    };
    const plain = await ask('Без источников пока');
    assert.equal(typeof plain.call.workDirectoryId, 'string', 'ordinary chats keep the output folder');
    const { binding, current } = await grantedSource(f, { 'Pricing.cs': code });
    const explained = await ask('Как считается наценка?');
    assert.equal(explained.call.workDirectoryId, undefined, 'no output files for explanation-only analysis');
    assert.equal(explained.call.allowWrite, false);
    assert.match(explained.text, /35%/);
    for (const attempt of ['BLOCK', 'BASE64', 'LINES', 'QUOTE']) {
      const blocked = await ask(attempt);
      assert.match(blocked.text, /Ответ не опубликован/, attempt);
      assert.ok(!blocked.text.includes('1.35m'), attempt);
    }
    // Excerpts mode: a short quote is published, a full listing is still blocked as verbatim reproduction.
    const b = await current();
    assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-bindings/${binding.id}`, f.admin, { revision: b.revision, outputPolicy: 'excerpts_allowed' })).statusCode, 200);
    const sourceRow = f.workspace.sources.registry.sourceInfo(b.sourceId)!;
    assert.equal((await f.req('PATCH', `/api/admin/sources/${sourceRow.id}`, f.admin, { revision: sourceRow.policy_revision, outputPolicy: 'excerpts_allowed' })).statusCode, 200);
    assert.match((await ask('QUOTE')).text, /return cost \* 1\.35m;/);
    assert.match((await ask('LINES')).text, /Ответ не опубликован/);
    // Raw source never appears in run details, status, chat list or audit pages.
    for (const url of ['/api/status', `/api/projects/${f.project.id}/chats`]) assert.ok(!(await f.req('GET', url, f.token)).body.includes('north region'), url);
    assert.ok(!(await f.req('GET', '/api/admin/sources-audit', f.admin)).body.includes('north region'));
  } finally { await f.app.close(); }
});

test('E5/AC11: moving a chat drops its source pin and executor context; a profile without a grant gets no sources; per-run read limits hold', async () => {
  let calls = 0;
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'sources_list')) return 'Без источников';
    if (request.prompt.includes('FLOOD')) {
      let last = { success: true, text: '' };
      for (let i = 0; i < 205 && last.success; i++) { last = await request.tools.call('sources_list', {}, signal); calls++; }
      return last.success ? 'лимит не сработал' : last.text;
    }
    return 'С источниками';
  });
  try {
    await grantedSource(f, { 'A.cs': 'class A {}\n' });
    await f.req('PATCH', `/api/projects/${f.project2.id}/members`, f.admin, { memberIds: [f.employee.id] });
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    await f.req('POST', `/api/projects/${f.project.id}/chats/${chat.id}/messages`, f.token, { text: 'Вопрос' }); await idle(f.workspace);
    assert.equal((await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text, 'С источниками');
    assert.ok(f.workspace.sources.policy.chatPin(chat.id));
    const moved = await f.req('PATCH', `/api/projects/${f.project.id}/chats/${chat.id}/move`, f.token, { projectId: f.project2.id });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(f.workspace.sources.policy.chatPin(chat.id), undefined, 'bindings do not move with the chat');
    const before = f.calls.length;
    await f.req('POST', `/api/projects/${f.project2.id}/chats/${chat.id}/messages`, f.token, { text: 'После переноса' }); await idle(f.workspace);
    assert.equal(f.calls[before].sessionId, undefined, 'new executor context');
    assert.equal((await f.req('GET', `/api/projects/${f.project2.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text, 'Без источников');
    // Per-run limit on tool calls.
    const second = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    await f.req('POST', `/api/projects/${f.project.id}/chats/${second.id}/messages`, f.token, { text: 'FLOOD' }); await idle(f.workspace);
    assert.match((await f.req('GET', `/api/projects/${f.project.id}/chats/${second.id}`, f.token)).json().messages.at(-1).text, /Лимит обращений/);
    assert.equal(calls, 201);
  } finally { await f.app.close(); }
});

test('E6: restricted sources stay unavailable until isolation is verified; ordinary chats keep working', async () => {
  const previous = process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS;
  delete process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS;
  const f = await fixture(async request => request.tools?.definitions.some(d => d.name === 'source_read') ? 'С источниками' : 'Без источников');
  try {
    await grantedSource(f, { 'Secret.cs': 'class S {}\n' }, { classification: 'restricted' });
    const matrix = (await f.req('GET', `/api/projects/${f.project.id}/source-matrix`, f.admin)).json();
    assert.ok(matrix.cells[0].reasons.some((r: string) => /изоляция исполнителя не проверена/.test(r)));
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const text = async () => (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text;
    await f.req('POST', `/api/projects/${f.project.id}/chats/${chat.id}/messages`, f.token, { text: 'Вопрос' }); await idle(f.workspace);
    assert.equal(await text(), 'Без источников');
    process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS = 'verified';
    await f.req('POST', `/api/projects/${f.project.id}/chats/${chat.id}/messages`, f.token, { text: 'Ещё вопрос' }); await idle(f.workspace);
    assert.equal(await text(), 'С источниками');
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS; else process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS = previous;
    await f.app.close();
  }
});

test('restricted excerpts stay private before publication, and a policy change during the turn blocks further reads and publication', async () => {
  const previous = process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS;
  process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS = 'verified';
  const marker = 'Quick confidential synthetic excerpt';
  let inspectDelta: (() => Promise<void>) | undefined;
  let tightenPolicy: (() => Promise<void>) | undefined;
  const f = await fixture(async (request, signal) => {
    const list = json((await request.tools!.call('sources_list', {}, signal)).text).sources;
    const args = { source: list[0].source, path: 'sample.txt' };
    assert.equal((await request.tools!.call('source_read', args, signal)).success, true);
    if (tightenPolicy) {
      await tightenPolicy();
      assert.equal((await request.tools!.call('source_read', args, signal)).success, false);
    }
    return marker;
  }, { workerFiles: true, afterDelta: async () => { await inspectDelta?.(); } });
  try {
    await f.workspace.settings({ allowWrite: true });
    f.workspace.corporate.data.profiles.find(p => p.id === 'universal')!.allowWrite = true;
    const { source, current, binding } = await grantedSource(f, { 'sample.txt': marker }, { classification: 'restricted', outputPolicy: 'excerpts_allowed' });
    const project = `/api/projects/${f.project.id}`;
    assert.equal((await f.req('PUT', `${project}/source-bindings/${binding.id}`, f.admin, { revision: (await current()).revision, outputPolicy: 'excerpts_allowed' })).statusCode, 200);
    const chat = (await f.req('POST', `${project}/chats`, f.token, {})).json();
    const chatUrl = `${project}/chats/${chat.id}`;
    let deltasChecked = 0;
    inspectDelta = async () => {
      const view = (await f.req('GET', chatUrl, f.token)).json();
      assert.equal(view.messages.at(-1).status, 'running');
      assert.equal(view.messages.at(-1).text, '');
      deltasChecked++;
    };
    const ask = async (text: string) => {
      assert.equal((await f.req('POST', chatUrl + '/messages', f.token, { text })).statusCode, 202);
      await idle(f.workspace);
      return (await f.req('GET', chatUrl, f.token)).json().messages.at(-1).text;
    };
    assert.equal(await ask('Короткая цитата'), marker);
    assert.equal(f.calls.at(-1)?.workDirectoryId, undefined);
    tightenPolicy = async () => {
      const row = f.workspace.sources.registry.sourceInfo(source.id)!;
      assert.equal((await f.req('PATCH', `/api/admin/sources/${source.id}`, f.admin, { revision: row.policy_revision, outputPolicy: 'explanation_only' })).statusCode, 200);
    };
    assert.match(await ask('Политика меняется'), /Ответ не опубликован: доступ к источникам изменился/);
    assert.equal(f.calls.at(-1)?.sessionId, undefined, 'raw previous executor transcript is not resumed');
    assert.equal(deltasChecked, 2);
    assert.equal((await f.req('GET', chatUrl + '/source-scope', f.token)).json().sources, 1);
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS;
    else process.env.BRIDGE_SOURCES_CLOSED_ANALYSIS = previous;
    await f.app.close();
  }
});
