import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { CodexClient, type CodexRunner } from '../server/codex.js';
import { createApp } from '../server/app.js';
import { Access } from '../server/access.js';
import { csrfFor } from '../server/fastkore.js';
import type { TranscribeDictation } from '../server/dictation.js';
import type { FastkoreRole, TeamUser } from '../shared/types.js';
import { erpBrowser } from './erp-browser.js';

const password = 'Test-password-for-office-2026';
async function fixture(transcribeDictation?: TranscribeDictation, run?: CodexRunner['run']) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-access-')), directory = path.join(root, 'library'); await mkdir(directory);
  const store = new Store(path.join(root, 'data'));
  const cli = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))]);
  const workspace = new Workspace(store, {
    isolated: true,
    inspect: (_path, signal) => cli.inspect(process.execPath, signal),
    run: run ?? ((input, events, signal) => cli.run({ ...input, cliPath: process.execPath }, events, signal)),
  });
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(directory), legacy = await workspace.addChat(project.id, 'Старая история'); legacy.sessionId = '87db344a-98f3-42c8-bba8-c7d9f3dcff11';
  const erp = erpBrowser();
  const app = await createApp(workspace, { ...erp.options, transcribeDictation });
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost:8787', 'x-bridge-local': '1' } })).json();
  const setup = await req('POST', '/api/auth/setup', boot.token, { username: 'boss', name: 'Руководитель', password }); assert.equal(setup.statusCode, 200);
  const admin = setup.json().token as string, adminId = setup.json().user.id;
  const enter = await erp.pair(app, admin);
  async function employee(username: string, roles: FastkoreRole[] = [{ id: randomUUID(), name: username }]) {
    const { user, cookie, projectRoles } = await enter(username, undefined, roles);
    assert.equal((await req('PATCH', '/api/users/' + user.id, admin, { roleId: 'employee' })).statusCode, 200);
    return { id: user.id, token: cookie, projectRoles };
  }
  const setProjectRoles = (roles: Awaited<ReturnType<typeof employee>>['projectRoles']) => erp.setProjectRoles(app, admin, project.id, roles);
  return { root, store, workspace, project, legacy, app, req, admin, adminId, enter, employee, setProjectRoles, pair: () => erp.pair(app, admin) };
}
async function done(workspace: Workspace) { const end = Date.now() + 10_000; while (workspace.activeRun) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 20)); } }

test('losing ERP delegation records the first cause atomically without logging the grant', async () => {
  const f = await fixture();
  try {
    const employee = await f.employee('Проверка журнала');
    const access = new Access(f.workspace);
    const session = access.data.credentials.find(c => c.userId === employee.id && c.source === 'fastkore')!;
    session.erpDelegation = { sealedGrant: 'test-secret-never-in-audit', revision: '1', expiresAt: Date.now() + 60_000 };
    await Promise.all([access.forgetErpDelegation(session.id, 'cli_ticket_denied'), access.forgetErpDelegation(session.id, 'expired')]);
    const events = f.store.auditEvents().filter(e => e.action === 'erp.delegation.invalidated' && e.targetId === session.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].details, { sessionId: session.id, installationId: session.installationId, delegationReason: 'cli_ticket_denied', status: 403 });
    assert.ok(!JSON.stringify(events).includes('test-secret'));
    assert.equal(access.data.credentials.find(c => c.id === session.id)?.erpDelegationRevoked, true);
  } finally { await f.app.close(); }
});

