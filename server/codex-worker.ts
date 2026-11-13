import Fastify from 'fastify';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient, type CodexRunner } from './codex.js';
import type { WorkerMessage, WorkerRun, WorkerToolResult } from './codex-remote.js';
import type { CodexToolResult } from './codex-tools.js';
import { BridgeError } from './store.js';
import { ExecutionAccountStore } from './execution-accounts.js';
import { executionConnected } from '../shared/execution-accounts.js';
import type { CodexLimits } from '../shared/types.js';
import { limitsForModel } from './google-limits.js';

const cli = '/usr/local/bin/codex';
const workspace = '/runner';
const socket = '/run/bridge-codex/worker.sock';
const runSchema = {
  type: 'object', additionalProperties: false, required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 128_000 },
    developerInstructions: { type: 'string', minLength: 1, maxLength: 64_000 },
    sessionId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$' },
    ephemeral: { type: 'boolean' },
    consultation: { type: 'boolean' },
    consultationKey: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
    workDirectoryId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] },
    toolDefinitions: { type: 'array', maxItems: 200, items: {
      type: 'object', additionalProperties: false, required: ['type', 'name', 'description', 'inputSchema'],
      properties: { type: { const: 'function' }, name: { type: 'string', pattern: '^(?:fastkore_[a-zA-Z0-9_-]{1,55}|project_files_(?:list|read)|knowledge|consult_specialist)$' },
        description: { type: 'string', maxLength: 4000 }, inputSchema: { type: 'object' } },
    } },
  },
};

