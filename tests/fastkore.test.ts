import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { audience, csrfFor, FastkoreSso, pairErpHttps, validateTicketHttps, type PairingClient, type PairingInput, type TicketValidator } from '../server/fastkore.js';
import { BridgeError, Store, redact } from '../server/store.js';
import { FastkoreCli } from '../server/fastkore-cli.js';
import { Workspace } from '../server/workspace.js';
import { parseHostTheme } from '../client/fastkore.js';
import type { FastkoreKeyIssue } from '../shared/types.js';
import { testCertificate } from './test-certificate.js';

process.env.BRIDGE_EXECUTION = 'disabled';
const origin = 'https://agents.example.test';
const validationUrl = 'https://erp.example.test/api/ai/validate-ticket';
const headers = { host: 'agents.example.test', 'x-forwarded-proto': 'https' };
const password = 'test-password-for-fastkore';
const installations = '/api/admin/fastkore/installations';
const exchangePath = '/auth/fastkore/exchange';
const formType = { 'content-type': 'application/x-www-form-urlencoded' };
const random = () => randomBytes(32).toString('base64url');
type Start = { cookie: string; challenge: string };
type App = Awaited<ReturnType<typeof createApp>>;

function cookies(response: { headers: Record<string, unknown> }) {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
}
function makeWorkspace(store: Store) {
  return new Workspace(store, { inspect: async () => { throw Error('Unexpected CLI startup'); }, run: async () => { throw Error('Unexpected CLI startup'); } });
}
async function setup(app: App) {
  const boot = await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } });
  assert.equal(boot.statusCode, 200);
  const result = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.json().token }, payload: { username: 'admin', name: 'Руководитель', password } });
  assert.equal(result.statusCode, 200);
  return { admin: result.json().token as string, adminId: result.json().user.id as string };
}
async function start(app: App, theme = 'light'): Promise<Start> {
  const response = await app.inject({ url: '/auth/fastkore/start?theme=' + theme, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body, new RegExp('color-scheme:' + theme));
  const [cookie] = cookies(response);
  assert.match(cookie, /^__Host-bridge_sso_start=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=120$/);
  const challenge = response.body.match(/name="fastkore-login-challenge" content="([A-Za-z0-9_-]{43})"/)?.[1];
  assert.ok(challenge);
  assert.notEqual(challenge, cookie.split(';')[0].split('=')[1]);
  return { cookie: cookie.split(';')[0], challenge };
}
function form(prep: Start, id: string, ticket: string) {
  return new URLSearchParams({ version: '1', installation_id: id, ticket, login_challenge: prep.challenge }).toString();
}
const identity = (installation_id: string, id: string) => ({ version: 1, valid: true, installation_id, audience, user: { id, display_name: 'Руководитель' }, role: 'admin' });
async function fixture(pairingClient?: PairingClient) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sso-'));
  const store = new Store(root), workspace = makeWorkspace(store);
  const userId = randomUUID(), responses = new Map<string, { challenge: string; result: ReturnType<typeof identity> }>();
  let calls = 0;
  let validate: TicketValidator = async (_url, _key, payload) => {
    const expected = responses.get(payload.ticket);
    return expected?.challenge === payload.login_challenge ? expected.result : { valid: false };
  };
  const options = {
    publicOrigin: origin, trustedProxies: ['127.0.0.1'], ssoKey: randomBytes(32),
    pairingClient,
    ticketValidator: ((url, key, payload) => { calls++; return validate(url, key, payload); }) as TicketValidator,
  };
  const app = await createApp(workspace, options);
  const { admin, adminId } = await setup(app);
  const req = (method: any, url: string, token = '', payload?: unknown, extra: Record<string, string> = {}) => app.inject({
    method, url, headers: { ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, ...(payload === undefined ? {} : { payload }),
  });
  const create = async (name: string) => {
    const created = await req('POST', installations, admin, { name, validateTicketUrl: validationUrl });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers['cache-control'], 'no-store');
    return created.json<FastkoreKeyIssue>();
  };
  const issue = await create('ERP A'), id = issue.installationId;
  const patch = (data: unknown, installationId = id) => req('PATCH', installations + '/' + installationId, admin, data);
  assert.equal((await patch({ enabled: true })).statusCode, 200);
  const ticket = (prep: Start, externalId = userId, installationId = id) => {
    const value = random();
    responses.set(value, { challenge: prep.challenge, result: identity(installationId, externalId) });
    return value;
  };
  const exchange = (prep: Start, value: string, extra: Record<string, string> = {}, installationId = id) =>
    req('POST', exchangePath, '', form(prep, installationId, value), { ...formType, cookie: prep.cookie, ...extra });
  async function login(externalId = userId, installationId = id, previous = '') {
    const prep = await start(app, 'dark');
    const response = await exchange(prep, ticket(prep, externalId, installationId), { cookie: [prep.cookie, previous].filter(Boolean).join('; ') }, installationId);
    assert.equal(response.statusCode, 303, response.body);
    assert.equal(response.headers.location, '/?embedded=fastkore&theme=dark');
    const [expired, session] = cookies(response);
    assert.match(expired, /^__Host-bridge_sso_start=; .*Max-Age=0$/);
    assert.match(session, /^__Host-bridge_session=ccb_s_[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    assert.ok(Number(session.split('Max-Age=')[1]) <= 1800);
    const cookie = session.split(';')[0];
    const me = await req('GET', '/api/auth/me', '', undefined, { cookie });
    assert.equal(me.statusCode, 200);
    return { cookie, csrf: me.json().authentication.csrfToken as string, user: me.json().user, authentication: me.json().authentication };
  }
  const asCookie = (s: { cookie: string; csrf: string }, method: any, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    req(method, url, '', payload, { cookie: s.cookie, origin, 'x-csrf-token': s.csrf, ...extra });
  return { root, store, workspace, app, options, issue, id, userId, req, create, patch, ticket, exchange, login, asCookie, responses, admin, adminId,
    get calls() { return calls; }, setValidator: (fn: TicketValidator) => { validate = fn; } };
}

test('1.1 provisions a cookie-only identity with no automatic platform rights', async () => {
  const f = await fixture();
  try {
    const session = await f.login(), a = session.authentication;
    assert.equal(a.source, 'fastkore');
    assert.equal(a.installationId, f.id);
    assert.equal(a.externalUserId, f.userId);
    assert.ok(Date.parse(a.expiresAt) > Date.now() + 29 * 60_000);
    assert.equal(a.csrfToken, csrfFor(session.cookie.split('=')[1]));
    assert.equal(a.canChangePassword, false);
    assert.notEqual(session.user.id, f.adminId);
    assert.equal(session.user.role, 'employee');
    assert.equal(session.user.roleId, 'sso_pending');
    assert.deepEqual((await f.asCookie(session, 'GET', '/api/projects')).json(), []);
    assert.deepEqual((await f.asCookie(session, 'GET', '/api/agents')).json(), []);
    assert.equal((await f.asCookie(session, 'POST', '/api/projects', { name: 'Без роли' })).statusCode, 403);
    assert.equal(f.store.state.security!.users.find(u => u.id === session.user.id)!.passwordHash, '');
    const next = await start(f.app), updatedTicket = f.ticket(next);
    f.responses.get(updatedTicket)!.result.user.display_name = 'Иван Петров';
    const exchanged = await f.exchange(next, updatedTicket);
    assert.equal(exchanged.statusCode, 303);
    const cookie = cookies(exchanged)[1].split(';')[0];
    const updatedUser = (await f.req('GET', '/api/auth/me', '', undefined, { cookie })).json().user;
    assert.equal(updatedUser.id, session.user.id);
    assert.equal(updatedUser.roleId, 'sso_pending');
    assert.equal(updatedUser.name, 'Иван Петров');
    assert.equal((await f.req('GET', '/api/users', f.admin)).json().find((item: { id: string }) => item.id === session.user.id).name, 'Иван Петров');
    const other = await f.create('ERP B');
    await f.patch({ enabled: true }, other.installationId);
    assert.notEqual((await f.login(f.userId, other.installationId)).user.id, session.user.id);
    const binary = await readFile(f.store.file);
    for (const secret of [f.issue.connectionKey, f.issue.erpKeyVerifier, session.cookie.split('=')[1], a.csrfToken, ...f.responses.keys()]) {
      assert.ok(!binary.includes(Buffer.from(secret)));
      assert.ok(!JSON.stringify(f.store.state).includes(secret));
    }
    assert.match((await f.req('GET', '/auth/fastkore/challenge.js')).body, /postMessage.+fastkore\.sso\.challenge/);
  } finally { await f.app.close(); }
});

test('Fastkore roles are scoped to the current installation and preserve unknown and empty snapshots', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    let roles: unknown = [{ id: id.toUpperCase(), name: 'Администратор ERP' }];
    f.setValidator(async (_url, _key, payload) => {
      const result = identity(payload.installation_id, f.userId);
      return { ...result, user: { ...result.user, ...(roles === undefined ? {} : { roles }) } };
    });
    const first = await f.login();
    assert.deepEqual(first.authentication.roles, [{ id, name: 'Администратор ERP' }]);
    assert.equal(first.authentication.installationId, f.id);
    assert.equal(first.user.role, 'employee');
    assert.equal(first.user.roleId, 'sso_pending');
    assert.deepEqual((await f.asCookie(first, 'GET', '/api/agents')).json(), []);
    assert.deepEqual((await f.asCookie(first, 'GET', '/api/projects')).json(), []);
    assert.deepEqual((await f.asCookie(first, 'GET', '/api/auth/browser-session')).json().authentication.roles, first.authentication.roles);
    assert.ok(!Object.hasOwn((await f.req('GET', '/api/users', f.admin)).json().find((user: { id: string }) => user.id === first.user.id), 'roles'));

    const secondInstallation = await f.create('ERP B');
    await f.patch({ enabled: true }, secondInstallation.installationId);
    roles = [{ id, name: 'Технолог' }];
    const other = await f.login(f.userId, secondInstallation.installationId);
    assert.equal(other.authentication.installationId, secondInstallation.installationId);
    assert.deepEqual(other.authentication.roles, roles);
    assert.deepEqual((await f.asCookie(first, 'GET', '/api/auth/me')).json().authentication.roles, first.authentication.roles);
    const catalogUrl = '/api/admin/erp-roles';
    const catalog = (await f.req('GET', catalogUrl, f.admin)).json();
    assert.equal(catalog.length, 2);
    assert.ok(catalog.every((role: { userCount: number }) => role.userCount === 1));
    assert.equal(catalog.find((role: { installationId: string }) => role.installationId === f.id).name, 'Администратор ERP');
    const team = (await f.req('GET', '/api/users', f.admin)).json();
    assert.deepEqual(team.find((user: { id: string }) => user.id === first.user.id).erpRoles, [
      { installationId: f.id, roles: first.authentication.roles },
    ]);
    const deleteUrl = catalogUrl + '/' + f.id + '/' + id;
    assert.equal((await f.asCookie(first, 'DELETE', deleteUrl)).statusCode, 403);
    assert.equal((await f.req('DELETE', deleteUrl, f.admin)).statusCode, 200);
    assert.equal((await f.req('GET', catalogUrl, f.admin)).json().length, 1);
    assert.equal((await f.req('DELETE', deleteUrl, f.admin)).statusCode, 404);
    const roleDb = new DatabaseSync(f.store.file, { readOnly: true });
    try {
      const saved = roleDb.prepare("SELECT value FROM metadata WHERE key='sso'").get() as { value: string };
      assert.equal(JSON.parse(saved.value).roles.length, 1);
    } finally { roleDb.close(); }
    roles = [{ id, name: 'Руководитель' }];
    await f.login();
    assert.equal((await f.req('GET', catalogUrl, f.admin)).json().find((role: { installationId: string }) => role.installationId === f.id).name, 'Руководитель');
    assert.equal((await f.req('GET', '/api/users', f.admin)).json().find((user: { id: string }) => user.id === first.user.id).erpRoles[0].roles[0].name, 'Руководитель');

    await f.req('PATCH', '/api/users/' + first.user.id, f.admin, { roleId: 'employee' });
    roles = [];
    const empty = await f.login();
    assert.equal(empty.user.id, first.user.id);
    assert.equal(empty.user.roleId, 'employee');
    assert.deepEqual(empty.authentication.roles, []);
    assert.deepEqual((await f.req('GET', '/api/users', f.admin)).json().find((user: { id: string }) => user.id === first.user.id).erpRoles[0].roles, []);
    roles = undefined;
    const legacy = await f.login();
    assert.equal(legacy.user.id, first.user.id);
    assert.ok(!Object.hasOwn(legacy.authentication, 'roles'));

    for (const invalid of [null, [{ id: 'invalid', name: 'Роль' }], [{ id, name: ' ' }], [{ id, name: 'A\nB' }],
      [{ id, name: 'Роль' }, { id: id.toUpperCase(), name: 'Та же роль' }]]) {
      roles = invalid;
      const prep = await start(f.app);
      const credentials = f.store.state.security!.credentials.length;
      const rejected = await f.exchange(prep, f.ticket(prep));
      assert.equal(rejected.statusCode, 502);
      assert.ok(!cookies(rejected).some(cookie => cookie.startsWith('__Host-bridge_session=')));
      assert.equal(f.store.state.security!.credentials.length, credentials);
    }
  } finally { await f.app.close(); }
});

test('exchange rejects missing, foreign and expired preparation and untrusted request data', async () => {
  const f = await fixture();
  try {
    const a = await start(f.app, 'dark'), b = await start(f.app), value = f.ticket(a);
    const nativeNavigation = { origin: 'null', 'sec-fetch-site': 'none' };
    assert.equal((await f.exchange(a, value, { ...nativeNavigation, cookie: '' })).statusCode, 401);
    assert.equal((await f.exchange(a, value, { ...nativeNavigation, cookie: b.cookie })).statusCode, 401);
    for (const bad of [{ origin: 'null' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: 'https://wrong.example.test', 'sec-fetch-site': 'none' }, { host: 'wrong.example.test' }, { 'x-forwarded-proto': 'http' }]) {
      assert.equal((await f.exchange(a, value, bad)).statusCode, 403);
    }
    const spoof = await f.app.inject({ method: 'POST', url: exchangePath, remoteAddress: '192.0.2.20', headers: { ...headers, ...formType, cookie: a.cookie }, payload: form(a, f.id, value) });
    assert.equal(spoof.statusCode, 403);
    for (const suffix of ['&theme=dark', '&ticket=' + value, '&returnUrl=https://other.example.test']) {
      assert.equal((await f.req('POST', exchangePath, '', form(a, f.id, value) + suffix, { ...formType, cookie: a.cookie })).statusCode, 400);
    }
    assert.equal((await f.req('POST', exchangePath + '?ticket=hidden', '', form(a, f.id, value), { ...formType, cookie: a.cookie })).statusCode, 400);
    assert.equal((await f.req('POST', exchangePath, '', 'x'.repeat(4097), { ...formType, cookie: a.cookie })).statusCode, 413);
    assert.equal((await f.req('POST', exchangePath, '', { version: '1', installation_id: f.id, ticket: value, login_challenge: a.challenge }, { cookie: a.cookie })).statusCode, 415);
    const realNow = Date.now;
    try {
      const past = realNow() - 121_000;
      Date.now = () => past;
      const old = await start(f.app, 'dark');
      Date.now = realNow;
      const expired = await f.exchange(old, f.ticket(old));
      assert.equal(expired.statusCode, 401);
      assert.match(expired.body, /color-scheme:dark/);
    } finally { Date.now = realNow; }
    assert.equal(f.calls, 0);
    assert.equal((await f.exchange(a, value, nativeNavigation)).statusCode, 303);
    assert.equal((await f.exchange(a, f.ticket(a))).statusCode, 401);
  } finally { await f.app.close(); }
});

test('only one exchange wins per browser preparation and a claimed ticket stays used after restart', async () => {
  const f = await fixture(); let closed = false;
  try {
    const prep = await start(f.app), tickets = [f.ticket(prep), f.ticket(prep)];
    const results = await Promise.all(tickets.map(ticket => f.exchange(prep, ticket)));
    assert.deepEqual(results.map(r => r.statusCode).sort(), [303, 401]);
    assert.equal(f.calls, 1);
    const ticket = tickets[results.findIndex(response => response.statusCode === 303)];
    await f.app.close(); closed = true;
    const store = new Store(f.root), app = await createApp(makeWorkspace(store), f.options);
    try {
      const fresh = await start(app);
      const replay = await app.inject({ method: 'POST', url: exchangePath, headers: { ...headers, ...formType, cookie: fresh.cookie }, payload: form(fresh, f.id, ticket) });
      assert.equal(replay.statusCode, 401);
      assert.equal(f.calls, 1);
      const list = await app.inject({ url: installations, headers: { authorization: 'Bearer ' + f.admin } });
      assert.equal(list.json()[0].id, f.id);
    } finally { await app.close(); }
  } finally { if (!closed) await f.app.close(); }
});

test('an existing WebView session keeps only its own sealed ERP grant across an Agent Platform restart', async () => {
  const f = await fixture();
  let closed = false;
  try {
    assert.equal((await f.patch({ mcpUrl: 'https://erp.example.test/webapi/mcp' })).statusCode, 200);
    const grant = 'fkug1.' + random();
    const claims = identity(f.id, f.userId), roles = [{ id: randomUUID(), name: 'Снабжение' }];
    f.setValidator(async () => ({
      ...claims, user: { ...claims.user, roles }, delegation: { grant, expires_in: 3600, audiences: ['fastkore-mcp'] },
    }));
    const session = await f.login();
    f.setValidator(async () => identity(f.id, randomUUID()));
    const denied = await f.login();
    assert.equal((await f.asCookie(session, 'GET', '/api/status')).json().fastkoreToolsStatus, 'ready');
    await f.app.close(); closed = true;
    const store = new Store(f.root), app = await createApp(makeWorkspace(store), f.options);
    try {
      const status = (cookie: string) => app.inject({ url: '/api/status', headers: { ...headers, cookie } });
      const ready = await status(session.cookie), unavailable = await status(denied.cookie);
      assert.equal(ready.statusCode, 200);
      assert.equal(ready.json().fastkoreToolsStatus, 'ready');
      assert.equal(unavailable.json().fastkoreToolsStatus, 'unavailable');
      const authentication = (cookie: string) => app.inject({ url: '/api/auth/me', headers: { ...headers, cookie } });
      assert.deepEqual((await authentication(session.cookie)).json().authentication.roles, roles);
      assert.ok(!Object.hasOwn((await authentication(denied.cookie)).json().authentication, 'roles'));
      assert.equal(f.calls, 2, 'restored WebView session does not exchange another ticket');
      const saved = store.state.security!.credentials.find(c => c.userId === session.user.id)!;
      const other = store.state.security!.credentials.find(c => c.userId === denied.user.id)!;
      assert.ok(saved.erpDelegation);
      const sso = new FastkoreSso(store, f.options.ssoKey, origin);
      const revision = saved.erpDelegation.revision;
      assert.equal(sso.openDelegation(saved, revision)?.grant, grant);
      assert.equal(sso.openDelegation({ ...other, erpDelegation: saved.erpDelegation }, revision), undefined);
      assert.equal(sso.openDelegation(saved, randomUUID()), undefined);
      assert.ok(!(await readFile(store.file)).includes(Buffer.from(grant)));
      assert.doesNotMatch(ready.body, /fkug1\.|sealedGrant/);
    } finally { await app.close(); }
  } finally { if (!closed) await f.app.close(); }
});

test('a valid SSO grant exposes CLI tools without MCP and only with a trusted runner', async t => {
  const socket = process.env.BRIDGE_FASTKORE_CLI_SOCKET, tickets = process.env.BRIDGE_FASTKORE_CLI_TICKETS;
  t.after(() => {
    if (socket === undefined) delete process.env.BRIDGE_FASTKORE_CLI_SOCKET;
    else process.env.BRIDGE_FASTKORE_CLI_SOCKET = socket;
    if (tickets === undefined) delete process.env.BRIDGE_FASTKORE_CLI_TICKETS;
    else process.env.BRIDGE_FASTKORE_CLI_TICKETS = tickets;
  });
  process.env.BRIDGE_FASTKORE_CLI_SOCKET = 'test-runner';
  process.env.BRIDGE_FASTKORE_CLI_TICKETS = '1';
  let trusted = false;
  const check = t.mock.method(FastkoreCli.prototype, 'checkTrust', async () => {
    if (!trusted) throw new BridgeError('Адрес или CA исполнителя не совпадает.', 424);
    return { authority: 'erp.example.test', caFingerprint: 'test-fingerprint' };
  });
  t.mock.method(FastkoreCli.prototype, 'run', async () => ({ success: true, exitCode: 0, data: { text: 'private ERP content' } }));
  const f = await fixture();
  try {
    const grant = 'fkug1.' + random();
    f.setValidator(async () => ({
      ...identity(f.id, f.userId), delegation: { grant, expires_in: 3600, audiences: ['fastkore-mcp'] },
    }));
    const session = await f.login();
    const credential = f.store.state.security!.credentials.find(item => item.userId === session.user.id)!;
    const signal = new AbortController().signal;
    const run = { id: randomUUID(), chatId: randomUUID(), status: 'running' as const, createdAt: new Date().toISOString(), progress: '' };
    const prepare = () => f.workspace.prepareFastkoreTools!(credential.id, undefined, () => {}, signal, run);
    const blocked = await prepare();
    assert.match(blocked.problem!, /не совпадает/);
    assert.deepEqual(blocked.tools?.definitions.map(tool => tool.name), ['fastkore_cli_describe']);
    trusted = true;
    const ready = await prepare();
    assert.equal(ready.problem, undefined);
    assert.deepEqual(ready.tools?.definitions.map(tool => tool.name), [
      'fastkore_cli_describe', 'fastkore_cli_auth_info', 'fastkore_cli_data_get', 'fastkore_cli_data_query',
    ]);
    assert.equal(check.mock.callCount(), 2);
    const entitySetId = randomUUID(), entityId = randomUUID();
    assert.equal((await ready.tools!.call('fastkore_cli_data_get', { entitySetId, entityId, scope: 'erp' }, signal)).success, true);
    const entry = f.store.auditEvents().find(event => event.action === 'erp.cli.read')!;
    assert.equal(entry.actorId, session.user.id);
    assert.equal(entry.details?.sessionId, credential.id);
    assert.equal(entry.details?.installationId, f.id);
    assert.equal(entry.details?.runId, run.id);
    assert.equal(entry.details?.chatId, run.chatId);
    assert.equal(entry.details?.scope, 'erp');
    assert.deepEqual(entry.details?.objectIds, { entitysetid: entitySetId, entityid: entityId });
    assert.doesNotMatch(JSON.stringify(entry), /private ERP content|fkug1/);
    await f.asCookie(session, 'POST', '/api/auth/logout', {});
    await assert.rejects(prepare());
  } finally { await f.app.close(); }
});

test('ERP failures, mismatched claims and failed SQLite writes do not publish a session', async () => {
  const f = await fixture();
  try {
    const victim = await start(f.app), browser = await start(f.app);
    assert.equal((await f.exchange(browser, f.ticket(victim))).statusCode, 401);
    for (const change of [
      (r: ReturnType<typeof identity>) => { r.version = 2; },
      (r: ReturnType<typeof identity>) => { r.installation_id = randomUUID(); },
      (r: ReturnType<typeof identity>) => { r.audience = 'other'; },
      (r: ReturnType<typeof identity>) => { r.user.id = 'erp-1'; },
    ]) {
      const prep = await start(f.app), value = f.ticket(prep);
      change(f.responses.get(value)!.result);
      assert.equal((await f.exchange(prep, value)).statusCode, 401);
    }
    f.setValidator(async () => { throw Error('private ERP details'); });
    const pending = await start(f.app), ticket = f.ticket(pending);
    const uncertain = await f.exchange(pending, ticket);
    assert.equal(uncertain.statusCode, 502);
    assert.ok(!uncertain.body.includes('private ERP details'));
    assert.equal((await f.exchange(pending, ticket)).statusCode, 401);

    f.setValidator(async (_url, _key, payload) => identity(payload.installation_id, f.userId));
    const db = new DatabaseSync(f.store.file);
    try {
      db.exec("CREATE TRIGGER fail_sso BEFORE INSERT ON metadata WHEN NEW.key='security' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;");
      const users = f.store.state.security!.users.length, credentials = f.store.state.security!.credentials.length;
      const prep = await start(f.app), value = f.ticket(prep);
      const failed = await f.exchange(prep, value);
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.headers['set-cookie'], undefined);
      assert.equal(f.store.state.security!.users.length, users);
      assert.equal(f.store.state.security!.credentials.length, credentials);
      assert.deepEqual(f.store.state.externalIdentities ?? [], []);
      db.exec('DROP TRIGGER fail_sso');
      assert.equal((await f.exchange(await start(f.app), value)).statusCode, 401);
    } finally { db.close(); }
  } finally { await f.app.close(); }
});