test('migration keeps session IDs, assigns private legacy chats to boss and retires shared key/local bypass', async () => {
  const f = await fixture(); try {
    assert.equal(f.legacy.visibility, 'private'); assert.equal(f.legacy.ownerId, f.adminId); assert.equal(f.legacy.sessionId, '87db344a-98f3-42c8-bba8-c7d9f3dcff11');
    assert.equal((await f.req('GET', '/api/projects', '1'.repeat(64))).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/local-login', headers: { host: '127.0.0.1', 'x-bridge-local': '1' } })).statusCode, 403);
    assert.equal((await f.req('POST', '/api/auth/setup', f.admin, { username: 'evil', name: 'evil', password })).statusCode, 403);
    const me = (await f.req('GET', '/api/auth/me', f.admin)).json(); assert.equal(me.user.role, 'admin'); assert.ok(!JSON.stringify(me).includes('passwordHash'));
    const stored = await readFile(f.store.file, 'utf8'); assert.ok(!stored.includes(password)); assert.ok(!stored.includes(f.admin));
  } finally { await f.app.close(); }
});

test('the first Fastkore system administrator takes the existing local setup account once', async () => {
  const f = await fixture();
  try {
    const impostor = await f.enter('Руководитель', undefined, [{ id: randomUUID(), name: 'Системный администратор' }]);
    assert.equal(impostor.user.role, 'employee');
    assert.equal(impostor.user.roleId, 'sso_pending');

    const role = { id: '1c3262c9-1105-4340-a9b5-1e0fbeaefe2d', name: 'ERP administrator' };
    const ids = [randomUUID(), randomUUID()];
    const sessions = await Promise.all(ids.map(id => f.enter('Администратор ERP', id, [role])));
    const adminIndex = sessions.findIndex(s => s.user.id === f.adminId);
    assert.notEqual(adminIndex, -1);
    assert.equal(sessions[adminIndex].user.role, 'admin');
    assert.equal(sessions[1 - adminIndex].user.role, 'employee');
    assert.equal((await f.enter('Администратор ERP', ids[adminIndex], [role])).user.id, f.adminId);
    assert.equal(f.store.state.security!.users.length, 3);
    assert.equal(f.store.state.externalIdentities!.filter(link => link.userId === f.adminId).length, 1);
    assert.equal((await f.req('GET', '/api/auth/me', sessions[adminIndex].cookie)).json().authentication.canOpenBrowserSettings, true);
    const local = await f.req('POST', '/api/auth/login', '', { username: 'boss', password });
    assert.equal(local.statusCode, 200);
    assert.equal(local.json().user.id, f.adminId);
  } finally { await f.app.close(); }
});

test('a linked Fastkore administrator can open browser settings with a one-time code', async () => {
  const f = await fixture();
  try {
    const enter = await f.pair(), externalUserId = randomUUID();
    const external = await enter('Администратор ERP', externalUserId, [{ id: randomUUID(), name: 'Системный администратор' }]);
    const issuePath = '/api/auth/fastkore/browser-code', exchangePath = '/auth/fastkore/browser/exchange';
    assert.equal((await f.req('POST', issuePath, external.cookie, {})).statusCode, 403);
    assert.equal((await f.req('POST', issuePath, f.admin, {})).statusCode, 403);
    const { installationId } = (await f.req('GET', '/api/auth/me', external.cookie)).json().authentication;
    assert.equal((await f.req('PUT', '/api/admin/fastkore/identities', f.admin, { installationId, externalUserId, userId: f.adminId })).statusCode, 200);
    const parent = await enter('Администратор ERP', externalUserId);
    const auth = (await f.req('GET', '/api/auth/me', parent.cookie)).json().authentication;
    assert.equal(auth.canOpenBrowserSettings, true);
    assert.equal((await f.req('GET', '/api/admin/instructions', parent.cookie)).statusCode, 403);
    const projectRoles = `/api/projects/${f.project.id}/roles`;
    assert.equal((await f.req('GET', projectRoles, parent.cookie)).statusCode, 403);

    const issue = async () => {
      const response = await f.req('POST', issuePath, parent.cookie, {});
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const { url, expiresAt } = response.json();
      const link = new URL(url);
      assert.equal(link.pathname, '/auth/fastkore/browser');
      assert.equal(link.search, '');
      assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 60_000);
      const code = new URLSearchParams(link.hash.slice(1)).get('code');
      assert.match(code ?? '', /^[A-Za-z0-9_-]{43}$/);
      return code!;
    };
    const exchange = (code: string) => f.req('POST', exchangePath, '', { code });
    const superseded = await issue(), code = await issue();
    assert.equal((await exchange(superseded)).statusCode, 401);
    const crossSite = await f.app.inject({ method: 'POST', url: exchangePath,
      headers: { host: 'agents.example.test', origin: 'https://example.test', 'x-forwarded-proto': 'https' }, payload: { code } });
    assert.equal(crossSite.statusCode, 403);
    const responses = await Promise.all([exchange(code), exchange(code)]);
    assert.deepEqual(responses.map(response => response.statusCode).sort((a, b) => a - b), [200, 401]);
    const signedIn = responses.find(response => response.statusCode === 200)!;
    assert.deepEqual(signedIn.json(), { redirect: '/?settings=team' });
    assert.match(String(signedIn.headers['set-cookie']), /; Secure; HttpOnly; SameSite=Lax/);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    const browser = (await f.req('GET', '/api/auth/browser-session', cookie)).json();
    assert.equal(browser.user.id, parent.user.id);
    assert.equal(browser.authentication.browserSettings, true);
    assert.equal(browser.authentication.canOpenBrowserSettings, false);
    assert.ok(Date.parse(browser.authentication.expiresAt) <= Date.parse(auth.expiresAt));
    assert.equal((await f.req('POST', issuePath, cookie, {})).statusCode, 403);
    assert.equal((await f.req('GET', projectRoles, cookie)).statusCode, 200);
    assert.equal((await f.req('GET', '/api/admin/instructions', cookie)).statusCode, 200);
    assert.equal((await f.req('GET', '/api/admin/fastkore/installations', cookie)).statusCode, 403);
    assert.equal((await f.req('POST', '/api/auth/logout', parent.cookie, {})).statusCode, 200);
    assert.equal((await f.req('GET', projectRoles, cookie)).statusCode, 401);
  } finally { await f.app.close(); }
});

