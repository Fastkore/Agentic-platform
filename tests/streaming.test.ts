import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CodexClient, type CodexEvent, type CodexRunner, type SteerTurn } from '../server/codex.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 7000;
  while (!check()) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('Codex acknowledges steering for the same turn while a tool is still executing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-steer-cli-'));
  const runner = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))], 'worker');
  let steer: SteerTurn | undefined, toolStarted = false, release!: () => void;
  const tool = new Promise<void>(resolve => { release = resolve; });
  const pending = runner.run({ cliPath: process.execPath, workspace: root, allowWrite: false, prompt: 'WAIT_FOR_STEER', tools: {
    definitions: [{ type: 'function', name: 'knowledge', description: '', inputSchema: { type: 'object' } }],
    call: async () => { toolStarted = true; await tool; return { success: true, text: 'Read' }; },
  } }, async () => {}, AbortSignal.timeout(8000), value => { steer = value; });
  void pending.catch(() => {});
  try {
    await until(() => toolStarted && !!steer);
    assert.equal(await steer!('Учитывай уточнение.'), 'accepted');
    release();
    assert.equal((await pending).response, 'Учитывай уточнение.');
    assert.equal(steer, undefined);
  } finally { release(); await pending.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('queued text is visible to the sender and sending it now consumes the job once in the current chat', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-steer-queue-'));
  const store = new Store(path.join(root, 'data'));
  const started: string[] = [], steered: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const workspace = new Workspace(store, {
    inspect: async () => ({ path: process.execPath, version: 'fake', status: '', authentication: 'chatgpt' }),
    run: async (request, emit, _signal, register) => {
      started.push(request.prompt);
      await emit({ kind: 'message-delta', text: 'Работаю…' });
      register?.(async text => {
        if (text === 'Reject') return 'rejected';
        steered.push(text);
        return 'accepted';
      });
      await gate;
      return { response: 'Готово.' };
    },
  });
  const app = await createApp(workspace);
  try {
    await workspace.settings({ cliPath: process.execPath });
    const boot = await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: '127.0.0.1', 'x-bridge-local': '1' } });
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.json().token },
      payload: { username: 'tester', name: 'Tester', password: 'Fixture-password-2026' } });
    assert.equal(setup.statusCode, 200, setup.body);
    const headers = { authorization: 'Bearer ' + setup.json().token };
    const project = await workspace.addProject(root);
    const chat = await workspace.addChat(project.id), other = await workspace.addChat(project.id);
    const send = async (id: string, text: string) => {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/chats/${id}/messages`, headers, payload: { text } });
      assert.equal(response.statusCode, 202, response.body);
      return workspace.getRun(response.json().id);
    };
    const first = await send(chat.id, 'First');
    await until(() => !!first.canSteer);
    const queued = await send(chat.id, 'Clarification'), rejected = await send(chat.id, 'Reject'), unrelated = await send(other.id, 'Other');
    const status = (await app.inject({ url: '/api/status', headers })).json();
    assert.equal(status.queuedRuns.find((run: { id: string }) => run.id === queued.id).queuedText, 'Clarification');
    const sendNow = (id: string) => app.inject({ method: 'POST', url: `/api/runs/${id}/send-now`, headers, payload: { targetRunId: first.id } });
    assert.equal((await sendNow(unrelated.id)).statusCode, 409);
    assert.equal((await sendNow(rejected.id)).json().result, 'rejected');
    assert.equal(rejected.status, 'queued');
    assert.equal((await sendNow(queued.id)).json().result, 'accepted');
    assert.equal((await sendNow(queued.id)).statusCode, 409);
    assert.deepEqual(steered, ['Clarification']);
    assert.deepEqual(started, ['First']);
    const messages = workspace.chat(project.id, chat.id).messages;
    assert.equal(messages.at(-2)?.text, 'Clarification');
    assert.equal(messages.at(-1)?.text, 'Работаю…');
    release(); await until(() => !workspace.busy);
    assert.deepEqual(started, ['First', 'Reject', 'Other']);
  } finally { release(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex streams public text before completion, ignores reasoning and does not duplicate the completed text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-stream-cli-'));
  const runner = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))], 'worker');
  const events: CodexEvent[] = []; let finished = false;
  const pending = runner.run({ cliPath: process.execPath, workspace: root, allowWrite: false, prompt: 'Test', tools: {
    definitions: [{ type: 'function', name: 'knowledge', description: '', inputSchema: { type: 'object' } }],
    call: async () => ({ success: true, text: '' }),
  } }, async event => { events.push(event); }, AbortSignal.timeout(10000)).then(result => { finished = true; return result; });
  try {
    await until(() => events.some(event => event.kind === 'message-delta'));
    assert.equal(finished, false);
    assert.equal(events.find(event => event.kind === 'message-delta')?.text, 'Проверяю');
    const result = await pending;
    assert.equal(result.response, 'Проверяю документы.');
    assert.ok(!JSON.stringify(events).includes('PRIVATE_REASONING'));
    assert.equal(events.filter(event => event.kind === 'message-delta').map(event => event.text).join(''), result.response);
    assert.equal(events.find(event => event.kind === 'message-replace')?.text, result.response);
  } finally { await pending.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('the first text fragment is persisted while the job is still running and the final snapshot replaces it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-stream-store-'));
  const store = new Store(path.join(root, 'data'));
  let published = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner: CodexRunner = {
    inspect: async () => ({ path: process.execPath, version: 'fake', status: '', authentication: 'chatgpt' }),
    run: async (_request, event, signal) => {
      await event({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
      await event({ kind: 'message-delta', text: 'Проверяю документацию…' }); published = true;
      await gate; signal.throwIfAborted();
      await event({ kind: 'message-replace', text: 'Ответ готов.' });
      return { response: 'Ответ готов.' };
    },
  };
  const workspace = new Workspace(store, runner);
  try {
    await workspace.settings({ cliPath: process.execPath });
    const project = await workspace.addProject(root), chat = await workspace.addChat(project.id);
    const run = await workspace.send(project.id, chat.id, 'Question', []);
    await until(() => published);
    assert.equal(run.status, 'running');
    const reader = new DatabaseSync(store.file, { readOnly: true });
    try {
      const rows = reader.prepare('SELECT payload FROM messages').all().map(row => JSON.parse(String(row.payload)));
      assert.equal(rows.find(row => row.role === 'assistant').text, 'Проверяю документацию…');
    } finally { reader.close(); }
    release(); await until(() => !workspace.busy);
    assert.equal(chat.messages.at(-1)?.text, 'Ответ готов.');
  } finally { release(); await workspace.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a finished tool disappears from run status while another tool is still active', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-tool-status-'));
  const store = new Store(path.join(root, 'data'));
  let emit!: (event: CodexEvent) => Promise<void>;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const workspace = new Workspace(store, {
    inspect: async () => ({ path: process.execPath, version: 'fake', status: '', authentication: 'chatgpt' }),
    run: async (_request, onEvent) => {
      emit = onEvent;
      await pending;
      return { response: 'Готово.' };
    },
  });
  try {
    await workspace.settings({ cliPath: process.execPath });
    const project = await workspace.addProject(root);
    const chat = await workspace.addChat(project.id);
    const run = await workspace.send(project.id, chat.id, 'Question', []);
    await until(() => !!emit);
    await emit({ kind: 'tool', text: 'fastkore_read', toolCallId: 'first' });
    await emit({ kind: 'tool', text: 'knowledge', toolCallId: 'second' });
    assert.equal(run.tool, 'knowledge');
    await emit({ kind: 'tool-end', toolCallId: 'second' });
    assert.equal(run.tool, 'fastkore_read');
    await emit({ kind: 'tool-end', toolCallId: 'first' });
    assert.equal(run.tool, undefined);
    assert.equal(run.status, 'running');
    finish();
    await until(() => !workspace.busy);
  } finally {
    finish();
    await workspace.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
