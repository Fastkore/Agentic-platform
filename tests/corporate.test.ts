import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import { migrateFastkoreChatBindings } from '../server/fastkore-chat.js';
import type { AgentProfile } from '../shared/types.js';
import type { CodexRequest, CodexRunner } from '../server/codex.js';
import { erpBrowser } from './erp-browser.js';
const password = 'Corporate-test-password-2026';
async function fixture(respond?: (request: CodexRequest, signal: AbortSignal) => Promise<string | undefined>) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-corporate-')); await mkdir(path.join(root, 'project'));
  const calls: CodexRequest[] = [];
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async (r, onEvent, signal) => {
    calls.push(r);
    if (r.consultation) return { response: (await respond?.(r, signal)) ?? 'Консультация', usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
    await onEvent({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
    if (r.prompt.includes('BLOCK')) await new Promise((resolve, reject) => { if (signal.aborted) reject(Error('aborted')); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    return { sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', response: (await respond?.(r, signal)) ?? 'OK', usage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 30 } };
  } };
  const store = new Store(path.join(root, 'data')), workspace = new Workspace(store, runner); await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const erp = erpBrowser(process.env.BRIDGE_PUBLIC_ORIGIN);
  const project = await workspace.addProject(path.join(root, 'project')), app = await createApp(workspace, erp.options);
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
  const admin = (await req('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Руководитель', password })).json().token;
  const enter = await erp.pair(app, admin);
  const { user: employee, cookie: token } = await enter('Алиса');
  assert.equal((await req('PATCH', '/api/users/' + employee.id, admin, { roleId: 'employee' })).statusCode, 200);
  await req('PATCH', `/api/projects/${project.id}/members`, admin, { memberIds: [employee.id] });
  return { root, calls, store, workspace, project, app, req, admin, employee, token, enter, runner };
}
async function idle(workspace: Workspace) { const deadline = Date.now() + 6000; while (workspace.busy) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } }

test('administrators archive, restore and permanently delete chats without losing token totals', async () => {
  const f = await fixture();
  try {
    const chats = `/api/projects/${f.project.id}/chats`;
    const created = (await f.req('POST', chats, f.token, { title: 'В архив' })).json();
    const url = `${chats}/${created.id}`, archive = url + '/archive';
    assert.equal((await f.req('DELETE', url, f.admin)).statusCode, 409);
    assert.equal((await f.req('PATCH', archive, f.token, { archived: true })).statusCode, 403);
    const blocked = await f.req('POST', url + '/messages', f.token, { text: 'BLOCK' });
    assert.equal(blocked.statusCode, 202);
    assert.equal((await f.req('PATCH', archive, f.admin, { archived: true })).statusCode, 409);
    assert.equal((await f.req('POST', `/api/runs/${blocked.json().id}/cancel`, f.token, {})).statusCode, 200);
    await idle(f.workspace);
    const sent = await f.req('POST', url + '/messages', f.token, { text: 'Удаляемый текст' });
    assert.equal(sent.statusCode, 202);
    await idle(f.workspace);
    const runId = sent.json().id, storedChat = f.workspace.chat(f.project.id, created.id);
    const generated = await f.workspace.files.upload('local', f.project, 'result.txt', Buffer.from('result'));
    const shared = await f.workspace.addAttachment(f.project.id, 'shared.txt', Buffer.from('shared'), () => f.employee.id);
    const message = storedChat.messages.at(-1)!;
    message.attachments.push(generated, shared);
    const file = `${url}/messages/${message.id}/files/${generated.id}`;
    const totals = (await f.req('GET', '/api/admin/usage', f.admin)).json().total;

    assert.equal((await f.req('PATCH', archive, f.admin, { archived: true })).statusCode, 200);
    assert.deepEqual((await f.req('GET', chats, f.admin)).json(), []);
    assert.equal((await f.req('GET', '/api/projects', f.admin)).json()[0].chatCount, 0);
    assert.equal((await f.req('GET', '/api/admin/chats/archive', f.token)).statusCode, 403);
    assert.equal((await f.req('GET', '/api/admin/chats/archive', f.admin)).json()[0].id, created.id);
    assert.equal((await f.req('GET', url, f.token)).statusCode, 404);
    assert.equal((await f.req('GET', file, f.token)).statusCode, 404);
    assert.equal((await f.req('GET', file, f.admin)).body, 'result');
    assert.equal((await f.req('POST', url + '/messages', f.admin, { text: 'Закрыто' })).statusCode, 409);
    assert.equal((await f.req('PATCH', archive, f.admin, { archived: false })).statusCode, 200);
    assert.equal((await f.req('GET', url, f.token)).statusCode, 200);
    assert.equal((await f.req('PATCH', archive, f.admin, { archived: true })).statusCode, 200);
    assert.equal((await f.req('DELETE', url, f.token)).statusCode, 403);

    // Simulate storage downtime after SQLite has accepted the deletion.
    f.workspace.files.remove = async () => { throw Error('storage unavailable'); };
    assert.equal((await f.req('DELETE', url, f.admin)).statusCode, 200);
    assert.equal((await f.req('GET', url, f.admin)).statusCode, 404);
    assert.equal((await f.req('GET', `/api/runs/${runId}`, f.admin)).statusCode, 404);
    assert.deepEqual((await f.req('GET', '/api/admin/usage', f.admin)).json().total, totals);
    const audit = (await f.req('GET', '/api/audit', f.admin)).json().filter((event: { targetId: string }) => event.targetId === created.id);
    assert.deepEqual(audit.map((event: { action: string }) => event.action), ['chat.delete', 'chat.archive', 'chat.restore', 'chat.archive']);
    await f.app.close();

    const store = new Store(f.store.root), reloaded = new Workspace(store, f.runner);
    try {
      assert.equal(store.state.projects[0].chats.length, 0);
      assert.equal(store.state.jobs?.some(job => job.runId === runId), false);
      assert.equal(store.state.runs.find(run => run.id === runId)?.response, undefined);
      assert.equal(store.pendingChatFileDeletions().length, 1);
      reloaded.start();
      const deadline = Date.now() + 3000;
      while (store.pendingChatFileDeletions().length) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
      await assert.rejects(readFile(generated.path!), { code: 'ENOENT' });
      assert.equal(await readFile(shared.path!, 'utf8'), 'shared');
    } finally { await reloaded.shutdown(); }
  } finally { await f.app.close(); }
});

test('Fastkore opens the latest personal chat for a card or list and keeps older related chats', async () => {
  const f = await fixture();
  try {
    const create = '/api/fastkore/chats', related = create + '/related';
    const projectId = f.project.id, messages = (id: string) => `/api/projects/${projectId}/chats/${id}/messages`;
    const base = { type: 'fastkore.context', version: 1, entity_set_id: randomUUID(), scope_reproducible: true };
    const card = { ...base, view: 'card', entity_id: randomUUID(), filter_status: 'none' };
    assert.equal((await f.req('POST', related, f.admin, { context: card })).statusCode, 403);
    const [first, duplicate] = await Promise.all([f.req('POST', create, f.token, { projectId, context: card }), f.req('POST', create, f.token, { projectId, context: card })]);
    assert.deepEqual([first.statusCode, duplicate.statusCode].sort(), [200, 201]);
    const id = first.json().chat.id;
    assert.equal(duplicate.json().chat.id, id);
    assert.equal(first.json().chat.fastkoreBinding, undefined);
    assert.equal(f.workspace.chat(projectId, id).fastkoreBinding?.entityId, card.entity_id);
    const fresh = await f.req('POST', create, f.token, { projectId, context: { ...card, control_uid: 'other-view' }, fresh: true });
    assert.equal(fresh.statusCode, 201);
    const ids = async (context: unknown, token = f.token) => (await f.req('POST', related, token, { context })).json().map((chat: { id: string }) => chat.id);
    assert.deepEqual(await ids(card), [fresh.json().chat.id, id]);
    assert.deepEqual(await ids({ ...card, entity_id: randomUUID() }), []);
    const other = await f.enter('Другой сотрудник');
    await f.req('PATCH', `/api/projects/${projectId}/members`, f.admin, { memberIds: [f.employee.id, other.user.id] });
    assert.deepEqual(await ids(card, other.cookie), []);
    assert.equal((await f.req('GET', `/api/projects/${projectId}/chats/${id}`, other.cookie)).statusCode, 404);
    assert.equal((await f.req('POST', messages(id), f.token, { text: 'Другой заказ', fastkoreContext: { ...card, entity_id: randomUUID() } })).statusCode, 409);

    const list = { ...base, view: 'list', tile_id: randomUUID(), catalog_id: randomUUID(), folder_id: randomUUID(), entity_id: randomUUID(), filter_status: 'included', filter_xml: '<Filter/>', deleted: false };
    const legacy = (await f.req('POST', `/api/projects/${projectId}/chats`, f.token, {})).json();
    assert.equal((await f.req('POST', messages(legacy.id), f.token, { text: 'Исторический запрос', fastkoreContext: list })).statusCode, 202);
    await idle(f.workspace);
    migrateFastkoreChatBindings(f.store.state);
    const selectedRow = { ...list, entity_id: randomUUID() };
    assert.deepEqual(await ids(selectedRow), [legacy.id]);
    assert.deepEqual(await ids({ ...list, filter_xml: '<Filter changed="1"/>' }), []);
    assert.deepEqual(await ids({ ...list, folder_id: randomUUID() }), []);
    assert.deepEqual(await ids({ ...list, deleted: true }), []);
    const next = await f.req('POST', create, f.token, { projectId, context: selectedRow, fresh: true });
    const nextId = next.json().chat.id;
    assert.equal(next.statusCode, 201);
    for (const context of [list, selectedRow]) {
      assert.equal((await f.req('POST', messages(nextId), f.token, { text: 'Открытый список', fastkoreContext: context })).statusCode, 202);
      await idle(f.workspace);
    }
    assert.ok(f.calls.at(-1)?.sessionId);
    assert.deepEqual(await ids(list), [nextId, legacy.id]);
  } finally { await f.app.close(); }
});
test('token activity groups project usage by day for administrators', async () => {
  const f = await fixture();
  try {
    const completed = new Date(Date.now() - 2 * 86_400_000);
    completed.setUTCHours(22, 30, 0, 0);
    const createdAt = completed.toISOString();
    const base = { projectId: f.project.id, status: 'complete' as const, progress: '', createdAt,
      completedAt: createdAt, usage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 30 } };
    f.store.state.runs.push(
      { ...base, id: randomUUID(), ownerId: f.employee.id }, { ...base, id: randomUUID() },
      { ...base, id: randomUUID(), projectId: undefined },
      { ...base, id: randomUUID(), status: 'running', completedAt: undefined },
      { ...base, id: randomUUID(), completedAt: new Date(Date.now() - 371 * 86_400_000).toISOString() },
    );
    const zone = '?timeZone=Europe%2FMoscow', route = '/api/codex/activity' + zone, reportRoute = '/api/admin/usage' + zone;
    assert.equal((await f.req('GET', route, f.token)).statusCode, 403);
    assert.equal((await f.req('GET', reportRoute, f.token)).statusCode, 403);
    assert.equal((await f.req('GET', '/api/codex/activity?timeZone=invalid', f.admin)).statusCode, 400);
    assert.equal((await f.req('GET', '/api/admin/usage?timeZone=invalid', f.admin)).statusCode, 400);
    const result = await f.req('GET', route, f.admin);
    assert.equal(result.statusCode, 200, result.body);
    const date = new Date(completed.getTime() + 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(result.json(), [{ date, tokens: 460 }]);
    const report = await f.req('GET', reportRoute, f.admin);
    assert.equal(report.statusCode, 200, report.body);
    const boss = f.store.state.security!.users.find(user => user.role === 'admin')!;
    assert.deepEqual(report.json(), {
      total: result.json(), unattributed: [{ date, tokens: 230 }],
      users: [{ id: boss.id, name: boss.name, disabled: false, days: [] },
        { id: f.employee.id, name: f.employee.name, disabled: false, days: [{ date, tokens: 230 }] }],
    });

    const chat = await f.workspace.addChat(f.project.id, 'Чат сотрудника', '', f.employee.id);
    const messages = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const input = { text: 'Запрос руководителя', clientRequestId: randomUUID() };
    assert.equal((await f.req('POST', messages, f.admin, input)).statusCode, 202);
    await idle(f.workspace);
    assert.equal((await f.req('POST', messages, f.admin, input)).statusCode, 202);
    const { users } = (await f.req('GET', reportRoute, f.admin)).json();
    assert.deepEqual(users[0].days.map((day: { tokens: number }) => day.tokens), [230]);
    assert.deepEqual(users[1].days, [{ date, tokens: 230 }]);
  } finally { await f.app.close(); }
});

test('profile grants apply to ERP sessions, configuration is private, and closed execution fails before Codex', async () => {
  const f = await fixture(); try {
    assert.equal((await f.req('GET', '/api/admin/profiles', f.token)).statusCode, 403);
    assert.deepEqual((await f.req('GET', '/api/agents', f.token)).json().map((a: any) => a.id), ['universal']);
    const estimator = f.workspace.corporate.data.profiles.find(p => p.id === 'estimator')!;
    const { id, ...input } = estimator;
    assert.equal((await f.req('PUT', '/api/admin/profiles/estimator', f.admin, { ...input, enabled: true })).statusCode, 200);
    const role = { name: 'Менеджер', enabled: true, profileIds: ['estimator'], operationIds: ['estimate'], readDatasetIds: [], instructions: 'Только утверждённый результат' };
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.admin, role)).statusCode, 200);
    await f.req('PATCH', '/api/users/' + f.employee.id, f.admin, { roleId: 'manager' });
    const agents = (await f.req('GET', '/api/agents', f.token)).json(); assert.equal(agents.length, 1); assert.equal(agents[0].id, 'estimator'); assert.equal(agents[0].available, false); assert.ok(!JSON.stringify(agents).includes('instructions'));
    const route = `/api/projects/${f.project.id}/chats`;
    assert.equal((await f.req('POST', route, f.token, { agentProfileId: 'universal' })).statusCode, 403);
    assert.equal((await f.req('POST', route, f.token, { agentProfileId: 'estimator' })).statusCode, 409); assert.equal(f.calls.length, 0);
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.token, role)).statusCode, 403);
  } finally { await f.app.close(); }
});
test('rules reach Codex; changing role instructions starts a fresh session and revokes in-flight work', async () => {
  const f = await fixture(); try {
    const initial = (await f.req('GET', '/api/status', f.admin)).json();
    assert.match(initial.settings.agentInstructions, /помощник Agent Platform/);
    assert.equal((await f.req('GET', '/api/status', f.token)).json().settings.agentInstructions, undefined);
    assert.equal((await f.req('PATCH', '/api/settings', f.token, { agentInstructions: 'Сотрудник меняет правила' })).statusCode, 403);
    assert.equal((await f.req('PATCH', '/api/settings', f.admin, { agentInstructions: 'Общий запрет: не расширяй выборку.' })).statusCode, 200);
    const role = { name: 'Менеджер', enabled: true, profileIds: ['universal'], operationIds: ['chat'], readDatasetIds: [], instructions: 'Проверяй единицы измерения' };
    await f.req('PUT', '/api/admin/roles/manager', f.admin, role); await f.req('PATCH', '/api/users/' + f.employee.id, f.admin, { roleId: 'manager' });
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json(), route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    await f.req('POST', route, f.token, { text: 'Первый' }); await idle(f.workspace);
    assert.match(f.calls[0].developerInstructions!, /Общий запрет:[\s\S]*Проверяй единицы/);
    assert.match(f.calls[0].prompt, /Текущий пользователь Fastkore.*"Алиса"/);
    assert.doesNotMatch(f.calls[0].prompt, /Общий запрет|Проверяй единицы/);
    await f.req('POST', route, f.token, { text: 'Второй' }); await idle(f.workspace); assert.ok(f.calls[1].sessionId);
    assert.equal((await f.req('PATCH', '/api/settings', f.admin, { agentInstructions: 'Новые общие правила' })).statusCode, 200);
    await f.req('POST', route, f.token, { text: 'После обновления общих правил' }); await idle(f.workspace);
    assert.equal(f.calls[2].sessionId, undefined);
    assert.match(f.calls[2].developerInstructions!, /Новые общие правила/);
    await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, instructions: 'Новые правила', revision: 1 });
    await f.req('POST', route, f.token, { text: 'После обновления роли' }); await idle(f.workspace); assert.equal(f.calls[3].sessionId, undefined); assert.match(f.calls[3].developerInstructions!, /Новые правила/);
    const running = (await f.req('POST', route, f.token, { text: 'BLOCK' })).json();
    while (f.calls.length < 5) await new Promise(r => setTimeout(r, 10));
    await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, enabled: false, revision: 2 }); await idle(f.workspace);
    assert.equal(f.workspace.getRun(running.id).status, 'cancelled'); assert.equal(f.workspace.getRun(running.id).response, undefined);
    assert.deepEqual((await f.req('GET', '/api/agents', f.token)).json(), []);
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, revision: 1 })).statusCode, 409);
  } finally { await f.app.close(); }
});