test('ERP role grants control creating an isolated project and can be changed by the administrator', async () => {
  const f = await fixture();
  try {
    const leader = { id: randomUUID(), name: 'Руководитель' };
    const systemAdmin = { id: randomUUID(), name: 'Системный администратор' };
    const teamRole = { id: randomUUID(), name: 'Отдел внедрения' };
    const creator = await f.employee('creator', [leader]), colleague = await f.employee('colleague', [teamRole]);
    const it = await f.employee('it', [systemAdmin]);
    for (const token of [f.admin, creator.token, it.token]) {
      assert.equal((await f.req('GET', '/api/status', token)).json().canCreateProject, true);
    }
    assert.equal((await f.req('GET', '/api/status', colleague.token)).json().canCreateProject, false);
    assert.equal((await f.req('POST', '/api/projects', colleague.token, { name: 'Запрещено' })).statusCode, 403);
    const response = await f.req('POST', '/api/projects', creator.token, { name: 'Новый проект' });
    assert.equal(response.statusCode, 201);
    const project = response.json();
    assert.equal(project.directory, path.join(f.store.root, 'projects', project.id));
    assert.deepEqual(f.workspace.project(project.id).rolePolicy?.roles, creator.projectRoles);
    assert.deepEqual((await f.req('GET', '/api/projects', creator.token)).json().map((item: { id: string }) => item.id), [project.id]);
    assert.equal((await f.req('POST', '/api/projects/' + project.id + '/chats', creator.token, {})).statusCode, 201);
    assert.equal((await f.req('GET', '/api/projects/' + project.id + '/chats', colleague.token)).statusCode, 404);
    assert.equal((await f.req('POST', '/api/projects', creator.token, { name: 'Существующая папка', directory: f.root })).statusCode, 403);
    const installation = f.store.state.sso!.installations![0].id;
    const setGrant = (role: FastkoreRole, createProjects: boolean) => f.req('PATCH',
      `/api/admin/erp-roles/${installation}/${role.id}/permissions`, f.admin, { mcp: true, cli: true, createProjects, revision: 0 });
    assert.equal((await setGrant(leader, false)).statusCode, 200);
    assert.equal((await f.req('POST', '/api/projects', creator.token, { name: 'Запрещено после отзыва' })).statusCode, 403);
    assert.equal((await setGrant(teamRole, true)).statusCode, 200);
    assert.equal((await f.req('GET', '/api/status', colleague.token)).json().canCreateProject, true);
    assert.equal((await f.req('POST', '/api/projects', colleague.token, { name: 'После выдачи' })).statusCode, 201);
  } finally { await f.app.close(); }
});

test('renaming a project from Fastkore requires a permitted role assigned to that project', async () => {
  const f = await fixture();
  try {
    const assigned = { id: randomUUID(), name: 'Участник' };
    const unrelated = { id: randomUUID(), name: 'Другая роль' };
    const employee = await f.employee('colleague', [assigned, unrelated]);
    const route = '/api/projects/' + f.project.id;
    const { directory } = f.project;
    const rename = (token: string, name: string) => f.req('PATCH', route, token, { name });
    const canRename = async () => (await f.req('GET', '/api/projects', employee.token)).json()[0]?.canRename;
    const grant = (roleId: string, renameProjects: boolean, revision = 0) => f.req('PATCH',
      `/api/admin/erp-roles/${employee.projectRoles[0].installationId}/${roleId}/permissions`, f.admin,
      { mcp: true, cli: true, renameProjects, revision });
    assert.equal((await rename(employee.token, 'Другое имя')).statusCode, 404);
    assert.equal((await f.setProjectRoles(employee.projectRoles.filter(role => role.roleId === assigned.id))).statusCode, 200);
    assert.equal(await canRename(), false);
    assert.equal((await grant(unrelated.id, true)).statusCode, 200);
    assert.equal(await canRename(), false);
    assert.equal((await rename(employee.token, 'Другое имя')).statusCode, 403);
    assert.equal((await f.req('PATCH', route, f.admin, { name: '   ' })).statusCode, 400);
    assert.equal((await rename(f.admin, 'Имя от администратора')).statusCode, 200);
    assert.equal((await grant(assigned.id, true)).statusCode, 200);
    assert.equal(await canRename(), true);
    const updated = await rename(employee.token, ' Новое имя ');
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json(), { name: 'Новое имя' });
    assert.equal(f.workspace.project(f.project.id).directory, directory);
    assert.equal((await f.req('GET', route + '/chats/' + f.legacy.id, f.admin)).statusCode, 200);
    assert.equal((await f.req('GET', '/api/projects', f.admin)).json()[0].name, 'Новое имя');
    assert.equal((await grant(assigned.id, false, 1)).statusCode, 200);
    assert.equal(await canRename(), false);
    assert.equal((await rename(employee.token, 'Имя после отзыва')).statusCode, 403);
  } finally { await f.app.close(); }
});

