import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { createApp } from '../server/app.js';
import { audience, csrfFor, validateSsoConfig, validateTicketHttps, type TrustedInstallation } from '../server/fastkore.js';
import { parseHostContext } from '../client/fastkore.js';
import { testCertificate } from './test-certificate.js';

process.env.BRIDGE_EXECUTION = 'disabled'; // SSO pilot must never execute under the shared server OS identity.
const origin = 'https://agents.example.test', password = 'Sso-test-password-2026';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sso-')); await mkdir(path.join(root, 'project'));
  const store = new Store(path.join(root, 'data')), workspace = new Workspace(store, {
    inspect: async () => ({ path: '', version: 'fake', authentication: 'chatgpt', status: '' }),
    run: async () => { throw Error('SSO pilot must not start Codex'); }
  });
  const project = await workspace.addProject(path.join(root, 'project'));
  const installation: TrustedInstallation = { id: 'office-a', name: 'Офис А', enabled: true, validationUrl: 'https://erp.example.test/api/ai/validate-ticket', secretFile: path.join(root, 'secret'), entityTypes: ['ProductionOrder'] };
  const responses = new Map<string, unknown>(); let calls = 0;
  let validate = async (_i: TrustedInstallation, ticket: string): Promise<unknown> => { calls++; return responses.get(ticket) ?? { valid: false }; };
  const options = { publicOrigin: origin, trustedProxies: ['127.0.0.1'], ssoConfig: { installations: [installation, { ...installation, id: 'office-b', name: 'Офис Б' }] }, ticketValidator: (i: TrustedInstallation, t: string) => validate(i, t) };
  const app = await createApp(workspace, options);
  const headers = { host: 'agents.example.test', 'x-forwarded-proto': 'https' };
  const req = (method: any, url: string, token = '', payload?: unknown, extra: Record<string, string> = {}) => app.inject({ method, url, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, ...(payload === undefined ? {} : { payload }) });
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
  const setup = await req('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Руководитель', password }); assert.equal(setup.statusCode, 200);
  const admin = setup.json().token as string, adminId = setup.json().user.id as string;
  const ticket = (userId = 'erp-1', installationId = 'office-a', displayName = 'Руководитель') => {
    const token = randomBytes(32).toString('base64url'); responses.set(token, { valid: true, installation_id: installationId, audience, user: { id: userId, display_name: displayName }, role: 'admin' }); return token;
  };
  const exchange = (t: string, installationId = 'office-a', extra: Record<string, string> = {}) => req('POST', '/auth/fastkore/exchange', '', new URLSearchParams({ installation_id: installationId, ticket: t }).toString(), { 'content-type': 'application/x-www-form-urlencoded', ...extra });
  async function login(userId = 'erp-1', installationId = 'office-a') {
    const response = await exchange(ticket(userId, installationId), installationId); assert.equal(response.statusCode, 303, response.body);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const browser = await req('GET', '/api/auth/browser-session', '', undefined, { cookie }); assert.equal(browser.statusCode, 200);
    const value = browser.json(); return { cookie, csrf: value.csrfToken as string, user: value.user, header: String(response.headers['set-cookie']) };
  }
  const asCookie = (s: { cookie: string; csrf: string }, method: any, url: string, payload?: unknown, extra: Record<string, string> = {}) => req(method, url, '', payload, { cookie: s.cookie, origin, 'x-bridge-csrf': s.csrf, ...extra });
  return { root, store, workspace, app, options, project, installation, responses, req, ticket, exchange, login, asCookie, admin, adminId, get calls() { return calls; }, setValidator: (fn: typeof validate) => { validate = fn; } };
}