test('cookie actions enforce CSRF, forbid local keys/password and revoke the old session on identity switch', async () => {
  const f = await fixture();
  try {
    const [one, two] = await Promise.all([f.login(), f.login()]);
    assert.equal(one.user.id, two.user.id);
    assert.equal((await f.req('GET', '/api/auth/me', f.admin, undefined, { cookie: one.cookie })).statusCode, 409);
    assert.equal((await f.req('GET', '/api/auth/me', one.cookie.split('=')[1])).statusCode, 401);
    assert.equal((await f.asCookie(one, 'POST', '/api/auth/keys', { name: 'ERP' })).statusCode, 404);
    assert.equal((await f.asCookie(one, 'POST', '/api/auth/password', { currentPassword: password, password: password + '-new' })).statusCode, 403);
    for (const extra of [{ origin: '' }, { origin: 'https://other.example.test' }, { 'x-csrf-token': '0'.repeat(64) }]) {
      assert.equal((await f.asCookie(one, 'POST', '/api/auth/logout', {}, extra)).statusCode, 403);
    }
    assert.equal((await f.req('POST', '/api/projects/missing/attachments', '', '--test--\r\n', { cookie: one.cookie, origin, 'content-type': 'multipart/form-data; boundary=test' })).statusCode, 403);
    const next = await f.login(randomUUID(), f.id, one.cookie);
    assert.notEqual(next.user.id, one.user.id);
    assert.equal((await f.asCookie(one, 'GET', '/api/projects')).statusCode, 401);
    assert.equal((await f.asCookie(two, 'GET', '/api/projects')).statusCode, 200);
    const logout = await f.asCookie(next, 'POST', '/api/auth/logout', {});
    assert.equal(logout.statusCode, 200);
    assert.match(cookies(logout)[0], /Max-Age=0/);
    assert.equal((await f.asCookie(next, 'GET', '/api/projects')).statusCode, 401);
    const credential = f.store.state.security!.credentials.find(c => c.userId === two.user.id && c.source === 'fastkore')!;
    credential.expiresAt = new Date(0).toISOString();
    assert.equal((await f.asCookie(two, 'GET', '/api/projects')).statusCode, 401);
  } finally { await f.app.close(); }
});

