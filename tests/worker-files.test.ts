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
      assert.equal(request.allowWrite, true);
      assert.equal(path.dirname(request.workspace), await realpath(jobs));
      assert.match(request.developerInstructions!, /output/);
      const input = calls++ === 0
        ? path.join('input', 'attachments', '1', 'input.txt')
        : path.join('input', 'previous', '1', 'result.txt');
      const source = await readFile(path.join(request.workspace, input), 'utf8');
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
    const profile = workspace.corporate.data.profiles[0];
    await workspace.corporate.saveProfile(user, { ...profile, allowWrite: true });
    const project = await workspace.addProject(projectFolder);
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
    }
  } finally {
    await app.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
