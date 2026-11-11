import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { CodexClient } from '../server/codex.js';
import { createApp } from '../server/app.js';
import { erpBrowser } from './erp-browser.js';

const password = 'Test-password-for-office-2026';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-access-')), directory = path.join(root, 'library'); await mkdir(directory);
  const store = new Store(path.join(root, 'data'));
  const cli = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))]);
  const workspace = new Workspace(store, {
    isolated: true,
    inspect: (_path, signal) => cli.inspect(process.execPath, signal),
    run: (input, events, signal) => cli.run({ ...input, cliPath: process.execPath }, events, signal),
  });
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(directory), legacy = await workspace.addChat(project.id, 'Старая история'); legacy.sessionId = '87db344a-98f3-42c8-bba8-c7d9f3dcff11';
  const erp = erpBrowser();
  const app = await createApp(workspace, erp.options);
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost:8787', 'x-bridge-local': '1' } })).json();
  const setup = await req('POST', '/api/auth/setup', boot.token, { username: 'boss', name: 'Руководитель', password }); assert.equal(setup.statusCode, 200);
  const admin = setup.json().token as string, adminId = setup.json().user.id;
  const enter = await erp.pair(app, admin);
  async function employee(username: string) {
    const { user, cookie } = await enter(username);
    assert.equal((await req('PATCH', '/api/users/' + user.id, admin, { roleId: 'employee' })).statusCode, 200);
    return { id: user.id, token: cookie };
  }
  return { root, store, workspace, project, legacy, app, req, admin, adminId, employee };
}
async function done(workspace: Workspace) { const end = Date.now() + 10_000; while (workspace.activeRun) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 20)); } }

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
test('employees can create a managed project without opening access to server folders or other employees', async () => {
  const f = await fixture();
  try {
    const creator = await f.employee('creator'), colleague = await f.employee('colleague');
    const response = await f.req('POST', '/api/projects', creator.token, { name: 'Новый проект' });
    assert.equal(response.statusCode, 201);
    const project = response.json();
    assert.equal(project.directory, path.join(f.store.root, 'projects', project.id));
    assert.deepEqual(f.workspace.project(project.id).memberIds, [creator.id]);
    assert.deepEqual((await f.req('GET', '/api/projects', creator.token)).json().map((item: { id: string }) => item.id), [project.id]);
    assert.equal((await f.req('POST', '/api/projects/' + project.id + '/chats', creator.token, {})).statusCode, 201);
    assert.equal((await f.req('GET', '/api/projects/' + project.id + '/chats', colleague.token)).statusCode, 404);
    assert.equal((await f.req('POST', '/api/projects', creator.token, { name: 'Существующая папка', directory: f.root })).statusCode, 403);
  } finally { await f.app.close(); }
});
test('three employees share library but private chat metadata, messages, jobs and writes are protected', async () => {
  const f = await fixture(); try {
    const a = await f.employee('alice'), b = await f.employee('boris'), c = await f.employee('clara');
    assert.deepEqual((await f.req('GET', '/api/projects', a.token)).json(), []);
    assert.equal((await f.req('GET', `/api/projects/${f.project.id}/chats`, a.token)).statusCode, 404);
    const base = `/api/projects/${f.project.id}`;
    assert.equal((await f.req('PATCH', base + '/members', f.admin, { memberIds: [a.id, b.id, c.id] })).statusCode, 200);
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
    assert.equal((await f.req('POST', route + '/messages', b.token, { text: 'wrong' })).statusCode, 404);
    assert.equal((await f.req('PATCH', route + '/visibility', a.token, { visibility: 'project' })).statusCode, 403);
    assert.equal((await f.req('GET', route, f.admin)).statusCode, 200);
    const run = (await f.req('POST', route + '/messages', a.token, { text: 'CANCEL_TEST', clientRequestId: 'same-id' })).json();
    await new Promise(r => setTimeout(r, 100));
    const status = (await f.req('GET', '/api/status', b.token)).json(); assert.equal(status.busy, true); assert.equal(status.activeRun, null); assert.ok(!JSON.stringify(status).includes(ca.id));
    assert.equal((await f.req('GET', `/api/runs/${run.id}`, b.token)).statusCode, 404);
    assert.equal((await f.req('POST', `/api/runs/${run.id}/cancel`, c.token, {})).statusCode, 404);
    await f.req('POST', `/api/runs/${run.id}/cancel`, a.token, {}); await done(f.workspace);
    await f.req('PATCH', route + '/visibility', f.admin, { visibility: 'project' });
    assert.equal((await f.req('GET', route + '/messages', b.token)).statusCode, 200);
    assert.equal((await f.req('POST', route + '/messages', b.token, { text: 'read only' })).statusCode, 403);
    assert.equal((await f.req('PATCH', route, b.token, { model: '' })).statusCode, 403);
    const rb = await f.req('POST', base + '/chats/' + cb.id + '/messages', b.token, { text: 'Привет', clientRequestId: 'same-id' }); assert.equal(rb.statusCode, 202); await done(f.workspace);
    assert.equal(f.workspace.chat(f.project.id, cb.id).messages[0].authorId, b.id);
    const bossReply = await f.req('POST', base + '/chats/' + cb.id + '/messages', f.admin, { text: 'Комментарий руководителя' }); assert.equal(bossReply.statusCode, 202); await done(f.workspace);
    const detail = (await f.req('GET', base + '/chats/' + cb.id, b.token)).json(); assert.equal(detail.messages.at(-2).authorId, f.adminId); assert.equal(detail.messages.at(-2).authorName, 'Руководитель');
    await f.req('PATCH', route + '/visibility', f.admin, { visibility: 'private' });
    assert.equal((await f.req('GET', route, b.token)).statusCode, 404);
    assert.equal((await f.req('GET', `/api/runs/${run.id}`, b.token)).statusCode, 404);
    await f.req('PATCH', base + '/members', f.admin, { memberIds: [b.id, c.id] });
    assert.equal((await f.req('GET', route, a.token)).statusCode, 404);
    assert.equal((await f.req('POST', route + '/messages', a.token, { text: 'revoked' })).statusCode, 404);
    assert.ok(cc.id);
  } finally { await f.app.close(); }
});
test('ERP employees cannot administer the platform or set passwords; disabling access revokes their session', async () => {
  const f = await fixture(); try {
    const a = await f.employee('alice');
    for (const [method, url, body] of [ ['GET','/api/users',undefined], ['GET','/api/audit',undefined], ['GET','/api/diagnostics',undefined], ['POST','/api/cli/check',{}], ['POST','/api/subscription/check',{}], ['PATCH','/api/settings',{allowWrite:true}], ['POST','/api/projects',{directory:f.root}], ['POST','/api/users',{username:'evil',name:'x',password,role:'admin'}], ['PATCH',`/api/projects/${f.project.id}/members`,{memberIds:[a.id]}] ] as const) assert.equal((await f.req(method,url,a.token,body)).statusCode,403,`${method} ${url}`);
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
    const boot = (await app.inject({ method:'POST',url:'/api/local-login',headers:{host:'localhost','x-bridge-local':'1'} })).json();
    assert.equal((await app.inject({ url:'/api/projects',headers:{authorization:`Bearer ${boot.token}`} })).statusCode,403);
    for(let i=0;i<10;i++) await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wrong',password:'wrong'}});
    assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wrong',password:'wrong'}})).statusCode,429);
  } finally { await app.close(); }
});