test('Codex can consult a different specialist from the user recommendation', async () => {
  const catalog: unknown[] = [];
  const f = await fixture(async (request, signal) => {
    if (request.consultation) return 'Подзадача проверена';
    if (!request.prompt.includes('Проверь текст') && !request.prompt.includes('Самостоятельный выбор')) return;
    const tool = request.tools!;
    const available = await tool.call('consult_specialist', {}, signal);
    catalog.push(JSON.parse(available.text));
    assert.equal((await tool.call('consult_specialist', { specialistId: 'accountant', task: 'Проверка' }, signal)).success, false);
    const consultation = await tool.call('consult_specialist', { specialistId: 'reviewer', task: 'Проверь факты' }, signal);
    assert.equal(consultation.success, true);
    return consultation.text;
  });
  try {
    const { id, revision, ...base } = f.workspace.corporate.data.profiles[0];
    const editor = { ...base, name: 'Редактор', description: 'Исправляет текст.', instructions: 'Исправляй опечатки.', toolIds: [] };
    const reviewer = { ...base, name: 'Рецензент', description: 'Проверяет факты.', instructions: 'Проверяй факты.', toolIds: [],
      icon: 'search', instructionFiles: [{ name: 'review.md', text: 'Сверяй даты.' }] };
    assert.equal((await f.req('PUT', '/api/admin/profiles/editor', f.admin, { ...editor, description: ' ' })).statusCode, 400);
    assert.equal((await f.req('PUT', '/api/admin/profiles/editor', f.admin, editor)).statusCode, 200);
    const saved = await f.req('PUT', '/api/admin/profiles/reviewer', f.admin, reviewer);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().icon, 'search');
    assert.deepEqual(saved.json().instructionFiles, reviewer.instructionFiles);
    const project = '/api/projects/' + f.project.id;
    const chat = (await f.req('POST', project + '/chats', f.token, {})).json();
    const route = project + '/chats/' + chat.id + '/messages';
    const question = { text: 'Проверь текст', recommendedSpecialistId: 'editor', clientRequestId: 'specialist-1' };
    assert.equal((await f.req('POST', route, f.token, question)).statusCode, 403);
    const { id: roleId, ...role } = f.workspace.corporate.data.roles.find(item => item.id === 'employee')!;
    assert.equal((await f.req('PUT', '/api/admin/roles/' + roleId, f.admin, { ...role, profileIds: [id, 'editor', 'reviewer'] })).statusCode, 200);
    const attachment = await f.workspace.addAttachment(f.project.id, 'draft.txt', Buffer.from('private attachment'), () => f.employee.id);
    const sent = await f.req('POST', route, f.token, { ...question, attachmentIds: [attachment.id] });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.json().agentProfileId, id);
    assert.equal((await f.req('POST', route, f.token, { ...question, recommendedSpecialistId: 'reviewer', attachmentIds: [attachment.id] })).statusCode, 409);
    await idle(f.workspace);
    assert.equal(f.workspace.getRun(sent.json().id).status, 'complete');
    assert.match(f.calls[0].prompt, /Рекомендация сотрудника.*editor/);
    assert.doesNotMatch(f.calls[0].developerInstructions!, /Исправляй опечатки|Сверяй даты/);
    assert.match(f.calls[1].developerInstructions!, /Проверяй факты[\s\S]*review.md[\s\S]*Сверяй даты/);
    assert.equal(f.calls[1].prompt, 'Проверь факты');
    assert.equal(f.calls[1].allowWrite, false);
    assert.equal(f.calls[1].ephemeral, true);
    assert.equal(f.calls[1].sessionId, undefined);
    assert.equal(f.calls[1].tools, undefined);
    assert.deepEqual(catalog[0], [
      { id: 'editor', name: editor.name, description: editor.description },
      { id: 'reviewer', name: reviewer.name, description: reviewer.description },
    ]);
    const next = await f.req('POST', route, f.token, { text: 'Самостоятельный выбор' });
    assert.equal(next.statusCode, 202, next.body);
    await idle(f.workspace);
    assert.equal(f.workspace.getRun(next.json().id).status, 'complete');
    assert.ok(f.calls[2].sessionId);
    assert.doesNotMatch(f.calls[2].prompt, /Рекомендация сотрудника/);
    const detail = (await f.req('GET', project + '/chats/' + chat.id, f.token)).json();
    assert.equal(detail.messages[0].specialistName, 'Редактор');
    assert.deepEqual(detail.messages[1].consultedSpecialists, ['Рецензент']);
    assert.equal(detail.messages[1].usage.outputTokens, 31);
    assert.equal(detail.messages[2].specialistName, undefined);
    assert.deepEqual(detail.messages[3].consultedSpecialists, ['Рецензент']);
    const policy = { revision: 0, connections: [{ profileId: id, toolIds: ['chat-files'], fileIds: null }] };
    assert.equal((await f.req('PUT', project + '/agent-settings', f.admin, policy)).statusCode, 200);
    assert.equal((await f.req('POST', route, f.token, { ...question, clientRequestId: 'specialist-2' })).statusCode, 403);
  } finally { await f.app.close(); }
});