test('project visibility combines roles within the current Fastkore installation and revokes direct access', async () => {
  const f = await fixture();
  try {
    const shared = { id: randomUUID(), name: 'Общая роль' };
    const employee = await f.employee('With roles', [{ id: randomUUID(), name: 'Другая роль' }, shared]);
    const otherInstallation = await f.pair();
    const foreign = await otherInstallation('Other installation', undefined, [shared]);
    const base = '/api/projects/' + f.project.id;
    Object.assign(f.project, { memberIds: [employee.id, foreign.user.id] });
    assert.deepEqual((await f.req('GET', '/api/projects', employee.token)).json(), []);
    assert.equal((await f.req('GET', base + '/chats', employee.token)).statusCode, 404);
    const grant = await f.setProjectRoles([employee.projectRoles[1]]);
    assert.equal(grant.statusCode, 200, grant.body);
    assert.equal((await f.req('PUT', base + '/roles', f.admin, { roles: [], revision: 0 })).statusCode, 409);
    assert.deepEqual((await f.req('GET', '/api/projects', foreign.cookie)).json(), []);
    assert.equal((await f.req('GET', base + '/agents', foreign.cookie)).statusCode, 404);
    assert.equal((await f.req('GET', base + '/library', foreign.cookie)).statusCode, 404);
    assert.equal((await f.req('GET', '/api/projects', f.admin)).json()[0].roles[0].name, shared.name);
    const projectsFor = async (userId: string) => {
      const users = (await f.req('GET', '/api/users', f.admin)).json<TeamUser[]>();
      return users.find(user => user.id === userId)!.projects;
    };
    const projectLabel = { id: f.project.id, name: f.project.name };
    assert.deepEqual(await projectsFor(employee.id), [projectLabel]);
    assert.deepEqual(await projectsFor(foreign.user.id), []);
    assert.deepEqual(await projectsFor(f.adminId), [projectLabel]);
    assert.equal((await f.req('GET', base + '/chats', employee.token)).statusCode, 200);
    const created = await f.req('POST', base + '/chats', employee.token, {});
    assert.equal(created.statusCode, 201, created.body);
    const chatUrl = base + '/chats/' + created.json().id;
    assert.equal((await f.req('GET', chatUrl, employee.token)).statusCode, 200);
    assert.equal((await f.setProjectRoles([])).statusCode, 200);
    assert.deepEqual(await projectsFor(employee.id), []);
    assert.equal((await f.req('GET', chatUrl, employee.token)).statusCode, 404);
    assert.equal((await f.req('GET', chatUrl, f.admin)).statusCode, 200);
  } finally { await f.app.close(); }
});