test('registration and rotation disclose keys once and revoke active and in-flight sessions', async () => {
  const f = await fixture();
  try {
    assert.match(f.issue.connectionKey, new RegExp('^fkap1\\.' + f.id + '\\.[A-Za-z0-9_-]{43}$'));
    assert.equal(f.issue.connectionKey.length, 86);
    const digest = createHash('sha256').update(f.issue.connectionKey, 'utf8').digest('hex');
    assert.equal(f.issue.erpKeyVerifier, 'fkap1.' + f.id + '.' + digest);
    assert.equal((await f.req('POST', installations, f.admin, { name: 'test', validateTicketUrl: 'http://erp.test/api/ai/validate-ticket' })).statusCode, 400);
    const second = await f.create('ERP B');
    const list = await f.req('GET', installations, f.admin);
    assert.equal(list.json().find((item: any) => item.id === second.installationId).enabled, false);
    assert.ok(!/secret|encryptedKey|connectionKey|erpKeyVerifier/.test(list.body));
    const url = validationUrl.replace('erp.', 'new.');
    assert.equal((await f.patch({ validateTicketUrl: url, confirmValidateTicketUrl: true })).statusCode, 409);
    const old = await f.login();
    const credentialId = f.store.state.security!.credentials.find(c => c.userId === old.user.id)!.id;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let usedKey = '';
    f.setValidator(async (_url, key, payload) => {
      usedKey = key; entered(); await gate;
      return identity(payload.installation_id, f.userId);
    });
    const prep = await start(f.app), pending = f.exchange(prep, f.ticket(prep));
    await waiting;
    try {
      const rotated = await f.req('POST', installations + '/' + f.id + '/rotate-key', f.admin, {});
      assert.equal(rotated.statusCode, 200);
      assert.equal(rotated.headers['cache-control'], 'no-store');
      assert.equal(rotated.json().installationId, f.id);
      assert.notEqual(rotated.json().connectionKey, f.issue.connectionKey);
      assert.equal(usedKey, f.issue.connectionKey);
      assert.equal((await f.asCookie(old, 'GET', '/api/projects')).statusCode, 401);
      assert.ok(!f.store.state.security!.credentials.some(c => c.id === credentialId));
      release();
      assert.equal((await pending).statusCode, 403);
      await f.login();
      assert.equal(usedKey, rotated.json().connectionKey);
    } finally { release(); }
    assert.equal((await f.patch({ enabled: false })).statusCode, 200);
    assert.equal((await f.patch({ validateTicketUrl: url })).statusCode, 409);
    assert.equal((await f.patch({ validateTicketUrl: url, confirmValidateTicketUrl: true })).json().validateTicketUrl, url);
  } finally { await f.app.close(); }
});

