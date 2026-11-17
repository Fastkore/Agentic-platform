import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workspace } from '../server/workspace.js';
import { FileStorage } from '../server/file-storage.js';
import { createApp } from '../server/app.js';
import { FilesystemLibraryBlobStore } from '../server/library/blob-store.js';
import type { CodexRequest, CodexRunner } from '../server/codex.js';
import { defaultExclusions } from '../shared/library.js';
import { erpBrowser } from './erp-browser.js';
import { sha } from './library-helpers.js';

const password = 'Library-test-password-2026';
export type Respond = (request: CodexRequest, signal: AbortSignal) => Promise<string | undefined>;
export async function fixture(respond?: Respond, options: { workerFiles?: boolean; afterDelta?: () => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-library-')); await mkdir(path.join(root, 'project')); await mkdir(path.join(root, 'project2'));
  const calls: CodexRequest[] = [];
  const holder: { respond?: Respond } = { respond };
  const runner: CodexRunner = { isolated: true, inspect: async () => ({ path: process.execPath, version: 'fake', authentication: 'chatgpt', status: '' }), run: async (r, onEvent, signal) => {
    calls.push(r);
    await onEvent({ kind: 'session', text: '87db344a-98f3-42c8-bba8-c7d9f3dcff11' });
    const response = (await holder.respond?.(r, signal)) ?? 'OK';
    await onEvent({ kind: 'message-delta', text: response.slice(0, 40) });
    await options.afterDelta?.();
    return { sessionId: '87db344a-98f3-42c8-bba8-c7d9f3dcff11', response, usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1 } };
  } };
  const workerRoot = options.workerFiles ? path.join(root, 'worker') : undefined;
  if (workerRoot) await mkdir(workerRoot);
  const store = new Store(path.join(root, 'data')), workspace = new Workspace(store, runner, new FileStorage(), workerRoot);
  workspace.useLibraryStorage({ store: new FilesystemLibraryBlobStore(path.join(root, 'objects')) });
  await workspace.settings({ cliPath: process.execPath, includePreviews: false });
  const erp = erpBrowser(process.env.BRIDGE_PUBLIC_ORIGIN);
  const project = await workspace.addProject(path.join(root, 'project')), project2 = await workspace.addProject(path.join(root, 'project2'));
  const app = await createApp(workspace, erp.options);
  const req = erp.request(app);
  const boot = (await app.inject({ method: 'POST', url: '/api/local-login', headers: { host: 'localhost', 'x-bridge-local': '1' } })).json();
  const admin = (await req('POST', '/api/auth/setup', boot.token, { username: 'admin', name: 'Руководитель', password })).json().token as string;
  const enter = await erp.pair(app, admin);
  const { user: employee, cookie: token } = await enter('Алиса');
  assert.equal((await req('PATCH', '/api/users/' + employee.id, admin, { roleId: 'employee' })).statusCode, 200);
  await req('PATCH', `/api/projects/${project.id}/members`, admin, { memberIds: [employee.id] });
  const headers = { host: new URL(process.env.BRIDGE_PUBLIC_ORIGIN ?? 'https://agents.example.test').host, 'x-forwarded-proto': 'https', origin: process.env.BRIDGE_PUBLIC_ORIGIN ?? 'https://agents.example.test' };
  const part = (url: string, body: Buffer, auth = admin) => app.inject({ method: 'PUT', url, payload: body, headers: { ...headers, authorization: 'Bearer ' + auth, 'content-type': 'application/octet-stream' } });
  /** Browser-equivalent upload over HTTP: list, parts and completion; then processing. */
  async function upload(folderId: string, files: Record<string, string | Buffer>, mode: 'replace' | 'add' = 'replace') {
    const entries = Object.entries(files).map(([p, d]) => { const b = Buffer.isBuffer(d) ? d : Buffer.from(d); return { path: p, size: b.length, sha256: sha(b), b }; });
    const created = await req('POST', `/api/library/${folderId}/operations`, admin, { idempotencyKey: 'k' + Math.random().toString(36).slice(2, 12), mode,
      totalFiles: entries.length, totalBytes: entries.reduce((s, e) => s + e.size, 0), exclusions: defaultExclusions });
    assert.equal(created.statusCode, 201, created.body);
    const op = created.json();
    const base = `/api/library/${folderId}/operations/${op.id}`;
    const manifest = await req('PUT', base + '/manifest', admin, { page: 0, last: true, entries: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })) });
    assert.equal(manifest.statusCode, 200, manifest.body);
    if (manifest.json().status === 'unchanged') return manifest.json();
    const st = (await req('GET', base, admin)).json();
    for (const file of st.files) {
      const data = entries.find(e => e.path === file.path)!.b;
      for (let p = 1; p <= file.partsTotal; p++) {
        const r = await part(`${base}/files/${file.fileId}/parts/${p}`, data.subarray((p - 1) * st.operation.partBytes, p * st.operation.partBytes));
        assert.equal(r.statusCode, 200, r.body);
      }
    }
    const done = await req('POST', base + '/complete', admin, { idempotencyKey: 'complete-' + op.id.slice(0, 8) });
    assert.equal(done.statusCode, 202, done.body);
    await workspace.library.indexer.drain();
    return done.json();
  }
  return { root, calls, holder, workspace, project, project2, app, req, admin, employee, token, enter, upload, part };
}
export async function idle(workspace: Workspace) { const deadline = Date.now() + 8000; while (workspace.busy) { if (Date.now() > deadline) throw Error('timeout'); await new Promise(r => setTimeout(r, 10)); } }
export const json = (text: string) => JSON.parse(text);

/** Creates a folder, connects it to the project, uploads files and assigns it to the base assistant. */
export async function grantedFolder(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, string>, options: { name?: string; classification?: 'shared' | 'restricted';
  outputPolicy?: 'explanation_only' | 'excerpts_allowed'; projectId?: string; profile?: 'code' | 'documents' } = {}) {
  const projectId = options.projectId ?? f.project.id;
  const created = await f.req('POST', '/api/library', f.admin, { name: options.name ?? 'Папка ' + Math.random().toString(36).slice(2, 7), profile: options.profile ?? 'code',
    classification: options.classification ?? 'shared', outputPolicy: options.outputPolicy ?? 'explanation_only' });
  assert.equal(created.statusCode, 201, created.body);
  const folder = created.json() as { id: string };
  const connected = await f.req('POST', `/api/projects/${projectId}/library`, f.admin, { folderId: folder.id });
  assert.equal(connected.statusCode, 201, connected.body);
  await f.upload(folder.id, files);
  const connection = async () => (await f.req('GET', `/api/projects/${projectId}/library`, f.admin)).json().connections.find((c: { folderId: string }) => c.folderId === folder.id);
  const granted = await f.req('PUT', `/api/projects/${projectId}/library/${folder.id}/grants`, f.admin, { profileId: 'universal', enabled: true, revision: (await connection()).revision });
  assert.equal(granted.statusCode, 200, granted.body);
  return { folder, connection };
}