test('Fastkore requests preserve selection context while allowing questions about other ERP sections', async () => {
  const f = await fixture();
  try {
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const entitySet = randomUUID(), folder = randomUUID();
    const base = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: entitySet, scope_reproducible: true };
    const filtered = { ...base, filter_status: 'included', filter_xml: '<EntitySetFilter />', folder_id: folder };
    assert.equal((await f.req('POST', route, f.admin, { text: 'Вне Fastkore', fastkoreContext: filtered })).statusCode, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.req('POST', route, f.token, { text: 'Покажи выборку', fastkoreContext: filtered })).statusCode, 202);
    await idle(f.workspace);
    assert.match(f.calls[0].prompt, /EntitySetFilter/);
    assert.ok(f.calls[0].prompt.includes(folder));
    const unfiltered = { ...base, filter_status: 'none', filter_xml: null, folder_id: null };
    assert.equal((await f.req('POST', route, f.token, { text: 'Новая область', fastkoreContext: unfiltered })).statusCode, 202);
    await idle(f.workspace);
    assert.match(f.calls[1].prompt, /"filter_xml":null/);
    assert.match(f.calls[1].prompt, /"folder_id":null/);
    assert.ok(!f.calls[1].prompt.includes(folder));
    assert.equal(f.calls[1].sessionId, undefined);
    assert.equal((await f.req('POST', route, f.token, {
      text: 'В главном окне ERP', fastkoreContext: { type: 'fastkore.context', version: 1, view: 'none' },
    })).statusCode, 202);
    await idle(f.workspace);
    assert.doesNotMatch(f.calls[2].prompt, /entity_set_id|filter_xml|EntitySetFilter/);
    assert.equal(f.workspace.chat(f.project.id, chat.id).messages[0].text, 'Покажи выборку');
    for (const context of [{ ...filtered, scope_reproducible: false }, { ...base, filter_status: 'unavailable', filter_xml: null }]) {
      assert.equal((await f.req('POST', route, f.token, { text: 'Покажи заказы из другого раздела', fastkoreContext: context })).statusCode, 202);
      await idle(f.workspace);
      assert.match(f.calls.at(-1)!.prompt, /scope=erp/);
      assert.match(f.calls.at(-1)!.prompt, /scope=current/);
    }
  } finally { await f.app.close(); }
});

