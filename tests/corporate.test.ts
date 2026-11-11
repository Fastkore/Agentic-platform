import test from 'node:test';
import assert from 'node:assert/strict';
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
    const role = { name: 'Менеджер', enabled: true, profileIds: ['universal'], operationIds: ['chat'], readDatasetIds: [], instructions: 'Проверяй единицы измерения' };
    await f.req('PUT', '/api/admin/roles/manager', f.admin, role); await f.req('PATCH', '/api/users/' + f.employee.id, f.admin, { roleId: 'manager' });
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json(), route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    await f.req('POST', route, f.token, { text: 'Первый' }); await idle(f.workspace); assert.match(f.calls[0].prompt, /Проверяй единицы/);
    await f.req('POST', route, f.token, { text: 'Второй' }); await idle(f.workspace); assert.ok(f.calls[1].sessionId);
    await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, instructions: 'Новые правила', revision: 1 });
    await f.req('POST', route, f.token, { text: 'Третий' }); await idle(f.workspace); assert.equal(f.calls[2].sessionId, undefined); assert.match(f.calls[2].prompt, /Новые правила/);
    const running = (await f.req('POST', route, f.token, { text: 'BLOCK' })).json();
    while (f.calls.length < 4) await new Promise(r => setTimeout(r, 10));
    await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, enabled: false, revision: 2 }); await idle(f.workspace);
    assert.equal(f.workspace.getRun(running.id).status, 'cancelled'); assert.equal(f.workspace.getRun(running.id).response, undefined);
    assert.deepEqual((await f.req('GET', '/api/agents', f.token)).json(), []);
    assert.equal((await f.req('PUT', '/api/admin/roles/manager', f.admin, { ...role, revision: 1 })).statusCode, 409);
  } finally { await f.app.close(); }
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
