import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import { initializeCorporate } from '../server/corporate.js';
import { migrateFastkoreChatBindings } from '../server/fastkore-chat.js';
import { fastkoreChatTitle, fastkoreExecutionContext, parseFastkoreContext } from '../shared/fastkore-context.js';
import type { AgentProfile } from '../shared/types.js';
import type { CodexRequest, CodexRunner } from '../server/codex.js';
import { erpBrowser } from './erp-browser.js';
import { FilesystemLibraryBlobStore } from '../server/library/blob-store.js';
const password = 'Corporate-test-password-2026';
async function fixture(respond?: (request: CodexRequest, signal: AbortSignal) => Promise<string | undefined>) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-corporate-')); await mkdir(path.join(root, 'project'));
  const calls: CodexRequest[] = [];
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async (r, onEvent, signal) => {
    calls.push(r);
    if (r.consultation) return { response: (await respond?.(r, signal)) ?? 'Консультация', usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
    await onEvent({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
    if (r.prompt.endsWith('\nBLOCK')) await new Promise((resolve, reject) => { if (signal.aborted) reject(Error('aborted')); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    return { sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', response: (await respond?.(r, signal)) ?? 'OK', usage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 30 } };
  } };
  const store = new Store(path.join(root, 'data')), workspace = new Workspace(store, runner); await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  workspace.useLibraryStorage({ store: new FilesystemLibraryBlobStore(path.join(root, 'library-objects')) });
  const erp = erpBrowser(process.env.BRIDGE_PUBLIC_ORIGIN);
  const project = await workspace.addProject(path.join(root, 'project')), app = await createApp(workspace, erp.options);
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
  const admin = (await req('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Руководитель', password })).json().token;
  const login = await erp.pair(app, admin);
  const enter = (name: string) => login(name, undefined, [{ id: randomUUID(), name }]);
  const { user: employee, cookie: token, projectRoles } = await enter('Алиса');
  assert.equal((await req('PATCH', '/api/users/' + employee.id, admin, { roleId: 'employee' })).statusCode, 200);
  const setProjectRoles = (projectId: string, roles: typeof projectRoles) => erp.setProjectRoles(app, admin, projectId, roles);
  assert.equal((await setProjectRoles(project.id, projectRoles)).statusCode, 200);
  return { root, calls, store, workspace, project, app, req, admin, employee, token, enter, runner, projectRoles, setProjectRoles };
}
async function idle(workspace: Workspace) { const deadline = Date.now() + 6000; while (workspace.busy) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } }

test('new projects connect only enabled agents that opt in, and existing projects keep their connections', async () => {
  const f = await fixture();
  try {
    const { id: _id, revision: _revision, autoConnect: _autoConnect, ...base } = f.workspace.corporate.data.profiles[0];
    const save = async (id: string, values: object) => {
      const result = await f.req('PUT', '/api/admin/profiles/' + id, f.admin, { ...base, name: id, ...values });
      assert.equal(result.statusCode, 200, result.body);
      return result.json();
    };
    assert.equal((await save('manual_agent', {})).autoConnect, false);
    let automatic = await save('automatic_agent', { autoConnect: true });
    await save('disabled_agent', { enabled: false, autoConnect: true });
    const create = async (input: { name: string; directory?: string }) => {
      const result = await f.req('POST', '/api/projects', f.admin, input);
      assert.equal(result.statusCode, 201, result.body);
      return result.json().id as string;
    };
    const connections = async (id: string) => {
      const result = await f.req('GET', '/api/projects/' + id + '/agent-settings', f.admin);
      assert.equal(result.statusCode, 200, result.body);
      return result.json().policy.connections.map((connection: { profileId: string }) => connection.profileId);
    };
    const project = await create({ name: 'Новый проект' });
    assert.deepEqual(await connections(project), ['universal', 'automatic_agent']);
    const initialAgents = await f.req('GET', '/api/projects/' + project + '/agents', f.admin);
    assert.deepEqual(initialAgents.json().map((agent: AgentProfile) => agent.id), ['universal', 'automatic_agent']);
    automatic = await save('automatic_agent', { revision: automatic.revision, description: 'Уточнённое описание' });
    assert.equal(automatic.autoConnect, true);
    await save('automatic_agent', { revision: automatic.revision, autoConnect: false });
    const directory = path.join(f.root, 'new-directory');
    await mkdir(directory);
    const attached = await create({ name: 'Проект из папки', directory });
    assert.deepEqual(await connections(attached), ['universal']);
    assert.deepEqual(await connections(project), ['universal', 'automatic_agent']);
    assert.deepEqual(await connections(f.project.id), ['universal', 'manual_agent', 'automatic_agent']);
    const universal = f.workspace.corporate.data.profiles[0];
    await save('universal', { revision: universal.revision, autoConnect: false });
    assert.deepEqual(await connections(await create({ name: 'Без агентов' })), []);
  } finally { await f.app.close(); }
});

test('a Fastkore project member can start and run a linked chat without an internal role assignment', async () => {
  const f = await fixture();
  try {
    const member = await f.enter('Проверка доступа');
    assert.equal(member.user.roleId, 'sso_pending');
    const project = '/api/projects/' + f.project.id;
    const policy = { revision: 0, connections: [{ profileId: 'universal', toolIds: [], fileIds: null }] };
    assert.equal((await f.req('PUT', project + '/agent-settings', f.admin, policy)).statusCode, 200);
    assert.equal((await f.req('GET', project + '/agents', member.cookie)).statusCode, 404);
    assert.equal((await f.setProjectRoles(f.project.id, member.projectRoles)).statusCode, 200);
    assert.deepEqual((await f.req('GET', project + '/agents', member.cookie)).json().map((p: AgentProfile) => p.id), ['universal']);
    const context = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: randomUUID(),
      entity_ids: [], scope_reproducible: true, filter_status: 'none' };
    const opened = await f.req('POST', '/api/fastkore/chats', member.cookie, { projectId: f.project.id, context, agentProfileId: 'universal' });
    assert.equal(opened.statusCode, 201, opened.body);
    const messages = project + '/chats/' + opened.json().chat.id + '/messages';
    const sent = await f.req('POST', messages, member.cookie, { text: 'Проверь заказы', fastkoreContext: context });
    assert.equal(sent.statusCode, 202, sent.body);
    await idle(f.workspace);
    assert.equal(f.workspace.getRun(sent.json().id).status, 'complete');
    assert.equal((await f.req('PUT', project + '/agent-settings', f.admin, { revision: 1, connections: [] })).statusCode, 200);
    assert.equal((await f.req('POST', messages, member.cookie, { text: 'Ещё раз', fastkoreContext: context })).statusCode, 403);
  } finally { await f.app.close(); }
});

test('moving a chat requires access to the destination and preserves its history and files', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'destination');
    await mkdir(directory);
    const destination = await f.workspace.addProject(directory);
    const chats = `/api/projects/${f.project.id}/chats`;
    const created = await f.req('POST', chats, f.token, { title: 'Исходный чат' });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json();
    const source = f.workspace.chat(f.project.id, id);
    const result = await f.workspace.files.upload('local', f.project, 'result.txt', Buffer.from('Содержимое'));
    source.messages.push({
      id: randomUUID(), role: 'assistant', status: 'complete', text: 'Результат',
      createdAt: new Date().toISOString(), attachments: [result],
    });
    await f.store.save();

    const move = `${chats}/${id}/move`, body = { projectId: destination.id, title: 'Новое название' };
    assert.equal((await f.req('PATCH', move, f.token, body)).statusCode, 404);
    assert.equal((await f.setProjectRoles(destination.id, f.projectRoles)).statusCode, 200);
    const saved = await f.req('PATCH', move, f.token, body);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await f.req('GET', `${chats}/${id}`, f.token)).statusCode, 404);
    const moved = f.workspace.chat(destination.id, id);
    assert.equal(moved.title, body.title);
    assert.equal(moved.ownerId, source.ownerId);
    assert.equal(moved.messages[0].text, 'Результат');
    assert.equal((await f.workspace.files.read(destination, moved.messages[0].attachments[0])).toString(), 'Содержимое');
  } finally { await f.app.close(); }
});