test('SSO first entry uses exact external identity, grants nothing, and stores only token/ticket hashes', async () => {
  const f = await fixture(); try {
    const s = await f.login(); assert.match(s.header, /Secure; HttpOnly; SameSite=Lax; Max-Age=1800/); assert.match(s.header, /^__Host-/); assert.ok(!s.header.includes('Domain='));
    assert.notEqual(s.user.id, f.adminId); assert.equal(s.user.role, 'employee'); assert.equal(s.user.roleId, '');
    assert.deepEqual((await f.asCookie(s, 'GET', '/api/projects')).json(), []);
    assert.deepEqual((await f.asCookie(s, 'GET', '/api/agents')).json(), []);
    assert.equal((await f.asCookie(s, 'GET', '/api/users')).statusCode, 403);
    assert.equal((await f.asCookie(s, 'POST', `/api/projects/${f.project.id}/chats`, {})).statusCode, 404);
    assert.equal(f.store.state.security!.users.find(u => u.id === s.user.id)!.passwordHash, '');
    const again = await f.login(); assert.equal(again.user.id, s.user.id);
    const anotherOffice = await f.login('erp-1', 'office-b'); assert.notEqual(anotherOffice.user.id, s.user.id);
    const json = JSON.stringify(f.store.state); assert.ok(!json.includes(s.cookie.split('=')[1])); assert.ok(!json.includes(s.csrf));
    for (const token of f.responses.keys()) assert.ok(!json.includes(token));
    const listing = (await f.req('GET', '/api/admin/fastkore/installations', f.admin)).body;
    assert.ok(!listing.includes('secretFile')); assert.ok(!listing.includes('validationUrl'));
  } finally { await f.app.close(); }
});

test('simultaneous replay is rejected before ERP call and replay protection survives application restart', async () => {
  const f = await fixture(); let closed = false; try {
    const t = f.ticket(); const result = await Promise.all([f.exchange(t), f.exchange(t)]);
    assert.deepEqual(result.map(r => r.statusCode).sort(), [303, 401]); assert.equal(f.calls, 1);
    await f.app.close(); closed = true;
    const binary = await readFile(f.store.file); assert.ok(!binary.includes(Buffer.from(t)));
    const store = new Store(f.store.root), workspace = new Workspace(store, { inspect: async () => { throw Error(); }, run: async () => { throw Error(); } });
    const app = await createApp(workspace, f.options);
    try {
      const response = await app.inject({ method: 'POST', url: '/auth/fastkore/exchange', headers: { host: 'agents.example.test', 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ installation_id: 'office-a', ticket: t }).toString() });
      assert.equal(response.statusCode, 401); assert.equal(f.calls, 1);
    } finally { await app.close(); }
  } finally { if (!closed) await f.app.close(); }
});

test('concurrent distinct tickets create one user; identity switch replaces and revokes the previous browser session', async () => {
  const f = await fixture(); try {
    const [a, b] = await Promise.all([f.login('erp-alice'), f.login('erp-alice')]);
    assert.equal(a.user.id, b.user.id); assert.equal(f.store.state.externalIdentities!.length, 1);
    const switched = await f.exchange(f.ticket('erp-boris'), 'office-a', { cookie: a.cookie }); assert.equal(switched.statusCode, 303);
    const cookie = String(switched.headers['set-cookie']).split(';')[0];
    const current = await f.req('GET', '/api/auth/browser-session', f.admin, undefined, { cookie });
    assert.notEqual(current.json().user.id, a.user.id); assert.equal(current.json().user.role, 'employee');
    assert.equal((await f.asCookie(a, 'GET', '/api/projects')).statusCode, 401);
    assert.equal((await f.asCookie(b, 'GET', '/api/projects')).statusCode, 200);
  } finally { await f.app.close(); }
});

