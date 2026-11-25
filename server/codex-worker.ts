import Fastify from 'fastify';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient, ExecutionAccountStopped, type CodexRunner, type SteerTurn } from './codex.js';
import type { WorkerMessage, WorkerRun, WorkerSteer, WorkerToolResult } from './codex-remote.js';
import type { CodexToolResult } from './codex-tools.js';
import { BridgeError } from './store.js';
import { ExecutionAccountStore } from './execution-accounts.js';
import { executionConnected, executionProviders, gigaChatScopes, type ExecutionProvider, type GigaChatScope } from '../shared/execution-accounts.js';
import type { CodexLimits } from '../shared/types.js';
import { limitsForModel } from './google-limits.js';
import { readGlmKey } from './glm.js';
import { searchZai } from './internet-search.js';
import { defaultExecutionConcurrency, executionConcurrencySchema, validExecutionConcurrency } from './execution-concurrency.js';
import { chatImagesUnsupportedProvider, chatImageUrlPattern, maxChatImages, maxChatImagePayload, maxChatImageUrlLength, supportsChatImages } from './chat-images.js';
import { jobOfficeTool, runJobOffice } from './job-office.js';
import { jobFilesTool, useJobFiles } from './job-files.js';
import { defaultToolResponseChars, isFastkoreCliResponseLimit, maxFastkoreCliResponseChars } from '../shared/fastkore-cli-response-limit.js';

const cli = '/usr/local/bin/codex';
const workspace = '/runner';
const socket = '/run/bridge-codex/worker.sock';
const workerBodyLimit = 800_000;
const runSchema = {
  type: 'object', additionalProperties: false, required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 128_000 },
    imageUrls: { type: 'array', maxItems: maxChatImages, items: { type: 'string', pattern: chatImageUrlPattern, maxLength: maxChatImageUrlLength } },
    imageQuestion: { type: 'string', maxLength: 60_000 },
    developerInstructions: { type: 'string', minLength: 1, maxLength: 64_000 },
    sessionId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    sessionSlot: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$' },
    expectedAccountId: { type: 'string', maxLength: 100 },
    ephemeral: { type: 'boolean' },
    consultation: { type: 'boolean' },
    consultationKey: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
    steeringKey: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
    workDirectoryId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] },
    executionConcurrency: executionConcurrencySchema,
    toolDefinitions: { type: 'array', maxItems: 200, items: {
      type: 'object', additionalProperties: false, required: ['type', 'name', 'description', 'inputSchema'],
      properties: { type: { const: 'function' }, name: { type: 'string', pattern: '^(?:fastkore_[a-zA-Z0-9_-]{1,55}|library_(?:list|tree|search|read)|internet_(?:search|read|request)|knowledge|freecad_(?:design|linkage)|consult_specialist|my_instructions)$' },
        description: { type: 'string', maxLength: 4000 }, inputSchema: { type: 'object' } },
    } },
  },
};