export function createCodexWorker(codex: CodexRunner = new CodexClient([], 'worker'), jobsRoot = process.env.BRIDGE_CODEX_JOB_FILES,
  accounts?: ExecutionAccountStore) {
  const app = Fastify({ logger: false, bodyLimit: 800_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  // One concurrent run per executor provider; different providers run in parallel.
  const activeLanes = new Map<string, AbortController>();
  const consultations = new Map<string, { signal: AbortSignal; controller: AbortController; lane: string; running: boolean }>();
  let changingAccount = false;
  const runner = async (model?: string) => accounts ? accounts.runner((await accounts.select(model)).account.id) : codex;
  const pendingTools = new Map<string, (result: CodexToolResult) => void>();
  const inspect = async (signal?: AbortSignal, model?: string) => {
    const selection = accounts && await accounts.select(model).catch((error: Error) => ({ error }));
    if (selection && 'error' in selection) return { path: '', version: '', authentication: 'signed-out' as const, status: selection.error.message };
    const info = await (selection ? accounts!.runner(selection.account.id) : codex).inspect(cli, signal);
    return {
      path: '', version: info.version, authentication: info.authentication,
      status: info.status,
      accountId: selection && await accounts!.executionKey(selection.account.id),
      provider: selection?.account.provider,
    };
  };
  const requireLogin = async (signal?: AbortSignal, model?: string) => {
    const info = await inspect(signal, model);
    if (!executionConnected(info)) throw new BridgeError(info.status, 503);
  };
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof BridgeError ? error.statusCode : (error as { validation?: unknown }).validation ? 400 : 502;
    return reply.code(status).send({ error: 'Исполнитель Codex не выполнил запрос.' });
  });
  app.get('/health', async () => ({ ok: true }));
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
  async function changeAccount<T>(work: () => Promise<T>) {
    if (!accounts || activeLanes.size || changingAccount) throw new BridgeError('Дождитесь завершения задания.', 409);
    changingAccount = true;
    try { return await work(); } finally { changingAccount = false; }
  }
  app.post<{ Body: { name: string; provider?: 'codex' | 'gemini' | 'antigravity' | 'glm' } }>('/accounts', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, provider: { enum: ['codex', 'gemini', 'antigravity', 'glm'] } },
  } } }, request => changeAccount(() => accounts!.create(request.body.name, request.body.provider)));
  app.post<{ Params: { id: string } }>('/accounts/:id/login', request => changeAccount(() => accounts!.login(request.params.id)));
  app.post<{ Params: { id: string } }>('/accounts/:id/activate', request => changeAccount(() => accounts!.activate(request.params.id)));
  app.post<{ Params: { id: string } }>('/accounts/:id/deactivate', request => changeAccount(() => accounts!.deactivate(request.params.id)));
  app.post<{ Params: { id: string } }>('/accounts/:id/remove', request => changeAccount(() => accounts!.remove(request.params.id)));
  app.post<{ Params: { id: string }; Body: { code: string } }>('/accounts/:id/code', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 2048 } },
  } } }, request => changeAccount(async () => accounts!.authorizationCode(request.params.id, request.body.code)));
  app.post<{ Params: { id: string }; Body: { key: string } }>('/accounts/:id/key', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 2048 } },
  } } }, request => changeAccount(() => accounts!.setKey(request.params.id, request.body.key)));
  app.post<{ Body: WorkerToolResult }>('/tool-result', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['id', 'success', 'text'],
    properties: { id: { type: 'string', maxLength: 36 }, success: { type: 'boolean' }, text: { type: 'string', maxLength: 96_000 } },
  } } }, async request => {
    const resolve = pendingTools.get(request.body.id);
    if (!activeLanes.size || !resolve) throw new BridgeError('Вызов инструмента завершён.', 409);
    pendingTools.delete(request.body.id);
    resolve({ success: request.body.success, text: request.body.text });
    return { ok: true };
  });
  app.post<{ Body: WorkerRun }>('/run', { schema: { body: runSchema } }, async (request, reply) => {
    const consultation = request.body.consultation === true;
    const selection = accounts ? await accounts.select(request.body.model).catch((error: Error) => ({ error })) : undefined;
    const lane = selection && !('error' in selection) ? selection.account.provider : 'codex';
    const parent = consultation && request.body.consultationKey ? consultations.get(request.body.consultationKey) : undefined;
    if (consultation) {
      if (!parent || parent.signal.aborted || parent.running || activeLanes.get(parent.lane) !== parent.controller ||
        (activeLanes.has(lane) && lane !== parent.lane) ||
        !request.body.ephemeral || request.body.sessionId || request.body.workDirectoryId ||
        request.body.toolDefinitions?.some(tool => tool.name === 'consult_specialist')) throw new BridgeError('Консультация недоступна.', 409);
    } else if (activeLanes.has(lane) || changingAccount) {
      // Sent directly: a pre-hijack throw would lose the specific reason to the generic handler.
      return reply.code(409).send({ error: 'Исполнитель этого провайдера занят. Дождитесь завершения задания.' });
    }
    const controller = new AbortController();
    if (parent) parent.running = true;
    if (!activeLanes.has(lane)) activeLanes.set(lane, controller);
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
      await requireLogin(runSignal, request.body.model);
      const { toolDefinitions, workDirectoryId, ...body } = request.body;
      const selected = selection && !('error' in selection) ? selection : undefined;
      if (selected) body.model = selected.model;
      provider = selected?.account.provider === 'antigravity' ? 'Antigravity CLI' : selected?.account.provider === 'gemini' ? 'Gemini CLI' : selected?.account.provider === 'glm' ? 'GLM (Z.ai)' : 'Codex';
      let directory = workspace;
      if (workDirectoryId) {
        if (!jobsRoot || !path.isAbsolute(jobsRoot)) throw new BridgeError('Рабочая папка Codex не настроена.', 503);
        directory = path.join(await realpath(jobsRoot), workDirectoryId);
        if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
          throw new BridgeError('Рабочая папка задания недоступна.', 503);
        }
      }
      const executor = selected ? accounts!.runner(selected.account.id) : codex;
      const result = await executor.run({ ...body, workDirectoryId, cliPath: cli, workspace: directory, allowWrite: !!workDirectoryId,
        ...(toolDefinitions?.length ? { tools: { definitions: toolDefinitions, async call(name: string, args: unknown, signal: AbortSignal) {
          if (!toolDefinitions.some(tool => tool.name === name)) return { success: false, text: 'Инструмент не разрешён для этого запроса.' };
          const id = randomUUID();
          const stop = AbortSignal.any([signal, runSignal, AbortSignal.timeout(name === 'consult_specialist' ? 195_000 : 45_000)]);
          if (name === 'consult_specialist') consultations.set(id, { signal: stop, controller, lane, running: false });
          const result = new Promise<CodexToolResult>(resolve => pendingTools.set(id, resolve));
          const cancel = () => pendingTools.get(id)?.({ success: false, text: 'Вызов инструмента не завершён.' });
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
      }, event => write({ event }), runSignal);
      await write({ result });
    } catch (error) {
      if (!runSignal.aborted) {
        await write({ error: error instanceof BridgeError && error.statusCode === 503 ? error.message : `${provider} не смог выполнить запрос. Проверьте подключение и лимиты.` }).catch(() => {});
      }
    } finally {
      if (parent) parent.running = false;
      if (activeLanes.get(lane) === controller) activeLanes.delete(lane);
      raw.end();
    }
  });
  app.addHook('preClose', async () => { for (const controller of activeLanes.values()) controller.abort(); });
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
