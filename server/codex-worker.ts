import Fastify from 'fastify';
import { once } from 'node:events';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient, type CodexRunner } from './codex.js';
import type { WorkerMessage, WorkerRun } from './codex-remote.js';
import { BridgeError } from './store.js';

const cli = '/usr/local/bin/codex';
const workspace = '/runner';
const socket = '/run/bridge-codex/worker.sock';
const runSchema = {
  type: 'object', additionalProperties: false, required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 128_000 },
    sessionId: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$' },
    ephemeral: { type: 'boolean' },
    reasoningEffort: { enum: ['low', 'medium', 'high', 'xhigh'] },
  },
};

export function createCodexWorker(codex: CodexRunner = new CodexClient([], 'worker')) {
  const app = Fastify({ logger: false, bodyLimit: 800_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  let active: AbortController | undefined;
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
      const result = await codex.run({ ...request.body, cliPath: cli, workspace, allowWrite: false }, event => write({ event }), controller.signal);
      await write({ result });
    } catch (error) {
      if (!controller.signal.aborted) {
        await write({ error: error instanceof BridgeError && error.statusCode === 503 ? error.message : 'Codex не смог выполнить запрос. Проверьте подключение и лимиты.' }).catch(() => {});
      }
    } finally {
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
