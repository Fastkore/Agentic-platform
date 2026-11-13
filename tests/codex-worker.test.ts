import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexWorker } from '../server/codex-worker.js';
import { RemoteCodexRunner } from '../server/codex-remote.js';
import { withFastkoreCliDescription } from '../server/codex-tools.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import type { CodexRunner } from '../server/codex.js';
import type { CliInfo } from '../shared/types.js';

test('isolated worker transports login status, limits and chat over a private socket', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-worker-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-' + randomUUID() : path.join(root, 'worker.sock');
  const store = new Store(root);
  let authentication: CliInfo['authentication'] = 'signed-out';
  const sessionId = randomUUID();
  const usage = { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 };
  let usedPercent = 11;
  const limits = () => ({ buckets: [{ name: 'Codex', windows: [{ usedPercent, windowDurationMins: 300, resetsAt: null }] }], resetsAvailable: null });
  const fake: CodexRunner = {
    inspect: async () => ({ path: '/fake', version: '0.167.1', authentication, status: 'Fixture' }),
    listModels: async () => ({ models: [{ id: 'test', name: 'Test', description: '', isDefault: true }], fetchedAt: new Date().toISOString(), source: 'codex' }),
    readLimits: async () => limits(),
    run: async (request, event) => {
      assert.equal(request.workspace, '/runner');
      assert.equal(request.allowWrite, false);
      assert.ok(request.prompt.endsWith('Только тестовый текст.'));
      assert.match(request.developerInstructions!, /Общие инструкции агента/);
      if (request.tools?.definitions.some(tool => tool.name === 'fastkore_GetCurrentUserInfo')) assert.deepEqual(await request.tools.call('fastkore_GetCurrentUserInfo', {}, new AbortController().signal), { success: true, text: 'Пользователь ERP' });
      if (request.tools?.definitions.some(tool => tool.name === 'knowledge')) {
        const result = await request.tools.call('knowledge', { action: 'index', section: 'fastkore' }, new AbortController().signal);
        assert.equal(result.success, true);
        assert.equal(JSON.parse(result.text).files.length, 4);
      }
      await event({ kind: 'session', text: sessionId });
      await event({ kind: 'message', text: 'Проверено.' });
      await event({ kind: 'usage', usage });
      usedPercent = 12;
      return { sessionId, response: 'Проверено.', usage };
    },
  };
  const worker = createCodexWorker(fake);
  const remote = new RemoteCodexRunner(socket);
  const workspace = new Workspace(store, remote);
  try {
    await worker.listen({ path: socket });
    const project = await workspace.addProject(root, 'Тест');
    const chat = await workspace.addChat(project.id);
    assert.equal((await workspace.codexConnection())?.authentication, 'signed-out');
    assert.equal(await workspace.limits(), null);
    await assert.rejects(workspace.send(project.id, chat.id, 'Только тестовый текст.', []), /вход в ChatGPT/i);
    assert.equal(workspace.queuedRuns.length, 0);
    authentication = 'chatgpt';
    assert.equal((await workspace.codexConnection(true))?.authentication, 'chatgpt');
    assert.deepEqual(await workspace.limits(), limits());
    assert.equal(workspace.codexLimitsRevision, 0);
    assert.equal((await workspace.models()).models[0].id, 'test');
    await assert.rejects(workspace.send(project.id, chat.id, 'Только тестовый текст.', ['file']), /вложение не найдено/i);
    const run = await workspace.send(project.id, chat.id, 'Только тестовый текст.', []);
    const deadline = Date.now() + 5000;
    while (!run.completedAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(run.status, 'complete');
    assert.equal(run.response, 'Проверено.');
    assert.deepEqual(run.usage, usage);
    assert.equal(chat.sessionId, sessionId);
    assert.equal(workspace.codexLimitsRevision, 1);
    assert.deepEqual(await workspace.limits(), limits());
    const toolRun = await remote.run({ cliPath: '/unused', workspace: '/unused', allowWrite: false, prompt: 'Только тестовый текст.',
      developerInstructions: 'Общие инструкции агента', tools: {
        definitions: [{ type: 'function', name: 'fastkore_GetCurrentUserInfo', description: 'ERP identity', inputSchema: { type: 'object' } }],
        async call(name, args) { assert.equal(name, 'fastkore_GetCurrentUserInfo'); assert.deepEqual(args, {}); return { success: true, text: 'Пользователь ERP' }; },
      },
    }, async () => {}, new AbortController().signal);
    assert.equal(toolRun.response, 'Проверено.');
  } finally {
    await workspace.shutdown();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('the worker admits an ephemeral specialist only while its main turn is waiting for a consultation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-worker-consultation-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-' + randomUUID() : path.join(root, 'worker.sock');
  const fake: CodexRunner = {
    inspect: async () => ({ path: '/fake', version: 'test', authentication: 'chatgpt', status: '' }),
    async run(request, _event, signal) {
      if (request.consultation) {
        assert.equal(request.ephemeral, true);
        assert.equal(request.sessionId, undefined);
        assert.equal(request.allowWrite, false);
        const tool = await request.tools!.call('project_files_list', {}, signal);
        return { response: tool.text };
      }
      const tool = await request.tools!.call('consult_specialist', {}, signal);
      return { response: tool.text };
    },
  };
  const worker = createCodexWorker(fake);
  const remote = new RemoteCodexRunner(socket);
  const signal = new AbortController().signal;
  const request = { cliPath: '/unused', workspace: '/unused', allowWrite: false, prompt: 'Проверить вопрос' };
  const toolDefinition = (name: string) => ({ type: 'function' as const, name, description: name, inputSchema: { type: 'object' } });
  const child = { ...request, consultation: true, ephemeral: true, tools: {
    definitions: [toolDefinition('project_files_list')],
    async call() { return { success: true, text: 'Источники проверены.' }; },
  } };
  try {
    await worker.listen({ path: socket });
    await assert.rejects(remote.run(child, async () => {}, signal), { statusCode: 409 });
    const parent = await remote.run({ ...request, tools: {
      definitions: [toolDefinition('consult_specialist')],
      async call(_name, _args, signal) {
        await assert.rejects(remote.run({ ...child, sessionId: randomUUID() }, async () => {}, signal), { statusCode: 409 });
        const result = await remote.run(child, async () => {}, signal);
        return { success: true, text: result.response };
      },
    } }, async () => {}, signal);
    assert.equal(parent.response, 'Источники проверены.');
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI tools expose only fixed offline descriptions and recheck the session', async () => {
  const calls: string[] = [];
  let authorized = true;
  const tools = withFastkoreCliDescription({ definitions: [], call: async () => ({ success: false, text: '' }) }, async command => {
    calls.push(command);
    return { authenticated: false, erpReadAvailable: false };
  }, () => { if (!authorized) throw new Error('Session ended'); });
  const signal = new AbortController().signal;
  assert.equal((await tools.call('fastkore_cli_describe', { command: 'data query', password: 'ignored' }, signal)).success, false);
  assert.equal((await tools.call('fastkore_cli_describe', { command: 'data delete' }, signal)).success, false);
  assert.deepEqual(calls, []);
  assert.match((await tools.call('fastkore_cli_describe', { command: 'data query' }, signal)).text, /"erpReadAvailable":false/);
  authorized = false;
  await assert.rejects(tools.call('fastkore_cli_describe', { command: 'data get' }, signal), /Session ended/);
  assert.deepEqual(calls, ['data-query']);
});

test('different providers run in parallel; the same provider serializes with a clear refusal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-parallel-'));
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { ExecutionAccountStore } = await import('../server/execution-accounts.js');
  const store = new ExecutionAccountStore(root);
  const gemini = await store.create('Google', 'gemini');
  await mkdir(path.join(store.home(gemini.id), '.gemini'), { recursive: true });
  await writeFile(path.join(store.home(gemini.id), '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'private-google' }));
  const glm = await store.create('GLM', 'glm');
  await writeFile(path.join(store.home(glm.id), 'config.toml'), 'model_provider = "ZAI"\nexperimental_bearer_token = "zai-key-1234567890abcdef1234567890"\n');
  await store.activate(gemini.id);
  await store.activate(glm.id);
  const sessionId = randomUUID();
  const gates = new Map<string, () => void>();
  const started = new Set<string>();
  store.runner = (id = store.active) => {
    const provider = id === gemini.id ? 'gemini' : 'glm';
    return {
      inspect: async () => ({ path: '', version: 'fake', authentication: provider === 'gemini' ? 'google' as const : 'glm' as const, status: '', provider }),
      listModels: async () => ({ models: [{ id: 'gm-x', name: 'X', description: '', isDefault: true }], fetchedAt: new Date().toISOString(), source: provider as 'gemini' | 'glm' }),
      readLimits: async () => null,
      run: async (request: { prompt: string }, event: (input: unknown) => Promise<void>) => {
        started.add(provider);
        await new Promise<void>(resolve => gates.set(provider, resolve));
        await event({ kind: 'session', text: sessionId });
        return { sessionId, response: 'OK-' + provider };
      },
    } as unknown as ReturnType<typeof store.runner>;
  };
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-par-' + randomUUID() : path.join(root, 'worker.sock');
  const worker = createCodexWorker(undefined, undefined, store);
  try {
    await worker.listen({ path: socket });
    const pendingGemini = worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Первый', model: 'gemini/gm-x' } });
    await new Promise(resolve => setTimeout(resolve, 60));
    const pendingGlm = worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Второй', model: 'glm/gm-x' } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(started.has('gemini') && started.has('glm'), 'both providers must be running at the same time');
    const blocked = await worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Третий', model: 'gemini/gm-x' } });
    assert.equal(blocked.statusCode, 409);
    assert.match(JSON.parse(blocked.body).error, /занят/);
    gates.get('gemini')!(); gates.get('glm')!();
    const first = await pendingGemini, second = await pendingGlm;
    assert.equal(JSON.parse(first.body.trim().split('\n').at(-1)!).result.response, 'OK-gemini');
    assert.equal(JSON.parse(second.body.trim().split('\n').at(-1)!).result.response, 'OK-glm');
  } finally { await worker.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('parallel specialist consultations keep their parent cancellation and tool results separate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-consult-parallel-'));
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { ExecutionAccountStore } = await import('../server/execution-accounts.js');
  const accounts = new ExecutionAccountStore(root);
  const google = await accounts.create('Google', 'gemini');
  await mkdir(path.join(accounts.home(google.id), '.gemini'));
  await writeFile(path.join(accounts.home(google.id), '.gemini', 'oauth_creds.json'), '{"refresh_token":"fixture"}');
  await writeFile(path.join(root, 'auth.json'), '{"tokens":{"access_token":"fixture"}}');
  await accounts.activate(google.id); await accounts.activate('default');
  const children = new Map<string, { signal: AbortSignal; release: () => void }>();
  accounts.runner = (id = accounts.active) => ({
    inspect: async () => ({ path: '', version: 'fake', authentication: id === 'default' ? 'chatgpt' : 'google', status: '' }),
    run: async (request, _event, signal) => {
      if (request.consultation) {
        await new Promise<void>((resolve, reject) => {
          children.set(id, { signal, release: resolve });
          signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
        });
        return { response: id };
      }
      const result = await request.tools!.call('consult_specialist', {}, signal);
      return { response: result.text };
    },
  });
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\consult-' + randomUUID() : path.join(root, 'worker.sock');
  const worker = createCodexWorker(undefined, undefined, accounts), remote = new RemoteCodexRunner(socket);
  const stopA = new AbortController();
  const base = { cliPath: '', workspace: root, allowWrite: false, prompt: 'Test' };
  const parent = (model: string, signal: AbortSignal) => remote.run({ ...base, model, tools: {
    definitions: [{ type: 'function', name: 'consult_specialist', description: '', inputSchema: { type: 'object' } }],
    call: async (_name, _args, childSignal) => {
      const result = await remote.run({ ...base, model, consultation: true, ephemeral: true }, async () => {}, childSignal);
      return { success: true, text: result.response };
    },
  } }, async () => {}, signal);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await worker.listen({ path: socket });
    const a = parent('codex/test', stopA.signal).then(() => 'completed', () => 'cancelled');
    const b = parent('gemini/test', AbortSignal.timeout(10000));
    await until(() => children.size === 2);
    stopA.abort(); await until(() => children.get('default')!.signal.aborted);
    assert.equal(children.get(google.id)!.signal.aborted, false);
    children.get(google.id)!.release();
    assert.equal((await b).response, google.id);
    assert.equal(await a, 'cancelled');
  } finally {
    stopA.abort(); for (const child of children.values()) child.release(); await worker.close(); await rm(root, { recursive: true, force: true });
  }
});