test('project roles control dictation and leave other role grants intact', async () => {
  let transcriptions = 0;
  const f = await fixture(async () => { transcriptions++; return 'Текст черновика'; });
  try {
    const a = await f.employee('alice'), b = await f.employee('boris');
    const accessRoute = `/api/projects/${f.project.id}/roles`;
    assert.equal((await f.req('GET', accessRoute, a.token)).statusCode, 403);
    assert.deepEqual((await f.req('GET', accessRoute, f.admin)).json().roles, []);
    assert.equal((await f.setProjectRoles(b.projectRoles)).statusCode, 200);

    const wav = Buffer.alloc(46);
    wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(2, 40);
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav');
    const request = new Request('http://localhost/', { method: 'POST', body: data });
    const payload = Buffer.from(await request.arrayBuffer());
    const publicOrigin = 'https://agents.example.test';
    const dictate = (chatId?: string) => f.app.inject({ method: 'POST', url: `/api/dictation?projectId=${f.project.id}${chatId ? '&chatId=' + chatId : ''}`,
      headers: { host: 'agents.example.test', 'x-forwarded-proto': 'https', origin: publicOrigin,
        cookie: a.token, 'x-csrf-token': csrfFor(a.token.split('=')[1]), 'content-type': request.headers.get('content-type')! }, payload });

    assert.equal((await dictate()).statusCode, 404);
    assert.equal((await f.req('PUT', accessRoute, a.token, { revision: 1, roles: a.projectRoles })).statusCode, 403);
    assert.equal((await f.setProjectRoles([...a.projectRoles, ...b.projectRoles])).statusCode, 200);
    assert.equal((await dictate(f.legacy.id)).statusCode, 404);
    assert.equal((await f.req('PATCH', '/api/settings', a.token, { dictationEnabled: false })).statusCode, 403);
    assert.equal((await f.req('GET', '/api/dictation/models', a.token)).statusCode, 403);
    assert.equal((await f.req('PATCH', '/api/settings', f.admin, { dictationEnabled: false })).statusCode, 200);
    assert.equal((await dictate()).statusCode, 503);
    assert.equal((await f.req('PATCH', '/api/settings', f.admin, { dictationEnabled: true })).statusCode, 200);
    const transcription = await dictate();
    assert.equal(transcription.statusCode, 200, transcription.body);
    assert.deepEqual(transcription.json(), { text: 'Текст черновика' });
    assert.equal(f.legacy.messages.length, 0);
    assert.equal((await f.setProjectRoles(b.projectRoles)).statusCode, 200);
    assert.equal((await dictate()).statusCode, 404);
    assert.deepEqual(f.workspace.project(f.project.id).rolePolicy?.roles, b.projectRoles);
    assert.equal(transcriptions, 1);
  } finally { await f.app.close(); }
});
test('uploaded 3D models can be opened by their owner and an administrator within the chat', async () => {
  const f = await fixture();
  try {
    const owner = await f.employee('model-owner'), reader = await f.employee('model-reader');
    assert.equal((await f.setProjectRoles([...owner.projectRoles, ...reader.projectRoles])).statusCode, 200);
    const chat = await f.workspace.addChat(f.project.id, '3D', undefined, owner.id);
    chat.visibility = 'project';
    const data = Buffer.from('solid sample\nendsolid sample\n');
    const model = await f.workspace.addAttachment(f.project.id, 'sample.STL', data, () => owner.id);
    const document = await f.workspace.addAttachment(f.project.id, 'note.txt', Buffer.from('Example'), () => owner.id);
    const messageId = randomUUID();
    chat.messages.push({ id: messageId, role: 'user', status: 'complete', text: '3D', authorId: owner.id,
      createdAt: new Date().toISOString(), attachments: [model, document] });
    await f.store.save();
    const chatUrl = `/api/projects/${f.project.id}/chats/${chat.id}`;
    const fileUrl = `${chatUrl}/messages/${messageId}/files/`;
    for (const token of [owner.token, f.admin]) {
      const opened = await f.req('GET', fileUrl + model.id, token);
      assert.equal(opened.statusCode, 200, opened.body);
      assert.deepEqual(opened.rawPayload, data);
    }
    assert.equal((await f.req('GET', chatUrl, reader.token)).statusCode, 200);
    assert.equal((await f.req('GET', fileUrl + model.id, reader.token)).statusCode, 404);
    assert.equal((await f.req('GET', fileUrl + document.id, owner.token)).statusCode, 404);
  } finally { await f.app.close(); }
});

test('chat pins persist independently for readers and require access to the chat', async () => {
  const f = await fixture();
  const owner = await f.employee('pin-owner'), reader = await f.employee('pin-reader');
  let sharedId: string;
  try {
    const chats = `/api/projects/${f.project.id}/chats`;
    assert.equal((await f.setProjectRoles([...owner.projectRoles, ...reader.projectRoles])).statusCode, 200);
    const shared = await f.workspace.addChat(f.project.id, 'Общий чат', undefined, owner.id);
    const privateChat = await f.workspace.addChat(f.project.id, 'Личный чат', undefined, owner.id);
    shared.visibility = 'project';
    sharedId = shared.id;
    await f.store.save();
    const pin = (chatId: string, token: string, pinned: boolean) => f.req('PATCH', `${chats}/${chatId}/pin`, token, { pinned });
    const summary = async (token: string) => (await f.req('GET', chats, token)).json().find((chat: { id: string }) => chat.id === sharedId);
    assert.equal((await pin(privateChat.id, reader.token, true)).statusCode, 404);
    assert.deepEqual((await pin(sharedId, reader.token, true)).json(), { pinned: true });
    assert.equal((await summary(reader.token)).pinned, true);
    assert.equal((await summary(owner.token)).pinned, undefined);
    assert.deepEqual((await pin(sharedId, reader.token, false)).json(), { pinned: false });
    assert.equal((await summary(reader.token)).pinned, undefined);
    assert.equal((await pin(sharedId, reader.token, true)).statusCode, 200);
    assert.equal((await pin(sharedId, reader.token, true)).statusCode, 200);
  } finally { await f.app.close(); }
  const reopened = new Store(f.store.root);
  try {
    assert.deepEqual(reopened.state.security?.users.find(user => user.id === reader.id)?.pinnedChatIds, [sharedId!]);
    assert.equal(reopened.state.security?.users.find(user => user.id === owner.id)?.pinnedChatIds, undefined);
  } finally { await reopened.close(); }
});

