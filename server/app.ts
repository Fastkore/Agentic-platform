import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { BridgeError } from './store.js';
import { Access, publicUser, type Principal } from './access.js';
import { maxUploadBytes } from './file-storage.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { libraryRoutes } from './library/routes.js';
import { editPersonalInstructions } from './personal-instructions.js';
import { instructionTile, personalInstructionLimits as personalLimits, type PersonalInstructionsEdit } from '../shared/personal-instructions.js';
import { instructionComponent } from './instruction-context.js';
import { UploadAdmission } from './upload-admission.js';
import { loadDictation, maxDictationBytes, validateDictation, type TranscribeDictation } from './dictation.js';
import { maxProjectInstructions, interfaceScales, specialistFileLimits, specialistIcons, unassignedChatsLabel } from '../shared/types.js';
import type { DictationModelId, FastkoreConnectionCheck, InterfaceScale } from '../shared/types.js';
import { fastkoreChatTitle, fastkoreExecutionContext, parseFastkoreContext } from '../shared/fastkore-context.js';
import { canReadChatAttachment, chatFileEntries } from '../shared/chat-attachments.js';
import { chatBinding, fastkoreChatSessionMatches, matchesFastkoreChat, migrateFastkoreChatBindings, parentFastkoreChatBindings } from './fastkore-chat.js';
import { FastkoreMcp } from './fastkore-mcp.js';
import { FastkoreCli, type FastkoreCliTiming } from './fastkore-cli.js';
import { elapsedMs } from './run-timing.js';
import { RemoteCodexRunner } from './codex-remote.js';
import { executionProviders, gigaChatScopes, type ExecutionProvider, type GigaChatScope } from '../shared/execution-accounts.js';
import { canAccessProject, canRenameProject, creationRoles, projectRoleOptions, erpRoleCatalog, restoreErpRoles, erpRolePermissions, erpCredentialPermissions, erpFileWriteAllowed, internetCredentialPermissions, isErpReadOnly, erpReadOnlyMessage, fastkoreReadCommands } from './erp-roles.js';
import { withInternetTools } from './internet-tools.js';
import { withFastkoreCliDescription } from './codex-tools.js';
import { formatFastkoreCliResult, withFastkoreCliCommands } from './fastkore-cli-tools.js';
import { executionConcurrencySchema } from './execution-concurrency.js';
import type { AgentProfile, Credential, Dataset, FastkoreAuthentication, FastkoreInstallation, FastkoreKeyIssue, FastkoreRolePermissions, FileStorageProvider, ProjectAgentPolicy, ProjectAgentSettings, Settings, User, WorkRole } from '../shared/types.js';
import type { AuditEvent, ProjectRolePolicy, ProjectRoleSettings, RelatedChatSummary, Run, UnassignedChatSummary, UserRecord } from '../shared/types.js';
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
// 'project-files' is a retired tool (replaced by the project library); accepted in saved settings and ignored.
const agentToolList = { type: 'array', items: { enum: [...agentToolIds, 'project-files'] }, maxItems: agentToolIds.length + 1, uniqueItems: true };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const erpAuditFields = new Set(['id', 'guid', 'entityid', 'entitysetid', 'orderid', 'projectid', 'taskid', 'purchaseorderid',
  'customerid', 'supplierid', 'contactid', 'contractorid', 'nomenclatureid', 'equipmentid', 'folderid', 'catalogid',
  'ownerentityid', 'ownerentitysetid', 'treeparentid', 'linkid', 'communicationentryid']);