test('failed, expired, mismatched and uncertain tickets never create a platform session or fallback', async () => {
  const f = await fixture(); try {
    const bad = randomBytes(32).toString('base64url'); assert.equal((await f.exchange(bad)).statusCode, 401);
    const wrongOffice = f.ticket('erp-1', 'office-b'); assert.equal((await f.exchange(wrongOffice)).statusCode, 401);
    const wrongAudience = f.ticket(); (f.responses.get(wrongAudience) as any).audience = 'other'; assert.equal((await f.exchange(wrongAudience)).statusCode, 401);
    const missingId = f.ticket(); (f.responses.get(missingId) as any).user.id = ''; assert.equal((await f.exchange(missingId)).statusCode, 401);
    f.setValidator(async () => { throw Error('secret ERP details'); }); const uncertain = f.ticket();
    const failure = await f.exchange(uncertain); assert.equal(failure.statusCode, 502); assert.ok(!failure.body.includes('secret ERP details')); assert.equal(failure.headers['set-cookie'], undefined);
    assert.equal((await f.exchange(uncertain)).statusCode, 401);
    assert.equal(f.store.state.externalIdentities?.length ?? 0, 0);
  } finally { await f.app.close(); }
});

test('SSO requires exact HTTPS through configured proxy; hostile origins and client-supplied endpoints are rejected', async () => {
  const f = await fixture(); try {
    const t = f.ticket();
    assert.equal((await f.exchange(t, 'office-a', { 'x-forwarded-proto': 'http' })).statusCode, 403);
    const spoof = await f.app.inject({ method: 'POST', url: '/auth/fastkore/exchange', remoteAddress: '192.0.2.20', headers: { host: 'agents.example.test', 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ installation_id: 'office-a', ticket: t }).toString() }); assert.equal(spoof.statusCode, 403);
    assert.equal((await f.exchange(t, 'office-a', { host: 'evil.test' })).statusCode, 403);
    assert.equal((await f.exchange(t, 'office-a', { origin: 'https://evil.test' })).statusCode, 403);
    assert.equal((await f.exchange(t, 'office-a', { origin: 'null', 'sec-fetch-site': 'cross-site' })).statusCode, 403);
    assert.equal((await f.req('POST', '/auth/fastkore/exchange?ticket=hidden', '', {})).statusCode, 400);
    assert.equal((await f.req('POST', '/auth/fastkore/exchange', '', { installation_id: 'office-a', ticket: t })).statusCode, 415);
    const extra = new URLSearchParams({ installation_id: 'office-a', ticket: t, validationUrl: 'https://evil.test' }).toString();
    assert.equal((await f.req('POST', '/auth/fastkore/exchange', '', extra, { 'content-type': 'application/x-www-form-urlencoded' })).statusCode, 400);
    assert.equal(f.calls, 0);
    assert.equal((await f.exchange(t)).statusCode, 303);
  } finally { await f.app.close(); }
});

test('cookie actions require Origin and CSRF, bearer ambiguity fails, and logout expires the session', async () => {
  const f = await fixture(); try {
    const s = await f.login(), token = s.cookie.split('=')[1]; assert.equal(s.csrf, csrfFor(token));
    const session = await f.req('GET', '/api/auth/browser-session', f.admin, undefined, { cookie: s.cookie }); assert.equal(session.json().user.id, s.user.id);
    assert.equal((await f.req('GET', '/api/projects', f.admin, undefined, { cookie: s.cookie })).statusCode, 409);
    assert.equal((await f.req('GET', '/api/projects', token)).statusCode, 401);
    assert.equal((await f.req('POST', '/api/auth/keys', '', { name: 'ERP' }, { cookie: s.cookie })).statusCode, 403);
    assert.equal((await f.asCookie(s, 'POST', '/api/auth/keys', { name: 'ERP' }, { origin: 'https://evil.test' })).statusCode, 403);
    assert.equal((await f.asCookie(s, 'POST', '/api/auth/keys', { name: 'ERP' }, { 'x-bridge-csrf': '0'.repeat(64) })).statusCode, 403);
    const key = await f.asCookie(s, 'POST', '/api/auth/keys', { name: 'ERP' }); assert.equal(key.statusCode, 201);
    assert.equal((await f.req('GET', '/api/projects', key.json().token)).statusCode, 200);
    const logout = await f.asCookie(s, 'POST', '/api/auth/logout', {}); assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await f.asCookie(s, 'GET', '/api/projects')).statusCode, 401);
  } finally { await f.app.close(); }
});

