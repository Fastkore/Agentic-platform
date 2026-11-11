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

const password = 'Test-password-for-office-2026';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-access-')), directory = path.join(root, 'library'); await mkdir(directory);
  const store = new Store(path.join(root, 'data')), workspace = new Workspace(store, new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))]));
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const project = await workspace.addProject(directory), legacy = await workspace.addChat(project.id, 'Старая история'); legacy.sessionId = '87db344a-98f3-42c8-bba8-c7d9f3dcff11';
  const app = await createApp(workspace);
  const req = async (method: string, url: string, token = '', payload?: unknown) => app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload }) });
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost:8787', 'x-bridge-local': '1' } })).json();
  const setup = await req('POST', '/api/auth/setup', boot.token, { username: 'boss', name: 'Руководитель', password }); assert.equal(setup.statusCode, 200);
  const admin = setup.json().token as string, adminId = setup.json().user.id;
  async function employee(username: string) {
    const created = await req('POST', '/api/users', admin, { username, name: username, role: 'employee', password }); assert.equal(created.statusCode, 201);
    const login = await req('POST', '/api/auth/login', '', { username, password }); assert.equal(login.statusCode, 200);
    return { id: created.json().id as string, token: login.json().token as string };
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
test('personal API keys follow owner ACL, revoke immediately, never expose hashes and survive restart', async () => {
  const f = await fixture(); let closed = false; try {
    const a = await f.employee('alice'), b = await f.employee('boris'), base = `/api/projects/${f.project.id}`;
    await f.req('PATCH', base + '/members', f.admin, { memberIds: [a.id, b.id] });
    const ca = (await f.req('POST', base + '/chats', a.token, {})).json(), cb = (await f.req('POST', base + '/chats', b.token, {})).json();
    const issued = await f.req('POST', '/api/auth/keys', a.token, { name: 'Fastkore' }); assert.equal(issued.statusCode, 201); const key = issued.json();
    assert.match(key.token, /^ccb_k_/); assert.equal((await f.req('GET', base + '/chats/' + ca.id, key.token)).statusCode, 200);
    assert.equal((await f.req('GET', base + '/chats/' + cb.id, key.token)).statusCode, 404);
    assert.equal((await f.req('POST', '/api/auth/keys', key.token, { name: 'extra' })).statusCode, 403);
    assert.equal((await f.req('DELETE', '/api/auth/keys/' + key.id, b.token)).statusCode, 404);
    const list = (await f.req('GET', '/api/auth/keys', a.token)).json(); assert.ok(!JSON.stringify(list).includes('hash')); assert.ok(!JSON.stringify(list).includes(key.token));
    await f.app.close(); closed = true;
    const reopenedStore = new Store(f.store.root), reopened = new Workspace(reopenedStore, new CodexClient()), app = await createApp(reopened);
    try {
      assert.equal((await app.inject({ url: base + '/chats/' + ca.id, headers: { authorization: `Bearer ${key.token}` } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'DELETE', url: '/api/auth/keys/' + key.id, headers: { authorization: `Bearer ${a.token}` } })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${key.token}` } })).statusCode, 401);
    } finally { await app.close(); }
  } finally { if (!closed) await f.app.close(); }
});
test('employees cannot change server settings, project membership, users or inspect diagnostics; reset and disable revoke all credentials', async () => {
  const f = await fixture(); try {
    const a = await f.employee('alice');
    for (const [method, url, body] of [ ['GET','/api/users',undefined], ['GET','/api/audit',undefined], ['GET','/api/diagnostics',undefined], ['POST','/api/cli/check',{}], ['POST','/api/subscription/check',{}], ['PATCH','/api/settings',{allowWrite:true}], ['POST','/api/projects',{directory:f.root}], ['POST','/api/users',{username:'evil',name:'x',password,role:'admin'}], ['PATCH',`/api/projects/${f.project.id}/members`,{memberIds:[a.id]}] ] as const) assert.equal((await f.req(method,url,a.token,body)).statusCode,403,`${method} ${url}`);
    const key = (await f.req('POST', '/api/auth/keys', a.token, { name:'key' })).json();
    await f.req('PATCH', '/api/users/' + a.id, f.admin, { password: 'A-new-valid-password-2026' });
    assert.equal((await f.req('GET','/api/projects',a.token)).statusCode,401); assert.equal((await f.req('GET','/api/projects',key.token)).statusCode,401);
    assert.equal((await f.req('POST','/api/auth/login','',{username:'alice',password})).statusCode,401);
    const login = await f.req('POST','/api/auth/login','',{username:'alice',password:'A-new-valid-password-2026'}); assert.equal(login.statusCode,200);
    const changed = await f.req('POST','/api/auth/password',login.json().token,{currentPassword:'A-new-valid-password-2026',password:'Self-changed-password-2026'}); assert.equal(changed.statusCode,200);
    assert.equal((await f.req('GET','/api/projects',login.json().token)).statusCode,401);
    assert.equal((await f.req('GET','/api/projects',changed.json().token)).statusCode,200);
    await f.req('PATCH','/api/users/'+a.id,f.admin,{disabled:true}); assert.equal((await f.req('GET','/api/projects',changed.json().token)).statusCode,401);
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