test('deleting a project preserves chats, attachments and archive while removing shared access', async () => {
  const f = await fixture();
  try {
    const source = `/api/projects/${f.project.id}`;
    const colleague = await f.enter('Борис');
    assert.equal((await f.setProjectRoles(f.project.id, [...f.projectRoles, ...colleague.projectRoles])).statusCode, 200);
    const created = await f.req('POST', source + '/chats', f.token, { title: 'История проекта' });
    assert.equal(created.statusCode, 201, created.body);
    const chat = f.workspace.chat(f.project.id, created.json().id);
    const url = `${source}/chats/${chat.id}`;
    const file = await f.workspace.files.upload('local', f.project, 'result.txt', Buffer.from('Сохранённый файл'));
    const messageId = randomUUID();
    chat.messages.push({ id: messageId, role: 'assistant', status: 'complete', text: 'Результат', createdAt: new Date().toISOString(), attachments: [file] });
    const archived = await f.workspace.addChat(f.project.id, 'Ранее архивированный', '', f.employee.id);
    assert.equal((await f.req('PATCH', `${source}/chats/${archived.id}/archive`, f.admin, { archived: true })).statusCode, 200);
    assert.equal((await f.req('PATCH', url + '/visibility', f.admin, { visibility: 'project' })).statusCode, 200);
    assert.equal((await f.req('GET', url, colleague.cookie)).statusCode, 200);
    assert.equal((await f.req('DELETE', source, f.token)).statusCode, 403);

    const running = await f.req('POST', url + '/messages', f.token, { text: 'BLOCK' });
    assert.equal(running.statusCode, 202, running.body);
    assert.equal((await f.req('DELETE', source, f.admin)).statusCode, 409);
    await f.req('POST', `/api/runs/${running.json().id}/cancel`, f.token, {});
    await idle(f.workspace);

    assert.equal((await f.req('DELETE', source, f.admin)).statusCode, 200);
    assert.equal((await f.req('DELETE', source, f.admin)).statusCode, 200);
    assert.deepEqual((await f.req('GET', '/api/projects', f.admin)).json(), []);
    const list = '/api/chats/without-project';
    assert.deepEqual((await f.req('GET', list, f.token)).json().map((item: { id: string }) => item.id), [chat.id]);
    assert.deepEqual((await f.req('GET', list, colleague.cookie)).json(), []);
    assert.equal((await f.req('GET', url, colleague.cookie)).statusCode, 404);
    assert.equal((await f.req('GET', url, f.token)).json().visibility, 'private');
    assert.equal((await f.req('GET', '/api/chats/archive', f.token)).json()[0].projectName, 'Без проекта');
    assert.equal((await f.req('GET', source + '/agent-settings', f.admin)).statusCode, 404);
    assert.equal((await f.req('POST', url + '/messages', f.token, { text: 'Ещё вопрос' })).statusCode, 409);
    const stored = new Store(path.join(f.root, 'data'));
    try {
      assert.ok(stored.state.projects[0].deletedAt);
      assert.equal(stored.state.projects[0].chats.find(item => item.id === chat.id)?.messages[0].attachments[0].id, file.id);
    } finally { await stored.close(); }
    assert.equal((await f.req('GET', `${url}/messages/${messageId}/files/${file.id}`, f.token)).body, 'Сохранённый файл');

    const folder = path.join(f.root, 'destination');
    await mkdir(folder);
    const destination = await f.workspace.addProject(folder);
    assert.equal((await f.setProjectRoles(destination.id, f.projectRoles)).statusCode, 200);
    const moved = await f.req('PATCH', url + '/move', f.token, { projectId: destination.id });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.deepEqual((await f.req('GET', list, f.token)).json(), []);
    const copied = moved.json().messages[0].attachments[0];
    const target = `/api/projects/${destination.id}/chats/${chat.id}/messages/${messageId}/files/${copied.id}`;
    assert.equal((await f.req('GET', target, f.token)).body, 'Сохранённый файл');
  } finally { await f.app.close(); }
});

test('an employee chooses a project for a new named Fastkore chat and can move it without losing its context', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'second-project');
    await mkdir(directory);
    const destination = await f.workspace.addProject(directory);
    assert.equal((await f.setProjectRoles(destination.id, f.projectRoles)).statusCode, 200);
    const component = randomUUID(), tile = randomUUID(), entity = randomUUID();
    const header = { type: 'fastkore.context', version: 1, entity_set_id: component, entity_set_name: 'Заказы', filter_status: 'none', scope_reproducible: true };
    const list = { ...header, view: 'list', entity_ids: [], tile_id: tile, tile_name: '  Текущие\nзаказы  ', chat_key: 'tile:' + tile };
    const history = (context: object) => f.req('POST', '/api/fastkore/chats/related', f.token, { context });
    const create = (context: object, projectId = f.project.id) => f.req('POST', '/api/fastkore/chats', f.token, { projectId, context });
    assert.deepEqual((await history(list)).json(), []);
    const response = await create(list, destination.id);
    assert.equal(response.statusCode, 201, response.body);
    const created = response.json();
    assert.equal(created.projectId, destination.id);
    assert.equal(created.chat.title, 'Текущие заказы');
    const oldUrl = `/api/projects/${destination.id}/chats/${created.chat.id}`;
    const moved = await f.req('PATCH', oldUrl + '/move', f.token, { projectId: f.project.id });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().title, created.chat.title);
    assert.equal((await f.req('GET', oldUrl, f.token)).statusCode, 404);
    const rows = (await history({ ...list, tile_name: 'Другое название' })).json();
    assert.deepEqual(rows.map((row: { id: string; projectId: string; title: string }) =>
      [row.id, row.projectId, row.title]), [[created.chat.id, f.project.id, 'Текущие заказы']]);
    const repeated = await create(list, destination.id);
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().chat.id, created.chat.id);
    const card = { ...header, view: 'card', entity_ids: [entity], entity_name: 'Заказ №42', chat_key: `card:${component}:${entity}` };
    assert.equal((await create(card)).json().chat.title, 'Заказ №42');
    const componentList = { ...header, view: 'list', entity_ids: [], chat_key: 'list:' + component };
    assert.equal((await create(componentList)).json().chat.title, 'Заказы');
  } finally { await f.app.close(); }
});