test('platform disable, session expiry, installation disable and external relinking revoke old access', async () => {
  const f = await fixture(); try {
    const s = await f.login(), key = (await f.asCookie(s, 'POST', '/api/auth/keys', { name: 'ERP' })).json().token;
    await f.req('PATCH', `/api/users/${s.user.id}`, f.admin, { disabled: true });
    assert.equal((await f.asCookie(s, 'GET', '/api/projects')).statusCode, 401);
    assert.equal((await f.exchange(f.ticket())).statusCode, 403);
    await f.req('PATCH', `/api/users/${s.user.id}`, f.admin, { disabled: false });
    const renewed = await f.login();
    const credential = f.store.state.security!.credentials.find(c => c.userId === s.user.id && c.kind === 'session')!; credential.expiresAt = new Date(0).toISOString();
    assert.equal((await f.asCookie(renewed, 'GET', '/api/projects')).statusCode, 401);
    const third = await f.login();
    assert.equal((await f.req('PATCH', '/api/admin/fastkore/installations/office-a', f.admin, { enabled: false })).statusCode, 200);
    assert.equal((await f.asCookie(third, 'GET', '/api/projects')).statusCode, 401);
    assert.equal((await f.req('GET', '/api/projects', key)).statusCode, 401);
    assert.equal((await f.exchange(f.ticket())).statusCode, 403);
    await f.req('PATCH', '/api/admin/fastkore/installations/office-a', f.admin, { enabled: true });
    const fourth = await f.login();
    await f.req('PUT', '/api/admin/fastkore/identities', f.admin, { installationId: 'office-a', externalUserId: 'erp-1', userId: f.adminId });
    assert.equal((await f.asCookie(fourth, 'GET', '/api/projects')).statusCode, 401);
    const mapped = await f.login(); assert.equal(mapped.user.id, f.adminId); assert.equal(mapped.user.role, 'admin');
  } finally { await f.app.close(); }
});

test('ERP context is validated by installation, cannot grant a specialist, and is immutable per chat', async () => {
  const f = await fixture(); try {
    const s = await f.login(), route = `/api/projects/${f.project.id}/chats`, object = { entityType: 'ProductionOrder', entityId: '1677' };
    await f.req('PATCH', `/api/users/${s.user.id}`, f.admin, { roleId: 'employee' });
    await f.req('PATCH', `/api/projects/${f.project.id}/members`, f.admin, { memberIds: [s.user.id] });
    const context = await f.asCookie(s, 'POST', '/api/fastkore/context/validate', { ...object, suggestedAgent: 'estimator' });
    assert.equal(context.statusCode, 200); assert.equal(context.json().context.installationId, 'office-a'); assert.equal(context.json().suggestionUnavailable, true); assert.equal(context.json().suggestedAgent, undefined);
    assert.equal((await f.asCookie(s, 'POST', '/api/fastkore/context/validate', { ...object, entityType: 'SecretLedger' })).statusCode, 400);
    assert.equal((await f.asCookie(s, 'POST', '/api/fastkore/context/validate', { ...object, installationId: 'office-b' })).statusCode, 400);
    const first = await f.asCookie(s, 'POST', route, { erpContext: object }); assert.equal(first.statusCode, 201);
    assert.equal(first.json().erpContext.entityId, '1677'); assert.equal(first.json().messages.length, 0); assert.equal(f.store.state.runs.length, 0);
    assert.equal((await f.asCookie(s, 'PATCH', route + '/' + first.json().id, { erpContext: { ...object, entityId: '9000' } })).statusCode, 400);
    assert.equal((await f.req('POST', route, f.admin, { erpContext: object })).statusCode, 403);
    const second = await f.asCookie(s, 'POST', route, { erpContext: { ...object, entityId: '9000' } }); assert.equal(second.statusCode, 201);
    assert.equal((await f.asCookie(s, 'GET', route + '/' + first.json().id)).json().erpContext.entityId, '1677');
    assert.equal((await f.asCookie(s, 'POST', route + '/' + first.json().id + '/messages', { text: 'Расчёт' })).statusCode, 503);
    assert.equal((await f.asCookie(s, 'GET', '/api/admin/fastkore/identities')).statusCode, 403);
  } finally { await f.app.close(); }
});

