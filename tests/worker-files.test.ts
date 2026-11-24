import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { RemoteCodexRunner } from '../server/codex-remote.js';
import { createCodexWorker } from '../server/codex-worker.js';
import { FileStorage } from '../server/file-storage.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import type { Credential, UserRecord } from '../shared/types.js';

test('ERP file roles permit isolated outputs and revoke active writing independently of legacy flags', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-erp-file-role-'));
  const jobs = path.join(root, 'jobs'), folder = path.join(root, 'project');
  await Promise.all([mkdir(jobs), mkdir(folder)]);
  const store = new Store(path.join(root, 'data'));
  const user: UserRecord = { id: 'owner', username: 'owner', name: 'Owner', role: 'admin', roleId: 'boss', disabled: false, passwordHash: '', createdAt: new Date().toISOString() };
  const credential: Credential = { id: 'session', userId: user.id, kind: 'session', hash: '', name: 'ERP', createdAt: user.createdAt,
    source: 'fastkore', installationId: 'erp', externalUserId: 'employee', externalRoles: [{ id: 'role', name: 'Руководитель' }] };
  store.state.security = { users: [user], credentials: [credential], audit: [] };
  let block = false, started = false, aborted = false;
  const modes: boolean[] = [];
  const workspace = new Workspace(store, {
    isolated: true,
    inspect: async () => ({ path: '', version: 'test', status: '', authentication: 'chatgpt' }),
    async run(request, _onEvent, signal) {
      modes.push(request.allowWrite);
      if (!request.allowWrite) return { response: 'Read only' };
      if (block) {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('Stopped')); }, { once: true });
        });
      }
      const output = path.join(jobs, request.workDirectoryId!, 'output');
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'result.txt'), 'created');
      return { response: 'Created' };
    },
  }, new FileStorage(), jobs);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'Run timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const project = await workspace.addProject(folder);
    const chat = await workspace.addChat(project.id, 'Files', undefined, user.id);
    assert.equal(store.state.settings.allowWrite, false);
    assert.equal(workspace.corporate.data.profiles[0].allowWrite, false);
    const send = () => workspace.send(project.id, chat.id, 'Create file', [], undefined, undefined, undefined, { ...user, credentialId: credential.id });
    const first = await send();
    await until(() => first.status === 'complete' || first.status === 'failed');
    assert.equal(first.status, 'complete', first.error);
    assert.equal(chat.messages.at(-1)!.attachments.length, 1);
    block = true;
    const active = await send();
    await until(() => started);
    store.state.sso = { rolePermissions: [{ installationId: 'erp', roleId: 'role', mcp: true, cli: true, fileWrite: false, revision: 1 }] };
    workspace.revokeFileWrites();
    await until(() => !workspace.busy);
    assert.equal(aborted, true);
    assert.notEqual(active.status, 'complete');
    const denied = await send();
    await until(() => denied.status === 'complete' || denied.status === 'failed');
    assert.equal(denied.status, 'complete', denied.error);
    assert.deepEqual(modes, [true, true, false]);
    assert.equal(chat.messages.at(-1)!.attachments.length, 0);
  } finally {
    await workspace.shutdown();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved provider limits are migrated to the previous overall limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-execution-migration-'));
  try {
    const previous = new Store(root);
    Object.assign(previous.state.settings, { executionConcurrency: { total: 12, codex: 8, glm: 2 } });
    await previous.save();
    await previous.close();
    const updated = new Store(root);
    try { assert.equal(updated.state.settings.executionConcurrency, 12); }
    finally { await updated.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('administrator can change execution limits while jobs run and the worker immediately honors them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-execution-limits-'));
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-' + randomUUID() : path.join(root, 'worker.sock');
  const gates = new Map<string, () => void>();
  const worker = createCodexWorker({
    inspect: async () => ({ path: '', version: 'test', status: '', authentication: 'chatgpt' }),
    async run(r) {
      const marker = r.prompt.split('\n').at(-1)!;
      await new Promise<void>(resolve => gates.set(marker, resolve));
      return { response: 'OK' };
    },
  });
  const store = new Store(path.join(root, 'data'));
  const workspace = new Workspace(store, new RemoteCodexRunner(socket));
  const app = await createApp(workspace);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) { assert.ok(Date.now() < deadline, 'job did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await worker.listen({ path: socket });
    const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.token },
      payload: { username: 'test-admin', name: 'Test admin', password: 'Test-password-2026-abc' } });
    assert.equal(setup.statusCode, 200);
    const { token, user } = setup.json(), headers = { authorization: 'Bearer ' + token };
    const save = (limit: number) => app.inject({
      method: 'PATCH', url: '/api/settings', headers, payload: { executionConcurrency: limit },
    });
    assert.equal((await save(0)).statusCode, 400);
    assert.equal((await save(1)).statusCode, 200);
    const project = await workspace.addProject(folder);
    const first = await workspace.addChat(project.id, 'First', undefined, user.id);
    const second = await workspace.addChat(project.id, 'Second', undefined, user.id);
    second.model = 'glm/test';
    const third = await workspace.addChat(project.id, 'Third', undefined, user.id);
    const send = (chat: string, text: string) => workspace.send(project.id, chat, text, [], undefined, undefined, undefined, user);
    await send(first.id, 'one');
    await until(() => gates.has('one'));
    const followup = await send(first.id, 'three');
    const parallel = await send(second.id, 'two');
    const last = await send(third.id, 'four');
    assert.equal(parallel.status, 'queued');
    assert.equal(followup.status, 'queued');
    assert.equal((await save(2)).statusCode, 200);
    await until(() => gates.has('two'));
    assert.equal(followup.status, 'queued');
    assert.equal(last.status, 'queued');
    assert.deepEqual((await worker.inject('/health')).json(), { ok: true, active: 2, concurrency: 2 });
    assert.equal((await save(1)).statusCode, 200);
    assert.equal(parallel.status, 'running');
    assert.equal((await worker.inject('/health')).json().active, 2);
    gates.get('two')!();
    await until(() => parallel.status === 'complete');
    assert.equal(followup.status, 'queued');
    gates.get('one')!();
    await until(() => gates.has('three'));
    assert.equal(last.status, 'queued');
    gates.get('three')!();
    await until(() => followup.status === 'complete');
    await until(() => gates.has('four'));
    gates.get('four')!();
    await until(() => last.status === 'complete');
    const saved = new Store(store.root);
    try { assert.equal(saved.state.settings.executionConcurrency, 1); }
    finally { await saved.close(); }
  } finally {
    for (const release of gates.values()) release();
    await app.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the isolated worker reads uploaded bytes, returns downloadable files, and resumes from the latest output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-worker-files-'));
  const jobs = path.join(root, 'jobs'), projectFolder = path.join(root, 'project');
  await Promise.all([mkdir(jobs), mkdir(projectFolder)]);
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-' + randomUUID() : path.join(root, 'worker.sock');
  const sessionId = randomUUID();
  let calls = 0;
  const worker = createCodexWorker({
    inspect: async () => ({ path: '', version: 'test', status: '', authentication: 'chatgpt' }),
    async run(request, onEvent) {
      if (!request.allowWrite) {
        assert.match(request.prompt, /<local_document_context>[\s\S]*source[\s\S]*<\/local_document_context>/);
        assert.match(request.prompt, /"результат":"ответ в чате"/);
        assert.equal(request.workDirectoryId, undefined);
        return { response: 'Текст прочитан' };
      }
      assert.equal(request.allowWrite, true);
      assert.equal(path.dirname(request.workspace), await realpath(jobs));
      assert.equal(request.workDirectoryId, path.basename(request.workspace));
      assert.match(request.developerInstructions!, /output/);
      const input = calls++ === 0
        ? path.join('input', 'attachments', '1', 'input.txt')
        : path.join('input', 'previous', '1', 'result.txt');
      const source = await readFile(path.join(request.workspace, input), 'utf8');
      if (calls === 2) {
        assert.match(request.prompt, /input\/earlier/);
        assert.equal(await readFile(path.join(request.workspace, 'input', 'earlier', '2', 'input.txt'), 'utf8'), 'source');
        assert.deepEqual(await readdir(path.join(request.workspace, 'input', 'earlier')), ['2']);
        assert.doesNotMatch(request.prompt, /foreign\.txt/);
      }
      await writeFile(path.join(request.workspace, 'output', 'result.txt'), source + '!');
      await onEvent({ kind: 'session', text: sessionId });
      return { sessionId, response: 'OK' };
    },
  }, jobs);
  const store = new Store(path.join(root, 'data'));
  const workspace = new Workspace(store, new RemoteCodexRunner(socket), new FileStorage(), jobs);
  const app = await createApp(workspace);
  try {
    await worker.listen({ path: socket });
    const boot = await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } });
    assert.equal(boot.statusCode, 200, boot.body);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.json().token },
      payload: { username: 'test-admin', name: 'Test admin', password: 'Test-password-2026-abc' } });
    assert.equal(setup.statusCode, 200, setup.body);
    const { token, user } = setup.json();
    const headers = { authorization: 'Bearer ' + token };
    const enabled = await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { allowWrite: true } });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const project = await workspace.addProject(projectFolder);
    project.chatAllowWrite = true;
    const chat = await workspace.addChat(project.id, 'Файлы', undefined, user.id);
    const attachment = await workspace.addAttachment(project.id, 'input.txt', Buffer.from('source'), () => user.id);
    const url = `/api/projects/${project.id}/chats/${chat.id}`;
    for (const [index, attachmentIds] of [[attachment.id], []].entries()) {
      const sent = await app.inject({ method: 'POST', url: url + '/messages', headers, payload: { text: 'Сохрани результат', attachmentIds } });
      assert.equal(sent.statusCode, 202, sent.body);
      const deadline = Date.now() + 5000;
      while (workspace.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const run = workspace.getRun(sent.json().id);
      assert.equal(run.status, 'complete', run.error);
      const message = chat.messages.at(-1)!;
      assert.equal(message.attachments.length, 1);
      const fileUrl = url + `/messages/${message.id}/files/${message.attachments[0].id}`;
      assert.equal((await app.inject({ method: 'GET', url: fileUrl })).statusCode, 401);
      const downloaded = await app.inject({ method: 'GET', url: fileUrl, headers });
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      assert.equal(downloaded.body, 'source' + '!'.repeat(index + 1));
      assert.deepEqual(await readdir(jobs), []);
      if (index === 0) {
        const foreign = await workspace.addAttachment(project.id, 'foreign.txt', Buffer.from('other user'), () => 'another-user');
        chat.messages[0].attachments.push(foreign);
      }
    }
    await workspace.settings({ allowWrite: false });
    const readonly = await app.inject({ method: 'POST', url: url + '/messages', headers, payload: { text: 'Прочитай вложение из первого вопроса' } });
    assert.equal(readonly.statusCode, 202, readonly.body);
    const deadline = Date.now() + 5000;
    while (workspace.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(chat.messages.at(-1)?.text, 'Текст прочитан');
  } finally {
    await app.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