test('a card with history in an inaccessible project can open a private chat in the selected project', async () => {
  const f = await fixture();
  try {
    const destination = await f.workspace.createProject('Поддержка', () => f.projectRoles);
    const component = randomUUID(), entity = randomUUID();
    const context = { type: 'fastkore.context', version: 1, view: 'card', entity_set_id: component, entity_ids: [entity],
      entity_name: 'Обращение #17559', chat_key: 'card:' + component + ':' + entity, filter_status: 'none', scope_reproducible: true };
    const open = (projectId: string) => f.req('POST', '/api/fastkore/chats', f.token, { projectId, context });
    const related = () => f.req('POST', '/api/fastkore/chats/related', f.token, { context });
    const original = await open(f.project.id);
    assert.equal(original.statusCode, 201);
    const originalId = original.json().chat.id;
    const sourcePath = '/api/projects/' + f.project.id + '/chats/' + originalId;
    assert.equal((await f.req('POST', sourcePath + '/messages', f.token, { text: 'Прежняя переписка', fastkoreContext: context })).statusCode, 202);
    await idle(f.workspace);
    assert.equal((await f.setProjectRoles(f.project.id, [])).statusCode, 200);
    assert.deepEqual((await related()).json(), []);
    assert.equal((await open(f.project.id)).statusCode, 404);
    const attempts = await Promise.all([open(destination.id), open(destination.id)]);
    assert.deepEqual(attempts.map(r => r.statusCode).sort(), [200, 201]);
    const replacement = attempts[0].json().chat;
    assert.equal(attempts[1].json().chat.id, replacement.id);
    assert.equal(attempts[0].json().projectId, destination.id);
    assert.notEqual(replacement.id, originalId);
    assert.deepEqual(replacement.messages, []);
    assert.equal(replacement.visibility, 'private');
    assert.equal((await f.req('POST', '/api/projects/' + destination.id + '/chats/' + replacement.id + '/messages',
      f.token, { text: 'Привет', fastkoreContext: context })).statusCode, 202);
    await idle(f.workspace);
    assert.match(f.calls.at(-1)!.prompt, /Привет/);
    assert.doesNotMatch(f.calls.at(-1)!.prompt, /Прежняя переписка/);
    assert.deepEqual((await related()).json().map((row: { id: string }) => row.id), [replacement.id]);
    assert.equal((await f.req('GET', sourcePath, f.token)).statusCode, 404);
    assert.equal((await f.setProjectRoles(f.project.id, f.projectRoles)).statusCode, 200);
    assert.equal((await open(f.project.id)).json().chat.id, originalId);
    assert.equal((await open(destination.id)).json().chat.id, replacement.id);
    assert.match((await f.req('GET', sourcePath, f.token)).body, /Прежняя переписка/);
  } finally { await f.app.close(); }
});

test('Fastkore navigation uses the saved chat target and does not expose it outside the owner ERP session', async () => {
  const f = await fixture();
  try {
    const authentication = (await f.req('GET', '/api/auth/me', f.token)).json().authentication;
    const { installationId } = authentication;
    const entitySet = randomUUID(), entity = randomUUID(), tile = randomUUID();
    const uri = `fastkore://ERP/Instance/ShowEntity?entitySet=${entitySet.toUpperCase()}&entity=${entity}`;
    const base = { type: 'fastkore.context', version: 1, entity_set_id: entitySet, filter_status: 'none', scope_reproducible: true };
    const card = { ...base, view: 'card', entity_ids: [entity], chat_key: `card:${entitySet}:${entity}` };
    const tileContext = { ...base, view: 'list', entity_ids: [entity], tile_id: tile, tile_name: 'Текущие заказы', chat_key: `tile:${tile}` };
    const create = (context: object) => f.req('POST', '/api/fastkore/chats', f.token, { projectId: f.project.id, context });
    const related = (context: object) => f.req('POST', '/api/fastkore/chats/related', f.token, { context });
    const created = (await create(card)).json().chat;
    const cardPath = `/api/projects/${f.project.id}/chats/${created.id}`;
    assert.equal(created.fastkoreNavigation, undefined);
    const wrongUri = uri.replace(entity, randomUUID());
    assert.equal((await related({ ...card, entity_uri: wrongUri })).statusCode, 200);
    assert.equal((await f.req('GET', cardPath, f.token)).json().fastkoreNavigation, undefined);

    const linked = { ...card, view: 'link_list', entity_ids: [], entity_set_id: randomUUID(),
      owner_entity_set_id: entitySet, owner_entity_id: entity, entity_uri: uri, entity_name: 'Заказ №42' };
    assert.equal(fastkoreChatTitle(parseFastkoreContext(linked)!), linked.entity_name);
    assert.equal((await related(linked)).json()[0].id, created.id);
    const target = { installationId, entityUri: uri };
    assert.deepEqual((await f.req('GET', cardPath, f.token)).json().fastkoreNavigation, target);
    assert.equal((await f.req('GET', cardPath, f.admin)).json().fastkoreNavigation, undefined);
    assert.equal((await related(card)).statusCode, 200);
    assert.deepEqual((await create(card)).json().chat.fastkoreNavigation, target);
    assert.ok(!Object.hasOwn(fastkoreExecutionContext(parseFastkoreContext(linked)!)!, 'entity_uri'));

    const tileChat = (await create({ ...tileContext, entity_uri: uri })).json().chat;
    assert.deepEqual(tileChat.fastkoreNavigation, { installationId, tileId: tile, tileName: tileContext.tile_name });
    assert.equal((await related({ ...tileContext, entity_ids: [], folder_id: randomUUID() })).json()[0].id, tileChat.id);
    assert.deepEqual((await f.req('GET', cardPath, f.token)).json().fastkoreNavigation, target);
  } finally { await f.app.close(); }
});

test('chat consultants persist and exclude the base assistant', async () => {
  const f = await fixture();
  try {
    const base = f.workspace.corporate.data.profiles.find(profile => profile.id === 'universal')!;
    assert.equal(base.name, 'Помощник Фасткор');
    const specialist = { ...base, id: 'reviewer', name: 'Рецензент' };
    f.workspace.corporate.data.profiles.push(specialist);
    const chats = `/api/projects/${f.project.id}/chats`;
    const created = await f.req('POST', chats, f.admin, { title: 'Консультация' });
    assert.equal(created.statusCode, 201, created.body);
    const chat = `${chats}/${created.json().id}`;
    assert.equal((await f.req('PATCH', chat + '/specialists', f.admin, { consultantIds: [base.id] })).statusCode, 403);
    const saved = await f.req('PATCH', chat + '/specialists', f.admin, { consultantIds: [specialist.id] });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual((await f.req('GET', chat, f.admin)).json().consultantIds, [specialist.id]);
    assert.equal((await f.req('PATCH', chat + '/specialists', f.admin, { consultantIds: [] })).statusCode, 200);
    assert.deepEqual((await f.req('GET', chat, f.admin)).json().consultantIds, []);
  } finally { await f.app.close(); }
});

