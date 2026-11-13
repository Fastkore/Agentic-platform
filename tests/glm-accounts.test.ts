import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ExecutionAccountStore } from '../server/execution-accounts.js';
import { GlmClient, glmFailure, readGlmKey, writeGlmConfig } from '../server/glm.js';
import { createCodexWorker } from '../server/codex-worker.js';
import { BridgeError } from '../server/store.js';
import { executionConnected, providerForModel } from '../shared/execution-accounts.js';

const validKey = 'zai-key-1234567890abcdef1234567890';
const otherKey = 'zai-key-9876543210abcdef1234567890';
const catalogFixture = { models: [{ slug: 'glm-5.3', display_name: 'GLM-5.3', description: 'Флагманская модель Z.ai.' }] };

// A local stand-in for api.z.ai: GET /models validates the bearer key and returns the catalog.
async function glmBackend(status = 200) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.authorization ?? ''));
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? JSON.stringify(catalogFixture) : '{"error": "invalid key"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0), seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function withGlmBackend<T>(work: (backend: Awaited<ReturnType<typeof glmBackend>>) => Promise<T>, status = 200) {
  const backend = await glmBackend(status);
  const previous = process.env.BRIDGE_GLM_BASE_URL;
  process.env.BRIDGE_GLM_BASE_URL = backend.url;
  try { return await work(backend); } finally { if (previous === undefined) delete process.env.BRIDGE_GLM_BASE_URL; else process.env.BRIDGE_GLM_BASE_URL = previous; await backend.close(); }
}

test('glm models route to the glm provider and glm keys count as connected', () => {
  assert.equal(providerForModel('glm/glm-5.3'), 'glm');
  assert.equal(providerForModel('glm-auto'), 'glm');
  assert.equal(providerForModel('glm-5.3'), 'glm');
  assert.equal(providerForModel('gpt-6.1-sol'), 'codex');
  assert.ok(executionConnected({ authentication: 'glm' }));
  assert.ok(!executionConnected({ authentication: 'api-key' }));
  assert.ok(!executionConnected({ authentication: 'signed-out' }));
});