test('completed chat replies stay unread for each reader until the latest reply is acknowledged', async () => {
  const f = await fixture(undefined, async () => ({ response: 'Готово' }));
  let sharedId!: string, latestReply!: string, readerId!: string;
  try {
    const owner = await f.employee('reply-owner'), reader = await f.employee('reply-reader');
    readerId = reader.id;
    await f.setProjectRoles([...owner.projectRoles, ...reader.projectRoles]);
    const shared = await f.workspace.addChat(f.project.id, 'Общий чат', undefined, owner.id);
    const personal = await f.workspace.addChat(f.project.id, 'Личный чат', undefined, owner.id);
    shared.visibility = 'project';
    sharedId = shared.id;
    await f.store.save();
    const route = (id: string) => `/api/projects/${f.project.id}/chats/${id}`;
    const unread = async (token: string) => (await f.req('GET', '/api/status', token)).json().unreadChatReplies;
    const read = (id: string, token: string, replyId: string) => f.req('PATCH', route(id) + '/read', token, { replyId });
    async function respond(id: string, text: string) {
      const submitted = await f.req('POST', route(id) + '/messages', owner.token, { text });
      assert.equal(submitted.statusCode, 202, submitted.body);
      await done(f.workspace);
      const run = (await f.req('GET', '/api/runs/' + submitted.json().id, owner.token)).json();
      assert.equal(run.status, 'complete', run.error);
      const result = await f.req('GET', route(id), owner.token);
      const replyId = result.json().lastCompletedReplyId;
      assert.ok(replyId);
      return replyId;
    }
    assert.deepEqual(await unread(reader.token), {});
    const first = await respond(sharedId, 'Первый вопрос');
    const other = await respond(personal.id, 'Личный вопрос');
    assert.equal((await read(personal.id, reader.token, other)).statusCode, 404);
    assert.deepEqual(await unread(reader.token), { [sharedId]: first });
    latestReply = await respond(sharedId, 'Второй вопрос');
    assert.notEqual(latestReply, first);
    assert.equal((await read(sharedId, reader.token, first)).statusCode, 200);
    assert.deepEqual(await unread(reader.token), { [sharedId]: latestReply });
    assert.equal((await read(sharedId, reader.token, latestReply)).statusCode, 200);
    assert.deepEqual(await unread(reader.token), {});
    assert.equal((await unread(owner.token))[sharedId], latestReply);
  } finally { await f.app.close(); }
  const reopened = new Store(f.store.root);
  try {
    assert.equal(reopened.state.security?.users.find(user => user.id === readerId)?.readChatReplies?.[sharedId], latestReply);
    assert.equal(reopened.state.projects[0].chats.find(chat => chat.id === sharedId)?.lastCompletedReplyId, latestReply);
  } finally { await reopened.close(); }
});