test('sharing a linked chat preserves one history and locks concurrent submissions by other authors', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => {
    if (request.prompt.endsWith('Конкурентный вопрос Алисы') || request.prompt.endsWith('Конкурентный вопрос Бориса')) await hold;
    return 'Ответ участнику';
  });
  try {
    const peer = await f.enter('Борис');
    assert.equal((await f.req('PATCH', '/api/users/' + peer.user.id, f.admin, { roleId: 'employee' })).statusCode, 200);
    assert.equal((await f.setProjectRoles(f.project.id, [...f.projectRoles, ...peer.projectRoles])).statusCode, 200);
    const set = randomUUID(), entity = randomUUID(), other = randomUUID();
    const context = {
      type: 'fastkore.context', version: 1, view: 'card', entity_set_id: set, entity_ids: [entity],
      chat_key: `card:${set}:${entity}`, filter_status: 'none', scope_reproducible: true,
      entity_uri: `fastkore://ERP/Instance/ShowEntity?entitySet=${set}&entity=${entity}`,
    };
    const created = await f.req('POST', '/api/fastkore/chats', f.token, { projectId: f.project.id, context });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().chat.id;
    const url = `/api/projects/${f.project.id}/chats/${id}`;
    assert.equal((await f.req('GET', url, peer.cookie)).statusCode, 404);
    const share = (visibility: string, token = f.token) => f.req('PATCH', url + '/visibility', token, { visibility });
    assert.equal((await share('project')).json().id, id);
    const related = await f.req('POST', '/api/fastkore/chats/related', peer.cookie, { context });
    assert.equal(related.json()[0].id, id);
    assert.equal((await f.req('GET', url, peer.cookie)).json().fastkoreNavigation.entityUri, context.entity_uri);
    const post = (token: string, text: string, fastkoreContext = context) => f.req('POST', url + '/messages', token, { text, fastkoreContext });
    assert.equal((await post(peer.cookie, 'Wrong card', { ...context, entity_ids: [other], chat_key: `card:${set}:${other}`, entity_uri: '' })).statusCode, 409);
    const owners = [{ token: f.token, name: 'Алиса' }, { token: peer.cookie, name: 'Борис' }];
    const results = await Promise.all(owners.map((actor, index) => post(actor.token, index === 0 ? 'Конкурентный вопрос Алисы' : 'Конкурентный вопрос Бориса')));
    assert.deepEqual(results.map(result => result.statusCode).sort(), [202, 409]);
    const winner = results.findIndex(result => result.statusCode === 202), first = owners[winner], second = owners[1 - winner];
    const runId = results[winner].json().id;
    assert.match(results[1 - winner].body, /Другой участник ждёт ответа/);
    const status = (await f.req('GET', '/api/status', second.token)).json();
    assert.ok([...status.activeRuns, ...status.queuedRuns].some(run => run.id === runId));
    assert.equal((await post(first.token, 'Своё уточнение в очереди')).statusCode, 202);
    assert.equal((await post(second.token, 'Заблокированный вопрос')).statusCode, 409);
    assert.equal((await f.req('POST', `/api/runs/${runId}/cancel`, second.token, {})).statusCode, 403);
    assert.equal((await share('private')).statusCode, 409);
    release(); await idle(f.workspace);
    const followUp = await post(second.token, 'Теперь вопрос коллеги');
    assert.equal(followUp.statusCode, 202, followUp.body);
    await idle(f.workspace);
    const result = (await f.req('GET', url, second.token)).json();
    assert.equal(result.ownerId, f.employee.id);
    assert.deepEqual(result.messages.filter(message => message.role === 'user').map(message => message.authorName), [first.name, first.name, second.name]);
    const prompt = f.calls.at(-1)!;
    assert.equal(prompt.sessionId, undefined);
    assert.ok(prompt.prompt.includes(`"author":"${first.name}"`) && prompt.prompt.includes('Своё уточнение в очереди'));
    assert.equal((await share('private')).statusCode, 200);
    assert.equal((await f.req('GET', url, peer.cookie)).statusCode, 404);
  } finally { release(); await f.app.close(); }
});

test('explicitly saving an instruction in a shared chat records the model formulation for the sender only', async () => {
  const instruction = 'Сверять итог перед отправкой документа.';
  const privateOwner = 'PRIVATE_OWNER_NOTE', privatePeer = 'PRIVATE_PEER_NOTE';
  let writes = 0;
  const f = await fixture(async (request, signal) => {
    assert.doesNotMatch(request.prompt, /PRIVATE_OWNER_NOTE|PRIVATE_PEER_NOTE/);
    const tool = request.tools?.definitions.find(tool => tool.name === 'my_instructions');
    if (request.prompt.endsWith('Обычный вопрос') || request.prompt.endsWith('Удали мои инструкции.')) {
      assert.equal(tool, undefined);
      return 'Откройте личные инструкции.';
    }
    assert.ok(tool);
    assert.match(request.developerInstructions ?? '', /сформулируй своими словами/);
    if (request.prompt.endsWith('Сохрани инструкцию.')) return 'Какое правило закрепить?';
    const call = (args: unknown) => request.tools!.call('my_instructions', args, signal);
    assert.equal((await call({ action: 'read' })).success, false);
    assert.equal((await call({ action: 'replace', text: 'wrong', revision: 1 })).success, false);
    const saved = await call({ action: 'remember', title: 'Контроль итога', text: instruction, scope: 'general' });
    assert.equal(saved.success, true, saved.text);
    assert.doesNotMatch(saved.text, /PRIVATE_OWNER_NOTE|PRIVATE_PEER_NOTE/);
    writes++;
    return 'Приём готов.';
  });
  try {
    const peer = await f.enter('Борис');
    assert.equal((await f.req('PATCH', '/api/users/' + peer.user.id, f.admin, { roleId: 'employee' })).statusCode, 200);
    assert.equal((await f.setProjectRoles(f.project.id, [...f.projectRoles, ...peer.projectRoles])).statusCode, 200);
    f.store.savePersonalInstructions(f.employee.id, { text: privateOwner, autoInstructions: true, revision: 0, notes: [] });
    f.store.savePersonalInstructions(peer.user.id, { text: privatePeer, autoInstructions: false, revision: 0, notes: [] });
    const base = `/api/projects/${f.project.id}/chats`;
    const created = await f.req('POST', base, f.token, {});
    assert.equal(created.statusCode, 201, created.body);
    const url = base + '/' + created.json().id;
    assert.equal((await f.req('PATCH', url + '/visibility', f.token, { visibility: 'project' })).statusCode, 200);
    const send = async (text: string) => {
      const sent = await f.req('POST', url + '/messages', peer.cookie, { text });
      assert.equal(sent.statusCode, 202, sent.body);
      await idle(f.workspace);
      const run = f.workspace.getRun(sent.json().id);
      assert.equal(run.status, 'complete', run.error);
      return (await f.req('GET', url, peer.cookie)).json().messages.at(-1);
    };
    assert.equal((await send('Обычный вопрос')).instructionSave, undefined);
    assert.equal((await send('Удали мои инструкции.')).instructionSave, 'not-saved');
    assert.equal((await send('Сохрани инструкцию.')).instructionSave, 'not-saved');
    const ask = 'Сохрани инструкции: ну там, как обычно, перед отправкой проверь сумму, чтобы всё сошлось.';
    assert.equal((await send(ask)).instructionSave, 'saved');
    assert.equal((await send(ask)).instructionSave, 'already-saved');
    const personal = (await f.req('GET', '/api/me/instructions', peer.cookie)).json();
    assert.equal(personal.text, privatePeer);
    assert.equal(personal.autoInstructions, false);
    assert.deepEqual(personal.notes.map((note: { text: string }) => note.text), [instruction]);
    assert.equal(writes, 2);
    assert.deepEqual(f.store.personalInstructions(f.employee.id).notes, []);
  } finally { await f.app.close(); }
});