test('glm account validates its key with Z.ai, keeps it private and rotates the execution identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-glm-'));
  const store = new ExecutionAccountStore(root);
  try {
    const account = await store.create('Рабочий GLM', 'glm');
    assert.equal((await store.list()).accounts.find(item => item.id === account.id)?.signedIn, false);
    assert.ok(await store.setKey(account.id, 'short-key').catch(error => error instanceof BridgeError));
    await assert.rejects(store.login(account.id), /API-ключ/);
    await assert.rejects(store.setKey('default', validKey), /только к аккаунту GLM/);
    await withGlmBackend(async () => {
      await assert.rejects(store.setKey(account.id, 'wrong-format-but-long-enough-key!'), /некорректно/);
      const saved = (await store.setKey(account.id, validKey)).accounts.find(item => item.id === account.id)!;
      assert.equal(saved.signedIn, true);
      assert.ok(!JSON.stringify(saved).includes(validKey), 'the key must never appear in account listings');
      assert.equal(readGlmKey(store.home(account.id)), validKey);
    });
    assert.ok(store.runner(account.id) instanceof GlmClient);
    const identity = await store.executionKey(account.id);
    await withGlmBackend(async () => { await store.setKey(account.id, otherKey); });
    assert.notEqual(await store.executionKey(account.id), identity);
    await store.deactivate('default');
    await store.activate(account.id);
    assert.equal(store.provider, 'glm');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('z.ai rejecting the key blocks the save', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-glm-reject-'));
  const store = new ExecutionAccountStore(root);
  try {
    const account = await store.create('GLM', 'glm');
    await withGlmBackend(async backend => {
      await assert.rejects(store.setKey(account.id, validKey), /Z\.ai отклонил ключ/);
      assert.deepEqual(backend.seen, ['Bearer ' + validKey], 'the key must be sent to Z.ai as the bearer token');
    }, 401);
    assert.equal((await store.list()).accounts.find(item => item.id === account.id)?.signedIn, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('glm catalog and connection state come from the platform-written config', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bridge-glm-home-'));
  try {
    const client = new GlmClient(home);
    assert.equal((await client.inspect()).authentication, 'signed-out');
    await assert.rejects(client.listModels(), /Сохраните ключ/);
    await withGlmBackend(async () => { await writeGlmConfig(home, validKey); });
    const info = await client.inspect();
    assert.equal(info.authentication, 'glm');
    assert.ok(executionConnected(info));
    const catalog = await client.listModels();
    assert.equal(catalog.source, 'glm');
    assert.deepEqual(catalog.models.map(model => model.id), ['glm-auto', 'glm-5.3']);
    assert.equal(catalog.models[0].isDefault, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(home, 'models.json'), 'utf8')), catalogFixture, 'the saved catalog matches the Z.ai response shape');
    const config = await readFile(path.join(home, 'config.toml'), 'utf8');
    assert.ok(config.includes('model_provider = "ZAI"'));
    assert.ok(config.includes('wire_api = "responses"'));
    assert.ok(config.includes(`experimental_bearer_token = "${validKey}"`));
    assert.ok((await client.readLimits()).unavailableReason);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('glm runs through codex with the ZAI provider, no effort override and classified failures', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bridge-glm-run-'));
  const fake = path.join(home, 'fake-glm.mjs');
  await writeFile(fake, [
    "import { writeFile } from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    "await writeFile(new URL('./last-args.json', import.meta.url), JSON.stringify(args));",
    "let prompt = '';",
    "for await (const chunk of process.stdin) prompt += chunk;",
    "if (prompt.includes('GLM_FAIL')) { console.error('unexpected status 401 Unauthorized invalid api key'); process.exit(1); }",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'OK' } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));",
    '',
  ].join('\n'));
  const client = new GlmClient(home, [fake]);
  const events: string[] = [];
  try {
    const result = await client.run({ cliPath: process.execPath, workspace: home, prompt: 'Ответь ровно: OK',
      allowWrite: false, model: 'glm-5.3', reasoningEffort: 'xhigh' }, async event => { events.push(event.kind); }, AbortSignal.timeout(30_000));
    assert.equal(result.response, 'OK');
    assert.equal(result.sessionId, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    assert.ok(events.includes('session') && events.includes('message') && events.includes('usage'));
    const args: string[] = JSON.parse(await readFile(path.join(home, 'last-args.json'), 'utf8'));
    assert.ok(args.includes('model_provider="ZAI"'));
    assert.ok(!args.includes('--ignore-user-config'));
    assert.equal(args[args.indexOf('--model') + 1], 'glm-5.3');
    assert.ok(!args.some(item => item.startsWith('model_reasoning_effort')));
    await assert.rejects(client.run({ cliPath: process.execPath, workspace: home, prompt: 'GLM_FAIL', allowWrite: false },
      async () => {}, AbortSignal.timeout(30_000)), /Z\.ai отклонил ключ GLM/);
    const auto: string[] = JSON.parse(await readFile(path.join(home, 'last-args.json'), 'utf8'));
    assert.ok(!auto.includes('--model'), 'glm-auto keeps the provider default model');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('glm failures never echo the key or raw provider text', () => {
  assert.match(glmFailure('unexpected status 401 Unauthorized invalid api key'), /ключ GLM/);
  assert.match(glmFailure('429 quota rate limit exceeded'), /квота/);
  const generic = glmFailure('stream disconnected while waiting for ' + validKey);
  assert.ok(!generic.includes(validKey));
  assert.match(generic, /GLM не выполнила запрос/);
});

test('worker stores glm keys, merges the catalog and routes glm runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-glm-worker-'));
  const store = new ExecutionAccountStore(root);
  const worker = createCodexWorker(undefined, undefined, store);
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-glm-' + randomUUID() : path.join(root, 'worker.sock');
  try {
    const account = await store.create('GLM', 'glm');
    await worker.listen({ path: socket });
    assert.equal((await worker.inject({ method: 'POST', url: '/accounts', payload: { name: 'X', provider: 'nope' } })).statusCode, 400);
    assert.equal((await worker.inject({ method: 'POST', url: '/accounts/' + account.id + '/key', payload: { key: 'short-key' } })).statusCode, 400);
    await withGlmBackend(async () => {
      assert.equal((await worker.inject({ method: 'POST', url: '/accounts/' + account.id + '/key', payload: { key: validKey } })).statusCode, 200);
    });
    assert.equal((await worker.inject('/models')).statusCode, 503, 'no active account means no visible models');
    assert.equal((await worker.inject({ method: 'POST', url: '/accounts/' + account.id + '/activate', payload: {} })).statusCode, 200);
    const models = (await worker.inject('/models')).json();
    assert.ok(models.models.some((model: { id: string; isDefault: boolean }) => model.id === 'glm/glm-auto' && model.isDefault));
    assert.ok(models.models.some((model: { id: string }) => model.id === 'glm/glm-5.3'));
    const inspect = (await worker.inject('/inspect?model=glm/glm-5.3')).json();
    assert.equal(inspect.provider, 'glm');
    assert.equal(inspect.authentication, 'glm');

    let seen: { model?: string; reasoningEffort?: string } | undefined;
    store.runner = () => ({
      inspect: async () => ({ path: '', version: 'fake', authentication: 'glm' as const, status: '' }),
      listModels: async () => { throw new BridgeError('unused', 500); },
      readLimits: async () => null,
      run: async (request: { prompt: string; model?: string; reasoningEffort?: string }) => {
        seen = request;
        if (request.prompt === 'GLM_FAIL') throw new BridgeError(glmFailure('unexpected status 401'), 503);
        return { sessionId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', response: 'OK' };
      },
    }) as unknown as ReturnType<ExecutionAccountStore['runner']>;
    const ok = await worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Ответь ровно: OK', developerInstructions: 'Инструкции.', model: 'glm/glm-5.3' } });
    assert.equal(JSON.parse(ok.body.trim().split('\n').at(-1)!).result.response, 'OK');
    assert.equal(seen?.model, 'glm-5.3');
    assert.equal(seen?.reasoningEffort, undefined);
    const failed = await worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'GLM_FAIL', developerInstructions: 'Инструкции.', model: 'glm-auto' } });
    assert.match(failed.body, /Z\.ai отклонил ключ GLM/);
    assert.ok(!failed.body.includes(validKey));
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