test('three employees share library but private chat metadata, messages, jobs and writes are protected', async () => {
  const f = await fixture(); try {
    const a = await f.employee('alice'), b = await f.employee('boris'), c = await f.employee('clara');
    assert.deepEqual((await f.req('GET', '/api/projects', a.token)).json(), []);
    assert.equal((await f.req('GET', `/api/projects/${f.project.id}/chats`, a.token)).statusCode, 404);
    const base = `/api/projects/${f.project.id}`;
    assert.equal((await f.setProjectRoles([...a.projectRoles, ...b.projectRoles, ...c.projectRoles])).statusCode, 200);
    const ca = (await f.req('POST', base + '/chats', a.token, { title: 'Только Алиса' })).json();
    const cb = (await f.req('POST', base + '/chats', b.token, { title: 'Только Борис' })).json();
    const cc = (await f.req('POST', base + '/chats', c.token, {})).json();
    const route = base + '/chats/' + ca.id;
    assert.equal(ca.visibility, 'private'); assert.equal(ca.ownerId, a.id);
    assert.deepEqual((await f.req('GET', base + '/chats', b.token)).json().map((v: any) => v.id), [cb.id]);
    assert.equal((await f.req('GET', '/api/projects', b.token)).json()[0].chatCount, 1);
    assert.equal((await f.req('GET', route, b.token)).statusCode, 404);
    assert.equal((await f.req('GET', route + '/messages', c.token)).statusCode, 404);
    assert.equal((await f.req('PATCH', route, b.token, { model: '' })).statusCode, 404);
    assert.equal((await f.req('PATCH', route + '/title', b.token, { title: 'Чужой чат' })).statusCode, 404);
    assert.equal((await f.req('PATCH', route + '/title', a.token, { title: '  ' })).statusCode, 400);
    assert.deepEqual((await f.req('PATCH', route + '/title', a.token, { title: '  Новый диалог  ' })).json(), { title: 'Новый диалог' });
    assert.equal((await f.req('POST', route + '/messages', b.token, { text: 'wrong' })).statusCode, 404);
    assert.equal((await f.req('GET', route, f.admin)).statusCode, 200);
    const run = (await f.req('POST', route + '/messages', a.token, { text: 'CANCEL_TEST', clientRequestId: 'same-id' })).json();
    await new Promise(r => setTimeout(r, 100));
    const status = (await f.req('GET', '/api/status', b.token)).json(); assert.equal(status.busy, true); assert.equal(status.activeRun, null); assert.ok(!JSON.stringify(status).includes(ca.id));
    assert.equal((await f.req('PATCH', route + '/visibility', a.token, { visibility: 'project' })).statusCode, 409);
    assert.equal((await f.req('GET', `/api/runs/${run.id}`, b.token)).statusCode, 404);
    assert.equal((await f.req('POST', `/api/runs/${run.id}/cancel`, c.token, {})).statusCode, 404);
    await f.req('POST', `/api/runs/${run.id}/cancel`, a.token, {}); await done(f.workspace);
    assert.equal((await f.req('GET', route, a.token)).json().title, 'Новый диалог');
    assert.equal((await f.req('PATCH', route + '/visibility', a.token, { visibility: 'project' })).statusCode, 200);
    assert.equal((await f.req('GET', route + '/messages', b.token)).statusCode, 200);
    const peer = await f.req('POST', route + '/messages', b.token, { text: 'Вопрос коллеги' });
    assert.equal(peer.statusCode, 202, peer.body); await done(f.workspace);
    const shared = (await f.req('GET', route, a.token)).json();
    assert.equal(shared.ownerId, a.id);
    assert.equal(shared.messages.at(-2).authorId, b.id);
    assert.equal(shared.messages.at(-2).authorName, 'boris');
    assert.equal((await f.req('PATCH', route + '/visibility', b.token, { visibility: 'private' })).statusCode, 403);
    assert.equal((await f.req('PATCH', route, b.token, { model: '' })).statusCode, 403);
    assert.equal((await f.req('PATCH', route + '/title', b.token, { title: 'Общий чат' })).statusCode, 403);
    assert.equal((await f.req('PATCH', route + '/title', f.admin, { title: 'Обсуждение команды' })).statusCode, 200);
    assert.equal((await f.req('GET', base + '/chats', a.token)).json().find((item: { id: string }) => item.id === ca.id).title, 'Обсуждение команды');
    const rb = await f.req('POST', base + '/chats/' + cb.id + '/messages', b.token, { text: 'Привет', clientRequestId: 'same-id' }); assert.equal(rb.statusCode, 202); await done(f.workspace);
    assert.equal(f.workspace.chat(f.project.id, cb.id).messages[0].authorId, b.id);
    const bossReply = await f.req('POST', base + '/chats/' + cb.id + '/messages', f.admin, { text: 'Комментарий руководителя' }); assert.equal(bossReply.statusCode, 202); await done(f.workspace);
    const detail = (await f.req('GET', base + '/chats/' + cb.id, b.token)).json(); assert.equal(detail.messages.at(-2).authorId, f.adminId); assert.equal(detail.messages.at(-2).authorName, 'Руководитель');
    assert.equal((await f.req('PATCH', route + '/visibility', a.token, { visibility: 'private' })).statusCode, 200);
    assert.equal((await f.req('GET', route, b.token)).statusCode, 404);
    assert.equal((await f.req('GET', `/api/runs/${run.id}`, b.token)).statusCode, 404);
    assert.equal((await f.setProjectRoles([...b.projectRoles, ...c.projectRoles])).statusCode, 200);
    assert.equal((await f.req('GET', route, a.token)).statusCode, 404);
    assert.equal((await f.req('POST', route + '/messages', a.token, { text: 'revoked' })).statusCode, 404);
    assert.ok(cc.id);
  } finally { await f.app.close(); }
});
test('ERP employees cannot administer the platform or set passwords; disabling access revokes their session', async () => {
  const f = await fixture(); try {
    const a = await f.employee('alice');
    assert.equal((await f.req('GET', '/api/admin/execution/accounts', a.token)).statusCode, 403);
    assert.equal((await f.req('POST', '/api/admin/execution/accounts', a.token, { name: 'Other' })).statusCode, 403);
    for (const [method, url, body] of [ ['GET','/api/users',undefined], ['GET','/api/audit',undefined], ['GET','/api/diagnostics',undefined], ['POST','/api/cli/check',{}], ['POST','/api/subscription/check',{}], ['PATCH','/api/settings',{allowWrite:true}], ['POST','/api/projects',{directory:f.root}], ['POST','/api/users',{username:'evil',name:'x',password,role:'admin'}], ['PUT',`/api/projects/${f.project.id}/roles`,{revision:0,roles:a.projectRoles}] ] as const) assert.equal((await f.req(method,url,a.token,body)).statusCode,403,`${method} ${url}`);
    assert.equal((await f.req('PATCH', '/api/users/' + a.id, f.admin, { password: 'A-new-valid-password-2026' })).statusCode, 403);
    assert.equal((await f.req('POST','/api/auth/password',a.token,{currentPassword:password,password:'Self-changed-password-2026'})).statusCode,403);
    assert.equal((await f.req('POST','/api/auth/login','',{username:'alice',password})).statusCode,401);
    assert.equal((await f.req('PATCH','/api/users/'+a.id,f.admin,{disabled:true})).statusCode,200);
    assert.equal((await f.req('GET','/api/projects',a.token)).statusCode,401);
    assert.equal((await f.req('PATCH','/api/users/'+f.adminId,f.admin,{disabled:true})).statusCode,400);
    const audit = (await f.req('GET','/api/audit',f.admin)).json(); assert.ok(audit.some((a: any) => a.action === 'user.update')); assert.ok(!JSON.stringify(audit).includes(password));
  } finally { await f.app.close(); }
});
test('bootstrap only works on loopback before setup, setup gates data and login attempts are bounded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-bootstrap-')); const app = await createApp(new Workspace(new Store(root), new CodexClient()));
  try {
    assert.equal((await app.inject({ method:'POST',url:'/api/local-login',remoteAddress:'192.168.2.20',headers:{host:'localhost','x-bridge-local':'1'} })).statusCode,403);
    assert.equal((await app.inject({ method:'POST',url:'/api/local-login',headers:{host:'localhost.evil.test','x-bridge-local':'1'} })).statusCode,403);
    const alternatePath = '/%' + '61pi/local-login';
    const remote = await app.inject({ method: 'POST', url: alternatePath, remoteAddress: '192.168.2.20',
      headers: { host: 'localhost', 'x-bridge-local': '1' } });
    assert.equal(remote.statusCode, 403);
    assert.equal(remote.json().token, undefined);
    assert.equal((await app.inject({ url: '/%' + '61pi/models' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/%ZZ' })).statusCode, 400);
    const boot = (await app.inject({ method:'POST',url:'/api/local-login',headers:{host:'localhost','x-bridge-local':'1'} })).json();
    assert.equal((await app.inject({ url:'/api/projects',headers:{authorization:`Bearer ${boot.token}`} })).statusCode,403);
    for(let i=0;i<10;i++) await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wrong',password:'wrong'}});
    assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wrong',password:'wrong'}})).statusCode,429);
  } finally { await app.close(); }
});

test('ERP administrators cannot assign administrator roles or set local passwords', async () => {
  const f = await fixture();
  try {
    const elevated = await f.employee('ERP Admin'), other = await f.employee('Employee');
    const target = (id: string) => '/api/users/' + id;
    const role = { role: 'admin' };
    const change = { password: 'Different-local-password-2026' };
    assert.equal((await f.req('PATCH', target(elevated.id), f.admin, role)).statusCode, 200);
    assert.equal((await f.req('PATCH', target(elevated.id), elevated.token, change)).statusCode, 403);
    assert.equal((await f.req('PATCH', target(f.adminId), elevated.token, change)).statusCode, 403);
    assert.equal((await f.req('PATCH', target(other.id), elevated.token, role)).statusCode, 403);
    assert.equal((await f.req('PATCH', target(other.id), elevated.token, { name: 'Updated employee' })).statusCode, 200);
    assert.equal((await f.req('GET', '/api/admin/fastkore/installations', elevated.token)).statusCode, 403);
    assert.equal((await f.req('POST', '/api/auth/login', '', { username: 'boss', password })).statusCode, 200);
    assert.equal((await f.req('PATCH', target(elevated.id), f.admin, change)).statusCode, 200);
    assert.equal((await f.req('POST', '/api/auth/login', '', { username: 'sso-' + elevated.id, ...change })).statusCode, 200);
  } finally { await f.app.close(); }
});

test('twenty successful ERP sign-ins can share one office IP', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) await f.employee('Office user ' + i);
  } finally { await f.app.close(); }
});