test('Fastkore v1 history follows the desktop key and keeps queued snapshots on their original question', async () => {
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const f = await fixture(async request => {
    if (request.prompt.endsWith('Вопрос из папки A')) await waiting;
    return 'OK';
  });
  try {
    const component = randomUUID(), tile = randomUUID(), entity = randomUUID(), folderA = randomUUID(), folderB = randomUUID();
    const header = { type: 'fastkore.context', version: 1 };
    const list = { ...header, view: 'list', entity_set_id: component, entity_ids: [entity], tile_id: tile, chat_key: 'tile:' + tile,
      folder_id: folderA, filter_status: 'included', filter_xml: '<Filter>XML-A</Filter>', scope_reproducible: true };
    const moved = { ...list, entity_ids: [], folder_id: folderB, filter_xml: '<Filter>XML-B</Filter>' };
    const card = { ...header, view: 'card', entity_set_id: component, entity_ids: [entity], chat_key: 'card:' + component + ':' + entity,
      filter_status: 'none', scope_reproducible: true };
    const linked = { ...card, view: 'link_list', entity_set_id: randomUUID(), entity_ids: [], owner_entity_set_id: component, owner_entity_id: entity, link_id: randomUUID() };
    const home = { ...header, view: 'none', entity_ids: [], chat_key: 'home' };
    const otherTile = randomUUID();
    const create = (context: object, token = f.token) => f.req('POST', '/api/fastkore/chats', token, { projectId: f.project.id, context, fresh: true });
    const related = (context: object, token = f.token) => f.req('POST', '/api/fastkore/chats/related', token, { context });
    const created = await create(list);
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().chat.id;
    assert.equal((await create(moved)).json().chat.id, id);
    assert.equal((await related(moved)).json()[0].id, id);
    assert.deepEqual((await related({ ...list, tile_id: otherTile, chat_key: 'tile:' + otherTile })).json(), []);
    const namedCard = await create({ ...card, entity_name: '  Заказ № 42\nДля сборки  ' });
    assert.equal(namedCard.statusCode, 201, namedCard.body);
    assert.equal(namedCard.json().chat.title, 'Заказ № 42 Для сборки');
    const cardChat = namedCard.json().chat.id;
    assert.equal((await create(linked)).json().chat.id, cardChat);
    const linkedRows = (await related(linked)).json();
    assert.deepEqual(linkedRows.map((row: { id: string; parent?: boolean }) => [row.id, row.parent]), [[cardChat, true]]);
    const cardRows = (await related({ ...card, tile_id: tile })).json();
    assert.equal(cardRows[0].id, id);
    assert.equal(cardRows[0].parent, true);
    assert.equal(cardRows[0].contextMatches, false);
    assert.notEqual((await create(home)).json().chat.id, cardChat);
    assert.equal((await create({ ...card, entity_ids: [], chat_key: null })).statusCode, 400);
    assert.equal((await create({ ...card, chat_key: 'tile:' + tile })).statusCode, 400);
    const other = await f.enter('Другой сотрудник');
    assert.deepEqual((await related(list, other.cookie)).json(), []);

    const url = `/api/projects/${f.project.id}/chats/${id}/messages`;
    const send = (text: string, context: object) => f.req('POST', url, f.token, { text, fastkoreContext: context });
    const a = await send('Вопрос из папки A', list);
    const b = await send('Вопрос из папки B', moved);
    assert.equal(a.statusCode, 202, a.body);
    assert.equal(b.statusCode, 202, b.body);
    assert.equal((await send('Ошибочная версия', { ...list, version: 9 })).statusCode, 400);
    assert.equal((await send('Другой контекст', card)).statusCode, 409);
    const snapshots = [a, b].map(response => f.store.state.jobs?.find(j => j.runId === response.json().id)?.fastkoreContext);
    assert.deepEqual(snapshots.map(s => s?.view === 'list' && [s.folder_id, s.filter_xml, s.entity_ids]), [
      [folderA, list.filter_xml, [entity]], [folderB, moved.filter_xml, []],
    ]);
    resume();
    await idle(f.workspace);
    assert.ok(f.calls[0].prompt.includes(folderA) && !f.calls[0].prompt.includes(folderB));
    assert.ok(f.calls[1].prompt.includes(folderB) && !f.calls[1].prompt.includes(folderA));
    assert.equal(f.workspace.chat(f.project.id, id).messages.length, 4);
  } finally { resume(); await f.app.close(); }
});

test('a legacy list chat keeps its current ERP scope when the selection, folder and catalog change', async () => {
  const f = await fixture();
  try {
    const entitySetId = randomUUID(), tileId = randomUUID();
    const base = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: entitySetId, scope_reproducible: true,
      filter_status: 'included', filter_xml: '<Filter/>' };
    const endpoint = '/api/fastkore/chats';
    const projectId = f.project.id;
    const oldList = await f.req('POST', endpoint, f.token, { projectId, context: base });
    assert.equal(oldList.statusCode, 201, oldList.body);
    const chatId = oldList.json().chat.id;
    f.workspace.chat(projectId, chatId).fastkoreBinding!.key = 'legacy-filter-hash';
    const chosen = { ...base, chat_key: 'tile:' + tileId, tile_id: tileId, entity_ids: [randomUUID()],
      filter_xml: '<Filter>new search</Filter>', catalog_id: randomUUID(), folder_id: randomUUID() };
    const lookup = (context: object) => f.req('POST', endpoint + '/related', f.token, { context });
    assert.equal((await lookup(chosen)).json()[0].id, chatId);
    assert.deepEqual((await lookup({ ...chosen, entity_set_id: randomUUID() })).json(), []);
    const accepted = await f.req('POST', `/api/projects/${projectId}/chats/${chatId}/messages`, f.token, { text: 'По открытому списку', fastkoreContext: chosen });
    assert.equal(accepted.statusCode, 202, accepted.body);
    await idle(f.workspace);
    assert.match(f.calls[0].prompt, new RegExp(chosen.folder_id));
    assert.match(f.calls[0].prompt, new RegExp(chosen.entity_ids[0]));
    assert.equal(f.workspace.chat(projectId, chatId).messages.length, 2);
  } finally { await f.app.close(); }
});

test('ERP role permissions require an administrator, reject stale saves and survive role renaming', async () => {
  const f = await fixture();
  try {
    const installationId = f.store.state.sso!.installations![0].id;
    f.store.state.sso!.roles = [{ id: 'leader', name: 'Руководитель', installationId, lastSeenAt: new Date().toISOString() }];
    await f.store.save();
    const route = '/api/admin/erp-roles/' + installationId + '/leader/permissions';
    const payload = { mcp: false, cli: true, revision: 0 };
    assert.equal((await f.req('PATCH', route, f.token, payload)).statusCode, 403);
    const saved = await f.req('PATCH', route, f.admin, payload);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json(), { mcp: false, cli: true, fileWrite: true, readOnly: false, createProjects: true, webSearch: false, webRead: false, webRequests: false, revision: 1 });
    assert.equal((await f.req('PATCH', route, f.admin, payload)).statusCode, 409);
    const restricted = await f.req('PATCH', route, f.admin, { ...payload, readOnly: true, revision: 1 });
    assert.equal(restricted.statusCode, 200, restricted.body);
    assert.equal(restricted.json().readOnly, true);
    f.store.state.sso!.roles[0].name = 'Новое название';
    const rows = (await f.req('GET', '/api/admin/erp-roles', f.admin)).json();
    assert.equal(rows[0].permissions.mcp, false);
    assert.equal(rows[0].permissions.readOnly, true);
    assert.equal(rows[0].name, 'Новое название');
  } finally { await f.app.close(); }
});

