import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { CodexClient, type CodexRequest, type CodexRunner } from '../server/codex.js';
import { createApp } from '../server/app.js';
import { assistantName, assistantProjectId, type FastkoreRole } from '../shared/types.js';
import { fastkorePrompt } from '../server/fastkore-prompt.js';
import { parseFastkoreContext } from '../shared/fastkore-context.js';
import { erpBrowser, seedLegacyInstallation } from './erp-browser.js';

const password = 'Test-password-for-fastis-2026';

async function fixture(run?: CodexRunner['run']) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-fastis-'));
  const directory = path.join(root, 'project-a');
  await mkdir(directory);
  const dataDir = path.join(root, 'data');
  const store = new Store(dataDir);
  const cli = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))]);
  const workspace = new Workspace(store, {
    isolated: true,
    inspect: (_path, signal) => cli.inspect(process.execPath, signal),
    run: run ?? ((input, events, signal) => cli.run({ ...input, cliPath: process.execPath }, events, signal)),
  });
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(directory, 'Проект Альфа');
  const erp = erpBrowser();
  const app = await createApp(workspace, { ...erp.options });
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost:8787', 'x-bridge-local': '1' } })).json();
  const setup = await req('POST', '/api/auth/setup', boot.token, { username: 'boss', name: 'Руководитель', password });
  assert.equal(setup.statusCode, 200);
  const admin = setup.json().token as string;
  const enter = await erp.pair(app, admin);
  async function employee(username: string, roles: FastkoreRole[] = [{ id: randomUUID(), name: username }]) {
    const { user, cookie, projectRoles } = await enter(username, undefined, roles);
    assert.equal((await req('PATCH', '/api/users/' + user.id, admin, { roleId: 'employee' })).statusCode, 200);
    return { id: user.id, token: cookie, projectRoles, role: projectRoles[0] };
  }
  const setRoleAssistant = async (installationId: string, roleId: string, assistant: boolean, revision = 0) => {
    const res = await req('PATCH', `/api/admin/erp-roles/${encodeURIComponent(installationId)}/${encodeURIComponent(roleId)}/permissions`, admin, {
      mcp: true, cli: true, assistant, revision,
    });
    assert.equal(res.statusCode, 200);
    return res.json();
  };
  return { root, dataDir, store, workspace, project, erp, app, req, admin, enter, employee, setRoleAssistant };
}