test('pairing enables a new registration only after ERP confirms it and replays safely', async () => {
  const calls: PairingInput[] = [];
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const f = await fixture(async (url, payload) => {
    assert.equal(url, 'https://erp.example.test/api/ai/pair');
    calls.push(payload);
    if (calls.length === 1) {
      entered();
      await gate;
      throw new BridgeError('No response', 502);
    }
    return { version: 1, paired: true, installation_id: payload.installation_id };
  });
  try {
    const created = await f.req('POST', installations, f.admin, { name: 'ERP Pair', validateTicketUrl: 'erp.example.test', setup: 'pairing' });
    assert.equal(created.statusCode, 201, created.body);
    const registration = created.json();
    assert.equal(registration.validateTicketUrl, validationUrl);
    assert.equal(registration.pairingStatus, 'unpaired');
    assert.equal(registration.enabled, false);
    assert.doesNotMatch(created.body, /connectionKey|erpKeyVerifier|fkap1\./);
    assert.equal((await f.patch({ enabled: true }, registration.id)).statusCode, 409);
    const route = `${installations}/${registration.id}/pair`, code = random();
    assert.equal((await f.req('POST', route, f.admin, { pairingCode: 'invalid' })).statusCode, 400);
    assert.equal((await f.req('POST', route, f.admin, { pairingCode: code, endpoint: validationUrl })).statusCode, 400);
    const request = f.req('POST', route, f.admin, { pairingCode: code });
    await started;
    try {
      assert.equal((await f.req('POST', route, f.admin, { pairingCode: code })).statusCode, 409);
      assert.equal((await f.patch({ name: 'changed' }, registration.id)).statusCode, 409);
      const pending = (await f.req('GET', installations, f.admin)).json().find((item: { id: string }) => item.id === registration.id);
      assert.equal(pending.enabled, false);
      assert.equal(pending.pairingStatus, 'pending');
    } finally { resume(); }
    const paired = await request;
    assert.equal(paired.statusCode, 200, paired.body);
    assert.equal(paired.headers['cache-control'], 'no-store');
    assert.equal(paired.json().enabled, true);
    assert.equal(paired.json().pairingStatus, 'paired');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0], { version: 1, pairing_code: code, platform_origin: origin,
      installation_id: registration.id, erp_key_verifier: calls[0].erp_key_verifier });
    assert.match(calls[0].erp_key_verifier, new RegExp('^fkap1\\.' + registration.id + '\\.[a-f0-9]{64}$'));
    for (const value of [paired.body, (await f.req('GET', installations, f.admin)).body, JSON.stringify(f.store.state)]) {
      assert.ok(!value.includes(code));
      assert.ok(!value.includes(calls[0].erp_key_verifier));
    }
    assert.deepEqual((await f.req('POST', route, f.admin, { pairingCode: code })).json(), paired.json());
    assert.equal((await f.req('POST', route + '/rotate-key', f.admin, { pairingCode: code })).statusCode, 409);
    assert.equal(calls.length, 2);
  } finally { resume(); await f.app.close(); }
});

