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

const cli = '/usr/local/bin/codex';
const workspace = '/runner';
const socket = '/run/bridge-codex/worker.sock';
const runSchema = {
  type: 'object', additionalProperties: false, required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 128_000 },
    developerInstructions: { type: 'string', minLength: 1, maxLength: 50_000 },
    sessionId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$' },
    ephemeral: { type: 'boolean' },
    workDirectoryId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] },
    toolDefinitions: { type: 'array', maxItems: 200, items: {
      type: 'object', additionalProperties: false, required: ['type', 'name', 'description', 'inputSchema'],
      properties: { type: { const: 'function' }, name: { type: 'string', pattern: '^(?:fastkore_[a-zA-Z0-9_-]{1,55}|project_files_(?:list|read))$' },
        description: { type: 'string', maxLength: 4000 }, inputSchema: { type: 'object' } },
    } },
  },
};

export function createCodexWorker(codex: CodexRunner = new CodexClient([], 'worker'), jobsRoot = process.env.BRIDGE_CODEX_JOB_FILES) {
  const app = Fastify({ logger: false, bodyLimit: 800_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  let active: AbortController | undefined;
  const pendingTools = new Map<string, (result: CodexToolResult) => void>();
  const inspect = async (signal?: AbortSignal) => {
    const info = await codex.inspect(cli, signal);
    return {
      path: '', version: info.version, authentication: info.authentication,
      status: info.authentication === 'chatgpt' ? 'Вход через ChatGPT выполнен.' : 'Войдите в ChatGPT в контейнере исполнителя.',
    };
  };
  const requireLogin = async (signal?: AbortSignal) => {
    if ((await inspect(signal)).authentication !== 'chatgpt') throw new BridgeError('Требуется вход в ChatGPT на исполнителе.', 503);
  };
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof BridgeError ? error.statusCode : (error as { validation?: unknown }).validation ? 400 : 502;
    return reply.code(status).send({ error: 'Исполнитель Codex не выполнил запрос.' });
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/inspect', () => inspect());
  app.get('/models', async () => { await requireLogin(); return codex.listModels!(cli); });
  app.get('/limits', async () => ({ limits: (await inspect()).authentication === 'chatgpt' ? await codex.readLimits!(cli) : null }));
  app.post<{ Body: WorkerToolResult }>('/tool-result', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['id', 'success', 'text'],
    properties: { id: { type: 'string', maxLength: 36 }, success: { type: 'boolean' }, text: { type: 'string', maxLength: 96_000 } },
  } } }, async request => {
    const resolve = pendingTools.get(request.body.id);
    if (!active || !resolve) throw new BridgeError('Вызов инструмента завершён.', 409);
    pendingTools.delete(request.body.id);
    resolve({ success: request.body.success, text: request.body.text });
    return { ok: true };
  });
  app.post<{ Body: WorkerRun }>('/run', { schema: { body: runSchema } }, async (request, reply) => {
    if (active) throw new BridgeError('Исполнитель занят.', 409);
    const controller = new AbortController();
    active = controller;
    const { raw } = reply;
    raw.once('close', () => controller.abort());
    reply.hijack();
    raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    async function write(message: WorkerMessage) {
      controller.signal.throwIfAborted();
      if (!raw.write(JSON.stringify(message) + '\n')) await once(raw, 'drain', { signal: controller.signal });
    }
    try {
      await requireLogin(controller.signal);
      const { toolDefinitions, workDirectoryId, ...body } = request.body;
      let directory = workspace;
      if (workDirectoryId) {
        if (!jobsRoot || !path.isAbsolute(jobsRoot)) throw new BridgeError('Рабочая папка Codex не настроена.', 503);
        directory = path.join(await realpath(jobsRoot), workDirectoryId);
        if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
          throw new BridgeError('Рабочая папка задания недоступна.', 503);
        }
      }
      const result = await codex.run({ ...body, cliPath: cli, workspace: directory, allowWrite: !!workDirectoryId,
        ...(toolDefinitions?.length ? { tools: { definitions: toolDefinitions, async call(name: string, args: unknown, signal: AbortSignal) {
          if (!toolDefinitions.some(tool => tool.name === name)) return { success: false, text: 'Инструмент не разрешён для этого запроса.' };
          const id = randomUUID();
          const stop = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(45_000)]);
          const result = new Promise<CodexToolResult>(resolve => pendingTools.set(id, resolve));
          const cancel = () => pendingTools.get(id)?.({ success: false, text: 'Вызов Fastkore не завершён. Проверьте результат чтением.' });
          stop.addEventListener('abort', cancel, { once: true });
          try {
            stop.throwIfAborted();
            await write({ toolCall: { id, name, args } });
            return await result;
          } finally { stop.removeEventListener('abort', cancel); pendingTools.delete(id); }
        } } } : {}),
      }, event => write({ event }), controller.signal);
      await write({ result });
    } catch (error) {
      if (!controller.signal.aborted) {
        await write({ error: error instanceof BridgeError && error.statusCode === 503 ? error.message : 'Codex не смог выполнить запрос. Проверьте подключение и лимиты.' }).catch(() => {});
      }
    } finally {
      pendingTools.clear();
      active = undefined;
      raw.end();
    }
  });
  app.addHook('preClose', async () => { active?.abort(); });
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
  const worker = createCodexWorker();
  await worker.listen({ path: socket });
  await chmod(socket, 0o600);
  const stop = () => { void worker.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