test('project files are managed by a local administrator and read by the agent only in the current project', async () => {
  const f = await fixture();
  try {
    const route = '/api/projects/' + f.project.id + '/files';
    const upload = (url: string, token: string, name: string, content: string) => f.app.inject({
      method: 'POST', url, headers: {
        authorization: 'Bearer ' + token, 'content-type': 'multipart/form-data; boundary=bridge-files',
      }, payload: '--bridge-files\r\nContent-Disposition: form-data; name="file"; filename="' + name +
        '"\r\nContent-Type: text/plain\r\n\r\n' + content + '\r\n--bridge-files--\r\n',
    });
    assert.equal((await f.req('GET', route, f.token)).statusCode, 403);
    assert.equal((await f.req('POST', route, f.token)).statusCode, 403);
    const uploadResult = await upload(route, f.admin, 'project-notes.txt', 'Project reference');
    assert.equal(uploadResult.statusCode, 201, uploadResult.body);
    const file = uploadResult.json();
    assert.ok(!Object.hasOwn(file, 'path'));
    assert.deepEqual((await f.req('GET', route, f.admin)).json(), [file]);
    assert.equal((await f.req('GET', route + '/' + file.id, f.token)).statusCode, 403);
    const download = await f.req('GET', route + '/' + file.id, f.admin);
    assert.equal(download.body, 'Project reference');
    assert.match(String(download.headers['content-disposition']), /attachment.*project-notes\.txt/);
    const other = await f.workspace.createProject('Другой проект', () => f.employee.id);
    const otherFile = (await upload('/api/projects/' + other.id + '/files', f.admin, 'other.txt', 'Outside this project')).json();
    assert.equal((await f.req('GET', route + '/' + otherFile.id, f.admin)).statusCode, 404);
    const chat = (await f.req('POST', '/api/projects/' + f.project.id + '/chats', f.token, {})).json();
    assert.equal((await f.req('POST', '/api/projects/' + f.project.id + '/chats/' + chat.id + '/messages', f.token, { text: 'Прочитай материалы проекта' })).statusCode, 202);
    await idle(f.workspace);
    const tools = f.calls[0].tools!;
    const signal = new AbortController().signal;
    assert.deepEqual(JSON.parse((await tools.call('project_files_list', {}, signal)).text).files, [file]);
    assert.match((await tools.call('project_files_read', { id: file.id }, signal)).text, /Project reference/);
    assert.equal((await tools.call('project_files_read', { id: otherFile.id }, signal)).success, false);
    assert.equal((await f.req('DELETE', route + '/' + file.id, f.token)).statusCode, 403);
    assert.equal((await f.req('DELETE', route + '/' + file.id, f.admin)).statusCode, 200);
    assert.deepEqual((await f.req('GET', route, f.admin)).json(), []);
    assert.equal((await tools.call('project_files_read', { id: file.id }, signal)).success, false);
  } finally { await f.app.close(); }
});