test('simultaneous file uploads share a bounded admission per actor', async t => {
  const f = await fixture();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const upload = f.workspace.files.upload.bind(f.workspace.files);
  t.mock.method(f.workspace.files, 'upload', async (...args: Parameters<typeof upload>) => {
    started.resolve();
    await finish.promise;
    return upload(...args);
  });
  try {
    const employee = await f.employee('Uploader');
    assert.equal((await f.setProjectRoles(employee.projectRoles)).statusCode, 200);
    const request = () => f.app.inject({
      method: 'POST', url: `/api/projects/${f.project.id}/attachments`,
      headers: { host: 'agents.example.test', 'x-forwarded-proto': 'https', origin: 'https://agents.example.test',
        cookie: employee.token, 'x-csrf-token': csrfFor(employee.token.split('=')[1]), 'content-type': 'multipart/form-data; boundary=upload' },
      payload: '--upload\r\nContent-Disposition: form-data; name="file"; filename="draft.txt"\r\n\r\nDraft\r\n--upload--\r\n',
    });
    const first = request().then(response => response);
    const winner = await Promise.race([started.promise.then(() => 'storage'), first.then(response => response.body)]);
    assert.equal(winner, 'storage');
    assert.equal((await request()).statusCode, 429);
    finish.resolve();
    assert.equal((await first).statusCode, 201);
    assert.equal((await request()).statusCode, 201);
  } finally {
    finish.resolve();
    await f.app.close();
  }
});