test('rotation retains the old credential until confirmation and reuses the candidate after restart', async () => {
  const calls: PairingInput[] = [];
  let mode = 'ok';
  const f = await fixture(async (_url, payload) => {
    calls.push(payload);
    if (mode === 'lost') throw new BridgeError('No response', 502);
    return { version: 1, paired: true, installation_id: mode === 'mismatch' ? randomUUID() : payload.installation_id };
  });
  let app = f.app;
  const route = `${installations}/${f.id}/pair`, code = random();
  const post = (url: string, pairingCode: string) => app.inject({ method: 'POST', url, headers: { ...headers, authorization: 'Bearer ' + f.admin }, payload: { pairingCode } });
  const session = (cookie: string) => app.inject({ url: '/api/auth/me', headers: { ...headers, cookie } });
  try {
    const linked = await post(route, random());
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(calls[0].erp_key_verifier, f.issue.erpKeyVerifier);
    const { cookie } = await f.login();
    mode = 'lost';
    assert.equal((await post(route + '/rotate-key', code)).statusCode, 502);
    assert.equal((await session(cookie)).statusCode, 200);
    assert.notEqual(calls[1].erp_key_verifier, calls[0].erp_key_verifier);
    await app.close();
    app = await createApp(makeWorkspace(new Store(f.root)), f.options);
    mode = 'mismatch';
    assert.equal((await post(route + '/rotate-key', code)).statusCode, 502);
    assert.equal((await session(cookie)).statusCode, 200);
    mode = 'ok';
    const rotated = await post(route + '/rotate-key', code);
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal(rotated.json().pairingStatus, 'paired');
    assert.deepEqual(calls.slice(1), Array.from({ length: 4 }, () => calls[1]));
    assert.equal((await session(cookie)).statusCode, 401);
    assert.equal((await post(`${installations}/${f.id}/rotate-key`, code)).statusCode, 409);
    for (const publicOrigin of ['https://new.example.test', origin]) {
      await app.close();
      app = await createApp(makeWorkspace(new Store(f.root)), { ...f.options, publicOrigin });
      const list = await app.inject({ url: installations, headers: { authorization: 'Bearer ' + f.admin } });
      assert.equal(list.json()[0].enabled, false);
      assert.equal(list.json()[0].pairingStatus, 'unpaired');
    }
  } finally { await app.close(); }
});

