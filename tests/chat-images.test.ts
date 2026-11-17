import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { CodexClient } from '../server/codex.js';
import { RemoteCodexRunner } from '../server/codex-remote.js';
import { createCodexWorker } from '../server/codex-worker.js';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';

const redJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==', 'base64');
// A JPEG may contain application metadata. Pad the fixture to exercise both worker
// request limits and the App Server's echoed visual input above four megabytes.
const metadata = Buffer.alloc(60_004);
metadata.writeUInt16BE(0xffef, 0);
metadata.writeUInt16BE(60_002, 2);
const jpeg = Buffer.concat([redJpeg.subarray(0, 2), ...Array.from({ length: 52 }, () => metadata), redJpeg.subarray(2)]);

test('a read-only chat sends uploaded JPEG bytes and a text attachment through the worker to Codex', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-chat-images-'));
  const projectFolder = path.join(root, 'project');
  await mkdir(projectFolder);
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bridge-vision-' + randomUUID() : path.join(root, 'worker.sock');
  const client = new CodexClient([fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))], 'worker');
  const worker = createCodexWorker({
    inspect: (_path, signal) => client.inspect(process.execPath, signal),
    run(request, onEvent, signal, steer) {
      assert.equal(request.allowWrite, false);
      assert.equal(request.workDirectoryId, undefined);
      return client.run({ ...request, cliPath: process.execPath, workspace: projectFolder }, onEvent, signal, steer);
    },
  });
  const workspace = new Workspace(new Store(path.join(root, 'data')), new RemoteCodexRunner(socket));
  const app = await createApp(workspace);
  try {
    await worker.listen({ path: socket });
    const boot = await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } });
    assert.equal(boot.statusCode, 200, boot.body);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { authorization: 'Bearer ' + boot.json().token },
      payload: { username: 'vision-admin', name: 'Vision admin', password: 'Test-password-2026-abc' } });
    assert.equal(setup.statusCode, 200, setup.body);
    const { token, user } = setup.json();
    const headers = { authorization: 'Bearer ' + token };
    const project = await workspace.addProject(projectFolder);
    const chat = await workspace.addChat(project.id, 'Изображения', undefined, user.id);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const upload = async (name: string, file: Blob) => {
      const form = new FormData();
      form.append('file', file, name);
      const result = await fetch(origin + `/api/projects/${project.id}/attachments`, { method: 'POST', headers, body: form });
      assert.equal(result.status, 201, result.status === 201 ? undefined : await result.text());
      return (await result.json() as { id: string }).id;
    };
    const imageId = await upload('photo.JPG', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
    const documentId = await upload('note.txt', new Blob(['Текстовый файл тоже прочитан']));
    const url = `/api/projects/${project.id}/chats/${chat.id}/messages`;
    const sent = await app.inject({ method: 'POST', url, headers, payload: { text: 'VERIFY_CHAT_IMAGE', attachmentIds: [imageId, documentId] } });
    assert.equal(sent.statusCode, 202, sent.body);
    const deadline = Date.now() + 8000;
    while (workspace.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const run = workspace.getRun(sent.json().id);
    assert.equal(run.status, 'complete', run.error);
    assert.deepEqual(JSON.parse(run.response!), {
      images: [{ mime: 'data:image/jpeg', hash: createHash('sha256').update(jpeg).digest('hex') }], hasDocument: true,
    });
    assert.deepEqual(chat.messages[0].attachments.map(file => file.name), ['photo.JPG', 'note.txt']);

    chat.model = 'glm/test';
    const unsupported = await app.inject({ method: 'POST', url, headers, payload: { text: 'Фото', attachmentIds: [imageId] } });
    assert.equal(unsupported.statusCode, 422, unsupported.body);
    assert.match(unsupported.body, /выберите модель ChatGPT/);
  } finally {
    await app.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
