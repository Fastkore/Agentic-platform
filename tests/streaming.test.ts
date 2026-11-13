import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CodexClient, type CodexEvent, type CodexRunner } from '../server/codex.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 7000;
  while (!check()) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

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