export function createCodexWorker(codex: CodexRunner = new CodexClient([], 'worker'), jobsRoot = process.env.BRIDGE_CODEX_JOB_FILES,
  accounts?: ExecutionAccountStore) {
  const app = Fastify({ logger: false, bodyLimit: workerBodyLimit, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const active = new Map<AbortController, { accountId?: string; done: Promise<void> }>();
  let activeJobs = 0;
  const activeSessions = new Set<string>();
  let lastLimit = defaultExecutionConcurrency();
  const consultations = new Map<string, { signal: AbortSignal; controller: AbortController; running: boolean }>();
  let accountChange: { id?: string; all?: boolean } | undefined;
  const runner = async (model?: string) => accounts ? accounts.runner((await accounts.select(model)).account.id) : codex;
  const pendingTools = new Map<string, { resolve: (result: CodexToolResult) => void; maxResponseChars: number; acceptsImage: boolean }>();
  const steeringTurns = new Map<string, SteerTurn>();
  const inspectCache = new Map<string, { expires: number; info: Awaited<ReturnType<CodexRunner['inspect']>> }>();
  const inspectAccount = async (accountId: string, executor: CodexRunner, signal?: AbortSignal) => {
    const executionKey = await accounts!.executionKey(accountId);
    const cached = inspectCache.get(executionKey);
    if (cached && cached.expires > Date.now()) return { info: cached.info, executionKey };
    const info = await executor.inspect(cli, signal);
    if (executionConnected(info)) {
      if (inspectCache.size >= 32) {
        for (const [key, entry] of inspectCache) if (entry.expires <= Date.now()) inspectCache.delete(key);
      }
      inspectCache.set(executionKey, { info, expires: Date.now() + 3_000 });
    } else {
      inspectCache.delete(executionKey);
    }
    return { info, executionKey };
  };
  const inspect = async (signal?: AbortSignal, model?: string) => {
    const selection = accounts && await accounts.select(model).catch((error: Error) => ({ error }));
    if (selection && 'error' in selection) return { path: '', version: '', authentication: 'signed-out' as const,
      status: selection.error.message, catalogRevision: accounts?.catalogRevision };
    if (selection && accounts) {
      const { info, executionKey } = await inspectAccount(selection.account.id, accounts.runner(selection.account.id), signal);
      return {
        path: '', version: info.version, authentication: info.authentication,
        status: info.status,
        accountId: executionKey,
        provider: selection.account.provider,
        catalogRevision: accounts.catalogRevision,
      };
    }
    const info = await codex.inspect(cli, signal);
    return {
      path: '', version: info.version, authentication: info.authentication,
      status: info.status,
      accountId: undefined,
      provider: undefined,
      catalogRevision: accounts?.catalogRevision,
    };
  };
  const requireLogin = async (signal?: AbortSignal, model?: string) => {
    const info = await inspect(signal, model);
    if (!executionConnected(info)) throw new BridgeError(info.status, 503);
  };
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof BridgeError ? error.statusCode : (error as { validation?: unknown }).validation ? 400 : 502;
    return reply.code(status).send({ error: error instanceof BridgeError && (_req.url === '/proxy' || _req.url.startsWith('/accounts/'))
      ? error.message : 'Исполнитель модели не выполнил запрос.' });
  });
  app.get('/health', async () => ({ ok: true, active: activeJobs, concurrency: lastLimit }));
  app.post<{ Body: { query: string } }>('/internet/search', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 400 } },
  } } }, async (request, reply) => {
    const account = accounts && (await accounts.list()).accounts.find(account => account.provider === 'glm' && account.active && account.signedIn);
    const key = account && readGlmKey(accounts!.home(account.id));
    if (!key) return { success: false, text: 'Для интернет-поиска нужен активный аккаунт GLM Coding Plan с сохранённым ключом Z.ai.' };
    const stop = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) stop.abort(); });
    return searchZai(request.body.query, key, AbortSignal.any([stop.signal, AbortSignal.timeout(40000)]));
  });
  app.get<{ Querystring: { model?: string } }>('/inspect', request => inspect(undefined, request.query.model));
  app.get('/models', async () => { await requireLogin(); return accounts ? accounts.models(cli) : (await runner()).listModels!(cli); });
  const quotaCache = new Map<string, { expires: number; promise: Promise<CodexLimits | null> }>();
  app.get<{ Querystring: { model?: string } }>('/limits', async request => {
    if (!accounts) return { limits: executionConnected(await inspect()) ? await codex.readLimits!(cli) : null };
    const selection = await accounts.select(request.query.model).catch(() => null);
    if (!selection) return { limits: null };
    const key = await accounts.executionKey(selection.account.id);
    let entry = quotaCache.get(key);
    if (!entry || entry.expires < Date.now()) {
      // One account probe supplies all model rows; concurrent menu requests share this promise.
      const promise = accounts.runner(selection.account.id).readLimits!(cli).catch(() => null);
      entry = { promise, expires: Infinity };
      quotaCache.set(key, entry);
      const current = entry;
      void promise.finally(() => { current.expires = Date.now() + 15000; });
      if (quotaCache.size > 20) for (const [id, cached] of quotaCache) if (cached.expires < Date.now()) quotaCache.delete(id);
    }
    const limits = await entry.promise;
    return { limits: limitsForModel(limits && { ...limits, provider: selection.account.provider }, selection.model) };
  });
  app.get('/accounts', async () => { if (!accounts) throw new BridgeError('Управление аккаунтами недоступно.', 503); return accounts.list(); });
  async function changeAccount<T>(work: () => Promise<T>, options: { id?: string; stop?: boolean; all?: boolean } = {}) {
    if (!accounts) throw new BridgeError('Управление аккаунтами недоступно.', 503);
    if (accountChange) throw new BridgeError('Выполняется другое изменение настроек аккаунта.', 409);
    const affected = [...active].filter(([, run]) => options.all || options.id !== undefined && run.accountId === options.id);
    if (affected.length && !options.stop) throw new BridgeError('Аккаунт выполняет задание.', 409);
    accountChange = options;
    inspectCache.clear();
    try {
      for (const [controller] of affected) controller.abort(new ExecutionAccountStopped());
      await Promise.all(affected.map(([, run]) => run.done));
      return await work();
    } finally {
      inspectCache.clear();
      accountChange = undefined;
    }
  }
  app.post<{ Body: { name: string; provider?: ExecutionProvider } }>('/accounts', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, provider: { enum: executionProviders } },
  } } }, request => changeAccount(() => accounts!.create(request.body.name, request.body.provider)));
  app.post<{ Params: { id: string } }>('/accounts/:id/login', request => changeAccount(() => accounts!.login(request.params.id), { id: request.params.id }));
  app.post<{ Body: { proxyUrl: string } }>('/proxy', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['proxyUrl'], properties: { proxyUrl: { type: 'string', maxLength: 2048 } },
  } } }, request => changeAccount(() => accounts!.setProxy(request.body.proxyUrl), { all: true }));
  app.post<{ Params: { id: string } }>('/accounts/:id/activate', request => changeAccount(() => accounts!.activate(request.params.id), { id: request.params.id }));
  app.post<{ Params: { id: string } }>('/accounts/:id/deactivate', request => changeAccount(() => accounts!.deactivate(request.params.id), { id: request.params.id, stop: true }));
  app.post<{ Params: { id: string } }>('/accounts/:id/remove', request => changeAccount(() => accounts!.remove(request.params.id), { id: request.params.id, stop: true }));
  app.post<{ Params: { id: string }; Body: { code: string } }>('/accounts/:id/code', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 2048 } },
  } } }, request => changeAccount(async () => accounts!.authorizationCode(request.params.id, request.body.code), { id: request.params.id }));
  app.post<{ Params: { id: string }; Body: { key: string; scope?: GigaChatScope } }>('/accounts/:id/key', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 2048 }, scope: { enum: gigaChatScopes } },
  } } }, request => changeAccount(() => accounts!.setKey(request.params.id, request.body.key, request.body.scope), { id: request.params.id }));
  app.post<{ Body: WorkerToolResult }>('/tool-result', { bodyLimit: 6 * maxFastkoreCliResponseChars + maxChatImageUrlLength + 1024, schema: { body: {
    type: 'object', additionalProperties: false, required: ['id', 'success', 'text'],
    properties: { id: { type: 'string', maxLength: 36 }, success: { type: 'boolean' }, text: { type: 'string', maxLength: maxFastkoreCliResponseChars },
      imageUrl: { type: 'string', maxLength: maxChatImageUrlLength, pattern: chatImageUrlPattern } },
  } } }, async request => {
    const pending = pendingTools.get(request.body.id);
    if (!active.size || !pending) throw new BridgeError('Вызов инструмента завершён.', 409);
    if (request.body.text.length > pending.maxResponseChars) throw new BridgeError('Ответ превышает лимит вызова инструмента.', 413);
    if (request.body.imageUrl && (!request.body.success || !pending.acceptsImage)) throw new BridgeError('В этом вызове изображение недопустимо.', 400);
    pendingTools.delete(request.body.id);
    pending.resolve({ success: request.body.success, text: request.body.text, ...(request.body.imageUrl ? { imageUrl: request.body.imageUrl } : {}) });
    return { ok: true };
  });
  app.post<{ Body: WorkerSteer }>('/steer', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['key', 'text'], properties: {
      key: { type: 'string', pattern: '^[0-9a-f-]{36}$' }, text: { type: 'string', minLength: 1, maxLength: 60_000 },
    },
  } } }, async request => ({ result: await steeringTurns.get(request.body.key)?.(request.body.text) ?? 'rejected' }));
  app.post<{ Body: WorkerRun }>('/run', { bodyLimit: workerBodyLimit + maxChatImagePayload, schema: { body: runSchema } }, async (request, reply) => {
    const imagePayload = request.body.imageUrls?.reduce((length, url) => length + url.length, 0) ?? 0;
    if (imagePayload > maxChatImagePayload) {
      throw new BridgeError('Общий размер изображений превышает 20 МБ.', 413);
    }
    const limit = request.body.executionConcurrency ?? defaultExecutionConcurrency();
    if (!validExecutionConcurrency(limit)) throw new BridgeError('Некорректные лимиты исполнителя.', 400);
    lastLimit = limit;
    const consultation = request.body.consultation === true;
    const selection = accounts ? await accounts.select(request.body.model).catch((error: Error) => ({ error })) : undefined;
    const selected = selection && !('error' in selection) ? selection : undefined;
    const accountId = selected?.account.id;
    const lane = selected?.account.provider ?? 'codex';
    const session = request.body.sessionId?.toLowerCase();
    const parent = consultation && request.body.consultationKey ? consultations.get(request.body.consultationKey) : undefined;
    if (consultation) {
      if (!parent || parent.signal.aborted || parent.running || !active.has(parent.controller) ||
        !request.body.ephemeral || request.body.sessionId || request.body.sessionSlot || request.body.workDirectoryId ||
        request.body.toolDefinitions?.some(tool => tool.name === 'consult_specialist')) throw new BridgeError('Консультация недоступна.', 409);
    } else if (activeJobs >= limit || (session && activeSessions.has(session))) {
      // Sent directly: a pre-hijack throw would lose the specific reason to the generic handler.
      return reply.code(409).send({ error: 'Исполнитель занят. Дождитесь завершения задания.' });
    }
    const controller = new AbortController();
    if (parent) parent.running = true;
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    active.set(controller, { accountId, done });
    // A consultation borrows its waiting parent's slot and cannot be nested.
    if (!parent) activeJobs++;
    if (session) activeSessions.add(session);
    const runSignal = parent ? AbortSignal.any([controller.signal, parent.signal]) : controller.signal;
    let provider = 'Исполнитель модели';
    const { raw } = reply;
    raw.once('close', () => controller.abort());
    reply.hijack();
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    async function write(message: WorkerMessage) {
      runSignal.throwIfAborted();
      if (!raw.write(JSON.stringify(message) + '\n')) await once(raw, 'drain', { signal: runSignal });
    }
    try {
      const { toolDefinitions, workDirectoryId, steeringKey, expectedAccountId, executionConcurrency: _executionConcurrency, ...body } = request.body;
      if (expectedAccountId && accountId !== expectedAccountId || accountId && !accounts!.isActive(accountId)) throw new ExecutionAccountStopped();
      if (accountChange?.all || accountId && accountChange?.id === accountId) throw new BridgeError('Настройки аккаунта меняются. Повторите запрос.', 503);
      if (selection && 'error' in selection) throw selection.error;
      const executor = selected ? accounts!.runner(selected.account.id) : codex;
      const info = selected && accounts
        ? (await inspectAccount(selected.account.id, executor, runSignal)).info
        : await executor.inspect(cli, runSignal);
      if (!executionConnected(info)) throw new BridgeError(info.status, 503);
      runSignal.throwIfAborted();
      if (selected) body.model = selected.model;
      if (body.imageUrls?.length && !supportsChatImages(lane)) throw new BridgeError(chatImagesUnsupportedProvider, 503);
      provider = lane === 'antigravity' ? 'Antigravity CLI' : lane === 'gemini' ? 'Gemini CLI' : lane === 'glm' ? 'GLM (Z.ai)' : lane === 'gigachat' ? 'GigaChat' : 'Codex';
      let directory = workspace;
      if (workDirectoryId) {
        if (!jobsRoot || !path.isAbsolute(jobsRoot)) throw new BridgeError('Рабочая папка Codex не настроена.', 503);
        directory = path.join(await realpath(jobsRoot), workDirectoryId);
        if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
          throw new BridgeError('Рабочая папка задания недоступна.', 503);
        }
      }
      runSignal.throwIfAborted();
      const job = { ...body, workDirectoryId, cliPath: cli, workspace: directory, allowWrite: !!workDirectoryId };
      const nativeOffice = job.allowWrite && (lane === 'codex' || lane === 'glm' || lane === 'gigachat');
      const nativeFiles = job.allowWrite && lane === 'gigachat';
      const definitions = [...(toolDefinitions ?? []), ...(nativeOffice ? [jobOfficeTool] : []), ...(nativeFiles ? [jobFilesTool] : [])];
      const result = await executor.run({ ...job,
        ...(definitions.length ? { tools: { definitions, async call(name: string, args: unknown, signal: AbortSignal) {
          if (nativeOffice && name === jobOfficeTool.name) return runJobOffice(job, args, AbortSignal.any([signal, runSignal]), lane === 'gigachat');
          if (nativeFiles && name === jobFilesTool.name) return { success: true, text: await useJobFiles(job, args, AbortSignal.any([signal, runSignal])) };
          if (!toolDefinitions?.some(tool => tool.name === name)) return { success: false, text: 'Инструмент не разрешён для этого запроса.' };
          const id = randomUUID();
          const stop = AbortSignal.any([signal, runSignal, AbortSignal.timeout(name === 'consult_specialist' ? 195_000 :
            (name.startsWith('fastkore_cli_') || name.startsWith('freecad_') || name === 'fastkore_read_attachment') ? 125_000 : 45_000)]);
          if (name === 'consult_specialist') consultations.set(id, { signal: stop, controller, running: false });
          const requestedLimit = name === 'fastkore_cli_execute' && args && typeof args === 'object'
            ? (args as Record<string, unknown>).maxResponseChars : undefined;
          const maxResponseChars = isFastkoreCliResponseLimit(requestedLimit) ? requestedLimit : defaultToolResponseChars;
          const result = new Promise<CodexToolResult>(resolve => pendingTools.set(id, { resolve, maxResponseChars, acceptsImage: name === 'fastkore_cli_html_image' || name === 'fastkore_read_attachment' }));
          const cancel = () => pendingTools.get(id)?.resolve({ success: false, text: 'Вызов инструмента не завершён.' });
          stop.addEventListener('abort', cancel, { once: true });
          try {
            stop.throwIfAborted();
            await write({ toolCall: { id, name, args } });
            return await result;
          } finally {
            consultations.delete(id);
            stop.removeEventListener('abort', cancel); pendingTools.delete(id);
          }
        } } } : {}),
      }, event => write({ event }), runSignal, !consultation && steeringKey ? steer => {
        if (steer) steeringTurns.set(steeringKey, steer);
        else steeringTurns.delete(steeringKey);
        void write({ event: { kind: steer ? 'steer-ready' : 'steer-closed' } }).catch(() => {});
      } : undefined);
      await write({ result });
    } catch (error) {
      if (error instanceof ExecutionAccountStopped || runSignal.reason instanceof ExecutionAccountStopped) {
        if (!raw.destroyed) raw.write(JSON.stringify({ accountStopped: true } satisfies WorkerMessage) + '\n');
      } else if (!runSignal.aborted) {
        await write({ error: error instanceof BridgeError && error.statusCode === 503 ? error.message : `${provider} не смог выполнить запрос. Проверьте подключение и лимиты.` }).catch(() => {});
      }
    } finally {
      if (!consultation && request.body.steeringKey) steeringTurns.delete(request.body.steeringKey);
      if (parent) parent.running = false;
      active.delete(controller);
      if (!parent) activeJobs--;
      if (session) activeSessions.delete(session);
      raw.end();
      finished();
    }
  });
  app.addHook('preClose', async () => { for (const controller of active.keys()) controller.abort(); });
  app.addHook('onClose', async () => { accounts?.close(); });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const previous = await lstat(socket).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (previous) {
    if (!previous.isSocket()) throw new Error('Путь исполнителя занят.');
    await unlink(socket);
  }
  process.umask(0o077);
  const worker = createCodexWorker(undefined, undefined, new ExecutionAccountStore(process.env.CODEX_HOME!));
  await worker.listen({ path: socket });
  await chmod(socket, 0o600);
  const stop = () => { void worker.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
