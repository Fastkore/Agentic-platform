import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { BridgeError } from './store.js';
import { Access, publicUser, type Principal } from './access.js';
import { projectFilePath } from './documents.js';
import { maxUploadBytes } from './file-storage.js';
import { loadDictation, maxDictationBytes, validateDictation, type TranscribeDictation } from './dictation.js';
import type { DictationModelId } from '../shared/types.js';
import { fastkoreContextProblem, isFastkoreContextReset, parseFastkoreContext, type FastkoreContext } from '../shared/fastkore-context.js';
import { FastkoreMcp } from './fastkore-mcp.js';
import { FastkoreCli } from './fastkore-cli.js';
import { withFastkoreCliDescription, withFastkoreCliReads } from './codex-tools.js';
import type { AgentProfile, Dataset, FastkoreAuthentication, FastkoreInstallation, FastkoreKeyIssue, FileStorageProvider, ProjectAgentPolicy, ProjectAgentSettings, Settings, User, WorkRole } from '../shared/types.js';
import { agentToolIds } from '../shared/agent-tools.js';
import { operationIds } from './corporate.js';
import { FastkoreSso, loadSsoKey, cookieToken, csrfFor, validCsrf, setSessionCookie, setStartCookie, startCookie, normalizeTheme, uuid, type InstallationPatch, type PairingClient, type Theme, type TicketValidator } from './fastkore.js';

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
const agentToolList = { type: 'array', items: { enum: agentToolIds }, maxItems: agentToolIds.length, uniqueItems: true };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
export interface AppOptions { clientRoot?: string; port?: number; lan?: boolean; publicOrigin?: string; trustedProxies?: string[]; ssoKey?: Buffer; ticketValidator?: TicketValidator; pairingClient?: PairingClient; transcribeDictation?: TranscribeDictation }
const ssoStart = '/auth/fastkore/start', ssoExchange = '/auth/fastkore/exchange';
function ssoPage(theme: Theme, challenge?: string) {
  const message = challenge ? 'Вход через Fastkore' : 'Откройте помощника из ERP заново.';
  const bootstrap = challenge ? '<meta name="fastkore-login-challenge" content="' + challenge + '"><script defer src="/auth/fastkore/challenge.js"></script>' : '';
  const colors = theme === 'dark' ? 'background:#171717;color:#ededed' : 'background:#fff;color:#202124';
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Вход Fastkore</title>'
    + '<style>:root{color-scheme:' + theme + ';' + colors + ';font:16px system-ui}body{margin:2rem}</style>' + bootstrap + '<body><p role="status">' + message + '</p></body></html>';
}
export async function createApp(workspace: Workspace, options: AppOptions = {}) {
  const port = options.port ?? 8787, lan = options.lan ?? false;
  const dictation = options.transcribeDictation ? undefined : await loadDictation();
  const transcribeDictation = options.transcribeDictation ?? dictation?.transcribe;
  const dictationEnabled = () => !!transcribeDictation && workspace.store.state.settings.dictationEnabled !== false;
  const activeDictations = new Set<string>();
  const publicOrigin = options.publicOrigin ?? process.env.BRIDGE_PUBLIC_ORIGIN;
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('BRIDGE_PUBLIC_ORIGIN должен содержать HTTPS origin без пути и завершающего слеша.');
  const trustedProxies = options.trustedProxies ?? (process.env.BRIDGE_TRUST_PROXY ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (trustedProxies.some(v => ['true', '*', '0.0.0.0/0', '::/0'].includes(v))) throw new Error('Укажите конкретные доверенные адреса reverse proxy.');
  const ssoKey = options.ssoKey ?? await loadSsoKey(process.env.BRIDGE_SSO_KEY_FILE);
  if (!ssoKey && process.env.BRIDGE_SSO_CONFIG) throw new Error('Обновите конфигурацию Fastkore до ТЗ 1.1 и задайте BRIDGE_SSO_KEY_FILE.');
  if (ssoKey && (!publicOrigin || !trustedProxies.length || (!workspace.isolatedCodex && process.env.BRIDGE_EXECUTION !== 'disabled'))) throw new Error('Fastkore SSO требует HTTPS origin, доверенный proxy и изолированный исполнитель либо отключённое выполнение.');
  const access = new Access(workspace), sso = ssoKey && new FastkoreSso(workspace.store, ssoKey, publicOrigin!, options.ticketValidator, options.pairingClient);
  const fastkoreMcp = sso ? new FastkoreMcp(sso, id => access.forgetErpDelegation(id)) : undefined;
  const cliSocket = process.env.BRIDGE_FASTKORE_CLI_SOCKET;
  const fastkoreCli = cliSocket ? new FastkoreCli(cliSocket) : undefined;
  access.onSessionsRemoved = sessions => {
    for (const session of sessions) void fastkoreMcp?.revoke(session).catch(() => {});
  };
  workspace.prepareFastkoreTools = async (credentialId, context, authorize, signal) => {
    if (!fastkoreMcp) return {};
    const current = () => {
      authorize();
      return access.authenticateCredential(credentialId).credential;
    };
    const credential = current();
    const integration = await fastkoreMcp.prepare(credential, context, authorize, signal);
    if (!fastkoreCli || !sso || credential.source !== 'fastkore') return integration;
    const tools = withFastkoreCliDescription(integration.tools ?? {
      definitions: [], call: async () => ({ success: false, text: 'Инструмент Fastkore недоступен.' }),
    }, (command, callSignal) => fastkoreCli.describe(command, callSignal), authorize);
    const active = current();
    const stored = active.erpDelegation;
    const cliReady = process.env.BRIDGE_FASTKORE_CLI_TICKETS === '1' && !active.erpDelegationRevoked &&
      stored && stored.expiresAt > Date.now() && sso.delegationBinding(active)?.revision === stored.revision;
    if (!cliReady) return { ...integration, tools };
    const reads = withFastkoreCliReads(tools, context, async (input, callSignal) => {
      try {
        const result = await fastkoreCli.run(input, sso, current, id => fastkoreMcp.invalidate(id), callSignal);
        if (!result.success) return { success: false, text: `Fastkore CLI не выполнила чтение (код ${result.exitCode}).` };
        const text = JSON.stringify(result.data);
        if (text.length > 96_000) return { success: false, text: 'Ответ Fastkore CLI слишком большой. Уменьшите выборку.' };
        return { success: true, text };
      } catch (error) {
        return { success: false, text: error instanceof BridgeError ? error.message : 'Fastkore CLI не выполнила чтение.' };
      }
    });
    return { tools: reads, problem: reads.definitions.length > tools.definitions.length ? undefined : integration.problem };
  };
  if (sso) {
    if (!workspace.isolatedCodex) workspace.lockCliForSso();
    workspace.corporate.ensureSsoPendingRole();
    sso.reconcileOrigin();
    access.data.credentials = access.data.credentials.filter(c => c.source !== 'fastkore' || sso.credentialValid(c));
    for (const u of access.data.users) if (u.roleId === '') u.roleId = 'sso_pending';
  }
  access.externalCredentialValid = c => !!sso?.credentialValid(c);
  await workspace.store.save();
  const principals = new WeakMap<FastifyRequest, Principal>();
  const principal = (r: FastifyRequest) => {
    const p = principals.get(r); if (!p) throw new BridgeError('Войдите под своей учётной записью.', 401);
    // Recheck after awaited operations because the account or session may have been revoked.
    return access.authenticateCredential(p.credential.id);
  };
  const user = (r: FastifyRequest) => principal(r).user;
  const admin = (r: FastifyRequest) => { const u = user(r); access.admin(u); return u; };
  const localAdmin = (r: FastifyRequest) => {
    const p = principal(r);
    if (p.credential.source === 'fastkore') throw new BridgeError('Требуется локальный вход руководителя.', 403);
    access.admin(p.user); return p.user;
  };
  const configuredSso = () => {
    if (!sso) throw new BridgeError('На сервере не настроен ключ шифрования Fastkore.', 503);
    return sso;
  };
  const attempts = new Map<string, { count: number; until: number }>(); let logins = 0;
  const starts = new Map<string, { count: number; until: number }>();
  const exchanges = new Map<string, { count: number; until: number }>();
  const rateLimit = (r: FastifyRequest, bucket = attempts) => {
    const now = Date.now(); for (const [ip, entry] of bucket) if (entry.until <= now) bucket.delete(ip);
    let entry = bucket.get(r.ip);
    if (!entry) { if (bucket.size >= 5000) throw new BridgeError('Попробуйте войти позже.', 429); entry = { count: 0, until: now + 10 * 60_000 }; bucket.set(r.ip, entry); }
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
    const route = request.url.split('?')[0];
    if (route === ssoStart || route === ssoExchange) {
      if (!sso) throw new BridgeError('Вход Fastkore ещё не настроен.', 503);
      if (route === ssoExchange && request.url.includes('?')) throw new BridgeError('Билет передаётся только в теле POST-запроса.');
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      // WebView2 sends an opaque origin on a native POST navigation. The exchange still checks the preparation cookie and challenge.
      const nativeExchange = route === ssoExchange && request.method === 'POST' && origin === 'null' && fetchSite === 'none';
      if ((origin !== undefined && origin !== publicOrigin && !nativeExchange)
        || (route === ssoExchange && fetchSite && !['none', 'same-origin'].includes(fetchSite as string))) {
        throw new BridgeError('Откройте помощника штатной кнопкой Fastkore.', 403);
      }
      secureRequest(request); rateLimit(request, route === ssoStart ? starts : exchanges); return;
    }
    if (!request.url.startsWith('/api/')) return;
    if (request.headers.origin && request.headers.origin !== (publicOrigin ?? `${request.protocol}://${request.headers.host}`)) throw new BridgeError('Запрос с другого сайта запрещён.', 403);
    if (route === '/api/health' || route === '/api/auth/browser-session') return;
    const authorization = request.headers.authorization ?? '', cookie = cookieToken(request.headers.cookie);
    if (cookie && authorization) throw new BridgeError('Обнаружены два способа входа. Используйте отдельное окно браузера.', 409);
    if (route === '/api/auth/login') {
      if (cookie) throw new BridgeError('Для локального входа используйте отдельное окно браузера.', 409);
      rateLimit(request); return;
    }
    if (route === '/api/local-login') {
      const host = request.headers.host ?? '';
      if (cookie || !loopback(request.ip) || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || request.headers['x-bridge-local'] !== '1') throw new BridgeError('Первичная настройка доступна только на серверном компьютере.', 403);
      rateLimit(request); return;
    }
    if (cookie) {
      secureRequest(request);
      const p = access.authenticate(cookie);
      if (p.credential.source !== 'fastkore') throw new BridgeError('Недействительная сессия Fastkore.', 401);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (request.headers.origin !== publicOrigin || !validCsrf(cookie, request.headers['x-csrf-token']))) throw new BridgeError('Не удалось подтвердить запрос страницы. Перезагрузите её.', 403);
      principals.set(request, p);
    } else {
      if (!authorization.startsWith('Bearer ') || authorization.length > 200) throw new BridgeError('Войдите под своей учётной записью.', 401);
      const p = access.authenticate(authorization.slice(7));
      if (p.credential.source === 'fastkore') throw new BridgeError('Для сеанса Fastkore требуется cookie.', 401);
      principals.set(request, p);
    }
    if (access.setupRequired && !['/api/auth/me', '/api/auth/setup', '/api/auth/logout'].includes(route)) throw new BridgeError('Сначала задайте логин и пароль руководителя.', 403);
  });
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; validation?: unknown };
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const message = err.validation ? 'Некорректные поля запроса.' : code >= 500 && !(error instanceof BridgeError) ? 'Внутренняя ошибка сервера. Проверьте папку данных и настройки.' : err.message;
    const route = request.url.split('?')[0];
    if (code === 401 && route.startsWith('/api/') && request.headers.cookie?.includes('__Host-bridge_session=')) reply.header('Set-Cookie', setSessionCookie('', 0));
    if (route === ssoStart || route === ssoExchange) {
      if (process.env.NODE_ENV === 'production') {
        const origin = request.headers.origin;
        const fetchSite = request.headers['sec-fetch-site'];
        const originKind = origin === undefined ? 'missing' : origin === publicOrigin ? 'platform' : origin === 'null' ? 'opaque' : 'other';
        console.warn(JSON.stringify({
          event: 'fastkore.sso.rejected', route, status: code,
          reason: err.validation ? 'invalid_form' : error instanceof BridgeError ? error.message : 'request_error',
          origin: originKind, fetchSite: typeof fetchSite === 'string' && ['same-origin', 'same-site', 'cross-site', 'none'].includes(fetchSite) ? fetchSite : undefined,
          hasPreparationCookie: request.headers.cookie?.includes(startCookie + '=') ?? false,
        }));
      }
      let theme = normalizeTheme(new URLSearchParams(request.url.split('?')[1]).get('theme'));
      if (route === ssoExchange) {
        try { theme = sso?.attemptTheme(cookieToken(request.headers.cookie, startCookie)) ?? 'light'; }
        catch { theme = 'light'; }
      }
      reply.code(code).type('text/html; charset=utf-8').send(ssoPage(theme));
    } else reply.code(code).send({ error: message });
  });
  app.get<{ Querystring: { theme?: string } }>(ssoStart, { exposeHeadRoute: false }, (request, reply) => {
    // A malformed or duplicate preparation cookie can be replaced with a fresh attempt.
    let previous = '';
    try { previous = cookieToken(request.headers.cookie, startCookie); } catch { /* start over */ }
    const theme = normalizeTheme(request.query.theme);
    const { cookie, challenge } = configuredSso().start(theme, previous);
    return reply.header('Set-Cookie', setStartCookie(cookie)).type('text/html; charset=utf-8').send(ssoPage(theme, challenge));
  });
  app.get('/auth/fastkore/challenge.js', (_request, reply) => reply.type('text/javascript; charset=utf-8').send(
    "const challenge = document.querySelector('meta[name=fastkore-login-challenge]');\n"
    + "if (challenge) { window.chrome?.webview?.postMessage({ type: 'fastkore.sso.challenge', version: 1, login_challenge: challenge.content }); challenge.remove(); }\n"
  ));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_r, body, done) => {
    const fields = new URLSearchParams(body as string), result: Record<string, string> = {};
    for (const [key, value] of fields) {
      if (!['version', 'installation_id', 'ticket', 'login_challenge'].includes(key) || Object.hasOwn(result, key)) { done(new BridgeError('Некорректные поля входа Fastkore.')); return; }
      result[key] = value;
    }
    done(null, result);
  });
  app.post<{ Body: { version: string; installation_id: string; ticket: string; login_challenge: string } }>(ssoExchange, { bodyLimit: 4096,
    schema: { body: object({ version: { type: 'string', const: '1' }, installation_id: string(36), ticket: string(43), login_challenge: string(43) }, ['version', 'installation_id', 'ticket', 'login_challenge']) },
  }, async (request, reply) => {
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError('Вход Fastkore принимает POST формы.', 415);
    if (request.headers.authorization) throw new BridgeError('Вход по билету выполняется отдельно от API-ключа.', 400);
    logins++;
    try {
      const { installation_id, ticket, login_challenge } = request.body;
      const previous = cookieToken(request.headers.cookie);
      const sso = configuredSso();
      const { identity, theme, recheck } = await sso.exchange({ installation_id, ticket, login_challenge }, cookieToken(request.headers.cookie, startCookie));
      const issued = await access.fastkoreLogin(identity, previous, recheck, (credential, delegation) => sso.sealDelegation(credential, delegation));
      const maxAge = Math.max(0, Math.floor((Date.parse(issued.expiresAt!) - Date.now()) / 1000));
      return reply.header('Set-Cookie', [setStartCookie('', 0), setSessionCookie(issued.token, maxAge)]).code(303).header('Location', '/?embedded=fastkore&theme=' + theme).send();
    } finally { logins--; }
  });
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1 } });
  app.get('/api/health', async () => ({ name: 'Codex Chat Bridge', version: '0.6.0', ok: true }));
  const authDetails = (p: Principal, token: string): FastkoreAuthentication => ({
    source: 'fastkore', installationId: p.credential.installationId!, externalUserId: p.credential.externalUserId!,
    expiresAt: p.credential.expiresAt!, csrfToken: csrfFor(token), canChangePassword: false,
  });
  app.get('/api/auth/browser-session', async request => {
    const token = cookieToken(request.headers.cookie);
    if (!token) return { authenticated: false, fastkoreEnabled: !!sso };
    if (request.headers.authorization) throw new BridgeError('Обнаружены два способа входа.', 409);
    secureRequest(request); const p = access.authenticate(token);
    if (p.credential.source !== 'fastkore') throw new BridgeError('Недействительная сессия Fastkore.', 401);
    return { authenticated: true, user: publicUser(p.user), setupRequired: false, authentication: authDetails(p, token) };
  });
  app.post('/api/local-login', async () => access.bootstrap());
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', { schema: { body: object({ username: string(48), password: { type: 'string', maxLength: 200 } }, ['username', 'password']) } }, async request => {
    logins++; try { return await access.login(request.body.username, request.body.password); } finally { logins--; }
  });
  app.get('/api/auth/me', async request => {
    const p = principal(request), source = p.credential.source ?? 'local';
    return {
      user: publicUser(p.user), setupRequired: access.setupRequired, source,
      ...(source === 'fastkore' ? { authentication: authDetails(p, cookieToken(request.headers.cookie)) } : {}),
    };
  });
  app.post<{ Body: { username: string; name: string; password: string } }>('/api/auth/setup', { schema: { body: object({ username: string(48), name: string(100), password }, ['username', 'name', 'password']) } }, async request => access.setup(user(request), request.body.username, request.body.name, request.body.password));
  app.post('/api/auth/logout', async (request, reply) => { const p = principal(request); const result = await access.logout(p); if (p.credential.source === 'fastkore') reply.header('Set-Cookie', setSessionCookie('', 0)); return result; });
  app.post<{ Body: { currentPassword: string; password: string } }>('/api/auth/password', { schema: { body: object({ currentPassword: string(200), password }, ['currentPassword', 'password']) } }, async request => access.changePassword(principal(request), request.body.currentPassword, request.body.password));
  app.get('/api/users', async request => access.users(user(request)));
  app.get<{ Params: { userId: string } }>('/api/users/:userId/projects', async request => access.userProjects(user(request), request.params.userId));
  app.patch<{ Params: { userId: string }; Body: { projectIds: string[] } }>('/api/users/:userId/projects', {
    schema: { body: object({ projectIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: string(100) } }, ['projectIds']) },
  }, async request => access.setUserProjects(() => user(request), request.params.userId, request.body.projectIds));
  app.post<{ Body: { username: string; name: string; password: string; role: User['role']; roleId?: string } }>('/api/users', { schema: { body: object({ username: string(48), name: string(100), password, role: { enum: ['admin', 'employee'] }, roleId: identifier }, ['username', 'name', 'password', 'role']) } }, async (request, reply) => reply.code(201).send(await access.createUser(localAdmin(request), request.body)));
  app.patch<{ Params: { userId: string }; Body: { disabled?: boolean; password?: string; name?: string; roleId?: string; role?: User['role'] } }>('/api/users/:userId', { schema: { body: object({ disabled: { type: 'boolean' }, password, name: string(100), roleId: identifier, role: { enum: ['admin', 'employee'] } }) } }, async request => access.updateUser(user(request), request.params.userId, request.body));
  app.get('/api/audit', async request => { admin(request); return access.data.audit; });
  app.get('/api/admin/fastkore/installations', async request => { localAdmin(request); return sso?.list() ?? []; });
  app.get('/api/admin/fastkore/cli-pilot', async request => {
    localAdmin(request); secureRequest(request);
    if (!fastkoreCli) throw new BridgeError('Исполнитель Fastkore CLI не настроен.', 503);
    return fastkoreCli.describe();
  });
  const tlsFingerprint = { type: 'string', pattern: '^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){31}$' };
  app.post<{ Body: { validateTicketUrl: string } }>('/api/admin/fastkore/tls/check', {
    schema: { body: object({ validateTicketUrl: string(2048) }, ['validateTicketUrl']) },
  }, async request => {
    localAdmin(request);
    secureRequest(request);
    return configuredSso().inspectTls(request.body.validateTicketUrl);
  });
  app.post<{ Params: { id: string }; Body: { fingerprint: string } }>('/api/admin/fastkore/installations/:id/tls', {
    schema: { body: object({ fingerprint: tlsFingerprint }, ['fingerprint']) },
  }, async request => {
    localAdmin(request);
    secureRequest(request);
    return configuredSso().confirmInstallationTls(access, () => localAdmin(request), request.params.id, request.body.fingerprint);
  });
  app.post<{ Body: { name: string; validateTicketUrl: string; setup?: 'pairing' | 'manual'; tlsFingerprint?: string } }>('/api/admin/fastkore/installations', {
    schema: { body: object({ name: string(100), validateTicketUrl: string(2048), setup: { type: 'string', enum: ['pairing', 'manual'] }, tlsFingerprint }, ['name', 'validateTicketUrl']) },
  }, async (request, reply) => {
    localAdmin(request);
    secureRequest(request);
    const service = configuredSso();
    const { name, validateTicketUrl, setup, tlsFingerprint } = request.body;
    if (tlsFingerprint && setup !== 'pairing') throw new BridgeError('Подтверждение CA доступно при привязке по коду.');
    const trust = tlsFingerprint && await service.confirmTls(validateTicketUrl, tlsFingerprint);
    const result = await access.changeInstallation<FastkoreInstallation | FastkoreKeyIssue>(() => localAdmin(request), 'sso.installation.create', items =>
      setup === 'pairing' ? service.registerForPairing(items, name, validateTicketUrl, trust || undefined) : service.create(items, name, validateTicketUrl));
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string }; Body: InstallationPatch }>('/api/admin/fastkore/installations/:id', {
    schema: { body: { ...object({ name: string(100), validateTicketUrl: string(2048), enabled: { type: 'boolean' }, confirmValidateTicketUrl: { type: 'boolean' }, mcpUrl: string(2048) }), minProperties: 1 } },
  }, async request => {
    localAdmin(request);
    const service = configuredSso();
    return access.changeInstallation(() => localAdmin(request), 'sso.installation.update', items => service.update(items, request.params.id, request.body));
  });
  app.post<{ Params: { id: string } }>('/api/admin/fastkore/installations/:id/rotate-key', async request => {
    localAdmin(request);
    secureRequest(request);
    const service = configuredSso();
    return access.changeInstallation(() => localAdmin(request), 'sso.installation.rotate', items => service.rotate(items, request.params.id));
  });
  for (const [suffix, rotate] of [['/pair', false], ['/pair/rotate-key', true]] as const) {
    app.post<{ Params: { id: string }; Body: { pairingCode: string } }>('/api/admin/fastkore/installations/:id' + suffix, {
      bodyLimit: 4096,
      schema: { body: object({ pairingCode: { type: 'string', pattern: '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' } }, ['pairingCode']) },
    }, async request => {
      localAdmin(request);
      secureRequest(request);
      return configuredSso().pair(access, () => localAdmin(request), request.params.id, request.body.pairingCode, rotate);
    });
  }
  app.get('/api/admin/fastkore/identities', async request => { localAdmin(request); return workspace.store.state.externalIdentities ?? []; });
  app.put<{ Body: { installationId: string; externalUserId: string; userId: string } }>('/api/admin/fastkore/identities', { schema: { body: object({ installationId: string(36), externalUserId: string(36), userId: string(100) }, ['installationId', 'externalUserId', 'userId']) } }, async request => {
    localAdmin(request);
    const b = request.body;
    if (!uuid(b.externalUserId) || !sso?.exists(b.installationId)) throw new BridgeError('Неизвестная установка или некорректный ID пользователя.');
    return access.linkExternal(() => localAdmin(request), b.installationId, b.externalUserId, b.userId);
  });
  app.get('/api/agents', async request => workspace.corporate.list(user(request)));
  app.get('/api/admin/roles', async request => { admin(request); return workspace.corporate.data.roles; });
  app.get('/api/admin/profiles', async request => { admin(request); return workspace.corporate.data.profiles.map(p => ({ ...p, unavailableReason: workspace.corporate.unavailable(p) })); });
  app.get('/api/admin/datasets', async request => { admin(request); return workspace.corporate.data.datasets; });
  app.get('/api/admin/operations', async request => { admin(request); return operationIds; });
  const revision = { type: 'integer', minimum: 1, maximum: 2147483647 };
  app.put<{ Params: { id: string }; Body: Omit<WorkRole, 'id' | 'revision'> & { revision?: number } }>('/api/admin/roles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), enabled: { type: 'boolean' }, profileIds: identifiers, operationIds: identifiers, readDatasetIds: identifiers, instructions: { type: 'string', maxLength: 20000 }, revision }, ['name', 'enabled', 'profileIds', 'operationIds', 'readDatasetIds', 'instructions']) } }, async request => workspace.corporate.saveRole(admin(request), { ...request.body, id: request.params.id }));
  app.put<{ Params: { id: string }; Body: Omit<AgentProfile, 'id' | 'revision'> & { revision?: number } }>('/api/admin/profiles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), description: { type: 'string', maxLength: 1000 }, instructions: { type: 'string', maxLength: 20000 }, enabled: { type: 'boolean' }, model: modelSchema, reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] }, operationIds: identifiers, datasetIds: identifiers, skillIds: identifiers, allowWrite: { type: 'boolean' }, outputMode: { enum: ['chat', 'restricted'] }, revision, toolIds: agentToolList }, ['name', 'description', 'instructions', 'enabled', 'model', 'reasoningEffort', 'operationIds', 'datasetIds', 'skillIds', 'allowWrite', 'outputMode']) } }, async request => workspace.corporate.saveProfile(admin(request), { ...request.body, id: request.params.id }));
  app.put<{ Params: { id: string }; Body: Omit<Dataset, 'id' | 'revision'> & { revision?: number } }>('/api/admin/datasets/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), directory: string(2000), projectIds: identifiers, classification: { enum: ['shared', 'restricted'] }, revision }, ['name', 'directory', 'projectIds', 'classification']) } }, async request => workspace.corporate.saveDataset(admin(request), { ...request.body, id: request.params.id }));
  const canCreateProject = (u: User) => u.role === 'admin' || workspace.corporate.role(u)?.operationIds.includes('chat') === true;
  app.get('/api/status', async request => {
    const cli = await workspace.codexConnection();
    const { user: u, credential } = principal(request);
    const settings = workspace.store.state.settings;
    let activeRun = workspace.activeRun;
    if (activeRun) { try { access.run(u, activeRun.id); } catch { activeRun = null; } }
    const queuedRuns = workspace.queuedRuns.filter(r => { try { access.run(u, r.id); return true; } catch { return false; } });
    return { version: '0.6.0', activeRun, queuedRuns, busy: workspace.busy, user: publicUser(u), setupRequired: access.setupRequired, canCreateProject: canCreateProject(u),
      cli: u.role === 'admin' ? cli : cli && { ...cli, path: '', status: '' },
      isolatedCodex: workspace.isolatedCodex, workerFilesAvailable: workspace.workerFilesAvailable, codexLimitsRevision: workspace.codexLimitsRevision,
      settings: { ...settings, cliPath: u.role === 'admin' ? settings.cliPath : '',
        agentInstructions: u.role === 'admin' && credential.source !== 'fastkore' ? settings.agentInstructions : undefined },
      addresses: publicOrigin ? [publicOrigin] : addresses(port, lan), port, lan, executionDisabled: workspace.executionDisabled,
      dictationAvailable: !!transcribeDictation, dictationEnabled: dictationEnabled(),
      fastkoreToolsStatus: credential.source === 'fastkore' ? fastkoreMcp?.status(credential) : undefined,
      storageWarning: u.role === 'admin' ? workspace.store.warning : undefined,
      fileStorage: u.role === 'admin' && credential.source === 'local' ? workspace.fileStorageStatus : undefined };
  });
  app.get('/api/dictation/models', async request => {
    admin(request);
    return dictation ? dictation.models() : null;
  });
  app.post<{ Params: { id: DictationModelId; action: 'download' | 'select' } }>('/api/dictation/models/:id/:action', {
    schema: { params: object({ id: { enum: ['turbo', 'quality'] }, action: { enum: ['download', 'select'] } }, ['id', 'action']) },
  }, async request => {
    admin(request);
    if (!dictation) throw new BridgeError('Сервис распознавания речи не настроен.', 503);
    return dictation.models(request.params);
  });
  app.post<{ Querystring: { projectId?: string; chatId?: string; agentProfileId?: string } }>('/api/dictation', {
    schema: { querystring: object({ projectId: string(100), chatId: string(100), agentProfileId: identifier }) },
  }, async request => {
    const { projectId, chatId, agentProfileId } = request.query;
    const authorize = () => {
      const actor = user(request);
      if (chatId && !projectId) throw new BridgeError('Укажите проект диалога.');
      const project = projectId ? access.project(actor, projectId) : undefined;
      if (!project && !canCreateProject(actor)) throw new BridgeError('Рабочая роль не разрешает работу с чатом.', 403);
      const chat = chatId && projectId ? access.editChat(actor, projectId, chatId) : undefined;
      workspace.corporate.profile(actor, chat ? chat.agentProfileId : agentProfileId, project);
      return actor.id;
    };
    const actorId = authorize();
    if (!transcribeDictation || !dictationEnabled()) throw new BridgeError('Диктовка выключена на сервере.', 503);
    if (activeDictations.has(actorId) || activeDictations.size >= 2) throw new BridgeError('Распознавание занято. Попробуйте чуть позже.', 429);
    activeDictations.add(actorId);
    try {
      const file = await request.file({ limits: { fileSize: maxDictationBytes + 1 } });
      if (file?.mimetype !== 'audio/wav') throw new BridgeError('Ожидается запись с микрофона.');
      const audio = await file.toBuffer();
      validateDictation(audio);
      authorize();
      if (!dictationEnabled()) throw new BridgeError('Диктовка выключена на сервере.', 503);
      const text = await transcribeDictation(audio);
      authorize();
      if (!dictationEnabled()) throw new BridgeError('Диктовка выключена на сервере.', 503);
      return { text };
    } finally {
      activeDictations.delete(actorId);
    }
  });
  app.get('/api/models', async () => workspace.models());
  app.post('/api/models/refresh', async () => workspace.models(true));
  app.get('/api/codex/limits', async () => ({ limits: await workspace.limits() }));
  app.post('/api/cli/check', async request => { admin(request); return workspace.isolatedCodex ? workspace.codexConnection(true) : workspace.inspect(); });
  app.post('/api/subscription/check', async (request, reply) => { admin(request); const run = await workspace.subscription(); return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run); });
  app.patch<{ Body: Partial<Settings> }>('/api/settings', { schema: { body: object({ cliPath: { type: 'string', maxLength: 2000 }, allowWrite: { type: 'boolean' }, includePreviews: { type: 'boolean' }, model: modelSchema, dictationEnabled: { type: 'boolean' }, agentInstructions: string(8000) }) } }, async request => {
    admin(request);
    if (request.body.agentInstructions !== undefined) localAdmin(request);
    if (workspace.isolatedCodex && request.body.allowWrite !== undefined) localAdmin(request);
    if (request.body.dictationEnabled && !transcribeDictation) throw new BridgeError('Сервис распознавания речи не настроен.', 409);
    const settings = await workspace.settings(request.body);
    return principal(request).credential.source === 'fastkore' ? { ...settings, agentInstructions: undefined } : settings;
  });
  app.patch<{ Body: { provider: FileStorageProvider } }>('/api/settings/file-storage', {
    schema: { body: object({ provider: { enum: ['local', 's3'] } }, ['provider']) },
  }, request => workspace.changeFileStorage(request.body.provider, () => { localAdmin(request); }));
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
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/agents', async request => {
    const actor = user(request);
    return workspace.corporate.list(actor, access.project(actor, request.params.projectId));
  });
  const projectAgentSettings = '/api/projects/:projectId/agent-settings';
  app.get<{ Params: { projectId: string } }>(projectAgentSettings, async (request): Promise<ProjectAgentSettings> => {
    localAdmin(request);
    const project = workspace.project(request.params.projectId);
    const files = workspace.projectFiles(project);
    const fileIds = new Set(files.map(file => file.id));
    const policy = project.agentPolicy ?? workspace.corporate.defaultProjectPolicy(true);
    return {
      policy: { ...policy, connections: policy.connections.map(connection => ({
        ...connection, fileIds: connection.fileIds?.filter(id => fileIds.has(id)) ?? null,
      })) },
      files,
      isolated: workspace.isolatedCodex,
      profiles: workspace.corporate.data.profiles.map(profile => ({
        id: profile.id, name: profile.name, description: profile.description, toolIds: workspace.corporate.tools(profile),
        unavailableReason: profile.enabled ? workspace.corporate.unavailable(profile) : 'Агент выключен в каталоге.',
      })),
    };
  });
  app.put<{ Params: { projectId: string }; Body: ProjectAgentPolicy }>(projectAgentSettings, {
    schema: { body: object({
      revision: { ...revision, minimum: 0 },
      connections: { type: 'array', maxItems: 100, items: object({
        profileId: identifier, toolIds: agentToolList,
        fileIds: { anyOf: [{ type: 'null' }, { ...identifiers, maxItems: 1000 }] },
      }, ['profileId', 'toolIds', 'fileIds']) },
    }, ['revision', 'connections']) },
  }, async request => {
    const authorize = () => localAdmin(request);
    authorize();
    return workspace.corporate.saveProjectPolicy(workspace.project(request.params.projectId), request.body, authorize);
  });
  const projectFilesPath = '/api/projects/:projectId/files';
  app.get<{ Params: { projectId: string } }>(projectFilesPath, async request => {
    localAdmin(request);
    return workspace.projectFiles(workspace.project(request.params.projectId));
  });
  app.post<{ Params: { projectId: string } }>(projectFilesPath, async (request, reply) => {
    const authorize = () => localAdmin(request).id;
    authorize();
    workspace.project(request.params.projectId);
    const file = await request.file();
    if (!file) throw new BridgeError('Выберите файл для загрузки.');
    const buffer = await file.toBuffer();
    return reply.code(201).send(await workspace.addProjectFile(request.params.projectId, file.filename, buffer, authorize));
  });
  app.get<{ Params: { projectId: string; fileId: string } }>(projectFilesPath + '/:fileId', async (request, reply) => {
    localAdmin(request);
    const project = workspace.project(request.params.projectId);
    const file = workspace.projectFile(project, request.params.fileId);
    const contents = file.storage === 's3' ? await workspace.files.read(project, file) : undefined;
    const target = contents ? undefined : await projectFilePath(project, file);
    localAdmin(request);
    workspace.projectFile(project, file.id);
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    return reply.type('application/octet-stream').header('Content-Disposition', "attachment; filename*=UTF-8''" + name)
      .send(target ? createReadStream(target) : contents);
  });
  app.delete<{ Params: { projectId: string; fileId: string } }>(projectFilesPath + '/:fileId', request =>
    workspace.deleteProjectFile(request.params.projectId, request.params.fileId, () => { localAdmin(request); }));
  app.patch<{ Params: { projectId: string }; Body: { memberIds: string[] } }>('/api/projects/:projectId/members', { schema: { body: object({ memberIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: string(100) } }, ['memberIds']) } }, async request => access.members(user(request), request.params.projectId, request.body.memberIds));
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/chats', async request => {
    const u = user(request); return access.project(u, request.params.projectId).chats.filter(c => access.canChat(u, c)).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length, ownerId: c.ownerId, ownerName: access.viewChat(c).ownerName, visibility: c.visibility }));
  });
  app.post<{ Params: { projectId: string }; Body: { title?: string; model?: string; agentProfileId?: string } }>('/api/projects/:projectId/chats', { schema: { body: object({ title: string(120), model: modelSchema, agentProfileId: identifier }) } }, async (request, reply) => {
    const check = () => access.project(user(request), request.params.projectId); check();
    const c = await workspace.addChat(request.params.projectId, request.body.title, request.body.model, user(request).id, check, request.body.agentProfileId); return reply.code(201).send(access.viewChat(c));
  });
  type ChatParams = { projectId: string; chatId: string };
  const chatPath = '/api/projects/:projectId/chats/:chatId';
  app.get<{ Params: ChatParams }>(chatPath, async request => access.viewChat(access.chat(user(request), request.params.projectId, request.params.chatId)));
  app.get<{ Params: ChatParams & { messageId: string; fileId: string } }>(chatPath + '/messages/:messageId/files/:fileId', async (request, reply) => {
    const { projectId, chatId, messageId, fileId } = request.params;
    const findFile = () => {
      const chat = access.chat(user(request), projectId, chatId);
      const file = chat.messages.find(message => message.id === messageId && message.role === 'assistant' && message.status === 'complete')
        ?.attachments.find(item => item.id === fileId);
      if (!file) throw new BridgeError('Файл результата не найден.', 404);
      return file;
    };
    const file = findFile();
    const contents = await workspace.files.read(workspace.project(projectId), file);
    findFile();
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    return reply.type('application/octet-stream').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', "attachment; filename*=UTF-8''" + name).send(contents);
  });
  app.patch<{ Params: ChatParams; Body: { model: string } }>(chatPath, { schema: { body: object({ model: modelSchema }, ['model']) } }, async request => {
    const check = () => access.editChat(user(request), request.params.projectId, request.params.chatId); check();
    return access.viewChat(await workspace.changeChatModel(request.params.projectId, request.params.chatId, request.body.model, check));
  });
  app.patch<{ Params: ChatParams; Body: { visibility: 'private' | 'project' } }>(chatPath + '/visibility', { schema: { body: object({ visibility: { enum: ['private', 'project'] } }, ['visibility']) } }, async request => access.visibility(user(request), request.params.projectId, request.params.chatId, request.body.visibility));
  app.get<{ Params: ChatParams }>(chatPath + '/messages', async request => access.chat(user(request), request.params.projectId, request.params.chatId).messages);
  app.post<{ Params: ChatParams; Body: { text: string; attachmentIds?: string[]; clientRequestId?: string; model?: string; fastkoreContext?: unknown } }>(chatPath + '/messages', { schema: { body: object({ text: string(60_000), attachmentIds: { type: 'array', items: string(100), maxItems: 8, uniqueItems: true }, clientRequestId: string(100), model: modelSchema, fastkoreContext: { type: 'object' } }, ['text']) } }, async (request, reply) => {
    const check = () => {
      const u = user(request); access.editChat(u, request.params.projectId, request.params.chatId);
      const p = access.project(u, request.params.projectId);
      for (const id of request.body.attachmentIds ?? []) if (!p.attachments.some(a => a.id === id && !a.libraryUploadedAt && (u.role === 'admin' || a.ownerId === u.id))) throw new BridgeError('Вложение не найдено.', 404);
    }; check();
    const text = request.body.text.trim(); if (!text) throw new BridgeError('Напишите вопрос.');
    let snapshot: FastkoreContext | undefined;
    if (request.body.fastkoreContext !== undefined) {
      if (principal(request).credential.source !== 'fastkore') throw new BridgeError('Контекст ERP доступен в сеансе Fastkore.', 403);
      const project = workspace.project(request.params.projectId);
      const chat = workspace.chat(project.id, request.params.chatId);
      const profile = workspace.corporate.profile(user(request), chat.agentProfileId, project);
      if (workspace.corporate.tools(profile, project).includes('fastkore') && !isFastkoreContextReset(request.body.fastkoreContext)) {
        const parsed = parseFastkoreContext(request.body.fastkoreContext);
        if (!parsed) throw new BridgeError('Fastkore передал некорректный снимок. Откройте помощника из нужной карточки или списка.');
        const problem = fastkoreContextProblem(parsed);
        if (problem) throw new BridgeError(problem, 409);
        snapshot = parsed;
      }
    }
    const run = await workspace.send(request.params.projectId, request.params.chatId, text, request.body.attachmentIds ?? [], request.body.clientRequestId ? `${user(request).id}:${request.body.clientRequestId}` : undefined, request.body.model, check, { id: user(request).id, name: user(request).name, credentialId: principal(request).credential.id }, snapshot);
    return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run);
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/attachments', async (request, reply) => {
    const { projectId } = request.params;
    const authorize = () => {
      const actor = user(request);
      access.project(actor, projectId);
      return actor.id;
    };
    authorize();
    const file = await request.file(); if (!file) throw new BridgeError('Прикрепите один файл.');
    const buffer = await file.toBuffer();
    return reply.code(201).send(await workspace.addAttachment(projectId, file.filename, buffer, authorize));
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