test('unconfigured SSO and unsafe configuration stay closed; native messages are strictly data', async () => {
  const f = await fixture(); try {
    await assert.rejects(createApp(f.workspace, { ...f.options, trustedProxies: [] }));
    const mode = process.env.BRIDGE_EXECUTION;
    try { delete process.env.BRIDGE_EXECUTION; await assert.rejects(createApp(f.workspace, f.options)); } finally { process.env.BRIDGE_EXECUTION = mode; }
    assert.throws(() => validateSsoConfig({ installations: [{ ...f.installation, validationUrl: 'http://erp.test/api/ai/validate-ticket' }] }));
    assert.throws(() => validateSsoConfig({ installations: [{ ...f.installation, validationUrl: 'https://user:secret@erp.test/api/ai/validate-ticket' }] }));
    assert.throws(() => validateSsoConfig({ installations: [{ ...f.installation, validationUrl: 'https://erp.test/api/ai/validate-ticket?url=other' }] }));
    const store = new Store(path.join(f.root, 'other')), workspace = new Workspace(store, { inspect: async () => { throw Error(); }, run: async () => { throw Error(); } });
    const app = await createApp(workspace);
    try { assert.equal((await app.inject({ method: 'POST', url: '/auth/fastkore/exchange' })).statusCode, 503); assert.equal((await app.inject({ url: '/api/auth/browser-session' })).json().authenticated, false); } finally { await app.close(); }
    const message = { type: 'fastkore.context', version: 1, entityType: 'ProductionOrder', entityId: '1677', suggestedAgent: 'estimator' };
    assert.deepEqual(parseHostContext(message), message); for (const value of [null, JSON.stringify(message), { ...message, version: 2 }, { ...message, entityId: '../secret\n' }, { ...message, script: 'alert(1)' }, { ...message, suggestedAgent: '--admin' }]) assert.equal(parseHostContext(value), null);
  } finally { await f.app.close(); }
});

test('actual HTTPS validation verifies TLS, sends the exact contract and bounds redirects, malformed and oversized responses', async () => {
  const tls = testCertificate(), root = await mkdtemp(path.join(tmpdir(), 'bridge-https-')), secret = randomBytes(32).toString('base64url'); await writeFile(path.join(root, 'secret'), secret);
  let mode = 'ok', calls = 0;
  const server = createServer(tls, async (req, res) => {
    calls++; assert.equal(req.url, '/api/ai/validate-ticket'); assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const chunk of req) body += chunk; const value = JSON.parse(body);
    assert.equal(value.installation_id, 'office-a'); assert.equal(value.audience, audience); assert.equal(value.ticket, 'test-ticket');
    if (mode === 'redirect') { res.writeHead(302, { location: '/other', 'content-type': 'application/json' }); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(mode === 'large' ? ' '.repeat(9000) : mode === 'bad' ? '{bad' : JSON.stringify({ valid: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const installation: TrustedInstallation = { id: 'office-a', name: 'Test', enabled: true, entityTypes: [], validationUrl: `https://127.0.0.1:${(server.address() as any).port}/api/ai/validate-ticket`, secretFile: path.join(root, 'secret') };
  try {
    await assert.rejects(validateTicketHttps(installation, 'test-ticket')); assert.equal(calls, 0);
    assert.deepEqual(await validateTicketHttps(installation, 'test-ticket', { ca: tls.cert }), { valid: true });
    for (mode of ['redirect', 'large', 'bad']) await assert.rejects(validateTicketHttps(installation, 'test-ticket', { ca: tls.cert }));
    assert.equal(calls, 4);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