test('administrators archive, restore and permanently delete chats without losing token totals', async () => {
  const f = await fixture();
  try {
    const chats = `/api/projects/${f.project.id}/chats`;
    const created = (await f.req('POST', chats, f.token, { title: 'В архив' })).json();
    const url = `${chats}/${created.id}`, archive = url + '/archive';
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
    assert.equal((await f.req('DELETE', url, f.admin)).statusCode, 409);
    const generated = await f.workspace.files.upload('local', f.project, 'result.txt', Buffer.from('result'));
    const shared = await f.workspace.addAttachment(f.project.id, 'shared.txt', Buffer.from('shared'), () => f.employee.id);
    const message = storedChat.messages.at(-1)!;
    message.attachments.push(generated, shared);
    const file = `${url}/messages/${message.id}/files/${generated.id}`;
    const totals = (await f.req('GET', '/api/admin/usage', f.admin)).json().total;

    assert.equal((await f.req('PATCH', archive, f.admin, { archived: true })).statusCode, 200);
    assert.deepEqual((await f.req('GET', chats, f.admin)).json(), []);
    const projectHistory = await f.req('GET', chats + '?includeArchived=true', f.admin);
    assert.equal(projectHistory.statusCode, 200, projectHistory.body);
    assert.deepEqual(projectHistory.json().map(({ id, archivedAt }: { id: string; archivedAt?: string }) => ({ id, archivedAt })),
      [{ id: created.id, archivedAt: storedChat.archivedAt }]);
    assert.equal((await f.req('GET', chats + '?includeArchived=true', f.token)).statusCode, 403);
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
    assert.equal((await f.req('DELETE', url, f.token)).statusCode, 404);

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

test('Fastkore opens the latest personal chat for a card or tile and reuses the tile across selections', async () => {
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
    assert.equal((await f.setProjectRoles(projectId, [...f.projectRoles, ...other.projectRoles])).statusCode, 200);
    assert.deepEqual(await ids(card, other.cookie), []);
    assert.equal((await f.req('GET', `/api/projects/${projectId}/chats/${id}`, other.cookie)).statusCode, 404);
    assert.equal((await f.req('POST', messages(id), f.token, { text: 'Другой заказ', fastkoreContext: { ...card, entity_id: randomUUID() } })).statusCode, 409);

    const list = { ...base, view: 'list', tile_id: randomUUID(), catalog_id: randomUUID(), folder_id: randomUUID(), entity_id: randomUUID(), filter_status: 'included', filter_xml: '<Filter/>', deleted: false };
    const legacy = (await f.req('POST', `/api/projects/${projectId}/chats`, f.token, {})).json();
    assert.equal((await f.req('POST', messages(legacy.id), f.token, { text: 'Исторический запрос', fastkoreContext: list })).statusCode, 202);
    await idle(f.workspace);
    migrateFastkoreChatBindings(f.store.state);
    const selectedRow = { ...list, entity_id: randomUUID() };
    const changedFilter = { ...list, filter_xml: '<Filter changed="1"/>', folder_id: randomUUID(), deleted: true, control_uid: 'other-view' };
    for (const context of [selectedRow, changedFilter, { ...list, scope_reproducible: false, filter_status: 'unavailable', filter_xml: null }]) {
      assert.deepEqual(await ids(context), [legacy.id]);
    }
    assert.deepEqual(await ids({ ...list, tile_id: randomUUID() }), []);
    assert.deepEqual(await ids({ ...list, entity_set_id: randomUUID() }), []);
    assert.equal((await f.req('POST', create, f.token, { projectId, context: { ...list, entity_set_id: randomUUID(), tile_id: null } })).statusCode, 201);
    const next = await f.req('POST', create, f.token, { projectId, context: selectedRow, fresh: true });
    const nextId = next.json().chat.id;
    assert.equal(next.statusCode, 200);
    assert.equal(nextId, legacy.id);
    for (const context of [list, selectedRow]) {
      assert.equal((await f.req('POST', messages(nextId), f.token, { text: 'Открытый список', fastkoreContext: context })).statusCode, 202);
      await idle(f.workspace);
    }
    assert.ok(f.calls.at(-1)?.sessionId);
    assert.equal((await f.req('POST', messages(nextId), f.token, { text: 'Изменённая выборка', fastkoreContext: changedFilter })).statusCode, 202);
    await idle(f.workspace);
    assert.equal(f.calls.at(-1)?.sessionId, undefined);
    assert.match(f.calls.at(-1)!.prompt, new RegExp(changedFilter.folder_id));
    assert.deepEqual(await ids(list), [nextId]);

    const details = { ...list, view: 'link_list', owner_entity_set_id: randomUUID(), owner_entity_id: randomUUID(), link_id: randomUUID() };
    const detail = await f.req('POST', create, f.token, { projectId, context: details });
    assert.equal(detail.statusCode, 201);
    assert.deepEqual(await ids(details), [detail.json().chat.id]);
    assert.deepEqual(await ids({ ...details, owner_entity_id: randomUUID() }), []);
    assert.deepEqual(await ids(list), [nextId]);
  } finally { await f.app.close(); }
});

test('resetting a tile chat archives the history and opens one empty replacement for the owner', async () => {
  const f = await fixture();
  try {
    const projectId = f.project.id;
    const context = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: randomUUID(), tile_id: randomUUID(), scope_reproducible: true, filter_status: 'none' };
    const create = () => f.req('POST', '/api/fastkore/chats', f.token, { projectId, context, fresh: true });
    const initial = await Promise.all([create(), create()]);
    assert.deepEqual(initial.map(result => result.statusCode).sort(), [200, 201]);
    const { id } = initial[0].json().chat;
    assert.equal(initial[1].json().chat.id, id);
    const url = `/api/projects/${projectId}/chats/${id}`, reset = url + '/reset';
    const other = await f.enter('Другой автор');
    assert.equal((await f.setProjectRoles(projectId, [...f.projectRoles, ...other.projectRoles])).statusCode, 200);
    assert.equal((await f.req('POST', reset, f.admin, { context })).statusCode, 403);
    assert.equal((await f.req('POST', reset, other.cookie, { context })).statusCode, 404);
    assert.equal((await f.req('POST', reset, f.token, { context: { ...context, tile_id: randomUUID() } })).statusCode, 409);
    const running = await f.req('POST', url + '/messages', f.token, { text: 'BLOCK', fastkoreContext: context });
    assert.equal(running.statusCode, 202);
    assert.equal((await f.req('POST', reset, f.token, { context })).statusCode, 409);
    assert.equal((await f.req('POST', '/api/runs/' + running.json().id + '/cancel', f.token, {})).statusCode, 200);
    await idle(f.workspace);
    assert.equal((await f.req('POST', url + '/messages', f.token, { text: 'Сохранённый вопрос', fastkoreContext: context })).statusCode, 202);
    await idle(f.workspace);
    const result = await f.req('POST', reset, f.token, { context });
    assert.equal(result.statusCode, 200, result.body);
    const replacement = result.json();
    assert.notEqual(replacement.id, id);
    assert.deepEqual(replacement.messages, []);
    assert.equal(replacement.sessionId, undefined);
    assert.equal((await create()).json().chat.id, replacement.id);
    assert.equal((await f.req('PATCH', url + '/archive', f.admin, { archived: false })).statusCode, 409);
    assert.deepEqual((await f.req('GET', '/api/chats/archive', f.token)).json().map((chat: { id: string }) => chat.id), [id]);
    assert.deepEqual((await f.req('GET', '/api/chats/archive', other.cookie)).json(), []);
    const archived = (await f.req('GET', url, f.token)).json();
    assert.ok(archived.archivedAt);
    assert.ok(archived.messages.some((message: { text: string }) => message.text === 'Сохранённый вопрос'));
    assert.equal((await f.req('GET', url, other.cookie)).statusCode, 404);
    assert.equal((await f.req('POST', url + '/messages', f.token, { text: 'В архив', fastkoreContext: context })).statusCode, 409);
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

test('the retired result mode is ignored in saved profiles and legacy profile requests', async () => {
  const f = await fixture();
  try {
    const state = structuredClone(f.store.state);
    const saved = state.corporate!.profiles[0];
    Object.assign(saved, { outputMode: 'restricted' });
    assert.ok(!Object.hasOwn(initializeCorporate(state).profiles[0], 'outputMode'));
    const { id, ...profile } = f.workspace.corporate.data.profiles[0];
    const body = { ...profile, name: 'Профиль чата' };
    for (const legacyFields of [{}, { outputMode: 'restricted' }]) {
      const updated = await f.req('PUT', '/api/admin/profiles/chat-output-test', f.admin, { ...body, ...legacyFields });
      assert.equal(updated.statusCode, 200, updated.body);
      const stored = f.workspace.corporate.data.profiles.find(item => item.id === 'chat-output-test')!;
      assert.ok(!Object.hasOwn(stored, 'outputMode'));
      assert.equal(f.workspace.corporate.unavailable(stored, f.project), undefined);
      body.revision = stored.revision;
    }
  } finally { await f.app.close(); }
});

test('legacy estimate profiles become instructed chat specialists without expanding role access', async () => {
  const f = await fixture();
  try {
    const state = structuredClone(f.store.state);
    const corporate = state.corporate!;
    const estimator = corporate.profiles.find(profile => profile.id === 'estimator')!;
    estimator.operationIds = ['estimate'];
    estimator.instructions = '';
    estimator.enabled = true;
    const custom = { ...estimator, id: 'custom-estimator', instructions: 'Используй внутренний прайс.' };
    corporate.profiles.push(custom);
    const template = corporate.roles.find(role => role.id === 'employee')!;
    const estimateRole = { ...template, id: 'estimate-role', operationIds: ['estimate'], profileIds: ['universal', 'estimator', custom.id] };
    const chatRole = { ...template, id: 'chat-role', operationIds: ['chat'], profileIds: ['universal', 'estimator'] };
    corporate.roles.push(estimateRole, chatRole);
    initializeCorporate(state);
    assert.deepEqual(estimator.operationIds, ['chat']);
    assert.match(estimator.instructions, /расчёты стоимости и черновики коммерческих предложений/);
    assert.equal(custom.instructions, 'Используй внутренний прайс.');
    assert.deepEqual(estimateRole.operationIds, ['chat']);
    assert.deepEqual(estimateRole.profileIds, ['estimator', custom.id]);
    assert.deepEqual(chatRole.profileIds, ['universal']);
    const revisions = [estimator.revision, estimateRole.revision, chatRole.revision];
    initializeCorporate(state);
    assert.deepEqual([estimator.revision, estimateRole.revision, chatRole.revision], revisions);
    assert.deepEqual((await f.req('GET', '/api/admin/operations', f.admin)).json(), ['chat', 'technology', 'accounting']);
  } finally { await f.app.close(); }
});

test('project chat access follows project agents independently of the global role catalog', async () => {
  const f = await fixture(); try {
    assert.equal((await f.req('GET', '/api/admin/profiles', f.token)).statusCode, 403);
    assert.deepEqual((await f.req('GET', '/api/agents', f.token)).json().map((a: any) => a.id), ['universal']);
    const estimator = f.workspace.corporate.data.profiles.find(p => p.id === 'estimator')!;
    const { id, ...input } = estimator;
    assert.equal((await f.req('PUT', '/api/admin/profiles/estimator', f.admin, { ...input, enabled: true })).statusCode, 200);
    const { id: technologistId, ...technologist } = f.workspace.corporate.data.profiles.find(p => p.id === 'technologist')!;
    assert.equal((await f.req('PUT', '/api/admin/profiles/' + technologistId, f.admin, { ...technologist, enabled: true })).statusCode, 200);
    const role = { name: 'Менеджер', enabled: true, profileIds: ['estimator', technologistId], operationIds: ['chat', 'technology'], readDatasetIds: [], instructions: 'Только утверждённый результат' };
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.admin, role)).statusCode, 200);
    await f.req('PATCH', '/api/users/' + f.employee.id, f.admin, { roleId: 'manager' });
    const agents = (await f.req('GET', '/api/agents', f.token)).json();
    assert.deepEqual(agents.map((agent: { id: string; available: boolean }) => [agent.id, agent.available]), [['estimator', true], ['technologist', false]]);
    assert.ok(!JSON.stringify(agents).includes('instructions'));
    const route = `/api/projects/${f.project.id}/chats`;
    assert.equal((await f.req('POST', route, f.token, { agentProfileId: 'universal' })).statusCode, 201);
    const direct = await f.req('POST', route, f.token, { agentProfileId: 'estimator' });
    assert.equal(direct.statusCode, 201);
    assert.equal(direct.json().agentProfileId, 'estimator');
    assert.equal(direct.json().visibility, 'private');
    assert.equal((await f.req('POST', route, f.token, { agentProfileId: technologistId })).statusCode, 409); assert.equal(f.calls.length, 0);
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.token, role)).statusCode, 403);
    const sent = await f.req('POST', route + '/' + direct.json().id + '/messages', f.token, { text: 'Подготовь расчёт' });
    assert.equal(sent.statusCode, 202, sent.body);
    await idle(f.workspace);
    assert.equal(f.workspace.getRun(sent.json().id).status, 'complete');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].prompt, /"агент":"Оценщик"/);
    assert.ok(!f.calls[0].consultation);
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

