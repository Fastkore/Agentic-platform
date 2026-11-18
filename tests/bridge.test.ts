import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipSync } from 'fflate';
import { Store, redact } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { authentication, buildArguments, CodexClient, type CodexRequest, type CodexRunner } from '../server/codex.js';
import { createApp } from '../server/app.js';
import { buildContext, documentText, uploadAttachment } from '../server/documents.js';

const fakeFile = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
test('XLSX preview rejects an archive beyond its expanded size budget', async () => {
  const content = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(9 * 1024 * 1024) });
  assert.ok(content.length < 20 * 1024 * 1024);
  await assert.rejects(documentText('large.xlsx', Buffer.from(content)), (error: unknown) =>
    (error as { statusCode?: number }).statusCode === 422);
});
async function authorizedApp(workspace: Workspace) {
  const app = await createApp(workspace);
  const initial = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: '127.0.0.1:8787', 'x-bridge-local': '1' } })).json();
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: `Bearer ${initial.token}` }, payload: { username: 'admin', name: 'Руководитель', password: 'Test-admin-password-2026' } });
  assert.equal(setup.statusCode, 200);
  return { app, headers: { authorization: `Bearer ${setup.json().token}` } };
}
async function temp() { return mkdtemp(path.join(tmpdir(), 'bridge-web-')); }
test('a connected account revision replaces a model catalog even when the primary account stays the same', async () => {
  const store = new Store(await temp());
  let revision = 'first';
  let catalogReads = 0;
  const workspace = new Workspace(store, {
    isolated: true,
    inspect: async () => ({ path: '', version: '', authentication: 'chatgpt', status: '', accountId: 'same-account', catalogRevision: revision }),
    listModels: async () => {
      catalogReads++;
      return { source: 'combined', fetchedAt: new Date().toISOString(), models: [
        { id: revision, name: revision, description: '', isDefault: true },
      ] };
    },
    run: async () => ({ response: '' }),
  });
  try {
    await workspace.codexConnection();
    assert.equal((await workspace.models()).models[0].id, 'first');
    assert.equal((await workspace.models()).models[0].id, 'first');
    assert.equal(catalogReads, 1);
    revision = 'additional-model';
    assert.equal((await workspace.codexConnection(true))?.catalogRevision, revision);
    assert.equal((await workspace.models()).models[0].id, revision);
    assert.equal(catalogReads, 2);
  } finally { await workspace.shutdown(); }
});
async function fixture() {
  const root = await temp(), folder = path.join(root, 'Проект с пробелами'); await mkdir(folder);
  const store = new Store(path.join(root, 'state')), workspace = new Workspace(store, new CodexClient([fakeFile]));
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(folder, 'Тестовый проект'), chat = await workspace.addChat(project.id);
  return { root, folder, store, workspace, project, chat };
}
async function done(workspace: Workspace, id: string) { const deadline = Date.now() + 15_000; while (workspace.activeRun) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } return workspace.getRun(id); }