test('project connections enforce the agent tool list, selected files, and access revocation', async () => {
  const f = await fixture();
  const projectPath = '/api/projects/' + f.project.id;
  const settingsPath = projectPath + '/agent-settings';
  try {
    const { id, ...profile } = f.workspace.corporate.data.profiles[0];
    const updated = await f.req('PUT', '/api/admin/profiles/' + id, f.admin, {
      ...profile, instructions: 'Указывай источники.', toolIds: ['project-files', 'fastkore'],
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const allowed = await f.workspace.addProjectFile(f.project.id, 'allowed.txt', Buffer.from('Allowed source'), () => 'admin');
    const denied = await f.workspace.addProjectFile(f.project.id, 'denied.txt', Buffer.from('Denied source'), () => 'admin');
    const attachment = await f.workspace.addAttachment(f.project.id, 'attachment.txt', Buffer.from('Attachment'), () => f.employee.id);
    const other = await f.workspace.createProject('Другой проект', () => f.employee.id);
    const foreign = await f.workspace.addProjectFile(other.id, 'foreign.txt', Buffer.from('Foreign source'), () => 'admin');
    const policy = { revision: 0, connections: [{ profileId: id, toolIds: ['project-files', 'chat-files'], fileIds: [allowed.id] }] };
    assert.equal((await f.req('GET', settingsPath, f.token)).statusCode, 403);
    assert.equal((await f.req('PUT', settingsPath, f.token, policy)).statusCode, 403);
    assert.equal((await f.req('PUT', settingsPath, f.admin, {
      ...policy, connections: [{ ...policy.connections[0], fileIds: [foreign.id] }],
    })).statusCode, 400);
    const saved = await f.req('PUT', settingsPath, f.admin, policy);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, 1);
    assert.equal((await f.req('PUT', settingsPath, f.admin, policy)).statusCode, 409);
    assert.deepEqual((await f.req('GET', projectPath + '/agents', f.token)).json()[0].toolIds, ['project-files']);
    assert.equal((await f.req('GET', settingsPath, f.admin)).json().files.length, 2);

    let erpPrepares = 0;
    f.workspace.prepareFastkoreTools = async () => { erpPrepares++; return {}; };
    const chat = (await f.req('POST', projectPath + '/chats', f.token, {})).json();
    const messages = projectPath + '/chats/' + chat.id + '/messages';
    assert.equal((await f.req('POST', messages, f.token, { text: 'Вложение', attachmentIds: [attachment.id] })).statusCode, 403);
    const sent = await f.req('POST', messages, f.token, { text: 'Прочитай материалы', fastkoreContext: {
      type: 'fastkore.context', version: 1, view: 'list', entity_set_id: randomUUID(), scope_reproducible: true, filter_status: 'none',
    } });
    assert.equal(sent.statusCode, 202, sent.body);
    await idle(f.workspace);
    assert.equal(erpPrepares, 0);
    assert.doesNotMatch(f.calls[0].prompt, /fastkore_context/);
    assert.match(f.calls[0].developerInstructions!, /Указывай источники/);
    const tools = f.calls[0].tools!;
    const signal = new AbortController().signal;
    assert.deepEqual(JSON.parse((await tools.call('project_files_list', {}, signal)).text).files, [allowed]);
    assert.equal((await tools.call('project_files_read', { id: allowed.id }, signal)).success, true);
    assert.equal((await tools.call('project_files_read', { id: denied.id }, signal)).success, false);

    const running = (await f.req('POST', messages, f.token, { text: 'BLOCK' })).json();
    const deadline = Date.now() + 4000;
    while (f.calls.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.length, 2);
    assert.equal((await f.req('PUT', settingsPath, f.admin, { revision: 1, connections: [] })).statusCode, 200);
    await idle(f.workspace);
    assert.equal(f.workspace.getRun(running.id).status, 'cancelled');
    assert.deepEqual((await f.req('GET', projectPath + '/agents', f.token)).json(), []);
    assert.equal((await f.req('POST', messages, f.token, { text: 'Продолжить' })).statusCode, 403);
    assert.equal((await f.req('POST', projectPath + '/chats', f.token, {})).statusCode, 403);
    assert.deepEqual((await f.req('GET', '/api/projects/' + other.id + '/agents', f.token)).json()[0].toolIds, ['project-files']);
    assert.equal((await f.req('POST', '/api/projects/' + other.id + '/chats', f.token, {})).statusCode, 201);
    assert.equal((await f.req('GET', projectPath + '/chats/' + chat.id, f.token)).statusCode, 200);
  } finally { await f.app.close(); }
  const reopened = new Store(f.store.root);
  try { assert.deepEqual(reopened.state.projects.find(project => project.id === f.project.id)?.agentPolicy, { revision: 2, connections: [] }); }
  finally { await reopened.close(); }
});

test('dataset registry and profile configuration persist and cannot expose closed sources through chat mode', async () => {
  const f = await fixture(); try {
    assert.equal((await f.req('PUT', '/api/admin/datasets/prices', f.admin, { name: 'Прайсы', directory: path.join(f.root, 'project'), projectIds: [f.project.id], classification: 'restricted' })).statusCode, 200);
    const base = f.workspace.corporate.data.profiles[0]; const { id, revision, ...input } = base;
    const profile: Omit<AgentProfile, 'revision'> = { ...input, id: 'pricing_test', name: 'Проверка прайса', datasetIds: ['prices'], outputMode: 'chat', enabled: true };
    const { id: target, ...body } = profile;
    assert.equal((await f.req('PUT', '/api/admin/profiles/' + target, f.admin, body)).statusCode, 200);
    assert.equal((await f.req('POST', `/api/projects/${f.project.id}/chats`, f.admin, { agentProfileId: target })).statusCode, 409); assert.equal(f.calls.length, 0);
    assert.equal((await f.req('POST', `/api/projects/${f.project.id}/chats`, f.admin, { agentProfileId: 'universal' })).statusCode, 409);
    assert.equal((await f.req('POST', '/api/subscription/check', f.admin, {})).statusCode, 409);
    assert.equal((await f.req('GET', '/api/admin/datasets', f.token)).statusCode, 403);
    await f.app.close(); const reopened = new Store(f.store.root);
    assert.equal(reopened.state.corporate!.datasets[0].classification, 'restricted'); assert.equal(reopened.state.corporate!.profiles.at(-1)!.datasetIds[0], 'prices'); await reopened.close();
  } finally { await f.app.close(); }
});

test('SSO logout stops active execution and prevents queued work from starting', async () => {
  const f = await fixture(); try {
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json(), route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const running = (await f.req('POST', route, f.token, { text: 'BLOCK' })).json();
    const deadline = Date.now() + 5000; while (!f.calls.length) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
    const waiting = (await f.req('POST', route, f.token, { text: 'must not run' })).json(); assert.equal(waiting.status, 'queued');
    assert.equal((await f.req('POST', '/api/auth/logout', f.token)).statusCode, 200); await idle(f.workspace);
    assert.equal(f.workspace.getRun(running.id).status, 'cancelled'); assert.equal(f.workspace.getRun(waiting.id).status, 'error'); assert.equal(f.calls.length, 1);
    assert.equal((await f.req('GET', '/api/agents', f.token)).statusCode, 401);
  } finally { await f.app.close(); }
});

test('deployment mode disables inference and keeps accepted queue intact; HTTPS origin is explicit', async () => {
  const execution = process.env.BRIDGE_EXECUTION, origin = process.env.BRIDGE_PUBLIC_ORIGIN;
  process.env.BRIDGE_EXECUTION = 'disabled'; process.env.BRIDGE_PUBLIC_ORIGIN = 'https://agents.example.internal';
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture();
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const send = await f.req('POST', `/api/projects/${f.project.id}/chats/${chat.id}/messages`, f.token, { text: 'do not run' }); assert.equal(send.statusCode, 503); assert.equal(f.calls.length, 0);
    const status = (await f.req('GET', '/api/status', f.token)).json(); assert.equal(status.executionDisabled, true); assert.deepEqual(status.addresses, ['https://agents.example.internal']);
    const headers = { cookie: f.token, host: 'agents.example.internal', 'x-forwarded-proto': 'https', origin: 'https://agents.example.internal' };
    assert.equal((await f.app.inject({ url: '/api/projects', headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/projects', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    f.store.state.runs.push({ id: 'queued-fixture', projectId: f.project.id, chatId: chat.id, status: 'queued', progress: 'waiting', createdAt: new Date().toISOString() });
    f.store.state.jobs!.push({ runId: 'queued-fixture', kind: 'chat', text: 'do not run', attachmentIds: [] }); await f.store.save(); f.workspace.start();
    assert.equal(f.workspace.getRun('queued-fixture').status, 'queued'); assert.equal(f.calls.length, 0);
  } finally {
    await f?.app.close();
    if (execution === undefined) delete process.env.BRIDGE_EXECUTION; else process.env.BRIDGE_EXECUTION = execution;
    if (origin === undefined) delete process.env.BRIDGE_PUBLIC_ORIGIN; else process.env.BRIDGE_PUBLIC_ORIGIN = origin;
  }
});