async function waitIdle(workspace: Workspace) {
  const deadline = Date.now() + 10_000;
  while (workspace.busy) {
    assert.ok(Date.now() < deadline, 'Workspace remained busy');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('Fastis is opt-in per ERP role, can be completely disabled by role or globally, and never leaks into projects API', async () => {
  const f = await fixture();
  try {
    const salesRole = { id: randomUUID(), name: 'Менеджер продаж' };
    const warehouseRole = { id: randomUUID(), name: 'Кладовщик' };
    const alice = await f.employee('Алиса', [salesRole]);
    const bob = await f.employee('Боб', [warehouseRole]);

    // By default, Fastis is hidden for employee roles and visible for platform admin.
    assert.equal((await f.req('GET', '/api/status', f.admin)).json().assistantAvailable, true);
    assert.equal((await f.req('GET', '/api/status', alice.token)).json().assistantAvailable, false);
    assert.equal((await f.req('GET', '/api/assistant/chats', alice.token)).statusCode, 403);
    assert.equal((await f.req('POST', '/api/assistant/chats', alice.token, {})).statusCode, 403);

    // Enable Fastis ONLY for Менеджер продаж.
    const enabled = await f.setRoleAssistant(alice.role.installationId, salesRole.id, true, 0);
    assert.equal(enabled.assistant, true);
    assert.equal((await f.req('GET', '/api/status', alice.token)).json().assistantAvailable, true);
    assert.equal((await f.req('GET', '/api/status', bob.token)).json().assistantAvailable, false);
    assert.equal((await f.req('GET', '/api/assistant/chats', bob.token)).statusCode, 403);

    // Alice creates a Fastis chat; it must NOT appear in /api/projects or /api/projects/__fastis__/*.
    const created = await f.req('POST', '/api/assistant/chats', alice.token, { title: 'Сводка по заказам' });
    assert.equal(created.statusCode, 201);
    const chatId = created.json().id as string;
    assert.equal((await f.req('GET', `/api/projects/${assistantProjectId}/chats`, alice.token)).statusCode, 404);
    assert.equal((await f.req('GET', `/api/projects/${assistantProjectId}/chats`, f.admin)).statusCode, 404);
    const adminProjects = (await f.req('GET', '/api/projects', f.admin)).json() as { id: string }[];
    assert.ok(!adminProjects.some(p => p.id === assistantProjectId));
    assert.equal((await f.req('GET', '/api/chats/without-project', alice.token)).json().length, 0);

    // Enable Fastis for Bob too — Bob still must NOT see or access Alice's personal Fastis chat.
    await f.setRoleAssistant(bob.role.installationId, warehouseRole.id, true, 0);
    assert.equal((await f.req('GET', '/api/assistant/chats', bob.token)).json().length, 0);
    assert.equal((await f.req('GET', `/api/assistant/chats/${chatId}`, bob.token)).statusCode, 404);
    assert.equal((await f.req('PATCH', `/api/assistant/chats/${chatId}/title`, bob.token, { title: 'Чужой' })).statusCode, 404);

    // Disabling Fastis for Alice's role immediately hides and blocks her access.
    await f.setRoleAssistant(alice.role.installationId, salesRole.id, false, enabled.revision);
    assert.equal((await f.req('GET', '/api/status', alice.token)).json().assistantAvailable, false);
    assert.equal((await f.req('GET', '/api/assistant/chats', alice.token)).statusCode, 403);
    assert.equal((await f.req('GET', `/api/assistant/chats/${chatId}`, alice.token)).statusCode, 403);

    // Global disable and avatar selection persist and propagate through /api/status.
    const settingsBefore = (await f.req('GET', '/api/admin/assistant/settings', f.admin)).json();
    assert.equal(settingsBefore.enabled, true);
    assert.equal(settingsBefore.avatar, 'falcon-helmet');
    const disabled = await f.req('PUT', '/api/admin/assistant/settings', f.admin, {
      enabled: false, avatar: 'bird-hat', instructions: 'Проверяй критерии просрочки.', revision: settingsBefore.revision,
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().avatar, 'bird-hat');
    const adminStatusAfter = (await f.req('GET', '/api/status', f.admin)).json();
    assert.equal(adminStatusAfter.assistantAvailable, false);
    assert.equal(adminStatusAfter.assistantAvatar, 'bird-hat');
    assert.equal((await f.req('GET', '/api/status', bob.token)).json().assistantAvailable, false);
    assert.equal((await f.req('GET', '/api/assistant/chats', f.admin)).statusCode, 403);
    assert.equal((await f.req('GET', '/api/assistant/chats', bob.token)).statusCode, 403);
  } finally { await f.app.close(); }
});

test('Fastis inherits employee ERP role permissions, uses reference screen context, zero project libraries, and survives restart + move', async () => {
  const captured: CodexRequest[] = [];
  const forceReadOnlyCalls: boolean[] = [];
  const f = await fixture(async (input, events) => {
    captured.push(input);
    await events({ kind: 'session', text: randomUUID() });
    await events({ kind: 'message', text: 'Сводка готова.' });
    return { sessionId: randomUUID(), response: 'Сводка готова.' };
  });
  const originalPrepare = f.workspace.prepareFastkoreTools;
  f.workspace.prepareFastkoreTools = async (credentialId, context, authorize, signal, run, options) => {
    forceReadOnlyCalls.push(options?.forceReadOnly === true);
    return originalPrepare ? originalPrepare(credentialId, context, authorize, signal, run, options) : {};
  };
  try {
    const role = { id: randomUUID(), name: 'Финансист' };
    const alice = await f.employee('Алиса', [role]);
    await f.setRoleAssistant(alice.role.installationId, role.id, true, 0);
    const settingsBefore = (await f.req('GET', '/api/admin/assistant/settings', f.admin)).json();
    assert.equal((await f.req('PUT', '/api/admin/assistant/settings', f.admin, {
      enabled: true, instructions: 'Исключай отменённые заказы.', revision: settingsBefore.revision,
    })).statusCode, 200);

    const chat = (await f.req('POST', '/api/assistant/chats', alice.token, {})).json();
    // 1) System-wide question WITHOUT screen context.
    const r1 = await f.req('POST', `/api/assistant/chats/${chat.id}/messages`, alice.token, {
      text: 'Какие заказы просрочены на этой неделе?',
    });
    assert.equal(r1.statusCode, 202);
    await waitIdle(f.workspace);
    assert.equal(forceReadOnlyCalls[0], false, 'Fastis inherits employee ERP role CLI/MCP permissions');
    assert.match(captured[0].prompt, /общесистемный помощник Финист/);
    assert.match(captured[0].prompt, /Исключай отменённые заказы/);
    assert.doesNotMatch(captured[0].prompt, /library_list|Контекст открытой папки пока недоступен/);

    // 2) Question WITH optional attached screen context in reference mode.
    const setId = randomUUID(), entityId = randomUUID();
    const r2 = await f.req('POST', `/api/assistant/chats/${chat.id}/messages`, alice.token, {
      text: 'Почему этот заказ задерживается?',
      fastkoreContext: {
        type: 'fastkore.context', version: 1, view: 'card',
        entity_set_id: setId, entity_set_name: 'Заказы', entity_ids: [entityId],
        entity_name: 'Заказ #142', scope_reproducible: true, filter_status: 'none',
      },
    });
    assert.equal(r2.statusCode, 202);
    await waitIdle(f.workspace);
    assert.equal(forceReadOnlyCalls[1], false);
    assert.match(captured[1].prompt, /приложил открытое окно Fastkore как справочный контекст/);
    assert.match(captured[1].prompt, /Заказ #142/);

    // 3) Isolation across ERP installations: another installation must not see chats from installation 1.
    const secondInst = (await seedLegacyInstallation(f.store, f.erp.options, 'ERP-2')).installationId;
    const enter2 = await f.erp.pair(f.app, f.admin, secondInst);
    const secondRole = { id: randomUUID(), name: 'Финансист 2' };
    const alice2 = await enter2('Алиса-2', undefined, [secondRole]);
    await f.setRoleAssistant(secondInst, secondRole.id, true, 0);
    assert.equal((await f.req('GET', '/api/assistant/chats', alice2.cookie)).json().length, 0);
    assert.equal((await f.req('GET', `/api/assistant/chats/${chat.id}`, alice2.cookie)).statusCode, 404);

    // 4) Archive shows Fastis chat under Fastis name, and restore brings it back.
    assert.equal((await f.req('PATCH', `/api/assistant/chats/${chat.id}/archive`, alice.token, { archived: true })).statusCode, 200);
    const archiveList = (await f.req('GET', '/api/admin/chats/archive', f.admin)).json() as { id: string; projectId: string; projectName: string }[];
    assert.ok(archiveList.some(item => item.id === chat.id && item.projectId === assistantProjectId && item.projectName === assistantName));
    assert.equal((await f.req('PATCH', `/api/assistant/chats/${chat.id}/archive`, f.admin, { archived: false })).statusCode, 200);

    // 5) Move Fastis chat into an accessible project cleanly.
    await f.erp.setProjectRoles(f.app, f.admin, f.project.id, alice.projectRoles);
    const moved = await f.req('PATCH', `/api/assistant/chats/${chat.id}/move`, alice.token, {
      projectId: f.project.id, title: 'Разбор заказа #142',
    });
    assert.equal(moved.statusCode, 200);
    assert.equal((await f.req('GET', '/api/assistant/chats', alice.token)).json().length, 0);
    const projectChats = (await f.req('GET', `/api/projects/${f.project.id}/chats`, alice.token)).json() as { id: string; title: string }[];
    assert.ok(projectChats.some(item => item.id === chat.id && item.title === 'Разбор заказа #142'));

    // 6) Persistence across SQLite Store reload.
    const persistent = (await f.req('POST', '/api/assistant/chats', f.admin, { title: 'Переживёт рестарт' })).json();
    await f.app.close();
    const reopened = new Store(f.dataDir);
    try {
      assert.equal(reopened.state.assistant?.settings?.instructions, 'Исключай отменённые заказы.');
      assert.ok(reopened.state.assistant?.chats.some(item => item.id === persistent.id && item.title === 'Переживёт рестарт'));
    } finally { await reopened.close(); }
    return;
  } catch (err) {
    await f.app.close();
    throw err;
  }
});

test('fastkorePrompt reference mode frames attached screen as optional and keeps system-wide prompt clean', () => {
  const withoutScreen = fastkorePrompt(undefined, undefined, true, 'reference');
  assert.match(withoutScreen, /Общесистемный запрос в Fastkore/);
  assert.doesNotMatch(withoutScreen, /Контекст открытой папки пока недоступен/);

  const ctx = parseFastkoreContext({
    type: 'fastkore.context', version: 1, view: 'card',
    entity_set_id: randomUUID(), entity_set_name: 'Заказы',
    entity_ids: [randomUUID()], entity_name: 'Заказ #77',
    scope_reproducible: true, filter_status: 'none',
  });
  const withScreen = fastkorePrompt(ctx ?? undefined, undefined, true, 'reference');
  assert.match(withScreen, /приложил открытое окно Fastkore как справочный контекст/);
  assert.match(withScreen, /Заказ #77/);
});
