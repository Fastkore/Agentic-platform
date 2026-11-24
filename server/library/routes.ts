import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { externalProviders, type ExternalProvider, type ExternalSelection, libraryActions, type LibraryAction, type LibraryClassification, type LibraryProfile, type OutputPolicy } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import type { LibraryPolicy } from './policy.js';
import type { LibraryReader } from './reader.js';
import { notFound, type LibraryActor, type LibraryRegistry } from './registry.js';

export interface LibraryRouteDeps {
  registry: LibraryRegistry; policy: LibraryPolicy; reader: LibraryReader;
  actor: (request: FastifyRequest) => LibraryActor;
}
const id = (prefix: string) => ({ type: 'string', pattern: `^${prefix}[A-Za-z0-9_-]{1,80}$` });
const anyId = { type: 'string', minLength: 1, maxLength: 100 };
const revision = { type: 'integer', minimum: 0, maximum: 2147483647 };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const outputPolicy = { enum: ['explanation_only', 'excerpts_allowed'] };
const managers = { type: 'array', maxItems: 50, items: obj({ userId: anyId, actions: { type: 'array', maxItems: 10, uniqueItems: true, items: { enum: libraryActions } } }, ['userId', 'actions']) };
const idempotencyKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' };
const operationId = { type: 'string', pattern: '^[a-f0-9-]{36}$' };