function erpAuditIds(parameters: Record<string, unknown>) {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    const field = key.replaceAll('_', '').toLowerCase();
    if (erpAuditFields.has(field) && typeof value === 'string' && uuid(value.toLowerCase())) ids[field] = value.toLowerCase();
  }
  return ids;
}
export interface AppOptions { clientRoot?: string; port?: number; lan?: boolean; publicOrigin?: string; trustedProxies?: string[]; ssoKey?: Buffer; ticketValidator?: TicketValidator; pairingClient?: PairingClient; transcribeDictation?: TranscribeDictation }
const ssoStart = '/auth/fastkore/start', ssoExchange = '/auth/fastkore/exchange';
const ssoBrowser = '/auth/fastkore/browser';
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
  const uploads = new UploadAdmission();
  const publicOrigin = options.publicOrigin ?? process.env.BRIDGE_PUBLIC_ORIGIN;
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('BRIDGE_PUBLIC_ORIGIN должен содержать HTTPS origin без пути и завершающего слеша.');
  const trustedProxies = options.trustedProxies ?? (process.env.BRIDGE_TRUST_PROXY ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (trustedProxies.some(v => ['true', '*', '0.0.0.0/0', '::/0'].includes(v))) throw new Error('Укажите конкретные доверенные адреса reverse proxy.');
  const ssoKey = options.ssoKey ?? await loadSsoKey(process.env.BRIDGE_SSO_KEY_FILE);
  if (!ssoKey && process.env.BRIDGE_SSO_CONFIG) throw new Error('Обновите конфигурацию Fastkore до ТЗ 1.1 и задайте BRIDGE_SSO_KEY_FILE.');
  if (ssoKey && (!publicOrigin || !trustedProxies.length || (!workspace.isolatedCodex && process.env.BRIDGE_EXECUTION !== 'disabled'))) throw new Error('Fastkore SSO требует HTTPS origin, доверенный proxy и изолированный исполнитель либо отключённое выполнение.');
  const access = new Access(workspace), sso = ssoKey && new FastkoreSso(workspace.store, ssoKey, publicOrigin!, options.ticketValidator, options.pairingClient);
  const fastkoreMcp = sso ? new FastkoreMcp(sso, (id, reason) => access.forgetErpDelegation(id, reason)) : undefined;
  const cliSocket = process.env.BRIDGE_FASTKORE_CLI_SOCKET;
  const fastkoreCli = cliSocket ? new FastkoreCli(cliSocket) : undefined;
  function cliConfigurationProblem(binding?: { cliEnabled?: boolean }) {
    if (binding?.cliEnabled === false) return 'CLI отключён для этой установки. Администратор может включить его в настройках подключения Fastkore.';
    if (!workspace.isolatedCodex || workspace.executionDisabled) return 'Изолированный исполнитель задач отключён на сервере платформы. Обратитесь к администратору.';
    if (!fastkoreCli) return 'Исполнитель CLI не подключён. Администратору нужно настроить BRIDGE_FASTKORE_CLI_SOCKET на сервере платформы.';
  }
  async function cliTrustProblem(binding: { origin: string; ca?: string }, signal: AbortSignal) {
    try { await fastkoreCli!.checkTrust(binding, signal); }
    catch (error) {
      signal.throwIfAborted();
      return error instanceof BridgeError ? error.message : 'Не удалось проверить подключение CLI. Попросите администратора проверить службу CLI и сертификат ERP.';
    }
  }
  function erpToolAccess(credential: Credential) {
    const roles = erpCredentialPermissions(workspace.store.state, credential);
    const binding = sso?.delegationBinding(credential);
    const toolsStatus = credential.source === 'fastkore' ? fastkoreMcp?.status(credential, binding) : undefined;
    const login = credential.source !== 'fastkore' ? 'Откройте помощника из Fastkore под своей учётной записью для доступа к данным ERP.' : undefined;
    const reconnect = toolsStatus === 'reauth' ? fastkoreMcp?.reconnectReason(credential) : undefined;
    const delegation = reconnect ?? (credential.browserParentId ? 'Этот браузерный сеанс открыт для настроек. Для работы с данными вернитесь в чат внутри Fastkore.'
      : !credential.erpDelegation ? 'При входе ERP не передала разрешение действовать от вашего имени. Попросите администратора проверить делегирование в Fastkore.'
      : !binding ? 'Платформа не нашла действующее подключение этой установки ERP. Попросите администратора проверить привязку.' : undefined);
    const roleProblem = (kind: 'mcp' | 'cli') => roles[kind] ? undefined
      : `${kind.toUpperCase()} отключён разрешениями роли. Попросите администратора включить инструмент в настройках вашей роли Fastkore.`;
    const cliSetup = login ?? roleProblem('cli') ?? cliConfigurationProblem(binding);
    const mcpSetup = login ?? roleProblem('mcp') ?? (binding?.mcpEnabled === false
      ? 'MCP отключён для этой установки. Администратор может включить его в настройках подключения Fastkore.'
      : !workspace.isolatedCodex || workspace.executionDisabled ? 'Изолированный исполнитель задач отключён на сервере платформы. Обратитесь к администратору.'
      : binding && !binding.mcpUrl ? 'В настройках установки ERP не указан HTTPS-адрес MCP с путём /webapi/mcp. Попросите администратора сохранить адрес сервера.' : undefined);
    const mcpProblem = mcpSetup ?? delegation ?? (toolsStatus !== 'ready' ? 'Платформа не смогла подготовить сеанс MCP. Повторите запрос позже.' : undefined);
    const cliProblem = cliSetup ?? delegation;
    return { roles, binding, toolsStatus, mcpProblem, cliProblem, cliSetup,
      reconnectReason: (!cliSetup || !mcpSetup) ? reconnect : undefined };
  }
  async function connectionChecks(id: string): Promise<FastkoreConnectionCheck[]> {
    const { installation, origin, ca } = configuredSso().connectionSettings(id);
    const cliProblem = cliConfigurationProblem(installation) ?? await cliTrustProblem({ origin, ca }, new AbortController().signal);
    return [
      { id: 'sso', ready: installation.enabled, message: installation.enabled ? 'Вход из ERP включён.'
        : installation.tlsConfirmationRequired ? 'Подтвердите сертификат TLS сервера ERP.'
        : installation.pairingStatus === 'paired' ? 'Вход приостановлен. Разрешите вход в управлении установкой.' : 'Завершите подключение одноразовым кодом из ERP.' },
      { id: 'mcp', ready: !!installation.mcpUrl && installation.mcpEnabled !== false,
        message: installation.mcpEnabled === false ? 'MCP отключён в настройках установки.'
          : installation.mcpUrl ? 'Адрес сохранён. Доступ к инструментам проверяется от имени сотрудника при обращении из чата.'
          : 'Не указан HTTPS-адрес MCP. Сохраните адрес веб-сервера ERP с путём /webapi/mcp.' },
      { id: 'cli', ready: !cliProblem, message: cliProblem ?? 'Исполнитель подключён. Адрес и CA совпадают с ERP. Доступ к данным проверяется от имени сотрудника при выполнении команды.' },
    ];
  }
  const accountWorker = process.env.BRIDGE_CODEX_SOCKET && new RemoteCodexRunner(process.env.BRIDGE_CODEX_SOCKET);
  access.onSessionsRemoved = (sessions, reason) => {
    for (const session of sessions) void fastkoreMcp?.revoke(session).then(result => {
      if (!session.erpDelegation) return;
      workspace.store.recordAudit({ actorId: session.userId, targetId: session.id, action: 'erp.delegation.session_ended',
        details: { sessionId: session.id, installationId: session.installationId, ...result,
          delegationReason: session.expiresAt && Date.parse(session.expiresAt) <= Date.now() ? 'session_expired' : reason } });
    }).catch(() => console.error(JSON.stringify({ event: 'erp.delegation.audit_failed', sessionId: session.id })));
  };
  workspace.prepareFastkoreTools = async (credentialId, context, authorize, signal, run) => {
    if (!sso || !fastkoreMcp) return {};
    const session = () => {
      authorize();
      return access.authenticateCredential(credentialId).credential;
    };
    const credential = session();
    const accessAtStart = erpToolAccess(credential);
    const checkPermission = (kind: 'mcp' | 'cli') => {
      const active = session();
      if (!erpCredentialPermissions(workspace.store.state, active)[kind]) throw new BridgeError(`Доступ к Fastkore ${kind.toUpperCase()} отключён разрешениями ролей сотрудника.`, 403);
      return active;
    };
    const current = () => {
      const active = checkPermission('cli');
      if (sso.delegationBinding(active)?.cliEnabled === false) throw new BridgeError('CLI отключён в настройках установки ERP.', 403);
      return active;
    };
    const audit = (action: string, targetId: string, details: AuditEvent['details']) => {
      workspace.store.recordAudit({ actorId: credential.userId, action, targetId, details: {
        sessionId: credential.id, installationId: credential.installationId, runId: run?.id, chatId: run?.chatId, ...details,
      } });
    };
    const mcpStarted = performance.now();
    const integration = !accessAtStart.mcpProblem ? await fastkoreMcp.prepare(credential, () => { checkPermission('mcp'); }, signal, ({ tool, parameters, ...details }) =>
      audit('erp.mcp.call', tool, { ...details, objectIds: erpAuditIds(parameters) }),
      () => isErpReadOnly(workspace.store.state, checkPermission('mcp'))).finally(() => {
        if (run?.timing) run.timing.mcpSetupMs ??= elapsedMs(mcpStarted);
      }) : { problem: accessAtStart.mcpProblem };
    const cli = erpToolAccess(session());
    const problems = (cliProblem?: string) => [integration.problem && 'MCP — ' + integration.problem, cliProblem && 'CLI — ' + cliProblem].filter(Boolean).join(' ') || undefined;
    if (cli.cliSetup || !fastkoreCli) return { tools: integration.tools, problem: problems(cli.cliProblem) };
    const base = integration.tools ?? {
      definitions: [], call: async () => ({ success: false, text: 'Инструмент Fastkore недоступен.' }),
    };
    const descriptionOnly = () => withFastkoreCliDescription(base, (command, callSignal) => fastkoreCli.describe(command, callSignal), () => { current(); });
    if (cli.cliProblem || !cli.binding) return { tools: descriptionOnly(), problem: problems(cli.cliProblem) };
    const cliStarted = performance.now();
    try {
      const problem = await cliTrustProblem(cli.binding, signal);
      if (problem) return { tools: descriptionOnly(), problem: problems(problem) };
    } finally {
      if (run?.timing) run.timing.cliSetupMs ??= elapsedMs(cliStarted);
    }
    const afterTrust = erpToolAccess(session());
    if (afterTrust.cliSetup) return { tools: integration.tools, problem: problems(afterTrust.cliSetup) };
    if (afterTrust.cliProblem) return { tools: descriptionOnly(), problem: problems(afterTrust.cliProblem) };
    const commands = run ? withFastkoreCliCommands(base, () => fastkoreCli.describe(),
      (command, callSignal) => fastkoreCli.describeCommand(command, callSignal),
      async (command, args, callSignal, fields, maxResponseChars) => {
        const started = performance.now(), timing: FastkoreCliTiming = {};
        let success = false;
        let responseChars: number | undefined;
        try {
          const result = await fastkoreCli.run({ operation: 'execute', command, args, workDirectoryId: run.id, context: fastkoreExecutionContext(context) },
            sso, () => {
              const active = current();
              if (isErpReadOnly(workspace.store.state, active) && !fastkoreReadCommands.has(command)) {
                throw new BridgeError(erpReadOnlyMessage, 403);
              }
              return active;
            }, id => fastkoreMcp.invalidate(id, 'cli_ticket_denied'), callSignal, timing);
          const formatted = formatFastkoreCliResult(result, command, fields, maxResponseChars);
          success = formatted.success;
          responseChars = formatted.responseChars;
          return { success, text: formatted.text };
        } finally { audit('erp.cli.command', command, { success, elapsedMs: elapsedMs(started), ...timing, responseChars }); }
      }, () => { current(); }) : descriptionOnly();
    return { tools: commands, problem: problems() };
  };
  migrateFastkoreChatBindings(workspace.store.state);
  if (sso) {
    if (!workspace.isolatedCodex) workspace.lockCliForSso();
    workspace.corporate.ensureSsoPendingRole();
    sso.reconcileOrigin();
    access.data.credentials = access.data.credentials.filter(c => c.source !== 'fastkore' || sso.credentialValid(c));
    for (const u of access.data.users) if (u.roleId === '') u.roleId = 'sso_pending';
  }
  access.externalCredentialValid = c => !!sso?.credentialValid(c);
  restoreErpRoles(workspace.store.state);
  await workspace.store.save();
  const principals = new WeakMap<FastifyRequest, Principal>();
  const principal = (r: FastifyRequest) => {
    const p = principals.get(r); if (!p) throw new BridgeError('Войдите под своей учётной записью.', 401);
    // Recheck after awaited operations because the account or session may have been revoked.
    return access.authenticateCredential(p.credential.id);
  };
  const user = (r: FastifyRequest) => principal(r).user;
  const requestProject = (request: FastifyRequest, projectId: string) => {
    const { user, credential } = principal(request);
    return access.project(user, projectId, credential);
  };
  const viewChat = (request: FastifyRequest, chat: ReturnType<Workspace['chat']>) => access.viewChat(chat, principal(request).credential);
  const chatIdentityMatches = (p: Principal, chat: ReturnType<Workspace['chat']>) => fastkoreChatSessionMatches(chat, p.credential);
  const requestRun = (request: FastifyRequest<{ Params: { runId: string } }>) => {
    const p = principal(request);
    const run = access.run(p.user, request.params.runId, p.credential);
    if (run.projectId && run.chatId && !chatIdentityMatches(p, workspace.chat(run.projectId, run.chatId))) throw new BridgeError('Задание не найдено.', 404);
    return run;
  };
  const admin = (r: FastifyRequest) => { const u = user(r); access.admin(u); return u; };
  const localAdmin = (r: FastifyRequest) => {
    const p = principal(r);
    if (p.credential.source === 'fastkore') throw new BridgeError('Требуется локальный вход руководителя.', 403);
    access.admin(p.user); return p.user;
  };
  const isSettingsAdmin = ({ user, credential }: Principal) => user.role === 'admin' &&
    (credential.source !== 'fastkore' || !!credential.browserParentId);
  const settingsAdmin = (r: FastifyRequest) => {
    const p = principal(r);
    if (!isSettingsAdmin(p)) throw new BridgeError('Откройте настройки в браузере из сеанса администратора.', 403);
    return p.user;
  };
  const configuredSso = () => {
    if (!sso) throw new BridgeError('На сервере не настроен ключ шифрования Fastkore.', 503);
    return sso;
  };
  const attempts = new Map<string, { count: number; until: number }>();
  const failedAccounts = new Map<string, { count: number; until: number }>();
  let logins = 0;
  const starts = new Map<string, { count: number; until: number }>();
  const exchanges = new Map<string, { count: number; until: number }>();
  const browserExchanges = new Map<string, { count: number; until: number }>();
  const throttled = () => new BridgeError('Слишком много попыток входа. Повторите позже.', 429);
  const rateLimit = (key: string, bucket: typeof attempts, max: number) => {
    const now = Date.now();
    let entry = bucket.get(key);
    if (!entry || entry.until <= now) {
      if (bucket.size >= 5000) {
        for (const [id, value] of bucket) if (value.until <= now) bucket.delete(id);
        if (bucket.size >= 5000 && !bucket.has(key)) throw throttled();
      }
      entry = { count: 0, until: now + 10 * 60_000 };
      bucket.set(key, entry);
    }
    if (entry.count >= max) throw throttled();
    return entry;
  };
  const checkBootstrap = (request: FastifyRequest) => {
    const host = request.headers.host ?? '';
    if (cookieToken(request.headers.cookie) || !loopback(request.ip) || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) || request.headers['x-bridge-local'] !== '1') {
      throw new BridgeError('Первичная настройка доступна только на серверном компьютере.', 403);
    }
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
    const route = request.routeOptions.url ?? '';
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
      secureRequest(request);
      rateLimit(request.ip, route === ssoStart ? starts : exchanges, 120).count++;
      return;
    }
    if (!route.startsWith('/api/')) return;
    if (request.headers.origin && request.headers.origin !== (publicOrigin ?? `${request.protocol}://${request.headers.host}`)) throw new BridgeError('Запрос с другого сайта запрещён.', 403);
    if (route === '/api/health' || route === '/api/auth/browser-session') return;
    const authorization = request.headers.authorization ?? '', cookie = cookieToken(request.headers.cookie);
    if (cookie && authorization) throw new BridgeError('Обнаружены два способа входа. Используйте отдельное окно браузера.', 409);
    if (route === '/api/auth/login') {
      if (cookie) throw new BridgeError('Для локального входа используйте отдельное окно браузера.', 409);
      rateLimit(request.ip, attempts, 120).count++; return;
    }
    if (route === '/api/local-login') {
      checkBootstrap(request);
      rateLimit(request.ip, attempts, 120).count++; return;
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
    const route = request.routeOptions.url ?? '';
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
    if (logins >= 8) throw throttled();
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
  app.get(ssoBrowser, { exposeHeadRoute: false }, (request, reply) => {
    secureRequest(request);
    return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
      + '<title>Вход в настройки Agent Platform</title><script defer src="/fastkore-browser-settings.js"></script>'
      + '<style>:root{color-scheme:light dark;font:16px system-ui}body{margin:2rem}</style></head><body>'
      + '<p role="status">Открываем настройки Agent Platform…</p></body></html>');
  });
  app.post('/api/auth/fastkore/browser-code', request => {
    secureRequest(request);
    const { code, expiresAt } = access.issueBrowserCode(principal(request));
    return { url: publicOrigin + ssoBrowser + '#code=' + code, expiresAt };
  });
  app.post<{ Body: { code: string } }>(ssoBrowser + '/exchange', {
    bodyLimit: 512,
    schema: { body: object({ code: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } }, ['code']) },
  }, async (request, reply) => {
    secureRequest(request);
    const site = request.headers['sec-fetch-site'];
    if (request.headers.origin !== publicOrigin || (site && site !== 'same-origin') || request.headers.authorization || request.url.includes('?')) {
      throw new BridgeError('Откройте ссылку на настройки из Fastkore.', 403);
    }
    rateLimit(request.ip, browserExchanges, 120).count++;
    const issued = await access.redeemBrowserCode(request.body.code, cookieToken(request.headers.cookie));
    const maxAge = Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000);
    return reply.header('Set-Cookie', setSessionCookie(issued.token, Math.max(0, maxAge))).send({ redirect: '/?settings=team' });
  });
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1 } });
  app.get('/api/health', async () => ({ name: 'Codex Chat Bridge', version: '0.6.0', ok: true }));
  const authDetails = (p: Principal, token: string): FastkoreAuthentication => ({
    source: 'fastkore', installationId: p.credential.installationId!, externalUserId: p.credential.externalUserId!,
    expiresAt: p.credential.expiresAt!, csrfToken: csrfFor(token), canChangePassword: false, roles: p.credential.externalRoles,
    canOpenBrowserSettings: access.canOpenBrowserSettings(p), browserSettings: !!p.credential.browserParentId,
  });
  app.get('/api/auth/browser-session', async request => {
    const token = cookieToken(request.headers.cookie);
    if (!token) return { authenticated: false, fastkoreEnabled: !!sso };
    if (request.headers.authorization) throw new BridgeError('Обнаружены два способа входа.', 409);
    secureRequest(request); const p = access.authenticate(token);
    if (p.credential.source !== 'fastkore') throw new BridgeError('Недействительная сессия Fastkore.', 401);
    return { authenticated: true, user: publicUser(p.user), setupRequired: false, interfaceScale: p.user.interfaceScale ?? 100, authentication: authDetails(p, token) };
  });
  app.post('/api/local-login', async request => { checkBootstrap(request); return access.bootstrap(); });
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', { schema: { body: object({ username: string(48), password: { type: 'string', maxLength: 200 } }, ['username', 'password']) } }, async request => {
    if (logins >= 8) throw throttled();
    const account = rateLimit(request.body.username.trim().toLowerCase(), failedAccounts, 10);
    account.count++;
    logins++;
    try {
      const session = await access.login(request.body.username, request.body.password);
      account.count--;
      return session;
    } catch (error) {
      if (!(error instanceof BridgeError) || error.statusCode !== 401) account.count--;
      throw error;
    } finally { logins--; }
  });
  app.get('/api/auth/me', async request => {
    const p = principal(request), source = p.credential.source ?? 'local';
    return {
      user: publicUser(p.user), setupRequired: access.setupRequired, source, interfaceScale: p.user.interfaceScale ?? 100,
      ...(source === 'fastkore' ? { authentication: authDetails(p, cookieToken(request.headers.cookie)) } : {}),
    };
  });
  app.patch<{ Body: { interfaceScale: InterfaceScale } }>('/api/me/preferences', {
    schema: { body: object({ interfaceScale: { type: 'integer', enum: [...interfaceScales] } }, ['interfaceScale']) },
  }, request => access.changeInterfaceScale(() => principal(request), request.body.interfaceScale));
  app.post<{ Body: { username: string; name: string; password: string } }>('/api/auth/setup', { schema: { body: object({ username: string(48), name: string(100), password }, ['username', 'name', 'password']) } }, async request => access.setup(() => principal(request), request.body.username, request.body.name, request.body.password));
  app.post('/api/auth/logout', async (request, reply) => { const p = principal(request); const result = await access.logout(p); if (p.credential.source === 'fastkore') reply.header('Set-Cookie', setSessionCookie('', 0)); return result; });
  app.post<{ Body: { currentPassword: string; password: string } }>('/api/auth/password', { schema: { body: object({ currentPassword: string(200), password }, ['currentPassword', 'password']) } }, async request => access.changePassword(principal(request), request.body.currentPassword, request.body.password));
  app.get<{ Querystring: { includeDeleted?: 'true' } }>('/api/users',
    { schema: { querystring: object({ includeDeleted: { const: 'true' } }) } },
    request => access.users(user(request), request.query.includeDeleted === 'true'));
  app.get('/api/admin/erp-roles', async request => {
    admin(request);
    return erpRoleCatalog(workspace.store.state);
  });
  app.patch<{ Params: { installationId: string; roleId: string }; Body: FastkoreRolePermissions }>(
    '/api/admin/erp-roles/:installationId/:roleId/permissions', { schema: { body: object({ mcp: { type: 'boolean' }, cli: { type: 'boolean' },
      webSearch: { type: 'boolean' }, webRead: { type: 'boolean' }, webRequests: { type: 'boolean' }, fileWrite: { type: 'boolean' },
      readOnly: { type: 'boolean' }, createProjects: { type: 'boolean' }, renameProjects: { type: 'boolean' },
      revision: { type: 'integer', minimum: 0 } }, ['mcp', 'cli', 'revision']) } }, async request => {
      admin(request);
      const result = await workspace.store.changeAccess(draft => {
        const actor = admin(request), { installationId, roleId } = request.params;
        if (!draft.sso?.roles?.some(role => role.installationId === installationId && role.id === roleId)) throw new BridgeError('Роль не найдена.', 404);
        const previous = erpRolePermissions(draft, installationId, roleId);
        if (previous.revision !== request.body.revision) throw new BridgeError('Разрешения изменены. Откройте настройки роли заново.', 409);
        const records = draft.sso.rolePermissions ??= [];
        const value = { installationId, roleId, mcp: request.body.mcp, cli: request.body.cli,
          fileWrite: request.body.fileWrite ?? previous.fileWrite,
          readOnly: request.body.readOnly ?? previous.readOnly, createProjects: request.body.createProjects ?? previous.createProjects,
          webSearch: request.body.webSearch ?? previous.webSearch,
          webRead: request.body.webRead ?? previous.webRead, webRequests: request.body.webRequests ?? previous.webRequests, revision: previous.revision + 1 };
        const index = records.findIndex(item => item.installationId === installationId && item.roleId === roleId);
        if (index < 0) records.push(value); else records[index] = value;
        draft.security?.audit.unshift({ id: randomUUID(), actorId: actor.id, action: 'erp.role.permissions', targetId: installationId + '/' + roleId, createdAt: new Date().toISOString() });
        draft.security?.audit.splice(1000);
        return { mcp: value.mcp, cli: value.cli, readOnly: value.readOnly, createProjects: value.createProjects,
          fileWrite: value.fileWrite,
          webSearch: value.webSearch, webRead: value.webRead, webRequests: value.webRequests, revision: value.revision };
      });
      if (!result.fileWrite) workspace.revokeFileWrites();
      return result;
    });
  app.delete<{ Params: { installationId: string; roleId: string } }>('/api/admin/erp-roles/:installationId/:roleId', async request => {
    admin(request);
    return workspace.store.changeAccess(draft => {
      admin(request);
      const { installationId, roleId } = request.params;
      const roles = draft.sso?.roles;
      const index = roles?.findIndex(role => role.installationId === installationId && role.id === roleId) ?? -1;
      if (!roles || index < 0) throw new BridgeError('Роль не найдена.', 404);
      roles.splice(index, 1);
      const projectRolePolicies = new Map<string, ProjectRolePolicy>();
      for (const project of workspace.store.state.projects) {
        const policy = project.rolePolicy;
        if (!policy) continue;
        const remaining = policy.roles.filter(role => role.installationId !== installationId || role.roleId !== roleId);
        if (remaining.length !== policy.roles.length) projectRolePolicies.set(project.id, { revision: policy.revision + 1, roles: remaining });
      }
      draft.projectRolePolicies = projectRolePolicies;
      draft.security?.audit.unshift({ id: randomUUID(), actorId: user(request).id, action: 'erp.role.delete',
        targetId: installationId + '/' + roleId, createdAt: new Date().toISOString() });
      draft.security?.audit.splice(1000);
      return { ok: true };
    });
  });
  app.post<{ Body: { username: string; name: string; password: string; role: User['role']; roleId?: string } }>('/api/users', { schema: { body: object({ username: string(48), name: string(100), password, role: { enum: ['admin', 'employee'] }, roleId: identifier }, ['username', 'name', 'password', 'role']) } }, async (request, reply) => reply.code(201).send(await access.createUser(localAdmin(request), request.body)));
  app.patch<{ Params: { userId: string }; Body: { disabled?: boolean; password?: string; name?: string; roleId?: string; role?: User['role'] } }>('/api/users/:userId', { schema: { body: object({ disabled: { type: 'boolean' }, password, name: string(100), roleId: identifier, role: { enum: ['admin', 'employee'] } }) } }, async request => access.updateUser(() => principal(request), request.params.userId, request.body));
  app.delete<{ Params: { userId: string } }>('/api/users/:userId', request =>
    access.deleteUser(() => user(request), request.params.userId));
  app.get<{ Querystring: { before?: string } }>('/api/audit', {
    schema: { querystring: object({ before: string(80) }) },
  }, async request => {
    admin(request);
    const before = request.query.before;
    if (!before) return workspace.store.auditEvents(undefined, workspace.knowledge.auditEvents());
    const [time, id, extra] = before.split('/');
    const at = Date.parse(time);
    if (!Number.isFinite(at) || !uuid(id) || extra !== undefined) throw new BridgeError('Некорректный курсор журнала.');
    const cursor = { at, id };
    return workspace.store.auditEvents(cursor, workspace.knowledge.auditEvents(cursor));
  });
  app.get('/api/admin/fastkore/installations', async request => { localAdmin(request); return sso?.list() ?? []; });
  const browserMcpInstallation = (request: FastifyRequest) => {
    const { user: actor, credential: { installationId, browserParentId } } = principal(request);
    access.admin(actor);
    if (!browserParentId || !installationId) throw new BridgeError('Откройте настройки в браузере из Fastkore.', 403);
    return { actor, installationId };
  };
  app.get('/api/admin/fastkore/mcp', request => {
    const { installationId } = browserMcpInstallation(request);
    const installation = configuredSso().list().find(item => item.id === installationId);
    if (!installation) throw new BridgeError('Установка Fastkore не найдена.', 404);
    const { name, mcpUrl } = installation;
    return { name, mcpUrl };
  });
  app.get('/api/admin/fastkore/mcp/checks', async request => {
    const { installationId } = browserMcpInstallation(request);
    return connectionChecks(installationId);
  });
  app.patch<{ Body: { mcpUrl: string } }>('/api/admin/fastkore/mcp', {
    schema: { body: object({ mcpUrl: string(2048) }, ['mcpUrl']) },
  }, request => {
    const { installationId } = browserMcpInstallation(request);
    return access.changeInstallation(() => browserMcpInstallation(request).actor, 'sso.installation.update', items => {
      const installation = items.find(item => item.id === installationId);
      if (!installation) throw new BridgeError('Установка Fastkore не найдена.', 404);
      const address = URL.parse(request.body.mcpUrl.trim());
      const approvedOrigins = [new URL(installation.validateTicketUrl).origin, installation.mcpUrl && new URL(installation.mcpUrl).origin];
      if (!address || !approvedOrigins.includes(address.origin)) {
        throw new BridgeError('Новый домен MCP настраивается при локальном входе администратора.', 403);
      }
      const updated = configuredSso().update(items, installationId, { mcpUrl: request.body.mcpUrl });
      const { name, mcpUrl } = updated.result;
      return { ...updated, result: { name, mcpUrl } };
    });
  });
  app.get('/api/admin/fastkore/cli-pilot', async request => {
    localAdmin(request); secureRequest(request);
    if (!fastkoreCli) throw new BridgeError('Исполнитель Fastkore CLI не настроен.', 503);
    return fastkoreCli.describe();
  });
  const tlsFingerprint = { type: 'string', pattern: '^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){31}$' };
  app.get<{ Params: { id: string } }>('/api/admin/fastkore/installations/:id/checks', async request => {
    localAdmin(request);
    return connectionChecks(request.params.id);
  });
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
    schema: { body: { ...object({ name: string(100), validateTicketUrl: string(2048), enabled: { type: 'boolean' }, confirmValidateTicketUrl: { type: 'boolean' }, mcpUrl: string(2048), mcpEnabled: { type: 'boolean' }, cliEnabled: { type: 'boolean' } }), minProperties: 1 } },
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
  const instructionEditSchema = (administration = false) => object({
      text: { type: 'string', maxLength: personalLimits.instructions },
      autoInstructions: { type: 'boolean' },
      revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      notes: { type: 'array', maxItems: personalLimits.notes, items: object({
        id: string(100), title: string(personalLimits.title), text: string(personalLimits.note),
        scope: { enum: ['project', 'erp'] },
        ...(administration ? { common: { type: 'boolean' } } : {}),
      }, ['title', 'text']) },
      projectId: string(100),
      context: { type: 'object' },
    }, ['text', 'autoInstructions', 'revision', 'notes']);
  const instructionRole = (actor: User) => {
    const roleId = workspace.corporate.role(actor)?.id;
    return roleId === 'sso_pending' ? undefined : roleId;
  };
  function instructionView(actor: User, credential: Credential) {
    const allowedProjects = new Set(workspace.store.state.projects.filter(project => canAccessProject(actor, project, credential)).map(project => project.id));
    const authors = new Map(access.data.users.map(author => [author.id, author.name]));
    const sharedNotes = workspace.store.sharedInstructionNotes(actor.id, instructionRole(actor))
      .filter(({ note }) => !note.scope || (note.scope.kind === 'erp' ? note.scope.id === credential.installationId : allowedProjects.has(note.scope.id)))
      .map(({ note, authorId }) => ({ ...note, authorName: authors.get(authorId) ?? 'Сотрудник' }));
    return { ...workspace.store.personalInstructions(actor.id), ...(sharedNotes.length ? { sharedNotes } : {}) };
  }
  app.get('/api/me/instructions', async request => {
    const { user: actor, credential } = principal(request);
    return instructionView(actor, credential);
  });
  app.put<{ Body: PersonalInstructionsEdit }>('/api/me/instructions', { schema: { body: instructionEditSchema() } }, async request => {
    const { user: actor, credential } = principal(request);
    const project = request.body.projectId ? access.project(actor, request.body.projectId, credential) : undefined;
    const installation = workspace.store.state.sso?.installations?.find(item => item.id === credential.installationId);
    const snapshot = request.body.context === undefined ? undefined : parseFastkoreContext(request.body.context);
    if (snapshot === null) throw new BridgeError('Некорректный контекст Fastkore.');
    editPersonalInstructions(workspace.store, actor.id, request.body, {
      project: project && { kind: 'project', id: project.id, label: project.name },
      erp: installation && { kind: 'erp', id: installation.id, label: installation.name },
      component: installation ? instructionComponent(snapshot) : undefined,
    }, { roleId: instructionRole(actor), tile: installation ? instructionTile(snapshot) : undefined });
    return instructionView(actor, credential);
  });
  app.get('/api/admin/instructions', async request => {
    settingsAdmin(request);
    const authors = new Set(workspace.store.personalInstructionAuthors());
    return access.data.users.filter(actor => authors.has(actor.id)).map(actor => ({
      id: actor.id, name: actor.name, role: workspace.corporate.role(actor)?.name,
    }));
  });
  const instructionAuthor = (request: FastifyRequest<{ Params: { id: string } }>) => {
    settingsAdmin(request);
    const author = access.data.users.find(actor => actor.id === request.params.id);
    if (!author) throw new BridgeError('Сотрудник не найден.', 404);
    return author;
  };
  app.get<{ Params: { id: string } }>('/api/admin/instructions/:id', async request =>
    workspace.store.personalInstructions(instructionAuthor(request).id));
  app.put<{ Params: { id: string }; Body: PersonalInstructionsEdit }>('/api/admin/instructions/:id',
    { schema: { body: instructionEditSchema(true) } }, async request => {
      const author = instructionAuthor(request);
      return editPersonalInstructions(workspace.store, author.id, request.body, {}, { roleId: instructionRole(author), admin: true });
    });
  knowledgeRoutes(app, workspace.knowledge, settingsAdmin, uploads);
  const library = workspace.library;
  libraryRoutes(app, { registry: library.registry, policy: library.policy, reader: library.reader,
    actor: request => {
      const { user, credential } = principal(request);
      return { id: user.id, admin: user.role === 'admin', credentialId: credential.id };
    } });
  library.start();
  // Former project files move into the library once; failures are retried on the next start.
  void workspace.importProjectFiles().catch(() => {});
  app.get('/api/admin/roles', async request => { admin(request); return workspace.corporate.data.roles; });
  app.get('/api/admin/profiles', async request => { admin(request); return workspace.corporate.data.profiles.map(p => ({ ...p, unavailableReason: workspace.corporate.unavailable(p) })); });
  app.get('/api/admin/datasets', async request => { admin(request); return workspace.corporate.data.datasets; });
  app.get('/api/admin/operations', async request => { admin(request); return operationIds; });
  const revision = { type: 'integer', minimum: 1, maximum: 2147483647 };
  app.put<{ Params: { id: string }; Body: Omit<WorkRole, 'id' | 'revision'> & { revision?: number } }>('/api/admin/roles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), enabled: { type: 'boolean' }, profileIds: identifiers, operationIds: identifiers, readDatasetIds: identifiers, instructions: { type: 'string', maxLength: 20000 }, revision }, ['name', 'enabled', 'profileIds', 'operationIds', 'readDatasetIds', 'instructions']) } }, async request => workspace.corporate.saveRole(admin(request), { ...request.body, id: request.params.id }));
  app.put<{ Params: { id: string }; Body: Omit<AgentProfile, 'id' | 'revision'> & { revision?: number; outputMode?: 'chat' | 'restricted' } }>('/api/admin/profiles/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), description: { type: 'string', maxLength: 1000 }, instructions: { type: 'string', maxLength: 20000 }, enabled: { type: 'boolean' }, autoConnect: { type: 'boolean' }, model: modelSchema, reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] }, operationIds: identifiers, datasetIds: identifiers, skillIds: identifiers, allowWrite: { type: 'boolean' }, outputMode: { enum: ['chat', 'restricted'] }, revision, toolIds: agentToolList, icon: { enum: [...specialistIcons] }, instructionFiles: { type: 'array', maxItems: specialistFileLimits.count, items: object({ name: string(120), text: { type: 'string', minLength: 1, maxLength: specialistFileLimits.characters } }, ['name', 'text']) } }, ['name', 'description', 'instructions', 'enabled', 'model', 'reasoningEffort', 'operationIds', 'datasetIds', 'skillIds', 'allowWrite']) } }, async request => {
    const { outputMode: _legacyOutputMode, ...profile } = request.body;
    return workspace.corporate.saveProfile(admin(request), { ...profile, id: request.params.id });
  });
  app.put<{ Params: { id: string }; Body: Omit<Dataset, 'id' | 'revision'> & { revision?: number } }>('/api/admin/datasets/:id', { schema: { params: object({ id: identifier }, ['id']), body: object({ name: string(100), directory: string(2000), projectIds: identifiers, classification: { enum: ['shared', 'restricted'] }, revision }, ['name', 'directory', 'projectIds', 'classification']) } }, async request => workspace.corporate.saveDataset(admin(request), { ...request.body, id: request.params.id }));
  const canCreateProject = (u: UserRecord, credential: Credential) => isSettingsAdmin({ user: u, credential }) ||
    (credential.source === 'fastkore' && creationRoles(workspace.store.state, credential).length > 0);
  app.get('/api/status', async request => {
    const cli = await workspace.codexConnection();
    let active = principal(request);
    let erp = erpToolAccess(active.credential);
    let trustProblem: string | undefined;
    if (!erp.cliProblem && erp.binding) {
      trustProblem = await cliTrustProblem(erp.binding, request.signal);
      active = principal(request);
      erp = erpToolAccess(active.credential);
    }
    const { user: u, credential } = active;
    const manageSettings = isSettingsAdmin({ user: u, credential });
    const settings = workspace.store.state.settings;
    const isolatedToolsEnabled = workspace.isolatedCodex && !workspace.executionDisabled;
    const fastkoreToolsStatus = erp.toolsStatus;
    const cliProblem = erp.cliProblem ?? trustProblem;
    const previousCatalogProblem = fastkoreMcp?.lastCatalogProblem(credential.id);
    const mcpProblem = erp.mcpProblem ?? (previousCatalogProblem && 'При последней загрузке инструментов: ' + previousCatalogProblem + ' Платформа проверит MCP снова при следующем запросе.');
    const internetPermissions = internetCredentialPermissions(workspace.store.state, credential);
    const toolPermissions = {
      erpRoles: credential.source === 'fastkore' ? erp.roles : undefined,
      reconnectReason: erp.reconnectReason,
      fileWrite: credential.source === 'fastkore' && erpFileWriteAllowed(workspace.store.state, credential),
      cli: !cliProblem, mcp: !mcpProblem,
      cliUnavailableReason: cliProblem, mcpUnavailableReason: mcpProblem,
      webSearch: !!(isolatedToolsEnabled && accountWorker && internetPermissions.search),
      webRead: isolatedToolsEnabled && internetPermissions.read,
    };
    const visibleRun = (run: Run) => {
      try {
        access.run(u, run.id, credential);
        return !run.projectId || !run.chatId || chatIdentityMatches({ credential, user: u }, workspace.chat(run.projectId, run.chatId));
      } catch { return false; }
    };
    const activeRuns = workspace.activeRuns.filter(visibleRun);
    const activeRun = activeRuns[0] ?? null;
    const queuedRuns = workspace.queuedRuns.flatMap(run => {
      if (!visibleRun(run)) return [];
      const job = workspace.store.state.jobs?.find(item => item.runId === run.id);
      if (job?.authorId !== u.id) return [run];
      return [{ ...run, queuedText: job?.text.slice(0, 240), queuedFiles: job?.attachmentIds.length }];
    });
    const unreadChatReplies: Record<string, string> = {};
    for (const project of workspace.store.state.projects) {
      for (const chat of project.chats) {
        const replyId = chat.lastCompletedReplyId;
        if (replyId && !chat.archivedAt && u.readChatReplies?.[chat.id] !== replyId &&
          access.canAccessChat(u, project, chat, credential) && chatIdentityMatches({ user: u, credential }, chat)) unreadChatReplies[chat.id] = replyId;
      }
    }
    return { version: '0.6.0', activeRun, activeRuns, queuedRuns, unreadChatReplies, busy: workspace.busy, user: publicUser(u), setupRequired: access.setupRequired, canCreateProject: canCreateProject(u, credential),
      cli: u.role === 'admin' ? cli : cli && { ...cli, path: '', status: '' },
      isolatedCodex: workspace.isolatedCodex, workerFilesAvailable: workspace.workerFilesAvailable, codexLimitsRevision: workspace.codexLimitsRevision,
      settings: { ...settings, cliPath: u.role === 'admin' ? settings.cliPath : '',
        agentInstructions: manageSettings ? settings.agentInstructions : undefined,
        executionConcurrency: manageSettings && workspace.isolatedCodex ? workspace.executionConcurrency : undefined },
      addresses: publicOrigin ? [publicOrigin] : addresses(port, lan), port, lan, executionDisabled: workspace.executionDisabled,
      dictationAvailable: !!transcribeDictation, dictationEnabled: dictationEnabled(),
      fastkoreToolsStatus, toolPermissions,
      storageWarning: u.role === 'admin' ? workspace.store.warning : undefined,
      fileStorage: manageSettings ? workspace.fileStorageStatus : undefined };
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
      const { user: actor, credential } = principal(request);
      if (chatId && !projectId) throw new BridgeError('Укажите проект диалога.');
      const project = projectId ? access.project(actor, projectId, credential) : undefined;
      if (!project && actor.role !== 'admin' && !workspace.corporate.role(actor)?.operationIds.includes('chat')) {
        throw new BridgeError('Рабочая роль не разрешает работу с чатом.', 403);
      }
      const chat = chatId && projectId ? access.postChat(actor, projectId, chatId, credential) : undefined;
      if (chat && projectId) workspace.assertSharedChatAvailable(projectId, chat, actor.id);
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
  app.get<{ Querystring: { model?: string } }>('/api/codex/limits', {
    schema: { querystring: object({ model: string(128) }) },
  }, async request => ({ limits: await workspace.limits(request.query.model) }));
  app.get<{ Querystring: { model?: string } }>('/api/models/limits', {
    schema: { querystring: object({ model: string(128) }) },
  }, async request => ({ models: await workspace.modelLimits(request.query.model) }));
  app.get<{ Querystring: { timeZone?: string } }>('/api/codex/activity', {
    schema: { querystring: object({ timeZone: string(80) }) },
  }, async request => {
    admin(request);
    return workspace.tokenActivity(request.query.timeZone ?? 'UTC').total;
  });
  app.get<{ Querystring: { timeZone?: string } }>('/api/admin/usage', {
    schema: { querystring: object({ timeZone: string(80) }) },
  }, async request => workspace.tokenActivity(request.query.timeZone ?? 'UTC', access.users(user(request))));
  app.post('/api/cli/check', async request => { admin(request); return workspace.isolatedCodex ? workspace.codexConnection(true) : workspace.inspect(); });
  app.post('/api/subscription/check', async (request, reply) => { admin(request); const run = await workspace.subscription(); return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run); });
  app.patch<{ Body: Partial<Settings> }>('/api/settings', { schema: { body: object({ cliPath: { type: 'string', maxLength: 2000 }, allowWrite: { type: 'boolean' }, includePreviews: { type: 'boolean' }, model: modelSchema, reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] }, dictationEnabled: { type: 'boolean' }, agentInstructions: string(8000), executionConcurrency: executionConcurrencySchema }) } }, async request => {
    admin(request);
    if (request.body.agentInstructions !== undefined || request.body.executionConcurrency !== undefined || (workspace.isolatedCodex && request.body.allowWrite !== undefined)) settingsAdmin(request);
    if (request.body.dictationEnabled && !transcribeDictation) throw new BridgeError('Сервис распознавания речи не настроен.', 409);
    const settings = await workspace.settings(request.body);
    return isSettingsAdmin(principal(request)) ? settings : { ...settings, agentInstructions: undefined };
  });
  app.patch<{ Body: { provider: FileStorageProvider } }>('/api/settings/file-storage', {
    schema: { body: object({ provider: { enum: ['local', 's3'] } }, ['provider']) },
  }, request => workspace.changeFileStorage(request.body.provider, () => { settingsAdmin(request); }));
  app.get('/api/diagnostics', async request => { admin(request); return { text: (await readFile(path.join(workspace.store.root, 'diagnostics.log'), 'utf8').catch(() => '')).slice(-12_000) }; });
  workspace.prepareInternetTools = (other, credentialId, authorize) => withInternetTools(other,
    () => { authorize(); return internetCredentialPermissions(workspace.store.state, access.authenticateCredential(credentialId).credential); },
    authorize, (query, signal) => accountWorker ? accountWorker.searchInternet(query, signal)
      : Promise.resolve({ success: false, text: 'Интернет-поиск требует отдельного исполнителя.' }));
  const accountAccess = (request: FastifyRequest, changing = false) => {
    settingsAdmin(request);
    if (!accountWorker) throw new BridgeError('Управление аккаунтами требует отдельного исполнителя.', 503);
    if (changing && workspace.busy) throw new BridgeError('Дождитесь завершения заданий или остановите их.', 409);
    return accountWorker;
  };
  app.get('/api/admin/execution/accounts', request => accountAccess(request).accounts());
  app.post<{ Body: { proxyUrl: string } }>('/api/admin/execution/proxy', {
    schema: { body: object({ proxyUrl: { type: 'string', maxLength: 2048 } }, ['proxyUrl']) },
  }, async request => {
    const result = await accountAccess(request, true).setProxy(request.body.proxyUrl);
    workspace.resetExecutionConnection();
    return result;
  });
  app.delete<{ Params: { id: string } }>('/api/admin/execution/accounts/:id', async request => {
    const worker = accountAccess(request);
    const result = await worker.accountAction('remove', request.params.id);
    workspace.stopExecutionAccount(request.params.id);
    workspace.resetExecutionConnection();
    await workspace.pruneDefaultModel(result?.accounts);
    return result;
  });
  app.post<{ Body: { name: string; provider?: ExecutionProvider } }>('/api/admin/execution/accounts', {
    schema: { body: object({ name: string(100), provider: { enum: executionProviders } }, ['name']) },
  }, request => accountAccess(request).accountAction('create', undefined, request.body.name, request.body.provider));
  for (const action of ['login', 'activate', 'deactivate'] as const) {
    app.post<{ Params: { id: string } }>('/api/admin/execution/accounts/:id/' + action, async request => {
      const worker = accountAccess(request);
      const result = await worker.accountAction(action, request.params.id);
      if (action === 'deactivate') workspace.stopExecutionAccount(request.params.id);
      workspace.resetExecutionConnection();
      return result;
    });
  }
  app.post<{ Params: { id: string }; Body: { code: string } }>('/api/admin/execution/accounts/:id/code', {
    schema: { body: object({ code: string(2048) }, ['code']) },
  }, request => accountAccess(request).accountAction('code', request.params.id, request.body.code));
  app.post<{ Params: { id: string }; Body: { key: string; scope?: GigaChatScope } }>('/api/admin/execution/accounts/:id/key', {
    schema: { body: object({ key: string(2048), scope: { enum: gigaChatScopes } }, ['key']) },
  }, async request => {
    const result = await accountAccess(request).accountAction('key', request.params.id, request.body.key, undefined, request.body.scope);
    workspace.resetExecutionConnection();
    return result;
  });
  app.get('/api/projects', async request => {
    const p = principal(request);
    const catalog = isSettingsAdmin(p) ? projectRoleOptions(workspace.store.state) : undefined;
    return workspace.store.state.projects.filter(project => canAccessProject(p.user, project, p.credential)).map(project => ({
      id: project.id, name: project.name, instructions: project.instructions, directory: project.directory,
      canRename: canRenameProject(workspace.store.state, p.user, project, p.credential),
      chatCount: project.chats.filter(chat => !chat.archivedAt && access.canChat(p.user, chat) && chatIdentityMatches(p, chat)).length,
      roles: catalog?.filter(role => project.rolePolicy?.roles.some(selected => selected.installationId === role.installationId && selected.roleId === role.roleId)),
    }));
  });
  app.post('/api/migrations/desktop', async request => { localAdmin(request); const result = await workspace.importDesktop(); access.migrate(); await workspace.store.save(); return result; });
  const instructionsText = { type: 'string', maxLength: maxProjectInstructions };
  app.post<{ Body: { directory?: string; name?: string; instructions?: string } }>('/api/projects', { schema: { body: object({ directory: string(2000), name: string(100), instructions: instructionsText }) } }, async (request, reply) => {
    const { directory, name, instructions } = request.body;
    if (directory !== undefined) localAdmin(request);
    const authorize = () => {
      const { user: u, credential } = principal(request);
      if (!canCreateProject(u, credential)) throw new BridgeError('Роль не позволяет создавать проекты.', 403);
      return creationRoles(workspace.store.state, credential);
    };
    authorize();
    const project = directory === undefined
      ? await workspace.createProject(name ?? '', authorize, instructions)
      : await workspace.addProject(directory, name, workspace.isolatedCodex ? workspace.corporate.defaultProjectPolicy('new') : undefined, instructions);
    if (directory !== undefined) { access.migrate(); await workspace.store.save(); }
    return reply.code(201).send({ id: project.id, name: project.name, instructions: project.instructions, directory: project.directory, chatCount: project.chats.length });
  });
  function projectEditor(request: FastifyRequest, id: string) {
    const principalNow = principal(request);
    const project = access.project(principalNow.user, id, principalNow.credential);
    if (!canRenameProject(workspace.store.state, principalNow.user, project, principalNow.credential)) {
      throw new BridgeError('Ваша роль не позволяет изменять этот проект.', 403);
    }
    return principalNow.user.id;
  }
  app.patch<{ Params: { projectId: string }; Body: { name: string } }>('/api/projects/:projectId', {
    schema: { body: object({ name: string(100) }, ['name']) },
  }, request => workspace.renameProject(request.params.projectId, request.body.name, () => projectEditor(request, request.params.projectId)));
  app.put<{ Params: { projectId: string }; Body: { instructions: string; previous: string } }>('/api/projects/:projectId/instructions', {
    schema: { body: object({ instructions: instructionsText, previous: instructionsText }, ['instructions', 'previous']) },
  }, request => workspace.saveProjectInstructions(request.params.projectId, request.body, () => projectEditor(request, request.params.projectId)));
  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', request =>
    workspace.deleteProject(request.params.projectId, () => settingsAdmin(request)));
  const projectRolesPath = '/api/projects/:projectId/roles';
  app.get<{ Params: { projectId: string } }>(projectRolesPath, async (request): Promise<ProjectRoleSettings> => {
    settingsAdmin(request);
    const project = workspace.activeProject(request.params.projectId);
    return { ...(project.rolePolicy ?? { revision: 0, roles: [] }), available: projectRoleOptions(workspace.store.state) };
  });
  app.put<{ Params: { projectId: string }; Body: ProjectRolePolicy }>(projectRolesPath, {
    schema: { body: object({
      revision: { ...revision, minimum: 0 },
      roles: { type: 'array', maxItems: 1000, uniqueItems: true, items: object({ installationId: string(100), roleId: string(100) }, ['installationId', 'roleId']) },
    }, ['revision', 'roles']) },
  }, request => access.setProjectRoles(() => settingsAdmin(request), request.params.projectId, request.body));
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/agents', async request => {
    const { user, credential } = principal(request);
    const project = requestProject(request, request.params.projectId);
    const agents = workspace.corporate.list(user, project);
    if (credential.source !== 'fastkore' || process.env.BRIDGE_LIBRARY_CLOSED_ANALYSIS !== 'verified') return agents;
    return agents.map(agent => ({ ...agent, closedAnalysis: workspace.library.policy.runScope(user.id, project.id, agent.id, credential.id)
      .entries.some(entry => entry.classification === 'restricted') }));
  });
  const projectAgentSettings = '/api/projects/:projectId/agent-settings';
  app.get<{ Params: { projectId: string } }>(projectAgentSettings, async (request): Promise<ProjectAgentSettings> => {
    settingsAdmin(request);
    const project = workspace.activeProject(request.params.projectId);
    const files = workspace.projectFiles(project);
    const fileIds = new Set(files.map(file => file.id));
    const policy = project.agentPolicy ?? workspace.corporate.defaultProjectPolicy('legacy');
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
    const authorize = () => settingsAdmin(request);
    authorize();
    return workspace.corporate.saveProjectPolicy(workspace.activeProject(request.params.projectId), request.body, authorize);
  });
  app.get<{ Params: { projectId: string }; Querystring: { includeArchived?: 'true' | 'false' } }>('/api/projects/:projectId/chats', {
    schema: { querystring: { type: 'object', properties: { includeArchived: { enum: ['true', 'false'] } } } },
  }, async request => {
    const p = principal(request);
    const includeArchived = request.query.includeArchived === 'true';
    if (includeArchived) settingsAdmin(request);
    const pinned = new Set(p.user.pinnedChatIds);
    return access.project(p.user, request.params.projectId, p.credential).chats
      .filter(chat => (includeArchived || !chat.archivedAt) && access.canChat(p.user, chat) && chatIdentityMatches(p, chat))
      .map(chat => ({ ...access.chatSummary(chat), pinned: pinned.has(chat.id) || undefined, archivedAt: chat.archivedAt }));
  });
  app.get('/api/chats/without-project', async (request): Promise<UnassignedChatSummary[]> => {
    const p = principal(request);
    const pinned = new Set(p.user.pinnedChatIds);
    return workspace.store.state.projects.flatMap(project => project.deletedAt ? project.chats
      .filter(chat => !chat.archivedAt && access.canAccessChat(p.user, project, chat, p.credential) && chatIdentityMatches(p, chat))
      .map(chat => ({ ...access.chatSummary(chat), projectId: project.id, pinned: pinned.has(chat.id) || undefined })) : [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  const archivedChats = (include: (project: ReturnType<Workspace['project']>, chat: ReturnType<Workspace['chat']>) => boolean) =>
    workspace.store.state.projects.flatMap(project => project.chats.flatMap(chat => chat.archivedAt && include(project, chat)
      ? [{ ...access.chatSummary(chat), archivedAt: chat.archivedAt, projectId: project.id, projectName: project.deletedAt ? unassignedChatsLabel : project.name }] : []))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  app.get('/api/admin/chats/archive', async request => {
    admin(request);
    return archivedChats(() => true);
  });
  app.get('/api/chats/archive', async request => {
    const { user: actor, credential } = principal(request);
    if (credential.source !== 'fastkore' || !credential.installationId) throw new BridgeError('Личный архив доступен в сеансе Fastkore.', 403);
    return archivedChats((project, chat) => chat.ownerId === actor.id &&
      (project.deletedAt ? chatIdentityMatches({ user: actor, credential }, chat) :
        chat.fastkoreBinding?.installationId === credential.installationId && chatIdentityMatches({ user: actor, credential }, chat)) &&
      access.canAccessChat(actor, project, chat, credential));
  });
  const relatedChatContext = (request: FastifyRequest, raw: unknown) => {
    const p = principal(request);
    if (p.credential.source !== 'fastkore' || !p.credential.installationId) throw new BridgeError('Связанные чаты доступны в сеансе Fastkore.', 403);
    const context = parseFastkoreContext(raw);
    const binding = context && chatBinding(p.credential.installationId, context, p.credential.externalUserId);
    if (!binding || !context) throw new BridgeError('Для этого контекста Fastkore нет ключа истории.');
    return { binding, context, parents: parentFastkoreChatBindings(p.credential.installationId, p.credential.externalUserId, context) };
  };
  app.post<{ Body: { context: unknown } }>('/api/fastkore/chats/related', {
    schema: { body: object({ context: { type: 'object' } }, ['context']) },
  }, async request => {
    const { binding, context, parents } = relatedChatContext(request, request.body.context);
    await workspace.rememberFastkoreNavigation(binding, () => principal(request));
    const { user: actor, credential } = principal(request);
    const rows = new Map<string, RelatedChatSummary>();
    for (const parent of parents) {
      const source = workspace.relatedFastkoreChats(actor, parent, credential)[0];
      if (source) rows.set(source.chat.id, { ...access.chatSummary(source.chat), projectId: source.project.id, projectName: source.project.deletedAt ? unassignedChatsLabel : source.project.name,
        parent: true, contextMatches: false });
    }
    for (const { project, chat } of workspace.relatedFastkoreChats(actor, binding, credential, undefined, true)) {
      rows.set(chat.id, { ...access.chatSummary(chat), projectId: project.id, projectName: project.deletedAt ? unassignedChatsLabel : project.name, parent: rows.get(chat.id)?.parent });
    }
    for (const { project, chat } of workspace.relatedFastkoreChats(actor, binding, credential, context, true)) {
      if (!rows.has(chat.id)) rows.set(chat.id, { ...access.chatSummary(chat), projectId: project.id, projectName: project.deletedAt ? unassignedChatsLabel : project.name, legacyContext: true });
    }
    return [...rows.values()];
  });
  app.post<{ Body: { context: unknown; projectId: string; fresh?: boolean; agentProfileId?: string } }>('/api/fastkore/chats', {
    schema: { body: object({ context: { type: 'object' }, projectId: string(100), fresh: { type: 'boolean' }, agentProfileId: identifier }, ['context', 'projectId']) },
  }, async (request, reply) => {
    const { projectId, fresh, context, agentProfileId } = request.body;
    const { binding } = relatedChatContext(request, context);
    await workspace.rememberFastkoreNavigation(binding, () => principal(request));
    const result = await workspace.createFastkoreChat(projectId, binding, fresh === true, () => {
      const p = principal(request);
      access.project(p.user, projectId, p.credential);
      return p;
    }, agentProfileId);
    return reply.code(result.created ? 201 : 200).send({ projectId: result.projectId, chat: viewChat(request, result.chat) });
  });
  app.post<{ Params: { projectId: string }; Body: { title?: string; model?: string; agentProfileId?: string } }>('/api/projects/:projectId/chats', { schema: { body: object({ title: string(120), model: modelSchema, agentProfileId: identifier }) } }, async (request, reply) => {
    const check = () => requestProject(request, request.params.projectId); check();
    const c = await workspace.addChat(request.params.projectId, request.body.title, request.body.model, user(request).id, check, request.body.agentProfileId); return reply.code(201).send(access.viewChat(c));
  });
  type ChatParams = { projectId: string; chatId: string };
  const chatPath = '/api/projects/:projectId/chats/:chatId';
  const requestChat = (request: FastifyRequest<{ Params: ChatParams }>, edit: boolean | 'post' = false) => {
    const p = principal(request), { projectId, chatId } = request.params;
    if (edit === 'post') return access.postChat(p.user, projectId, chatId, p.credential);
    const chat = edit ? access.editChat(p.user, projectId, chatId, p.credential) : access.chat(p.user, projectId, chatId, p.credential);
    if (!chatIdentityMatches(p, chat)) throw new BridgeError('Диалог не найден.', 404);
    return chat;
  };
  app.get<{ Params: ChatParams }>(chatPath, async request => viewChat(request, requestChat(request)));
  app.patch<{ Params: ChatParams; Body: { replyId: string } }>(chatPath + '/read', {
    schema: { body: object({ replyId: string(36) }, ['replyId']) },
  }, request => access.markChatRead(request.body.replyId, () => ({ actor: principal(request).user, chat: requestChat(request) })));
  app.patch<{ Params: ChatParams; Body: { pinned: boolean } }>(chatPath + '/pin', {
    schema: { body: object({ pinned: { type: 'boolean' } }, ['pinned']) },
  }, request => access.setChatPinned(request.body.pinned, () => ({ actor: user(request), chat: requestChat(request) })));
  app.patch<{ Params: ChatParams; Body: { consultantIds: string[] } }>(chatPath + '/specialists', {
    schema: { body: object({ consultantIds: { type: 'array', uniqueItems: true, items: identifier } }, ['consultantIds']) },
  }, request => workspace.setChatConsultants(request.params.projectId, request.params.chatId, request.body.consultantIds, () => {
    requestChat(request, true);
    return user(request);
  }));
  app.patch<{ Params: ChatParams; Body: { projectId: string; title?: string } }>(chatPath + '/move', {
    schema: { body: object({ projectId: string(100), title: string(120) }, ['projectId']) },
  }, async request => {
    const { projectId, chatId } = request.params;
    const destinationId = request.body.projectId;
    const check = () => {
      requestChat(request, true);
      const p = principal(request);
      access.project(p.user, destinationId, p.credential);
      return p;
    };
    check();
    return viewChat(request, await workspace.moveChat(projectId, chatId, destinationId, request.body.title, check));
  });
  app.patch<{ Params: ChatParams; Body: { archived: boolean } }>(chatPath + '/archive', {
    schema: { body: object({ archived: { type: 'boolean' } }, ['archived']) },
  }, async request => viewChat(request, await workspace.setChatArchived(request.params.projectId, request.params.chatId, request.body.archived, () => admin(request))));
  app.post<{ Params: ChatParams; Body: { context: unknown } }>(chatPath + '/reset', {
    schema: { body: object({ context: { type: 'object' } }, ['context']) },
  }, async request => {
    const { projectId, chatId } = request.params;
    const context = parseFastkoreContext(request.body.context);
    return viewChat(request, await workspace.resetFastkoreChat(projectId, chatId, () => {
      const { user: actor, credential } = principal(request);
      if (credential.source !== 'fastkore' || !credential.installationId) throw new BridgeError('Очистка связанного чата доступна в сеансе Fastkore.', 403);
      const chat = access.editChat(actor, projectId, chatId, credential);
      if (chat.ownerId !== actor.id) throw new BridgeError('Очистить связанный чат может только его автор.', 403);
      if (!chat.fastkoreBinding || !context || !matchesFastkoreChat(chat.fastkoreBinding, credential.installationId, context, credential.externalUserId)) {
        throw new BridgeError('Откройте в Fastkore карточку или список, к которым привязан этот чат.', 409);
      }
      return actor;
    }, fastkoreChatTitle(context ?? undefined)));
  });
  app.delete<{ Params: ChatParams }>(chatPath, request => workspace.deleteArchivedChat(request.params.projectId, request.params.chatId, () => {
    const chat = requestChat(request), actor = user(request);
    if (actor.role !== 'admin' && (chat.ownerId !== actor.id || chat.archivedAt || chat.messages.length)) {
      throw new BridgeError('Удалить можно только свой пустой чат.', 403);
    }
    return actor;
  }));
  app.get<{ Params: ChatParams }>(chatPath + '/files', request => {
    const chat = requestChat(request), actor = user(request);
    return chatFileEntries(chat, actor).map(({ file, messageId, canDelete }) => ({
      id: file.id, name: file.name, size: file.size, messageId, canDelete,
    }));
  });
  app.post<{ Params: ChatParams; Body: { fileId: string } }>(chatPath + '/files', {
    schema: { body: object({ fileId: string(100) }, ['fileId']) },
  }, request => workspace.storeChatFile(request.params.projectId, request.params.chatId, request.body.fileId, () => {
    requestChat(request, 'post'); return user(request);
  }));
  app.get<{ Params: ChatParams & { fileId: string } }>(chatPath + '/files/:fileId', async (request, reply) => {
    const find = () => {
      const entry = chatFileEntries(requestChat(request), user(request)).find(item => item.file.id === request.params.fileId);
      if (!entry) throw new BridgeError('Файл чата не найден.', 404);
      return entry.file;
    };
    const file = find(), contents = await workspace.files.read(workspace.project(request.params.projectId), file);
    find();
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    return reply.type('application/octet-stream').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', "attachment; filename*=UTF-8''" + name).send(contents);
  });
  app.delete<{ Params: ChatParams & { fileId: string } }>(chatPath + '/files/:fileId', request => {
    const { projectId, chatId, fileId } = request.params;
    return workspace.deleteChatFile(projectId, chatId, fileId, () => { requestChat(request, 'post'); return user(request); });
  });
  app.post<{ Params: ChatParams & { fileId: string } }>(chatPath + '/files/:fileId/attach', async request => {
    const { projectId, fileId } = request.params;
    const find = () => {
      const chat = requestChat(request, 'post');
      const entry = chatFileEntries(chat, user(request)).find(item => item.file.id === fileId);
      if (!entry) throw new BridgeError('Файл чата не найден.', 404);
      return entry.file;
    };
    const file = find(), actor = user(request);
    if (file.ownerId === actor.id && workspace.project(projectId).attachments.some(item => item.id === fileId)) return file;
    const contents = await workspace.files.read(workspace.project(projectId), file);
    find();
    return workspace.addAttachment(projectId, file.name, contents, () => { find(); return user(request).id; });
  });
  app.get<{ Params: ChatParams & { messageId: string; fileId: string } }>(chatPath + '/messages/:messageId/files/:fileId', async (request, reply) => {
    const { projectId, chatId, messageId, fileId } = request.params;
    const findFile = () => {
      const chat = requestChat(request);
      const message = chat.messages.find(item => item.id === messageId);
      const file = message?.attachments.find(item => item.id === fileId);
      if (!message || !file || !canReadChatAttachment(file, message, chat.ownerId, user(request))) {
        throw new BridgeError('Вложение не найдено.', 404);
      }
      return file;
    };
    const file = findFile();
    const contents = await workspace.files.read(workspace.project(projectId), file);
    findFile();
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    return reply.type('application/octet-stream').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', "attachment; filename*=UTF-8''" + name).send(contents);
  });
  app.patch<{ Params: ChatParams; Body: { model?: string; reasoningEffort?: Settings['reasoningEffort'] } }>(chatPath, { schema: { body: { ...object({ model: modelSchema, reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] } }), minProperties: 1 } } }, async request => {
    const check = () => requestChat(request, true); check();
    return viewChat(request, await workspace.changeChatModel(request.params.projectId, request.params.chatId, request.body.model, check, request.body.reasoningEffort));
  });
  app.patch<{ Params: ChatParams; Body: { title: string } }>(chatPath + '/title', { schema: { body: object({ title: string(120) }, ['title']) } }, request =>
    workspace.renameChat(request.body.title, () => {
      const actor = user(request);
      return { actor, chat: requestChat(request, true) };
    }));
  app.patch<{ Params: ChatParams; Body: { visibility: 'private' | 'project' } }>(chatPath + '/visibility', { schema: { body: object({ visibility: { enum: ['private', 'project'] } }, ['visibility']) } }, async request =>
    viewChat(request, await workspace.setChatVisibility(request.params.projectId, request.params.chatId, request.body.visibility, () => {
      requestChat(request, true);
      return user(request);
    })));
  app.get<{ Params: ChatParams }>(chatPath + '/messages', async request => requestChat(request).messages);
  app.post<{ Params: ChatParams; Body: { text: string; attachmentIds?: string[]; clientRequestId?: string; model?: string; fastkoreContext?: unknown; recommendedSpecialistId?: string } }>(chatPath + '/messages', { schema: { body: object({ text: string(60_000), attachmentIds: { type: 'array', items: string(100), maxItems: 8, uniqueItems: true }, clientRequestId: string(100), model: modelSchema, fastkoreContext: { type: 'object' }, recommendedSpecialistId: identifier }, ['text']) } }, async (request, reply) => {
    const check = () => {
      const u = user(request); requestChat(request, request.body.model === undefined ? 'post' : true);
      if (workspace.project(request.params.projectId).deletedAt) throw new BridgeError('Сначала выберите проект для чата.', 409);
      const p = requestProject(request, request.params.projectId);
      for (const id of request.body.attachmentIds ?? []) if (!p.attachments.some(a => a.id === id && !a.libraryUploadedAt && (u.role === 'admin' || a.ownerId === u.id))) throw new BridgeError('Вложение не найдено.', 404);
    }; check();
    const text = request.body.text.trim(); if (!text) throw new BridgeError('Напишите вопрос.');
    const p = principal(request), { projectId, chatId } = request.params;
    const chat = workspace.chat(projectId, chatId);
    const rawContext = request.body.fastkoreContext;
    if (rawContext !== undefined && p.credential.source !== 'fastkore') throw new BridgeError('Контекст ERP доступен в сеансе Fastkore.', 403);
    const parsed = parseFastkoreContext(request.body.fastkoreContext);
    if (rawContext !== undefined && !parsed) throw new BridgeError('Fastkore передал некорректный или неподдерживаемый снимок.');
    if (chat.fastkoreBinding) {
      const installationId = p.credential.installationId;
      const shared = chat.visibility === 'project';
      const matches = parsed && installationId && matchesFastkoreChat(chat.fastkoreBinding, installationId, parsed, p.credential.externalUserId, shared);
      // Outside Fastkore the chat owner may continue a bound chat; a mismatching ERP context
      // still refuses the write so answers never land on the wrong card.
      const sameIdentity = !chat.fastkoreBinding.externalUserId || (installationId === chat.fastkoreBinding.installationId && p.credential.externalUserId === chat.fastkoreBinding.externalUserId);
      const continuesWithoutContext = !parsed && (p.credential.source !== 'fastkore' || sameIdentity) && (p.user.role === 'admin' || p.user.id === chat.ownerId);
      if (!continuesWithoutContext && (p.credential.source !== 'fastkore' || (!shared && p.user.id !== chat.ownerId) || !matches)) {
        throw new BridgeError('Откройте в Fastkore карточку или список, к которым привязан этот чат.', 409);
      }
    }
    const snapshot = parsed ?? undefined;
    if (snapshot && snapshot.view !== 'none') delete snapshot.entity_uri;
    const run = await workspace.send(request.params.projectId, request.params.chatId, text, request.body.attachmentIds ?? [], request.body.clientRequestId ? `${user(request).id}:${request.body.clientRequestId}` : undefined, request.body.model, check, { id: user(request).id, name: user(request).name, credentialId: principal(request).credential.id }, snapshot, request.body.recommendedSpecialistId);
    return reply.code(202).header('Location', `/api/runs/${run.id}`).send(run);
  });
  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/attachments', async (request, reply) => {
    const { projectId } = request.params;
    const authorize = () => {
      const actor = user(request);
      requestProject(request, projectId);
      return actor.id;
    };
    const actorId = authorize();
    const file = await uploads.receive(request, actorId, (name, data) => workspace.addAttachment(projectId, name, data, authorize));
    return reply.code(201).send(file);
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async request => requestRun(request));
  app.post<{ Params: { runId: string }; Body: { targetRunId: string } }>('/api/runs/:runId/send-now', {
    schema: { body: object({ targetRunId: string(36) }, ['targetRunId']) },
  }, async request => {
    const authorize = () => {
      const { user: actor, credential } = principal(request);
      const run = requestRun(request);
      if (!run.projectId || !run.chatId) throw new BridgeError('Уточнение должно быть сообщением чата.', 409);
      access.postChat(actor, run.projectId, run.chatId, credential);
    };
    const actor = principal(request);
    return workspace.sendQueuedNow(request.params.runId, request.body.targetRunId, { id: actor.user.id, credentialId: actor.credential.id }, authorize);
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async request => {
    const { user, credential } = principal(request), run = requestRun(request);
    if (run.projectId && run.chatId) {
      const chat = access.postChat(user, run.projectId, run.chatId, credential);
      if (chat.visibility === 'project' && user.role !== 'admin' && run.ownerId !== user.id) throw new BridgeError('Отменить запрос может его автор или администратор.', 403);
    }
    return workspace.cancel(run.id);
  });
  if (options.clientRoot) await app.register(fastifyStatic, {
    root: path.resolve(options.clientRoot), prefix: '/', index: ['index.html'], wildcard: false, preCompressed: true,
    setHeaders(reply, file) {
      if (path.basename(path.dirname(file)) === 'assets' && /-[\w-]{8}\.(?:js|css)(?:\.(?:br|gz))?$/.test(file)) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Адрес не найден.' }));
  app.addHook('onClose', async () => { await workspace.shutdown(); });
  workspace.start(job => { if (job.credentialId) access.authenticateCredential(job.credentialId); });
  return app;
}