test('prompt never becomes shell input; exact session and read-only are explicit', () => {
  const args = buildArguments({ cliPath: 'codex.exe', workspace: 'C:\\Проект', prompt: '& calc.exe', allowWrite: false, sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
  assert.ok(args.includes('read-only')); assert.ok(args.includes('resume')); assert.ok(!args.includes('--last')); assert.ok(!args.includes('& calc.exe')); assert.equal(args.at(-1), '-'); assert.ok(!args.some(a => a.includes('dangerously')));
});
test('auth parsing fails closed and redacts credentials', () => {
  assert.equal(authentication('Logged in using ChatGPT', 0), 'chatgpt'); assert.equal(authentication('Using API key', 0), 'api-key'); assert.equal(authentication('Not logged in', 1), 'signed-out'); assert.equal(authentication('failure', 1), 'unknown');
  assert.ok(!redact('Bearer SECRET sk-1234567890 refresh_token=SECRET').includes('SECRET'));
});
test('model arguments are explicit on first run and resume, and reject flag injection', () => {
  const request = { cliPath: 'codex.exe', workspace: 'C:\\Проект', prompt: 'test', allowWrite: false, model: 'test-a' };
  const first = buildArguments(request), resumed = buildArguments({ ...request, sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', model: 'test-b' });
  assert.equal(first[first.indexOf('--model') + 1], 'test-a'); assert.equal(resumed[resumed.indexOf('--model') + 1], 'test-b'); assert.ok(resumed.includes('resume'));
  assert.throws(() => buildArguments({ ...request, model: '--dangerously-bypass-approvals-and-sandbox' }));
  assert.ok(!buildArguments({ ...request, model: undefined }).includes('--model'));
  const developerInstructions = 'Проверь "кавычки" и C:\\Проект.\nСоблюдай правила.';
  const withInstructions = buildArguments({ ...request, developerInstructions });
  assert.ok(withInstructions.includes('developer_instructions=' + JSON.stringify(developerInstructions)));
  assert.equal(withInstructions.at(-1), '-');
});
test('Codex model catalog follows stdio handshake, pagination and hides invisible entries', async () => {
  const client = new CodexClient([fakeFile]); const catalog = await client.listModels(process.execPath);
  assert.deepEqual(catalog.models.map(m => m.id), ['test-a', 'test-b']); assert.equal(catalog.models[0].name, 'Test Model A'); assert.equal(catalog.models[0].isDefault, true);
});
test('Codex quota windows and reset count come from app-server', async () => {
  const client = new CodexClient([fakeFile]);
  assert.deepEqual(await client.readLimits(process.execPath), {
    buckets: [{ name: 'Codex', windows: [{ usedPercent: 25, windowDurationMins: 300, resetsAt: 1794397200 }] }],
    resetsAvailable: 2
  });
});
test('per-chat and default models reach the process, persist after reload and preserve session on model switch', async () => {
  const { workspace, store, project, chat, folder } = await fixture();
  try {
    await workspace.settings({ model: 'test-a' });
    assert.equal(workspace.cli?.authentication, 'chatgpt');
    const first = await workspace.send(project.id, chat.id, 'Первый вопрос', []); await done(workspace, first.id);
    const session = chat.sessionId; assert.equal(first.model, 'test-a');
    let args = JSON.parse(await readFile(path.join(folder, 'fake-last-arguments.json'), 'utf8')) as string[]; assert.equal(args[args.indexOf('--model') + 1], 'test-a');
    await workspace.changeChatModel(project.id, chat.id, 'test-b'); assert.equal(chat.sessionId, session);
    const second = await workspace.send(project.id, chat.id, 'Продолжи с другой моделью', []); await done(workspace, second.id);
    assert.equal(second.status, 'complete'); assert.equal(chat.sessionId, session); assert.equal(chat.messages.at(-1)?.model, 'test-b');
    args = JSON.parse(await readFile(path.join(folder, 'fake-last-arguments.json'), 'utf8')); assert.ok(args.includes('resume')); assert.equal(args[args.indexOf('--model') + 1], 'test-b');
    const reloaded = new Store(store.root); assert.equal(reloaded.state.settings.model, 'test-a'); assert.equal(reloaded.state.projects[0].chats[0].model, 'test-b');
    const other = await workspace.addChat(project.id); assert.equal(other.model, '');
    const inherited = await workspace.send(project.id, other.id, 'Наследование', []); await done(workspace, inherited.id); assert.equal(inherited.model, 'test-a');
  } finally { await workspace.shutdown(); }
});
test('a new executor receives the recent conversation once and stops at changes in scope', async () => {
  const root = await temp();
  const calls: CodexRequest[] = [];
  const codexModel = 'codex/test-model', glmModel = 'glm/test-model';
  const runner: CodexRunner = {
    isolated: true,
    inspect: async (_cliPath, _signal, model) => ({
      path: '', version: 'test', status: '', authentication: model === glmModel ? 'glm' : 'chatgpt',
      provider: model === glmModel ? 'glm' : 'codex', accountId: model === glmModel ? 'glm:active-key' : 'codex:active-key',
    }),
    listModels: async () => ({ source: 'combined', fetchedAt: new Date().toISOString(),
      models: [codexModel, glmModel].map(id => ({ id, name: id, description: '', isDefault: id === codexModel })) }),
    async run(request, onEvent) {
      calls.push(request);
      const sessionId = request.sessionId ?? (request.model === glmModel ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222');
      await onEvent({ kind: 'session', text: sessionId });
      if (request.prompt.endsWith('Сбой первого запуска')) throw Error('Пробный отказ исполнителя');
      return { sessionId, response: 'Ответ ' + calls.length };
    },
  };
  const workspace = new Workspace(new Store(root), runner);
  try {
    const project = await workspace.createProject('Проект', () => []);
    const chat = await workspace.addChat(project.id, undefined, undefined, 'admin');
    const send = async (text: string, status = 'complete') => {
      const run = await workspace.send(project.id, chat.id, text, [], undefined, undefined, undefined, { id: 'admin', name: 'Тест' });
      const result = await done(workspace, run.id);
      assert.equal(result.status, status, result.error);
      return calls.at(-1)!;
    };
    await workspace.changeChatModel(project.id, chat.id, codexModel);
    await send('Первый вопрос');
    await send('Второй вопрос');
    assert.ok(calls[1].sessionId);
    // Simulate history persisted by the previous release.
    chat.sessionProvider = undefined;
    for (const message of chat.messages) delete message.historyScope;
    await workspace.changeChatModel(project.id, chat.id, glmModel);
    const failed = await send('Сбой первого запуска', 'error');
    assert.equal(failed.sessionId, undefined);
    assert.match(failed.prompt, /Первый вопрос.*Ответ 1.*Второй вопрос.*Ответ 2/s);
    const replayed = await send('Продолжи на новой модели');
    assert.equal(replayed.sessionId, undefined);
    assert.match(replayed.prompt, /Первый вопрос.*Ответ 1.*Второй вопрос.*Ответ 2/s);
    assert.doesNotMatch(replayed.prompt, /Сбой первого запуска/);
    assert.equal(replayed.prompt.match(/Продолжи на новой модели/g)?.length, 1);
    const resumed = await send('Дальше в этой сессии');
    assert.ok(resumed.sessionId);
    assert.doesNotMatch(resumed.prompt, /chat_history/);

    await workspace.changeChatModel(project.id, chat.id, codexModel);
    const returned = await send('Вернёмся на Codex');
    assert.equal(returned.sessionId, undefined);
    assert.match(returned.prompt, /Первый вопрос.*Дальше в этой сессии/s);

    await workspace.settings({ agentInstructions: 'Обновлённые правила' });
    const newScope = await send('Новая область');
    assert.doesNotMatch(newScope.prompt, /chat_history/);
    await workspace.changeChatModel(project.id, chat.id, glmModel);
    const currentScope = await send('Продолжи новую область');
    assert.match(currentScope.prompt, /Новая область.*Ответ 7/s);
    assert.doesNotMatch(currentScope.prompt, /Первый вопрос|Дальше в этой сессии/);
  } finally { await workspace.shutdown(); }
});
test('HTTP model selection validates catalog, changes chat and handles per-request model override', async () => {
  const { workspace, project, chat } = await fixture(), { app, headers } = await authorizedApp(workspace);
  try {
    assert.equal((await app.inject('/api/models')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/models', headers })).json().models.length, 2);
    assert.equal((await app.inject({ method: 'POST', url: '/api/models/refresh', headers, payload: {} })).statusCode, 200);
    const route = `/api/projects/${project.id}/chats/${chat.id}`;
    assert.equal((await app.inject({ method: 'PATCH', url: route, headers, payload: { model: 'unknown' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: route, headers, payload: { model: '--bad' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: route, headers, payload: { model: 'test-a' } })).json().model, 'test-a');
    const run = (await app.inject({ method: 'POST', url: route + '/messages', headers, payload: { text: 'CANCEL_TEST', model: 'test-b' } })).json(); assert.equal(run.model, 'test-b');
    assert.equal((await app.inject({ method: 'PATCH', url: route, headers, payload: { model: 'test-a' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { model: 'test-a' } })).statusCode, 409);
    workspace.cancel(run.id); await done(workspace, run.id);
    assert.equal((await app.inject({ method: 'PATCH', url: route, headers, payload: { model: '' } })).json().model, '');
  } finally { await app.close(); }
});
test('a stale default model clears itself once no connected provider offers it', async () => {
  const { workspace, store } = await fixture();
  try {
    await workspace.settings({ model: 'test-a' });
    store.state.settings.model = 'gemini-auto'; await store.save(); // The provider account is gone.
    const catalog = await workspace.models(true);
    assert.equal(catalog.models.length, 2);
    assert.equal(store.state.settings.model, '');
    assert.equal((await workspace.models(true)).models.length, 2); // The healed setting persists.
  } finally { await workspace.shutdown(); }
});
test('legacy 0.2 state without model fields loads without losing chats or session IDs', async () => {
  const { workspace, store, project, chat } = await fixture(); await workspace.shutdown();
  const state: any = structuredClone(store.state); delete state.settings.model; delete state.projects[0].chats[0].model;
  const legacyRoot = await temp(); state.projects[0].chats[0].sessionId = '87db344a-98f3-42c8-bba8-c7d9f3dcff11'; await writeFile(path.join(legacyRoot, 'state.json'), JSON.stringify(state));
  const migrated = new Store(legacyRoot); assert.equal(migrated.state.settings.model, ''); assert.equal(migrated.state.projects[0].id, project.id); assert.equal(migrated.state.projects[0].chats[0].id, chat.id); assert.equal(migrated.state.projects[0].chats[0].sessionId, state.projects[0].chats[0].sessionId); await migrated.close();
});
test('SQLite migration uses valid legacy backup, preserves source and marks interrupted attempts', async () => {
  const root = await temp(); const state = { schemaVersion: 1, settings: { cliPath: '', model: '', allowWrite: false, includePreviews: false }, projects: [], runs: [{ id: 'job', status: 'running', progress: 'test', createdAt: '', response: 'partial' }] };
  const source = path.join(root, 'state.json'); await writeFile(source, '{broken'); await writeFile(source + '.bak', JSON.stringify(state));
  const recovered = new Store(root); assert.ok(recovered.warning); assert.equal(recovered.state.runs[0].status, 'interrupted'); assert.equal(recovered.state.runs[0].response, undefined); await recovered.save(); await recovered.close();
  assert.equal(await readFile(source, 'utf8'), '{broken'); assert.equal(JSON.parse(await readFile(source + '.bak', 'utf8')).runs[0].id, 'job');
  const reopened = new Store(root); assert.equal(reopened.state.runs[0].id, 'job'); await reopened.close();
});
test('desktop migration preserves project, chat and session IDs and leaves source intact', async () => {
  const root = await temp(), file = path.join(root, 'desktop.json');
  const old = { SchemaVersion: 1, Settings: { CliPath: process.execPath }, Projects: [{ Id: 'old-project', Name: 'Проект', Directory: root, Chats: [{ Id: 'old-chat', Title: 'История', SessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', Messages: [{ Role: 'assistant', Text: 'Кофе 42', Status: 'complete', Attachments: [], Usage: { InputTokens: 100, OutputTokens: 5 } }] }] }] };
  const original = JSON.stringify(old); await writeFile(file, original);
  const store = new Store(path.join(root, 'web')), workspace = new Workspace(store, new CodexClient());
  const result = await workspace.importDesktop(file); assert.equal(result.chatCount, 1); assert.equal(workspace.chat('old-project', 'old-chat').sessionId, old.Projects[0].Chats[0].SessionId); assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(workspace.importDesktop(file)); await workspace.shutdown();
});
test('real spawned process: unicode JSONL, dedup, usage, exact resume across reload', async () => {
  const { workspace, project, chat, store } = await fixture();
  try {
    let run = await workspace.send(project.id, chat.id, 'Привет & calc.exe', [], 'one'); run = await done(workspace, run.id);
    assert.equal(run.status, 'complete'); assert.equal(chat.messages.length, 2); assert.equal(chat.messages[1].text.match(/Кофе/g)?.length, 1); assert.equal(run.usage?.outputTokens, 15);
    const id = chat.sessionId; await workspace.shutdown();
    const reopened = new Workspace(new Store(store.root), new CodexClient([fakeFile]));
    try { const next = await reopened.send(project.id, chat.id, 'Продолжи', [], 'two'); assert.equal((await done(reopened, next.id)).status, 'complete'); assert.equal(reopened.chat(project.id, chat.id).sessionId, id); assert.equal(reopened.chat(project.id, chat.id).messages.length, 4); }
    finally { await reopened.shutdown(); }
  } finally { await workspace.shutdown(); }
});
test('API and browser share history; authorization, origins, validation, isolation and idempotency', async () => {
  const { workspace, project, chat, folder } = await fixture(), { app, headers } = await authorizedApp(workspace);
  try {
    assert.equal((await app.inject('/api/projects')).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/projects', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'example.com', 'x-bridge-local': '1' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: '127.0.0.1:8787', 'x-bridge-local': '1' } })).statusCode, 403);
    const list = (await app.inject({ url: '/api/projects', headers })).json(); assert.equal(list[0].id, project.id);
    const route = `/api/projects/${project.id}/chats/${chat.id}/messages`;
    assert.equal((await app.inject({ method: 'POST', url: route, headers, payload: { text: 'test', arbitraryPath: folder } })).statusCode, 400);
    const first = await app.inject({ method: 'POST', url: route, headers, payload: { text: 'Прочитай таблицу', clientRequestId: 'a' } }); assert.equal(first.statusCode, 202);
    const runId = first.json().id;
    const duplicate = await app.inject({ method: 'POST', url: route, headers, payload: { text: 'Прочитай таблицу', clientRequestId: 'a' } }); assert.equal(duplicate.json().id, runId);
    assert.equal((await app.inject({ method: 'POST', url: route, headers, payload: { text: 'Другое содержимое', clientRequestId: 'a' } })).statusCode, 409);
    const queued = await app.inject({ method: 'POST', url: route, headers, payload: { text: 'Одновременно' } }); assert.equal(queued.statusCode, 202);
    await done(workspace, runId);
    const detail = (await app.inject({ url: `/api/projects/${project.id}/chats/${chat.id}`, headers })).json(); assert.equal(detail.messages.length, 4); assert.match(detail.messages[1].text, /42/);
    const other = await workspace.addProject(await temp()); await workspace.addChat(other.id);
    assert.equal((await app.inject({ url: `/api/projects/${other.id}/chats/${chat.id}`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${other.id}/chats/${other.chats[0].id}/messages`, headers, payload: { text: 'test', clientRequestId: 'a' } })).statusCode, 409);
    assert.equal((await app.inject({ url: '/api/runs/unknown', headers })).statusCode, 404);
    const server = await app.listen({ host: '127.0.0.1', port: 0 }); assert.equal((await fetch(server + '/api/projects', { headers })).status, 200);
    const form = new FormData(); form.append('file', new Blob(['name,quantity\ncoffee,42']), 'report.csv');
    const uploaded = await fetch(`${server}/api/projects/${project.id}/attachments`, { method: 'POST', headers, body: form });
    assert.equal(uploaded.status, 201); const attachment = await uploaded.json() as { id: string };
    assert.ok(project.attachments.some(a => a.id === attachment.id));
    assert.equal((await app.inject({ method: 'POST', url: route, headers, payload: { text: 'test', attachmentIds: ['does-not-exist'] } })).statusCode, 404);
  } finally { await app.close(); }
});

test('personal instructions persist per employee and agent edits follow the current settings and chat scope', async () => {
  const root = await temp();
  const store = new Store(root);
  const runner: CodexRunner = {
    async inspect() { return { path: process.execPath, version: 'test', authentication: 'chatgpt', status: '' }; },
    async run(request, _onEvent, signal) {
      if (request.prompt.includes('Общий чат')) {
        assert.ok(!request.tools?.definitions.some(tool => tool.name === 'my_instructions'));
        assert.doesNotMatch(request.prompt, /Сверяй итоги/);
        return { response: 'OK' };
      }
      assert.match(request.prompt, /Сверяй итоги/);
      const call = (args: unknown) => request.tools!.call('my_instructions', args, signal);
      const append = await call({ action: 'append', text: 'Отмечай источник.' });
      const remember = await call({ action: 'remember', title: 'Проверка отчёта', text: 'Перед выдачей отчёта сверь контрольный итог.', scope: 'project' });
      if (request.prompt.includes('Запиши в мою инструкцию')) {
        assert.equal(append.success, true, append.text);
        assert.equal(remember.success, true, remember.text);
        const list = JSON.parse((await call({ action: 'read' })).text);
        assert.equal(list.notes.length, 1);
        const note = await call({ action: 'read', noteId: list.notes[0].id });
        assert.match(note.text, /контрольный итог/);
      } else {
        assert.equal(append.success, false);
        assert.equal(remember.success, false);
      }
      return { response: 'OK' };
    },
  };
  const workspace = new Workspace(store, runner);
  await workspace.settings({ cliPath: process.execPath });
  const { app, headers } = await authorizedApp(workspace);
  const url = '/api/me/instructions';
  const get = async () => (await app.inject({ url, headers })).json();
  const put = (payload: unknown) => app.inject({ method: 'PUT', url, headers, payload });
  let userId = '';
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    const first = await get();
    assert.deepEqual(first, { text: '', autoInstructions: true, notes: [], revision: 0 });
    const manual = { ...first, text: 'Сверяй итоги.' };
    assert.equal((await put(manual)).statusCode, 200);
    const beforeChat = await get();
    const other = { username: 'other-admin', name: 'Other', password: 'Test-admin-password-other', role: 'admin' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/users', headers, payload: other })).statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: other.username, password: other.password } });
    assert.equal(login.statusCode, 200);
    assert.deepEqual((await app.inject({ url, headers: { authorization: 'Bearer ' + login.json().token } })).json(), first);

    userId = (await app.inject({ url: '/api/auth/me', headers })).json().user.id;
    const project = await workspace.addProject(await temp());
    const chat = await workspace.addChat(project.id, undefined, undefined, userId);
    const send = async (text: string) => {
      const sent = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/chats/${chat.id}/messages`, headers, payload: { text } });
      assert.equal(sent.statusCode, 202, sent.body);
      const run = await done(workspace, sent.json().id);
      assert.equal(run.status, 'complete', run.error);
    };
    await send('Запиши в мою инструкцию, что нужно отмечать источник.');
    const afterChat = await get();
    assert.match(afterChat.text, /Отмечай источник/);
    assert.equal(afterChat.notes[0].scope.id, project.id);
    assert.equal((await put(beforeChat)).statusCode, 409);
    const notes = afterChat.notes.map(({ id, title, text }: { id: string; title: string; text: string }) => ({ id, title, text }));
    assert.equal((await put({ ...afterChat, notes, autoInstructions: false })).statusCode, 200);
    await send('Проверь отчёт.');
    chat.visibility = 'project';
    await send('Общий чат');
  } finally { await app.close(); }
  const reopened = new Store(root);
  try {
    const restored = reopened.personalInstructions(userId);
    assert.equal(restored.autoInstructions, false);
    assert.equal(restored.notes.length, 1);
    assert.match(restored.text, /Отмечай источник/);
  } finally { await reopened.close(); }
});
test('stop kills actual CLI and child process; subsequent job runs', async () => {
  const { workspace, project, chat, folder } = await fixture();
  try {
    const run = await workspace.send(project.id, chat.id, 'CANCEL_TEST', []);
    let childPid = 0; const deadline = Date.now() + 10_000;
    while (!childPid) { try { childPid = Number(await readFile(path.join(folder, 'fake-child.pid'), 'utf8')); } catch {} if (Date.now() > deadline) throw new Error('child not started'); await new Promise(r => setTimeout(r, 20)); }
    workspace.cancel(run.id); assert.equal((await done(workspace, run.id)).status, 'cancelled');
    assert.throws(() => process.kill(childPid, 0));
    const next = await workspace.send(project.id, chat.id, 'Продолжи', []); assert.equal((await done(workspace, next.id)).status, 'complete');
  } finally { await workspace.shutdown(); }
});
test('unexpected session replacement is rejected and prior UUID preserved', async () => {
  const { workspace, project, chat } = await fixture();
  try { const first = await workspace.send(project.id, chat.id, 'Первый', []); await done(workspace, first.id); const id = chat.sessionId;
    const second = await workspace.send(project.id, chat.id, 'CHANGE_SESSION', []); assert.equal((await done(workspace, second.id)).status, 'error'); assert.equal(chat.sessionId, id);
  } finally { await workspace.shutdown(); }
});
test('API-key authorization blocks execution before messages are added', async () => {
  const { store, project, chat } = await fixture(); let launched = false;
  const runner: CodexRunner = { inspect: async () => ({ path: '', version: '', authentication: 'api-key', status: '' }), run: async () => { launched = true; return { response: '' }; } };
  const workspace = new Workspace(store, runner);
  try { const run = await workspace.send(project.id, chat.id, 'test', []); assert.equal((await done(workspace, run.id)).status, 'error'); assert.equal(launched, false); assert.equal(chat.messages.length, 0); }
  finally { await workspace.shutdown(); }
});
test('XLSX, CSV and PDF preview; limits; upload path isolation; symlink refused', async () => {
  const root = await temp();
  const fixture = fileURLToPath(new URL('../DemoProject/Продажи.xlsx', import.meta.url));
  await copyFile(fixture, path.join(root, 'Продажи.xlsx')); assert.match(await documentText(path.join(root, 'Продажи.xlsx')), /Кофе \| 42/);
  const csv = path.join(root, 'data.csv'); await writeFile(csv, 'Товар;Количество\n"Кофе;зерно";42'); assert.match(await documentText(csv), /Кофе;зерно \| 42/);
  const pdf = path.join(root, 'test.pdf');
  // Minimal actual PDF with embedded text and valid xref offsets.
  let content = '%PDF-1.4\n'; const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 37 >>\nstream\nBT /F1 12 Tf 10 100 Td (Coffee 42) Tj ET\nendstream'];
  const offsets = [0]; for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(content)); content += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; } const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; await writeFile(pdf, content); assert.match(await documentText(pdf), /Coffee 42/);
  const a = await uploadAttachment(root, '../../report.csv', Buffer.from('x,42')); const b = await uploadAttachment(root, '../../report.csv', Buffer.from('x,17')); assert.notEqual(a.path, b.path); assert.ok(a.path.startsWith(path.join(await realpath(root), '.bridge') + path.sep)); assert.equal(a.name, 'report.csv');
  const context = await buildContext(root, [a], true, new AbortController().signal); assert.ok(context.length <= 24_000); assert.match(context, /Продажи.xlsx/);
  const linked = await temp(), outside = await temp(); await symlink(outside, path.join(linked, '.bridge'), 'junction'); await assert.rejects(uploadAttachment(linked, 'test.txt', Buffer.from('test')));
});