/** Library API: folders and uploads under /api/library, project connections under /api/projects/:projectId/library. */
export function libraryRoutes(app: FastifyInstance, deps: LibraryRouteDeps) {
  const { registry, policy, reader } = deps;
  const actor = deps.actor;
  const base = '/api/library';
  const folderParams = obj({ folderId: id('lib_') }, ['folderId']);
  const operationParams = obj({ folderId: id('lib_'), operationId }, ['folderId', 'operationId']);
  const admin = (request: FastifyRequest) => { const a = actor(request); if (!a.admin) throw new BridgeError('Доступно только администратору.', 403); return a; };
  const current = (folderId: string) => {
    const state = registry.currentState(folderId);
    if (!state) throw new BridgeError('В папке ещё нет готовых материалов.', 404);
    return state;
  };

  app.get(base + '/storage', async request => { admin(request); return registry.storageStatus(); });
  app.post(base + '/storage/check', async request => {
    admin(request);
    if (!registry.storage.store) throw new BridgeError(registry.storage.problem ?? 'Хранилище библиотеки не настроено.', 503);
    await registry.storage.store.check();
    return { ok: true, kind: registry.storage.store.kind };
  });
  const selection = obj({ connection: anyId, folder: { type: 'string', minLength: 1, maxLength: 4096 } }, ['connection', 'folder']);
  app.get<{ Params: { provider: ExternalProvider } }>(base + '/external/status/:provider', {
    schema: { params: obj({ provider: { enum: externalProviders } }, ['provider']) },
  }, async request => {
    admin(request);
    return { configured: registry.external.auth.configured(request.params.provider) };
  });
  app.post<{ Body: { provider: ExternalProvider } }>(base + '/external/authorize', { schema: { body: obj({ provider: { enum: externalProviders } }, ['provider']) } },
    async request => registry.external.auth.begin(admin(request).id, request.body.provider));
  app.post<{ Body: { state: string; code: string } }>(base + '/external/authorize/finish', { schema: { body: obj({ state: anyId, code: { type: 'string', minLength: 1, maxLength: 4096 } }, ['state','code']) } },
    async request => registry.external.auth.finish(admin(request).id, request.body.state, request.body.code));
  app.post<{ Body: { connection: string; parent?: string } }>(base + '/external/folders', { schema: { body: obj({ connection: anyId, parent: { type: 'string', maxLength: 4096 } }, ['connection']) } },
    async request => registry.external.auth.folders(admin(request).id, request.body.connection, request.body.parent));
  app.post<{ Params: {folderId: string}; Body: ExternalSelection }>(base + '/:folderId/external/reconnect', { schema: { params: folderParams, body: selection } },
    async request => {
      const owner = admin(request).id;
      registry.external.reconnect(owner, request.params.folderId, request.body);
      registry.external.schedule(request.params.folderId);
      return { ok: true };
    });
  app.post<{ Params: {folderId: string} }>(base + '/:folderId/external/sync', { schema: { params: folderParams } }, async (request, reply) => {
    const folder = registry.requireFolder(actor(request), request.params.folderId, 'manage');
    if (!registry.external.has(folder.id)) throw notFound();
    registry.external.schedule(folder.id);
    return reply.code(202).send({ ok: true });
  });
  app.get(base + '/audit', async request => { admin(request); return registry.auditPage(); });
  app.get(base, async request => registry.listFolders(actor(request)));
  app.post<{ Body: { name: string; description?: string; profile?: LibraryProfile; classification?: LibraryClassification; outputPolicy?: OutputPolicy; active?: boolean; quotaBytes?: number; external?: ExternalSelection;
    managers?: { userId: string; actions: LibraryAction[] }[] } }>(base, { schema: { body: obj({
      name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 2000 }, profile: { enum: ['code', 'documents'] },
      classification: { enum: ['shared', 'restricted'] }, outputPolicy, active: { type: 'boolean' }, quotaBytes: { type: 'integer', minimum: 1 }, managers, external: selection }, ['name']) } },
  async (request, reply) => {
    const folder = registry.createFolder(actor(request), request.body);
    if (request.body.external) {
      registry.external.auth.discard(request.body.external.connection);
      registry.external.schedule(folder.id);
    }
    return reply.code(201).send(folder);
  });
  app.get<{ Params: { folderId: string } }>(base + '/:folderId', { schema: { params: folderParams } }, async request => registry.getFolder(actor(request), request.params.folderId));
  app.patch<{ Params: { folderId: string }; Body: { revision: number; name?: string; description?: string; profile?: LibraryProfile; classification?: LibraryClassification;
    outputPolicy?: OutputPolicy; active?: boolean; quotaBytes?: number; managers?: { userId: string; actions: LibraryAction[] }[] } }>(base + '/:folderId', { schema: { params: folderParams, body: obj({
      revision, name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 2000 }, profile: { enum: ['code', 'documents'] },
      classification: { enum: ['shared', 'restricted'] }, outputPolicy, active: { type: 'boolean' }, quotaBytes: { type: 'integer', minimum: 1 }, managers }, ['revision']) } },
  async request => registry.updateFolder(actor(request), request.params.folderId, request.body));
  app.delete<{ Params: { folderId: string }; Querystring: { revision: string } }>(base + '/:folderId',
    { schema: { params: folderParams, querystring: obj({ revision: { type: 'string', pattern: '^[0-9]{1,10}$' } }, ['revision']) } },
    async request => registry.deleteFolder(actor(request), request.params.folderId, Number(request.query.revision)));
  app.get<{ Params: { folderId: string }; Querystring: { path?: string; cursor?: string } }>(base + '/:folderId/tree',
    { schema: { params: folderParams, querystring: obj({ path: { type: 'string', maxLength: 1024 }, cursor: { type: 'string', maxLength: 1100 } }) } }, async request => {
      registry.visibleFolder(actor(request), request.params.folderId);
      const state = current(request.params.folderId);
      await registry.external.verify(request.params.folderId, state.id);
      registry.visibleFolder(actor(request), request.params.folderId);
      return registry.tree(state.id, request.query.path ?? '', request.query.cursor ?? '');
    });
  /** Files without search, of the current content or of the last update that was not published. */
  app.get<{ Params: { folderId: string }; Querystring: { failed?: '1' } }>(base + '/:folderId/problems',
    { schema: { params: folderParams, querystring: obj({ failed: { enum: ['1'] } }) } }, async request => {
      const a = actor(request);
      const folder = registry.getFolder(a, request.params.folderId);
      const stateId = request.query.failed === '1' ? folder.failed?.stateId : registry.currentState(folder.id)?.id;
      if (!stateId) throw notFound();
      await registry.external.verify(folder.id, stateId);
      registry.visibleFolder(actor(request), folder.id);
      return registry.problems(stateId);
    });
  /** Originals: separate view/download permissions, audited; never used by agent tools. */
  app.get<{ Params: { folderId: string; fileId: string }; Querystring: { download?: '1'; line?: string } }>(base + '/:folderId/files/:fileId/original',
    { schema: { params: obj({ folderId: id('lib_'), fileId: id('f_') }, ['folderId', 'fileId']),
      querystring: obj({ download: { enum: ['1'] }, line: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' } }) } }, async (request, reply: FastifyReply) => {
      const a = actor(request), download = request.query.download === '1';
      registry.requireFolder(a, request.params.folderId, download ? 'download_original' : 'view_original');
      const state = current(request.params.folderId);
      await registry.external.verify(request.params.folderId, state.id);
      registry.requireFolder(actor(request), request.params.folderId, download ? 'download_original' : 'view_original');
      const file = registry.file(state.id, request.params.fileId);
      if (!file) throw notFound();
      registry.recordAudit({ actorId: a.id, action: download ? 'library.original.download' : 'library.original.view', targetId: file.file_id,
        details: { objectIds: { folderId: request.params.folderId } } });
      if (!download) { const result = await reader.readLines(state.id, file.file_id, Number(request.query.line ?? 1), 200); return { ...result, file: { path: file.path } }; }
      const blob = registry.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(file.blob_id) as { object_key: string };
      const stream = await registry.objectStore(blob.object_key).stream(blob.object_key);
      const name = encodeURIComponent(file.path.split('/').at(-1)!).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
      return reply.type('application/octet-stream').header('Content-Disposition', "attachment; filename*=UTF-8''" + name).header('Content-Length', String(file.size)).send(stream);
    });
  app.post<{ Params: { folderId: string }; Body: { paths: string[] } }>(base + '/:folderId/remove-files', { schema: { params: folderParams, body: obj({
    paths: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 4096 } } }, ['paths']) } },
  async request => registry.removeFiles(actor(request), request.params.folderId, request.body));
  app.post<{ Params: { folderId: string } }>(base + '/:folderId/retry', { schema: { params: folderParams } }, async request => registry.retry(actor(request), request.params.folderId));
  app.post<{ Params: { folderId: string } }>(base + '/:folderId/accept-coverage', { schema: { params: folderParams } }, async request => registry.acceptCoverage(actor(request), request.params.folderId));

  // ---- uploads -------------------------------------------------------------------------------
  app.post<{ Params: { folderId: string }; Body: { idempotencyKey: string; mode: 'replace' | 'add'; totalFiles: number; totalBytes: number; exclusions: string[] } }>(
    base + '/:folderId/operations', { schema: { params: folderParams, body: obj({
      idempotencyKey, mode: { enum: ['replace', 'add'] }, totalFiles: { type: 'integer', minimum: 1, maximum: 10_000_000 }, totalBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      exclusions: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } } }, ['idempotencyKey', 'mode', 'totalFiles', 'totalBytes', 'exclusions']) } },
    async (request, reply) => reply.code(201).send(registry.createOperation(actor(request), request.params.folderId, request.body)));
  app.get<{ Params: { folderId: string; operationId: string }; Querystring: { cursor?: string } }>(base + '/:folderId/operations/:operationId',
    { schema: { params: operationParams, querystring: obj({ cursor: { type: 'string', pattern: '^-?[0-9]{1,9}$' } }) } },
    async request => registry.operationStatus(actor(request), request.params.folderId, request.params.operationId, Number(request.query.cursor ?? -1)));
  app.put<{ Params: { folderId: string; operationId: string }; Body: { page: number; last: boolean; entries: { path: string; size: number; sha256: string; secretFindings?: string[] }[] } }>(
    base + '/:folderId/operations/:operationId/manifest', { bodyLimit: 2_000_000, schema: { params: operationParams, body: obj({
      page: { type: 'integer', minimum: 0, maximum: 100_000 }, last: { type: 'boolean' },
      entries: { type: 'array', maxItems: 1000, items: obj({ path: { type: 'string', minLength: 1, maxLength: 4096 }, size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, secretFindings: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } }, ['path', 'size', 'sha256']) },
    }, ['page', 'last', 'entries']) } }, async request => registry.putManifest(actor(request), request.params.folderId, request.params.operationId, request.body));
  app.post<{ Params: { folderId: string; operationId: string; fileId: string } }>(base + '/:folderId/operations/:operationId/files/:fileId/secret-decision',
    { schema: { params: obj({ folderId: id('lib_'), operationId, fileId: id('f_') }, ['folderId', 'operationId', 'fileId']) } },
    async request => registry.secretDecision(actor(request), request.params.folderId, request.params.operationId, request.params.fileId));
  app.post<{ Params: { folderId: string; operationId: string }; Body: { idempotencyKey: string } }>(base + '/:folderId/operations/:operationId/complete',
    { schema: { params: operationParams, body: obj({ idempotencyKey }, ['idempotencyKey']) } },
    async (request, reply) => reply.code(202).send(await registry.completeOperation(actor(request), request.params.folderId, request.params.operationId, request.body.idempotencyKey)));
  app.post<{ Params: { folderId: string; operationId: string } }>(base + '/:folderId/operations/:operationId/cancel', { schema: { params: operationParams } },
    async request => registry.cancelOperation(actor(request), request.params.folderId, request.params.operationId));
  // Raw part bodies: parser scoped to this plugin; size bounded by the configured part size.
  void app.register(async scoped => {
    scoped.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: registry.limits.partBytes + 1024 }, (_request, body, done) => done(null, body));
    scoped.put<{ Params: { folderId: string; operationId: string; fileId: string; part: string }; Body: Buffer }>(base + '/:folderId/operations/:operationId/files/:fileId/parts/:part', {
      bodyLimit: registry.limits.partBytes + 1024,
      schema: { params: obj({ folderId: id('lib_'), operationId, fileId: id('f_'), part: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } }, ['folderId', 'operationId', 'fileId', 'part']) },
    }, async request => {
      const a = actor(request);
      registry.authorizeOperation(a, request.params.folderId, request.params.operationId);
      if (!Buffer.isBuffer(request.body)) throw new BridgeError('Передайте часть файла как application/octet-stream.', 415);
      const declared = request.headers['x-content-sha256'];
      if (declared !== undefined && (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared))) throw new BridgeError('Некорректный заголовок X-Content-SHA256.');
      return registry.putPart(a, request.params.folderId, request.params.operationId, request.params.fileId, Number(request.params.part), request.body, declared);
    });
  });

  // ---- projects ------------------------------------------------------------------------------
  const project = '/api/projects/:projectId/library';
  const projectParams = obj({ projectId: anyId }, ['projectId']);
  const connectionParams = obj({ projectId: anyId, folderId: id('lib_') }, ['projectId', 'folderId']);
  app.get<{ Params: { projectId: string } }>(project, { schema: { params: projectParams } }, async request => policy.view(actor(request), request.params.projectId));
  app.post<{ Params: { projectId: string }; Body: { folderId: string; outputPolicy?: OutputPolicy } }>(project, { schema: { params: projectParams, body: obj({
    folderId: id('lib_'), outputPolicy }, ['folderId']) } }, async (request, reply) => reply.code(201).send(policy.connect(actor(request), request.params.projectId, request.body)));
  app.patch<{ Params: { projectId: string; folderId: string }; Body: { revision: number; enabled?: boolean; outputPolicy?: OutputPolicy } }>(project + '/:folderId',
    { schema: { params: connectionParams, body: obj({ revision, enabled: { type: 'boolean' }, outputPolicy }, ['revision']) } },
    async request => policy.updateConnection(actor(request), request.params.projectId, request.params.folderId, request.body));
  app.delete<{ Params: { projectId: string; folderId: string }; Querystring: { revision: string } }>(project + '/:folderId',
    { schema: { params: connectionParams, querystring: obj({ revision: { type: 'string', pattern: '^[0-9]{1,10}$' } }, ['revision']) } },
    async request => policy.disconnect(actor(request), request.params.projectId, request.params.folderId, Number(request.query.revision)));
  app.put<{ Params: { projectId: string; folderId: string }; Body: { profileId: string; enabled: boolean; outputPolicy?: OutputPolicy | null; revision: number; allFiles?: boolean } }>(
    project + '/:folderId/grants', { schema: { params: connectionParams, body: obj({ profileId: anyId, enabled: { type: 'boolean' },
      outputPolicy: { anyOf: [outputPolicy, { type: 'null' }] }, revision, allFiles: { type: 'boolean' } }, ['profileId', 'enabled', 'revision']) } },
    async request => policy.setGrant(actor(request), request.params.projectId, request.params.folderId, request.body));
}