test('only local administrators can manage installations, including when ERP is linked to an administrator', async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    assert.equal((await f.req('PUT', '/api/admin/fastkore/identities', f.admin, { installationId: f.id, externalUserId: f.userId, userId: f.adminId })).statusCode, 200);
    assert.equal((await f.asCookie(first, 'GET', '/api/auth/me')).statusCode, 401);
    const mapped = await f.login();
    assert.equal(mapped.user.id, f.adminId);
    assert.equal((await f.asCookie(mapped, 'GET', installations)).statusCode, 403);
    assert.equal((await f.asCookie(mapped, 'POST', installations + '/' + f.id + '/rotate-key', {})).statusCode, 403);
    assert.equal((await f.asCookie(mapped, 'POST', '/api/auth/keys', { name: 'test' })).statusCode, 404);
    assert.equal((await f.req('GET', installations, f.admin)).statusCode, 200);
  } finally { await f.app.close(); }
});

test('legacy API keys and local employee sessions are revoked before ERP is configured', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sso-migrate-'));
  const legacyStore = new Store(root), old = await createApp(makeWorkspace(legacyStore));
  const { admin, adminId } = await setup(old);
  const adminAuth = { authorization: 'Bearer ' + admin };
  const employeeId = randomUUID(), data = legacyStore.state.security!, now = new Date().toISOString();
  data.users.push({ id: employeeId, username: 'employee', name: 'Employee', role: 'employee', disabled: false,
    passwordHash: data.users.find(u => u.id === adminId)!.passwordHash, createdAt: now });
  const legacyCredentials = [
    { userId: employeeId, kind: 'session', token: 'ccb_s_' + randomBytes(32).toString('hex') },
    { userId: employeeId, kind: 'api', token: 'ccb_k_' + randomBytes(32).toString('hex') },
    { userId: adminId, kind: 'api', token: 'ccb_k_' + randomBytes(32).toString('hex') },
  ] as const;
  for (const { userId, kind, token } of legacyCredentials) data.credentials.push({ id: randomUUID(), userId, kind,
    hash: createHash('sha256').update(token).digest('hex'), name: 'Legacy', createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await legacyStore.save();
  await old.close();
  const store = new Store(root), app = await createApp(makeWorkspace(store));
  try {
    assert.equal((await app.inject({ url: '/api/auth/me', headers: adminAuth })).statusCode, 200);
    for (const { token } of legacyCredentials) assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer ' + token } })).statusCode, 401);
    assert.equal(store.state.security!.users.find(u => u.id === employeeId)!.passwordHash, '');
    assert.deepEqual(store.state.security!.credentials.map(c => [c.userId, c.kind]), [[adminId, 'session']]);
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      assert.equal((await app.inject({ method, url: method === 'DELETE' ? '/api/auth/keys/legacy' : '/api/auth/keys', headers: adminAuth })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/users', headers: adminAuth, payload: { name: 'New Employee', username: 'employee2', role: 'employee', password } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'employee', password } })).statusCode, 401);
    const localLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } });
    assert.equal(localLogin.statusCode, 200);
    const newPassword = 'updated-password-for-fastkore-test';
    const changed = await app.inject({ method: 'POST', url: '/api/auth/password', headers: adminAuth,
      payload: { currentPassword: password, password: newPassword } });
    assert.equal(changed.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer ' + localLogin.json().token } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer ' + changed.json().token } })).statusCode, 200);
  } finally { await app.close(); }
});

