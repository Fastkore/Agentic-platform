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
      assert.equal(request.prompt, 'Только тестовый текст.');
      assert.match(request.developerInstructions!, /Общие инструкции агента/);
      if (request.tools) assert.deepEqual(await request.tools.call('fastkore_GetCurrentUserInfo', {}, new AbortController().signal), { success: true, text: 'Пользователь ERP' });
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