test('editing or clearing the project brief refreshes the model session and retains chat history', async () => {
  const f = await fixture();
  try {
    const project = '/api/projects/' + f.project.id;
    const chat = (await f.req('POST', project + '/chats', f.token, {})).json();
    const send = async (text: string) => {
      const sent = await f.req('POST', project + '/chats/' + chat.id + '/messages', f.token, { text });
      assert.equal(sent.statusCode, 202, sent.body);
      await idle(f.workspace);
      return f.calls.at(-1)!;
    };
    await send('Ранее выбран заказ 17');
    const brief = 'Проверяй только сроки.';
    const update = (previous: string, instructions: string) => f.req('PUT', project + '/instructions', f.admin, { previous, instructions });
    assert.equal((await update('', brief)).statusCode, 200);
    const changed = await send('Продолжай проверку');
    assert.equal(changed.sessionId, undefined);
    assert.ok(changed.prompt.includes(brief));
    assert.match(changed.prompt, /Ранее выбран заказ 17/);
    assert.ok((await send('Уточни срок')).sessionId);
    assert.equal((await update(brief, '')).statusCode, 200);
    const cleared = await send('Подведи итог');
    assert.equal(cleared.sessionId, undefined);
    assert.doesNotMatch(cleared.prompt, /инструкция_проекта|Проверяй только сроки/);
    assert.match(cleared.prompt, /Уточни срок/);
  } finally { await f.app.close(); }
});

test('Codex can consult a different specialist from the user recommendation', async () => {
  const catalog: unknown[] = [];
  const f = await fixture(async (request, signal) => {
    if (request.consultation) {
      const tools = request.tools!;
      const result = await tools.call('knowledge', { action: 'search', section: 'fastkore', query: 'смета' }, signal);
      assert.equal(result.success, true);
      const [hit] = JSON.parse(result.text);
      const fragment = await tools.call('knowledge', { action: 'read', section: 'fastkore', id: hit.id, revision: hit.revision, part: hit.part }, signal);
      assert.equal(fragment.success, true);
      const company = await tools.call('knowledge', { action: 'index', section: 'company' }, signal);
      assert.equal(company.success, true);
      return 'Подзадача проверена';
    }
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
    const brief = 'Проверяй только условия поставки.';
    assert.equal((await f.req('PUT', project + '/instructions', f.admin, { instructions: brief, previous: '' })).statusCode, 200);
    const chat = (await f.req('POST', project + '/chats', f.token, {})).json();
    const route = project + '/chats/' + chat.id + '/messages';
    const question = { text: 'Проверь текст', recommendedSpecialistId: 'editor', clientRequestId: 'specialist-1' };
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
    assert.ok(f.calls[1].prompt.endsWith('Подзадача от основного агента\nПроверь факты'));
    assert.match(f.calls[1].prompt, /"агент":"Рецензент"/);
    for (const call of f.calls.slice(0, 2)) assert.ok(call.prompt.includes('"инструкция_проекта":"' + brief + '"'));
    assert.doesNotMatch(f.calls[1].prompt, /private attachment|draft\.txt|my_instructions|library_list/);
    assert.match(f.calls[1].prompt, /Fastkore-Business-Development-Guide\.md/);
    assert.equal(f.calls[1].allowWrite, false);
    assert.equal(f.calls[1].ephemeral, true);
    assert.equal(f.calls[1].sessionId, undefined);
    assert.deepEqual(f.calls[1].tools?.definitions.map(tool => tool.name), ['knowledge']);
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
    assert.match(f.calls[0].prompt, /"filter_status":"included"/);
    assert.doesNotMatch(f.calls[0].prompt, /EntitySetFilter/);
    assert.ok(f.calls[0].prompt.includes(folder));
    const unfiltered = { ...base, filter_status: 'none', filter_xml: null, folder_id: null };
    assert.equal((await f.req('POST', route, f.token, { text: 'Новая область', fastkoreContext: unfiltered })).statusCode, 202);
    await idle(f.workspace);
    assert.match(f.calls[1].prompt, /"filter_status":"none"/);
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
      assert.match(f.calls.at(-1)!.prompt, /Точную область окна воспроизвести нельзя/);
      assert.doesNotMatch(f.calls.at(-1)!.prompt, /context\.json/);
      assert.doesNotMatch(f.calls.at(-1)!.prompt, /scope=erp|scope=current/);
    }
  } finally { await f.app.close(); }
});