test('SSO opt-in requires trusted HTTPS and no agent execution, and theme messages are data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sso-config-'));
  const workspace = makeWorkspace(new Store(root)), ssoKey = randomBytes(32);
  await assert.rejects(createApp(workspace, { publicOrigin: origin, ssoKey, trustedProxies: [] }));
  delete process.env.BRIDGE_EXECUTION;
  try { await assert.rejects(createApp(workspace, { publicOrigin: origin, ssoKey, trustedProxies: ['127.0.0.1'] })); }
  finally { process.env.BRIDGE_EXECUTION = 'disabled'; }
  const app = await createApp(workspace);
  try {
    assert.equal((await app.inject({ url: '/auth/fastkore/start?theme=dark' })).statusCode, 503);
    assert.equal((await app.inject({ url: '/api/auth/browser-session' })).json().fastkoreEnabled, false);
  } finally { await app.close(); }
  assert.equal(parseHostTheme({ type: 'fastkore.ui', version: 1, theme: 'dark' }), 'dark');
  assert.equal(parseHostTheme({ type: 'fastkore.ui', version: 1, theme: 'system' }), null);
  assert.equal(parseHostTheme({ type: 'fastkore.ui', version: 2, theme: 'light' }), null);
  const key = 'fkap1.' + randomUUID() + '.' + random(), ticket = random(), challenge = random();
  const text = redact('key=' + key + ' ticket=' + ticket + '&login_challenge=' + challenge);
  for (const secret of [key, ticket, challenge]) assert.ok(!text.includes(secret));
});

