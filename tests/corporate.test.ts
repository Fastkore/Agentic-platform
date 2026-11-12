import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import type { AgentProfile } from '../shared/types.js';
import type { CodexRequest, CodexRunner } from '../server/codex.js';
import { erpBrowser } from './erp-browser.js';
const password = 'Corporate-test-password-2026';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-corporate-')); await mkdir(path.join(root, 'project'));
  const calls: CodexRequest[] = [];
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async (r, onEvent, signal) => {
    calls.push(r); await onEvent({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
    if (r.prompt.includes('BLOCK')) await new Promise((resolve, reject) => { if (signal.aborted) reject(Error('aborted')); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    return { sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', response: 'OK' };
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
  return { root, calls, store, workspace, project, app, req, admin, employee, token };
}
async function idle(workspace: Workspace) { const deadline = Date.now() + 6000; while (workspace.busy) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } }
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

test('Fastkore requests carry the current scoped snapshot and reject an unreproducible selection', async () => {
  const f = await fixture();
  try {
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const entitySet = randomUUID(), folder = randomUUID();
    const base = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: entitySet, scope_reproducible: true };
    const filtered = { ...base, filter_status: 'included', filter_xml: '<EntitySetFilter />', folder_id: folder };
    assert.equal((await f.req('POST', route, f.admin, { text: 'Вне Fastkore', fastkoreContext: filtered })).statusCode, 403);
    for (const context of [{ ...filtered, scope_reproducible: false }, { ...base, filter_status: 'unavailable', filter_xml: null }]) {
      assert.equal((await f.req('POST', route, f.token, { text: 'Покажи выборку', fastkoreContext: context })).statusCode, 409);
    }
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
