import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexWorker } from '../server/codex-worker.js';
import { RemoteCodexRunner } from '../server/codex-remote.js';
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
    await assert.rejects(workspace.send(project.id, chat.id, 'Только тестовый текст.', ['file']), /только текст/i);
    const run = await workspace.send(project.id, chat.id, 'Только тестовый текст.', []);
    const deadline = Date.now() + 5000;
    while (!run.completedAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(run.status, 'complete');
    assert.equal(run.response, 'Проверено.');
    assert.deepEqual(run.usage, usage);
    assert.equal(chat.sessionId, sessionId);
    assert.equal(workspace.codexLimitsRevision, 1);
    assert.deepEqual(await workspace.limits(), limits());
  } finally {
    await workspace.shutdown();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