test('HTTPS validation uses the exact contract and rejects untrusted TLS, redirects and invalid responses', async () => {
  const tls = testCertificate(), id = randomUUID(), key = 'fkap1.' + id + '.' + random();
  const payload = { installation_id: id, ticket: random(), login_challenge: random() };
  const claims = identity(id, randomUUID());
  const roles = Array.from({ length: 200 }, (_, index) => ({ id: randomUUID(), name: 'Менеджер по продажам и снабжению ' + (index + 1) }));
  const full = { ...claims, user: { ...claims.user, roles }, delegation: { grant: 'fkug1.' + 'a'.repeat(2048), expires_in: 3600, audiences: ['fastkore-mcp'] } };
  const escaped = JSON.stringify(full).replace(/[\u0080-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const size = Buffer.byteLength(escaped);
  assert.ok(size > 8 * 1024 && size < 64 * 1024);
  const atLimit = escaped + ' '.repeat(64 * 1024 - size);
  let mode = 'ok', calls = 0;
  const server = createServer(tls, async (req, res) => {
    calls++;
    assert.equal(req.url, '/api/ai/validate-ticket');
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    let body = ''; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { version: 1, ...payload, audience });
    if (mode === 'redirect') { res.writeHead(302, { location: '/other', 'content-type': 'application/json' }); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(mode === 'full' ? atLimit : mode === 'large' ? atLimit + ' ' : mode === 'bad' ? '{bad' : JSON.stringify({ valid: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'https://127.0.0.1:' + address.port + '/api/ai/validate-ticket';
  try {
    await assert.rejects(validateTicketHttps(url, key, payload));
    assert.equal(calls, 0);
    assert.deepEqual(await validateTicketHttps(url, key, payload, { ca: tls.cert }), { valid: true });
    mode = 'full';
    assert.deepEqual(await validateTicketHttps(url, key, payload, { ca: tls.cert }), full);
    for (mode of ['redirect', 'large', 'bad']) await assert.rejects(validateTicketHttps(url, key, payload, { ca: tls.cert }));
    assert.equal(calls, 5);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('ERP pairing validates TLS and does not forward the code on redirects', async () => {
  const tls = testCertificate(), id = randomUUID();
  const payload: PairingInput = { version: 1, pairing_code: random(), platform_origin: origin, installation_id: id,
    erp_key_verifier: `fkap1.${id}.${createHash('sha256').update(random()).digest('hex')}` };
  const success = { version: 1, paired: true, installation_id: id };
  const requests: { method?: string; url?: string; authorization?: string; body: string }[] = [];
  let status = 200, oversized = false;
  const server = createServer(tls, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(status, { location: '/other', 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify(success) + (oversized ? ' '.repeat(8 * 1024) : '') : JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `https://127.0.0.1:${address.port}/api/ai/pair`;
  try {
    await assert.rejects(pairErpHttps(url, payload), { statusCode: 502 });
    assert.equal(requests.length, 0);
    assert.deepEqual(await pairErpHttps(url, payload, { ca: tls.cert }), success);
    oversized = true;
    await assert.rejects(pairErpHttps(url, payload, { ca: tls.cert }), { statusCode: 502 });
    for (const [erpStatus, appStatus] of [[302, 502], [400, 400], [403, 403], [404, 424], [409, 409], [429, 429], [503, 503]]) {
      status = erpStatus;
      await assert.rejects(pairErpHttps(url, payload, { ca: tls.cert }), (error: BridgeError) => {
        assert.equal(error.statusCode, appStatus);
        assert.ok(!error.message.includes(payload.pairing_code));
        assert.ok(!error.message.includes(payload.erp_key_verifier));
        return true;
      });
    }
    assert.deepEqual(requests, Array.from({ length: 9 }, () => ({ method: 'POST', url: '/api/ai/pair', authorization: undefined, body: JSON.stringify(payload) })));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('public ERP TLS discovery requires confirmation and a rotated CA blocks pairing and ticket exchange', async () => {
  let tls = testCertificate();
  let pairRequests = 0, ticketRequests = 0;
  const externalId = randomUUID();
  const sockets = new Set<import('node:tls').TLSSocket>();
  const erp = createSecureServer({ ...tls, allowHTTP1: true });
  erp.on('secureConnection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  erp.on('request', async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.httpVersionMajor === 2) {
      assert.equal(req.url, '/fastkore.ServerInfo/GetTlsCertificates');
      assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(5));
      const pem = Buffer.from(tls.cert);
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(pem.length, 1);
      res.writeHead(200, { 'content-type': 'application/grpc' });
      res.addTrailers({ 'grpc-status': '0' });
      res.end(Buffer.concat([frame, pem]));
      return;
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ai/pair') {
      pairRequests++;
      res.end(JSON.stringify({ version: 1, paired: true, installation_id: payload.installation_id }));
    } else {
      assert.equal(req.url, '/api/ai/validate-ticket');
      ticketRequests++;
      assert.match(req.headers.authorization!, /^Bearer fkap1\./);
      res.end(JSON.stringify(identity(payload.installation_id, externalId)));
    }
  });
  await new Promise<void>(resolve => erp.listen(0, '127.0.0.1', resolve));
  const address = erp.address();
  assert.ok(address && typeof address !== 'string');
  const validateTicketUrl = `https://127.0.0.1:${address.port}/api/ai/validate-ticket`;
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-sso-tls-ca-'));
  const app = await createApp(makeWorkspace(new Store(root)), { publicOrigin: origin, trustedProxies: ['127.0.0.1'], ssoKey: randomBytes(32) });
  try {
    const { admin } = await setup(app);
    const req = (method: 'POST' | 'GET', url: string, payload?: unknown, token = admin) => app.inject({
      method, url, headers: { ...headers, ...(token && { authorization: 'Bearer ' + token }) }, ...(payload && { payload }),
    });
    const check = () => req('POST', '/api/admin/fastkore/tls/check', { validateTicketUrl });
    assert.equal((await req('POST', '/api/admin/fastkore/tls/check', { validateTicketUrl }, '')).statusCode, 401);
    const initial = await check();
    assert.equal(initial.statusCode, 200, initial.body);
    const fingerprint = new X509Certificate(tls.cert).fingerprint256;
    assert.equal(initial.json().fingerprint, fingerprint);
    assert.doesNotMatch(initial.body, /BEGIN CERTIFICATE|pem/);
    const registration = { name: 'ERP TLS', validateTicketUrl, setup: 'pairing' };
    assert.equal((await req('POST', installations, { ...registration, tlsFingerprint: '00:'.repeat(31) + '00' })).statusCode, 409);
    assert.deepEqual((await req('GET', installations)).json(), []);
    const created = await req('POST', installations, { ...registration, tlsFingerprint: fingerprint });
    assert.equal(created.statusCode, 201, created.body);
    const { id, tlsFingerprint } = created.json();
    assert.equal(tlsFingerprint, fingerprint);
    const pairRoute = installations + '/' + id + '/pair';
    const exchange = async () => {
      const prepared = await start(app);
      return app.inject({ method: 'POST', url: exchangePath, headers: { ...headers, ...formType, cookie: prepared.cookie },
        payload: form(prepared, id, random()) });
    };
    assert.equal((await req('POST', pairRoute, { pairingCode: random() })).statusCode, 200);
    assert.equal((await exchange()).statusCode, 303);
    assert.deepEqual([pairRequests, ticketRequests], [1, 1]);

    tls = testCertificate();
    erp.setSecureContext(tls);
    for (const socket of sockets) socket.destroy();
    const nextFingerprint = new X509Certificate(tls.cert).fingerprint256;
    const retryCode = random();
    const rejected = await req('POST', pairRoute, { pairingCode: retryCode });
    assert.equal(rejected.statusCode, 424, rejected.body);
    assert.equal((await exchange()).statusCode, 424);
    assert.deepEqual([pairRequests, ticketRequests], [1, 1]);
    assert.equal((await check()).json().fingerprint, nextFingerprint);
    const confirmRoute = installations + '/' + id + '/tls';
    assert.equal((await req('POST', confirmRoute, { fingerprint })).statusCode, 409);
    const confirmed = await req('POST', confirmRoute, { fingerprint: nextFingerprint });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().tlsFingerprint, nextFingerprint);
    assert.equal((await req('POST', pairRoute, { pairingCode: retryCode })).statusCode, 200);
    assert.equal(pairRequests, 2);
    assert.equal((await exchange()).statusCode, 303);
    assert.equal(ticketRequests, 2);
  } finally {
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => erp.close(() => resolve()));
  }
});