test('former project files move into the library once, keep per-file access and are read only through the library of their project', async () => {
  const f = await fixture();
  const projectPath = '/api/projects/' + f.project.id;
  try {
    const { id, ...profile } = f.workspace.corporate.data.profiles[0];
    assert.equal((await f.req('PUT', '/api/admin/profiles/' + id, f.admin, { ...profile, toolIds: ['project-files', 'chat-files'] })).statusCode, 200);
    const allowed = await f.workspace.addProjectFile(f.project.id, 'allowed.txt', Buffer.from('Allowed reference\n'), () => 'admin');
    await f.workspace.addProjectFile(f.project.id, 'denied.txt', Buffer.from('Denied reference\n'), () => 'admin');
    const other = await f.workspace.createProject('Другой проект', () => f.projectRoles);
    await f.workspace.addProjectFile(other.id, 'foreign.txt', Buffer.from('Foreign reference\n'), () => 'admin');
    const policy = { revision: 0, connections: [{ profileId: id, toolIds: ['project-files', 'chat-files'], fileIds: [allowed.id] }] };
    assert.equal((await f.req('PUT', projectPath + '/agent-settings', f.admin, policy)).statusCode, 200);
    // The former file routes are gone; the project has one entry «Библиотека».
    assert.equal((await f.req('GET', projectPath + '/files', f.admin)).statusCode, 404);
    const reports = await f.workspace.importProjectFiles();
    assert.equal(reports.length, 2);
    assert.deepEqual(await f.workspace.importProjectFiles(), [], 'the transfer runs once');
    await f.workspace.library.indexer.drain();
    const view = (await f.req('GET', projectPath + '/library', f.admin)).json();
    assert.equal(view.connections.length, 1);
    assert.match(view.connections[0].folderName, /Файлы проекта/);
    assert.equal(view.connections[0].current.files, 2);
    const cell = view.cells.find((c: { profileId: string }) => c.profileId === id);
    assert.equal(cell.granted, true);
    assert.equal(cell.files, 1, 'the per-file limit of the specialist is kept');
    assert.equal((await f.req('GET', projectPath + '/library', f.token)).statusCode, 404, 'employees do not manage the library');

    const member = await f.enter('Участник проекта без внутренней роли');
    assert.equal(member.user.roleId, 'sso_pending');
    assert.equal((await f.setProjectRoles(f.project.id, [...f.projectRoles, ...member.projectRoles])).statusCode, 200);
    const chat = (await f.req('POST', projectPath + '/chats', member.cookie, {})).json();
    assert.equal((await f.req('POST', projectPath + '/chats/' + chat.id + '/messages', member.cookie, { text: 'Прочитай материалы проекта' })).statusCode, 202);
    await idle(f.workspace);
    const tools = f.calls.at(-1)!.tools!;
    const signal = new AbortController().signal;
    assert.ok(!tools.definitions.some(d => d.name.startsWith('project_files')));
    const folders = JSON.parse((await tools.call('library_list', {}, signal)).text).folders;
    assert.equal(folders.length, 1, 'only the folder of this project');
    const folder = folders[0].folder;
    const tree = JSON.parse((await tools.call('library_tree', { folder }, signal)).text);
    assert.deepEqual(tree.entries.map((e: { name: string }) => e.name), ['allowed.txt']);
    const read = JSON.parse((await tools.call('library_read', { folder, path: 'allowed.txt' }, signal)).text);
    assert.deepEqual(read.lines, ['1: Allowed reference']);
    assert.equal(read.path, 'allowed.txt');
    assert.equal((await tools.call('library_read', { folder, path: 'denied.txt' }, signal)).success, false);
    const found = JSON.parse((await tools.call('library_search', { query: 'reference' }, signal)).text).matches;
    assert.deepEqual(found.map((m: { path: string }) => m.path), ['allowed.txt']);
    assert.match(f.calls.at(-1)!.developerInstructions!, /library_list/);
  } finally { await f.app.close(); }
});

test('project connections enforce access revocation while Fastkore follows the ERP role', async () => {
  const f = await fixture();
  const projectPath = '/api/projects/' + f.project.id;
  const settingsPath = projectPath + '/agent-settings';
  try {
    const { id, ...profile } = f.workspace.corporate.data.profiles[0];
    const updated = await f.req('PUT', '/api/admin/profiles/' + id, f.admin, {
      ...profile, instructions: 'Указывай источники.', toolIds: ['project-files'],
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const allowed = await f.workspace.addProjectFile(f.project.id, 'allowed.txt', Buffer.from('Allowed source'), () => 'admin');
    await f.workspace.addProjectFile(f.project.id, 'denied.txt', Buffer.from('Denied source'), () => 'admin');
    const attachment = await f.workspace.addAttachment(f.project.id, 'attachment.txt', Buffer.from('Attachment'), () => f.employee.id);
    const other = await f.workspace.createProject('Другой проект', () => f.projectRoles);
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
    assert.deepEqual((await f.req('GET', projectPath + '/agents', f.token)).json()[0].toolIds, ['fastkore']);
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
    assert.equal(erpPrepares, 1);
    assert.match(f.calls[0].prompt, /fastkore_context/);
    assert.match(f.calls[0].developerInstructions!, /Указывай источники/);

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
    assert.deepEqual((await f.req('GET', '/api/projects/' + other.id + '/agents', f.token)).json()[0].toolIds, ['fastkore']);
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
    const profile: Omit<AgentProfile, 'revision'> = { ...input, id: 'pricing_test', name: 'Проверка прайса', datasetIds: ['prices'], enabled: true };
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


test('owners can delete empty chats directly, but cannot delete foreign or running chats', async () => {
  const f = await fixture();
  try {
    const chats = '/api/projects/' + f.project.id + '/chats';
    const one = (await f.req('POST', chats, f.token, { title: 'Пустой чат' })).json();
    const url = chats + '/' + one.id;
    const other = await f.enter('Другой сотрудник');
    assert.equal((await f.setProjectRoles(f.project.id, [...f.projectRoles, ...other.projectRoles])).statusCode, 200);
    assert.equal((await f.req('DELETE', url, other.cookie)).statusCode, 404);
    assert.equal((await f.req('DELETE', url, f.token)).statusCode, 200);
    assert.equal((await f.req('GET', url, f.admin)).statusCode, 404);
    const two = (await f.req('POST', chats, f.token, {})).json();
    const task = await f.req('POST', chats + '/' + two.id + '/messages', f.token, { text: 'BLOCK' });
    assert.equal(task.statusCode, 202);
    assert.equal((await f.req('DELETE', chats + '/' + two.id, f.admin)).statusCode, 409);
    await f.req('POST', '/api/runs/' + task.json().id + '/cancel', f.token, {});
    await idle(f.workspace);
    const three = (await f.req('POST', chats, f.token, {})).json();
    assert.equal((await f.req('DELETE', chats + '/' + three.id, f.admin)).statusCode, 200);
  } finally { await f.app.close(); }
});
