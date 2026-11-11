import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { BridgeError } from './store.js';
import { Access, publicUser, type Principal } from './access.js';
import { uploadAttachment } from './documents.js';
import type { AgentProfile, Dataset, Settings, User, WorkRole } from '../shared/types.js';
import { operationIds } from './corporate.js';
import { FastkoreSso, loadSsoConfig, cookieToken, csrfFor, validCsrf, setSessionCookie, stableId, type SsoConfig, type TicketValidator } from './fastkore.js';

export function addresses(port: number, lan: boolean) {
  const urls = [`http://127.0.0.1:${port}`];
  if (lan) {
    const ips: string[] = [];
    for (const net of Object.values(networkInterfaces())) for (const nic of net ?? [])
      if (nic.family === 'IPv4' && !nic.internal && !nic.address.startsWith('169.254.')) ips.push(nic.address);
    const score = (ip: string) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
    for (const ip of [...new Set(ips)].sort((a, b) => score(a) - score(b))) urls.push(`http://${ip}:${port}`);
  }
  return urls;
}
const string = (maxLength = 1000) => ({ type: 'string', minLength: 1, maxLength });
const password = { type: 'string', minLength: 12, maxLength: 200 };
const modelSchema = { type: 'string', maxLength: 128, pattern: '^$|^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$' };
const identifier = { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,63}$' };
const identifiers = { type: 'array', items: string(100), maxItems: 100, uniqueItems: true };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
export interface AppOptions { clientRoot?: string; port?: number; lan?: boolean; publicOrigin?: string; trustedProxies?: string[]; ssoConfig?: SsoConfig; ticketValidator?: TicketValidator }
export async function createApp(workspace: Workspace, options: AppOptions = {}) {
  const port = options.port ?? 8787, lan = options.lan ?? false;
  const publicOrigin = options.publicOrigin ?? process.env.BRIDGE_PUBLIC_ORIGIN;
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('BRIDGE_PUBLIC_ORIGIN должен содержать HTTPS origin без пути и завершающего слеша.');
  const trustedProxies = options.trustedProxies ?? (process.env.BRIDGE_TRUST_PROXY ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (trustedProxies.some(v => ['true', '*', '0.0.0.0/0', '::/0'].includes(v))) throw new Error('Укажите конкретные доверенные адреса reverse proxy.');
  const ssoConfig = options.ssoConfig ?? await loadSsoConfig(process.env.BRIDGE_SSO_CONFIG);
  if (ssoConfig && (!publicOrigin || !trustedProxies.length || process.env.BRIDGE_EXECUTION !== 'disabled')) throw new Error('Пилот SSO требует HTTPS origin, доверенный proxy и BRIDGE_EXECUTION=disabled до проверки изоляции.');
  const access = new Access(workspace), sso = ssoConfig && new FastkoreSso(workspace.store, ssoConfig, options.ticketValidator);
  access.externalCredentialValid = c => !!sso?.credentialValid(c);
  await workspace.store.save();
  const principals = new WeakMap<FastifyRequest, Principal>();
  const principal = (r: FastifyRequest) => {
    const p = principals.get(r); if (!p) throw new BridgeError('Войдите под своей учётной записью.', 401);
    // Recheck credential after awaited operations (account/key may have been revoked).
    return access.authenticateCredential(p.credential.id);
  };
  const user = (r: FastifyRequest) => principal(r).user;
  const admin = (r: FastifyRequest) => { const u = user(r); access.admin(u); return u; };
  const attempts = new Map<string, { count: number; until: number }>(); let logins = 0;
  const rateLimit = (r: FastifyRequest) => {
    const now = Date.now(); for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
    let entry = attempts.get(r.ip);
    if (!entry) { if (attempts.size >= 5000) throw new BridgeError('Попробуйте войти позже.', 429); entry = { count: 0, until: now + 10 * 60_000 }; attempts.set(r.ip, entry); }
    if (++entry.count > 10 || logins >= 8) throw new BridgeError('Слишком много попыток входа. Повторите через 10 минут.', 429);
  };
  const secureRequest = (r: FastifyRequest) => {
    if (!publicOrigin || r.protocol !== 'https' || r.headers.host !== new URL(publicOrigin).host) throw new BridgeError('Для входа Fastkore требуется настроенный HTTPS-адрес.', 403);
  };
  const app = Fastify({ logger: false, bodyLimit: 128_000, requestTimeout: 60_000, trustProxy: trustedProxies.length ? trustedProxies : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    if (request.url.split('?')[0] === '/auth/fastkore/exchange') {
      if (!sso) throw new BridgeError('Вход Fastkore ещё не настроен.', 503);
      if (request.url.includes('?')) throw new BridgeError('Билет передаётся только в теле POST-запроса.');
      if (request.headers.origin && !['null', publicOrigin].includes(request.headers.origin) || request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(request.headers['sec-fetch-site'] as string)) throw new BridgeError('Откройте помощника штатной кнопкой Fastkore.', 403);
      secureRequest(request); rateLimit(request); return;
    }
    if (!request.url.startsWith('/api/')) return;
    if (request.headers.origin && request.headers.origin !== (publicOrigin ?? `${request.protocol}://${request.headers.host}`)) throw new BridgeError('Запрос с другого сайта запрещён.', 403);
    const route = request.url.split('?')[0];
    if (route === '/api/health' || route === '/api/auth/browser-session') return;
    if (route === '/api/auth/login') { rateLimit(request); return; }
    if (route === '/api/local-login') {
      const host = request.headers.host ?? '';
      if (!loopback(request.ip) || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || request.headers['x-bridge-local'] !== '1') throw new BridgeError('Первичная настройка доступна только на серверном компьютере.', 403);
      rateLimit(request); return;
    }
    const authorization = request.headers.authorization ?? '', cookie = cookieToken(request.headers.cookie);
    if (cookie && authorization) throw new BridgeError('Обнаружены два способа входа. Перезагрузите страницу или используйте отдельный API-клиент.', 409);
    if (cookie) {
      secureRequest(request);
      const p = access.authenticate(cookie);
      if (p.credential.kind !== 'session' || p.credential.source !== 'fastkore') throw new BridgeError('Недействительная сессия Fastkore.', 401);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (request.headers.origin !== publicOrigin || !validCsrf(cookie, request.headers['x-bridge-csrf']))) throw new BridgeError('Не удалось подтвердить запрос страницы. Перезагрузите её.', 403);
      principals.set(request, p);
    } else {
      if (!authorization.startsWith('Bearer ') || authorization.length > 200) throw new BridgeError('Войдите под своей учётной записью.', 401);
      const p = access.authenticate(authorization.slice(7));
      if (p.credential.source === 'fastkore' && p.credential.kind === 'session') throw new BridgeError('Для сеанса Fastkore требуется cookie.', 401);
      principals.set(request, p);
    }
    if (access.setupRequired && !['/api/auth/me', '/api/auth/setup', '/api/auth/logout'].includes(route)) throw new BridgeError('Сначала задайте логин и пароль руководителя.', 403);
  });
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; validation?: unknown };
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const message = err.validation ? 'Некорректные поля запроса.' : code >= 500 && !(error instanceof BridgeError) ? 'Внутренняя ошибка сервера. Проверьте папку данных и настройки.' : err.message;
    if (code === 401 && request.headers.cookie?.includes('__Host-bridge_session=')) reply.header('Set-Cookie', setSessionCookie('', 0));
    if (request.url.split('?')[0] === '/auth/fastkore/exchange') {
      reply.code(code).type('text/html; charset=utf-8').send('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Вход Fastkore</title><body><h1>Не удалось войти из Fastkore</h1><p>Закройте это окно и откройте помощника из ERP заново. Если ошибка повторится, обратитесь к администратору.</p></body></html>');
    } else reply.code(code).send({ error: message });
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_r, body, done) => {
    const fields = new URLSearchParams(body as string), result: Record<string, string> = {};
    for (const [key, value] of fields) {
      if (!['installation_id', 'ticket'].includes(key) || Object.hasOwn(result, key)) { done(new BridgeError('Некорректные поля входа Fastkore.')); return; }
      result[key] = value;
    }
    done(null, result);
  });
  app.post<{ Body: { installation_id: string; ticket: string } }>('/auth/fastkore/exchange', { bodyLimit: 8192, schema: { body: object({ installation_id: string(128), ticket: string(512) }, ['installation_id', 'ticket']) } }, async (request, reply) => {
    if (!sso || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new BridgeError('Вход Fastkore принимает POST формы.', 415);
    if (request.headers.authorization) throw new BridgeError('Вход по билету выполняется отдельно от API-ключа.', 400);
    logins++;
    try {
      const identity = await sso.exchange(request.body.installation_id, request.body.ticket);
      const issued = await access.fastkoreLogin(identity, cookieToken(request.headers.cookie), () => sso.installation(identity.installationId));
      return reply.header('Set-Cookie', setSessionCookie(issued.token)).code(303).header('Location', '/').send();
    } finally { logins--; }
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.get('/api/health', async () => ({ name: 'Codex Chat Bridge', version: '0.6.0', ok: true }));
  app.get('/api/auth/browser-session', async request => {
    // Deliberately ignores Authorization so a new ERP identity wins over stale browser storage.
    const token = cookieToken(request.headers.cookie);
    if (!token) return { authenticated: false, fastkoreEnabled: !!sso };
    secureRequest(request); const p = access.authenticate(token);
    if (p.credential.source !== 'fastkore' || p.credential.kind !== 'session') throw new BridgeError('Недействительная сессия Fastkore.', 401);
    return { authenticated: true, user: publicUser(p.user), setupRequired: false, csrfToken: csrfFor(token), source: 'fastkore' };
  });
  app.post('/api/local-login', async () => access.bootstrap());
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', { schema: { body: object({ username: string(48), password: { type: 'string', maxLength: 200 } }, ['username', 'password']) } }, async request => {
    logins++; try { return await access.login(request.body.username, request.body.password); } finally { logins--; }
  });
  app.get('/api/auth/me', async request => ({ user: publicUser(user(request)), setupRequired: access.setupRequired, source: principal(request).credential.source ?? 'local' }));
  app.post<{ Body: { username: string; name: string; password: string } }>('/api/auth/setup', { schema: { body: object({ username: string(48), name: string(100), password }, ['username', 'name', 'password']) } }, async request => access.setup(user(request), request.body.username, request.body.name, request.body.password));
  app.post('/api/auth/logout', async (request, reply) => { const p = principal(request); const result = await access.logout(p); if (p.credential.source === 'fastkore') reply.header('Set-Cookie', setSessionCookie('', 0)); return result; });
  app.post<{ Body: { currentPassword: string; password: string } }>('/api/auth/password', { schema: { body: object({ currentPassword: string(200), password }, ['currentPassword', 'password']) } }, async request => access.changePassword(principal(request), request.body.currentPassword, request.body.password));
  app.get('/api/auth/keys', async request => access.keys(principal(request)));
  app.post<{ Body: { name: string } }>('/api/auth/keys', { schema: { body: object({ name: string(100) }, ['name']) } }, async (request, reply) => reply.code(201).send(await access.createKey(principal(request), request.body.name)));
  app.delete<{ Params: { keyId: string } }>('/api/auth/keys/:keyId', async request => access.revokeKey(principal(request), request.params.keyId));
  app.get('/api/users', async request => access.users(user(request)));
  app.post<{ Body: { username: string; name: string; password: string; role: User['role']; roleId?: string } }>('/api/users', { schema: { body: object({ username: string(48), name: string(100), password, role: { enum: ['admin', 'employee'] }, roleId: identifier }, ['username', 'name', 'password', 'role']) } }, async (request, reply) => reply.code(201).send(await access.createUser(user(request), request.body)));
  app.patch<{ Params: { userId: string }; Body: { disabled?: boolean; password?: string; name?: string; roleId?: string; role?: User['role'] } }>('/api/users/:userId', { schema: { body: object({ disabled: { type: 'boolean' }, password, name: string(100), roleId: identifier, role: { enum: ['admin', 'employee'] } }) } }, async request => access.updateUser(user(request), request.params.userId, request.body));
  app.get('/api/audit', async request => { admin(request); return access.data.audit; });
  app.get('/api/admin/fastkore/installations', async request => { admin(request); return sso?.list() ?? []; });
  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/admin/fastkore/installations/:id', { schema: { body: object({ enabled: { type: 'boolean' } }, ['enabled']) } }, async request => {
    const actor = admin(request); if (!sso?.config.installations.some(i => i.id === request.params.id && i.enabled)) throw new BridgeError('Установка не настроена на сервере.', 404);
    return access.setInstallationEnabled(actor, request.params.id, request.body.enabled);
  });
  app.get('/api/admin/fastkore/identities', async request => { admin(request); return workspace.store.state.externalIdentities ?? []; });
  app.put<{ Body: { installationId: string; externalUserId: string; userId: string } }>('/api/admin/fastkore/identities', { schema: { body: object({ installationId: string(128), externalUserId: string(128), userId: string(100) }, ['installationId', 'externalUserId', 'userId']) } }, async request => {
    const actor = admin(request), b = request.body;
    if (!stableId(b.externalUserId) || !sso?.config.installations.some(i => i.id === b.installationId)) throw new BridgeError('Неизвестная установка или некорректный ID пользователя.');
    return access.linkExternal(actor, b.installationId, b.externalUserId, b.userId);
  });
  const erpContextSchema = object({ entityType: string(64), entityId: string(128) }, ['entityType', 'entityId']);
  app.post<{ Body: { entityType: string; entityId: string; suggestedAgent?: string } }>('/api/fastkore/context/validate', { schema: { body: object({ entityType: string(64), entityId: string(128), suggestedAgent: identifier }, ['entityType', 'entityId']) } }, async request => {
    if (!sso || !cookieToken(request.headers.cookie)) throw new BridgeError('Войдите из Fastkore.', 403);
    const context = sso.context(principal(request).credential, request.body);
    const suggested = workspace.corporate.list(user(request)).find(a => a.id === request.body.suggestedAgent && a.available);
    return { context, suggestedAgent: suggested?.id, suggestionUnavailable: !!request.body.suggestedAgent && !suggested };
  });
  app.get('/api/agents', async request => workspace.corporate.list(user(request)));
  app.get('/api/admin/roles', async request => { admin(request); return workspace.corporate.data.roles; });
  app.get('/api/admin/profiles', async request => { admin(request); return workspace.corporate.data.profiles.map(p => ({ ...p, unavailableReason: workspace.corporate.unavailable(p) })); });
  app.get('/api/admin/datasets', async request => { admin(request); return workspace.corporate.data.datasets; });
  app.get('/api/admin/operations', async request => { admin(request); return operationIds; });
  const revision = { type: 'integer', minimum: 1, maximum: 2147483647 };
  app.put<{ Params: { id: string }; Body: Omit<WorkRole, 'id' | 'revision'> & { revision?: number } }>('/api/admin/roles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), enabled: { type: 'boolean' }, profileIds: identifiers, operationIds: identifiers, readDatasetIds: identifiers, instructions: { type: 'string', maxLength: 20000 }, revision }, ['name', 'enabled', 'profileIds', 'operationIds', 'readDatasetIds', 'instructions']) } }, async request => workspace.corporate.saveRole(admin(request), { ...request.body, id: request.params.id }));
  app.put<{ Params: { id: string }; Body: Omit<AgentProfile, 'id' | 'revision'> & { revision?: number } }>('/api/admin/profiles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), description: { type: 'string', maxLength: 1000 }, instructions: { type: 'string', maxLength: 20000 }, enabled: { type: 'boolean' }, model: modelSchema, reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] }, operationIds: identifiers, datasetIds: identifiers, skillIds: identifiers, allowWrite: { type: 'boolean' }, outputMode: { enum: ['chat', 'restricted'] }, revision }, ['name', 'description', 'instructions', 'enabled', 'model', 'reasoningEffort', 'operationIds', 'datasetIds', 'skillIds', 'allowWrite', 'outputMode']) } }, async request => workspace.corporate.saveProfile(admin(request), { ...request.body, id: request.params.id }));
  app.put<{ Params: { id: string }; Body: Omit<Dataset, 'id' | 'revision'> & { revision?: number } }>('/api/admin/datasets/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), directory: string(2000), projectIds: identifiers, classification: { enum: ['shared', 'restricted'] }, revision }, ['name', 'directory', 'projectIds', 'classification']) } }, async request => workspace.corporate.saveDataset(admin(request), { ...request.body, id: request.params.id }));
  const canCreateProject = (u: User) => u.role === 'admin' || workspace.corporate.role(u)?.operationIds.includes('chat') === true;
  app.get('/api/status', async request => {
    const u = user(request); let activeRun = workspace.activeRun;
    if (activeRun) { try { access.run(u, activeRun.id); } catch { activeRun = null; } }
    const queuedRuns = workspace.queuedRuns.filter(r => { try { access.run(u, r.id); return true; } catch { return false; } });
    return { version: '0.6.0', activeRun, queuedRuns, busy: workspace.busy, user: publicUser(u), setupRequired: access.setupRequired, canCreateProject: canCreateProject(u),
      cli: u.role === 'admin' ? workspace.cli : workspace.cli && { ...workspace.cli, path: '', status: '' },
      settings: u.role === 'admin' ? workspace.store.state.settings : { ...workspace.store.state.settings, cliPath: '' },
      addresses: publicOrigin ? [publicOrigin] : addresses(port, lan), port, lan, executionDisabled: process.env.BRIDGE_EXECUTION === 'disabled', storageWarning: u.role === 'admin' ? workspace.store.warning : undefined };
  });
  app.get('/api/models', async () => workspace.models());
  app.post('/api/models/refresh', async () => workspace.models(true));
  app.get('/api/codex/limits', async () => ({ limits: await workspace.limits() }));
  app.post('/api/cli/check', async request => { admin(request); return workspace.inspect(); });
  app.post('/api/subscription/check', async (request, reply) => { admin(request); const run = await workspace.subscription(); return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run); });
  app.patch<{ Body: Partial<Settings> }>('/api/settings', { schema: { body: object({ cliPath: { type: 'string', maxLength: 2000 }, allowWrite: { type: 'boolean' }, includePreviews: { type: 'boolean' }, model: modelSchema }) } }, async request => { admin(request); return workspace.settings(request.body); });
  app.get('/api/diagnostics', async request => { admin(request); return { text: (await readFile(path.join(workspace.store.root, 'diagnostics.log'), 'utf8').catch(() => '')).slice(-12_000) }; });
  app.get('/api/projects', async request => {
    const u = user(request); return workspace.store.state.projects.filter(p => u.role === 'admin' || p.memberIds?.includes(u.id)).map(p => ({ id: p.id, name: p.name, directory: p.directory, chatCount: p.chats.filter(c => access.canChat(u, c)).length }));
  });
  app.post('/api/migrations/desktop', async request => { admin(request); const result = await workspace.importDesktop(); access.migrate(); await workspace.store.save(); return result; });
  app.post<{ Body: { directory?: string; name?: string } }>('/api/projects', { schema: { body: object({ directory: string(2000), name: string(100) }) } }, async (request, reply) => {
    const { directory, name } = request.body;
    if (directory !== undefined) admin(request);
    const project = directory === undefined
      ? await workspace.createProject(name ?? '', () => {
        const u = user(request);
        if (!canCreateProject(u)) throw new BridgeError('Рабочая роль не позволяет создавать проекты.', 403);
        return u.id;
      })
      : await workspace.addProject(directory, name);
    if (directory !== undefined) { access.migrate(); await workspace.store.save(); }
    return reply.code(201).send({ id: project.id, name: project.name, directory: project.directory, chatCount: project.chats.length });
  });
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/members', async request => { admin(request); return { memberIds: workspace.project(request.params.projectId).memberIds ?? [] }; });
  app.patch<{ Params: { projectId: string }; Body: { memberIds: string[] } }>('/api/projects/:projectId/members', { schema: { body: object({ memberIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: string(100) } }, ['memberIds']) } }, async request => access.members(user(request), request.params.projectId, request.body.memberIds));
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/chats', async request => {
    const u = user(request); return access.project(u, request.params.projectId).chats.filter(c => access.canChat(u, c)).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, ownerId: c.ownerId, ownerName: access.viewChat(c).ownerName, visibility: c.visibility }));
  });
  app.post<{ Params: { projectId: string }; Body: { title?: string; model?: string; agentProfileId?: string; erpContext?: { entityType: string; entityId: string } } }>('/api/projects/:projectId/chats', { schema: { body: object({ title: string(120), model: modelSchema, agentProfileId: identifier, erpContext: erpContextSchema }) } }, async (request, reply) => {
    const check = () => access.project(user(request), request.params.projectId); check();
    const context = request.body.erpContext && sso?.context(principal(request).credential, request.body.erpContext);
    if (request.body.erpContext && (!context || !cookieToken(request.headers.cookie))) throw new BridgeError('Контекст объекта требует входа из Fastkore.', 403);
    const recheck = () => { check(); if (context) sso!.context(principal(request).credential, context); };
    const c = await workspace.addChat(request.params.projectId, request.body.title, request.body.model, user(request).id, recheck, request.body.agentProfileId, context); return reply.code(201).send(access.viewChat(c));
  });
  type ChatParams = { projectId: string; chatId: string };
  const chatPath = '/api/projects/:projectId/chats/:chatId';
  app.get<{ Params: ChatParams }>(chatPath, async request => access.viewChat(access.chat(user(request), request.params.projectId, request.params.chatId)));
  app.patch<{ Params: ChatParams; Body: { model: string } }>(chatPath, { schema: { body: object({ model: modelSchema }, ['model']) } }, async request => {
    const check = () => access.editChat(user(request), request.params.projectId, request.params.chatId); check();
    return access.viewChat(await workspace.changeChatModel(request.params.projectId, request.params.chatId, request.body.model, check));
  });
  app.patch<{ Params: ChatParams; Body: { visibility: 'private' | 'project' } }>(chatPath + '/visibility', { schema: { body: object({ visibility: { enum: ['private', 'project'] } }, ['visibility']) } }, async request => access.visibility(user(request), request.params.projectId, request.params.chatId, request.body.visibility));
  app.get<{ Params: ChatParams }>(chatPath + '/messages', async request => access.chat(user(request), request.params.projectId, request.params.chatId).messages);
  app.post<{ Params: ChatParams; Body: { text: string; attachmentIds?: string[]; clientRequestId?: string; model?: string } }>(chatPath + '/messages', { schema: { body: object({ text: string(60_000), attachmentIds: { type: 'array', items: string(100), maxItems: 8, uniqueItems: true }, clientRequestId: string(100), model: modelSchema }, ['text']) } }, async (request, reply) => {
    const check = () => {
      const u = user(request); access.editChat(u, request.params.projectId, request.params.chatId);
      const p = access.project(u, request.params.projectId);
      for (const id of request.body.attachmentIds ?? []) if (!p.attachments.some(a => a.id === id && (u.role === 'admin' || a.ownerId === u.id))) throw new BridgeError('Вложение не найдено.', 404);
    }; check();
    const text = request.body.text.trim(); if (!text) throw new BridgeError('Напишите вопрос.');
    const run = await workspace.send(request.params.projectId, request.params.chatId, text, request.body.attachmentIds ?? [], request.body.clientRequestId ? `${user(request).id}:${request.body.clientRequestId}` : undefined, request.body.model, check, { id: user(request).id, name: user(request).name, credentialId: principal(request).credential.id });
    return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run);
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/attachments', async (request, reply) => {
    const p = access.project(user(request), request.params.projectId);
    const file = await request.file(); if (!file) throw new BridgeError('Прикрепите один файл.');
    const buffer = await file.toBuffer(); access.project(user(request), p.id);
    const attachment = await uploadAttachment(p.directory, file.filename, buffer); attachment.ownerId = user(request).id;
    p.attachments.push(attachment); await workspace.store.save(); return reply.code(201).send(attachment);
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async request => access.run(user(request), request.params.runId));
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async request => {
    const u = user(request), run = access.run(u, request.params.runId);
    if (run.projectId && run.chatId) access.editChat(u, run.projectId, run.chatId); return workspace.cancel(run.id);
  });
  if (options.clientRoot) await app.register(fastifyStatic, { root: path.resolve(options.clientRoot), prefix: '/', index: ['index.html'], wildcard: false });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Адрес не найден.' }));
  app.addHook('onClose', async () => { await workspace.shutdown(); });
  workspace.start(job => { if (job.credentialId) access.authenticateCredential(job.credentialId); });
  return app;
}
