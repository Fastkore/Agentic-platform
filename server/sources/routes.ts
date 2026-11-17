import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { delegableSourceActions } from '../../shared/sources.js';
import type { BindingSelector, SourceAction, SourceClassification, SourceKind, SourceOutputPolicy } from '../../shared/sources.js';
import { BridgeError } from '../store.js';
import type { SourceIndexer } from './indexer.js';
import { applyLegacyMigration, importServerDirectory, legacyReport } from './legacy.js';
import type { SourcePolicy } from './policy.js';
import type { SourceReader } from './reader.js';
import { notFound, type SourceActor, type SourceRegistry } from './registry.js';

export interface SourceRouteDeps {
  registry: SourceRegistry; policy: SourcePolicy; reader: SourceReader; indexer: SourceIndexer;
  actor: (request: FastifyRequest) => SourceActor;
  /** Resolves a chat the employee may open; returns the chat's specialist. Throws 404 otherwise. */
  chat: (request: FastifyRequest, projectId: string, chatId: string) => { userId: string; profileId: string };
  /** Current rights of a user named by an upload token (disabled users get undefined). */
  userActor: (userId: string) => SourceActor | undefined;
  legacy?: import('./legacy.js').LegacyDirectory;
}
/** Routes a local upload utility may call with a short-lived source token. */
export const uploadTokenRoutes = new Set(['/api/admin/sources/:sourceId/uploads', '/api/admin/sources/:sourceId/uploads/:uploadId', '/api/admin/sources/:sourceId/uploads/:uploadId/manifest',
  '/api/admin/sources/:sourceId/uploads/:uploadId/files/:fileId/parts/:part', '/api/admin/sources/:sourceId/uploads/:uploadId/files/:fileId/secret-decision',
  '/api/admin/sources/:sourceId/uploads/:uploadId/complete', '/api/admin/sources/:sourceId/uploads/:uploadId/cancel', '/api/admin/sources/:sourceId/snapshots']);
export const isUploadToken = (authorization: string | undefined) => !!authorization?.startsWith('Bearer fksrc1.');
const id = (prefix: string) => ({ type: 'string', pattern: `^${prefix}[A-Za-z0-9_-]{1,80}$` });
const anyId = { type: 'string', minLength: 1, maxLength: 100 };
const revision = { type: 'integer', minimum: 0, maximum: 2147483647 };
const date = { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const outputPolicy = { enum: ['explanation_only', 'excerpts_allowed'] };
const managers = { type: 'array', maxItems: 50, items: obj({ userId: anyId, actions: { type: 'array', maxItems: 10, uniqueItems: true, items: { enum: delegableSourceActions } } }, ['userId', 'actions']) };
const idempotencyKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' };

export function sourceRoutes(app: FastifyInstance, deps: SourceRouteDeps) {
  const { registry, policy, reader, indexer } = deps;
  const actor = (request: FastifyRequest): SourceActor => {
    const authorization = request.headers.authorization;
    if (!isUploadToken(authorization)) return deps.actor(request);
    const route = request.routeOptions.url ?? '';
    const sourceId = (request.params as { sourceId?: string }).sourceId ?? '';
    const userId = uploadTokenRoutes.has(route) ? registry.uploadTokenUser(authorization!.slice(7), sourceId) : undefined;
    const resolved = userId && deps.userActor(userId);
    if (!resolved) throw new BridgeError('Токен утилиты недействителен или истёк.', 401);
    return resolved;
  };
  const base = '/api/admin/sources';
  const sourceParams = obj({ sourceId: id('src_') }, ['sourceId']);
  const snapshotParams = obj({ sourceId: id('src_'), snapshotId: id('snp_') }, ['sourceId', 'snapshotId']);
  const uploadParams = obj({ sourceId: id('src_'), uploadId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } }, ['sourceId', 'uploadId']);
  const projectParams = obj({ projectId: anyId }, ['projectId']);
  const admin = (request: FastifyRequest) => { const a = actor(request); if (!a.admin) throw new BridgeError('Доступно только руководителю.', 403); return a; };

  app.get(base + '-storage', async request => { admin(request); return registry.storageStatus(); });
  app.post(base + '-storage/check', async request => {
    admin(request);
    if (!registry.storage.store) throw new BridgeError(registry.storage.problem ?? 'Хранилище источников не настроено.', 503);
    await registry.storage.store.check();
    return { ok: true, kind: registry.storage.store.kind };
  });
  app.get(base, async request => registry.listSources(actor(request)));
  app.post<{ Body: { name: string; description?: string; kind: SourceKind; classification: SourceClassification; outputPolicy?: SourceOutputPolicy; quotaBytes?: number;
    managers?: { userId: string; actions: SourceAction[] }[]; projectId?: string } }>(base, { schema: { body: obj({
      name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 2000 }, kind: { enum: ['code', 'documents', 'prices', 'mixed'] },
      classification: { enum: ['shared', 'restricted'] }, outputPolicy, quotaBytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, managers, projectId: anyId,
    }, ['name', 'kind', 'classification']) } }, async (request, reply) => {
    const a = actor(request);
    const { projectId, ...input } = request.body;
    if (projectId && !policy.canManageProject(a, projectId)) throw new BridgeError('Проект не найден.', 404);
    const source = registry.createSource(a, input);
    // Created from a project: the source is attached immediately, with no specialist access yet.
    const binding = projectId ? policy.attach(a, projectId, { sourceId: source.id, selector: input.kind === 'prices' ? 'effective_date' : 'pinned' }) : undefined;
    return reply.code(201).send({ source, binding });
  });
  app.get<{ Params: { sourceId: string } }>(base + '/:sourceId', { schema: { params: sourceParams } }, async request => registry.getSource(actor(request), request.params.sourceId));
  app.patch<{ Params: { sourceId: string }; Body: { revision: number; name?: string; description?: string; classification?: SourceClassification; outputPolicy?: SourceOutputPolicy; quotaBytes?: number;
    managers?: { userId: string; actions: SourceAction[] }[] } }>(base + '/:sourceId', { schema: { params: sourceParams, body: obj({ revision, name: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', maxLength: 2000 }, classification: { enum: ['shared', 'restricted'] }, outputPolicy, quotaBytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, managers,
    }, ['revision']) } }, async request => registry.updateSource(actor(request), request.params.sourceId, request.body));
  app.post<{ Params: { sourceId: string }; Body: { revision: number } }>(base + '/:sourceId/archive', { schema: { params: sourceParams, body: obj({ revision }, ['revision']) } },
    async request => registry.archiveSource(actor(request), request.params.sourceId, request.body.revision));
  app.delete<{ Params: { sourceId: string } }>(base + '/:sourceId', { schema: { params: sourceParams } }, async request => registry.deleteSource(actor(request), request.params.sourceId));
  /** Where the source is used, filtered to projects the manager may see. */
  app.get<{ Params: { sourceId: string } }>(base + '/:sourceId/usage', { schema: { params: sourceParams } }, async request => {
    const a = actor(request);
    registry.requireSource(a, request.params.sourceId, 'manage_source');
    const usage = registry.usage(request.params.sourceId);
    const visible = (projectId: string) => a.admin || policy.directory.canAccessProject(a.id, projectId);
    const bindings = usage.bindings.filter(b => visible(b.projectId));
    const bindingIds = new Set(bindings.map(b => b.id));
    return {
      bindings: bindings.map(b => ({ ...b, projectName: policy.directory.projectName(b.projectId), approved: JSON.parse(b.approved), enabled: !!b.enabled })),
      grants: usage.grants.filter(g => bindingIds.has(g.bindingId)).map(g => ({ ...g, enabled: !!g.enabled })),
      bundles: usage.bundles.filter(b => visible(b.projectId) && (JSON.parse(b.items) as { bindingId: string }[]).some(i => bindingIds.has(i.bindingId)))
        .map(b => ({ id: b.id, projectId: b.projectId, label: b.label, revision: b.revision })),
      hiddenProjects: a.admin ? 0 : usage.bindings.length - bindings.length,
      deletionBlockers: registry.deletionBlockers(request.params.sourceId),
    };
  });
  app.get<{ Params: { sourceId: string } }>(base + '/:sourceId/snapshots', { schema: { params: sourceParams } }, async request => {
    const list = registry.listSnapshots(actor(request), request.params.sourceId);
    return list.map(s => ({ ...s, dependencies: registry.dependencies(s.id) }));
  });
  app.patch<{ Params: { sourceId: string; snapshotId: string }; Body: { metadataRevision: number; label?: string; validFrom?: string | null; validTo?: string | null } }>(
    base + '/:sourceId/snapshots/:snapshotId', { schema: { params: snapshotParams, body: obj({ metadataRevision: revision, label: { type: 'string', minLength: 1, maxLength: 120 }, validFrom: date, validTo: date }, ['metadataRevision']) } },
    async request => registry.updateSnapshotMetadata(actor(request), request.params.sourceId, request.params.snapshotId, request.body));
  app.post<{ Params: { sourceId: string; snapshotId: string } }>(base + '/:sourceId/snapshots/:snapshotId/accept-coverage', { schema: { params: snapshotParams } },
    async request => registry.acceptCoverage(actor(request), request.params.sourceId, request.params.snapshotId));
  app.post<{ Params: { sourceId: string; snapshotId: string } }>(base + '/:sourceId/snapshots/:snapshotId/reindex', { schema: { params: snapshotParams } }, async request => {
    registry.requireSource(actor(request), request.params.sourceId, 'manage_source');
    const snapshot = registry.snapshotRow(request.params.snapshotId);
    if (!snapshot || snapshot.source_id !== request.params.sourceId) throw notFound();
    return { generation: indexer.requeue(request.params.snapshotId) };
  });
  app.post<{ Params: { sourceId: string; snapshotId: string }; Body: { retained: boolean } }>(base + '/:sourceId/snapshots/:snapshotId/retention',
    { schema: { params: snapshotParams, body: obj({ retained: { type: 'boolean' } }, ['retained']) } },
    async request => registry.setRetention(actor(request), request.params.sourceId, request.params.snapshotId, request.body.retained));
  app.post<{ Params: { sourceId: string; snapshotId: string } }>(base + '/:sourceId/snapshots/:snapshotId/archive', { schema: { params: snapshotParams } },
    async request => registry.archiveSnapshot(actor(request), request.params.sourceId, request.params.snapshotId, id => policy.isBound(id)));
  app.put<{ Params: { sourceId: string; snapshotId: string }; Body: { platformSnapshotIds: string[] } }>(base + '/:sourceId/snapshots/:snapshotId/dependencies',
    { schema: { params: snapshotParams, body: obj({ platformSnapshotIds: { type: 'array', maxItems: 20, uniqueItems: true, items: id('snp_') } }, ['platformSnapshotIds']) } },
    async request => registry.setDependencies(actor(request), request.params.sourceId, request.params.snapshotId, request.body.platformSnapshotIds));
  /** Tree metadata for managers; no file contents. */
  app.get<{ Params: { sourceId: string; snapshotId: string }; Querystring: { path?: string; cursor?: string } }>(base + '/:sourceId/snapshots/:snapshotId/tree',
    { schema: { params: snapshotParams, querystring: obj({ path: { type: 'string', maxLength: 1024 }, cursor: { type: 'string', maxLength: 1100 } }) } }, async request => {
      registry.requireSource(actor(request), request.params.sourceId, 'manage_source');
      const snapshot = registry.snapshotRow(request.params.snapshotId);
      if (!snapshot || snapshot.source_id !== request.params.sourceId) throw notFound();
      return registry.tree(snapshot.id, request.query.path ?? '', request.query.cursor ?? '');
    });
  /** Originals: separate view/download permissions, audited; never used by agent tools. */
  app.get<{ Params: { sourceId: string; snapshotId: string; fileId: string }; Querystring: { download?: '1'; line?: string } }>(base + '/:sourceId/snapshots/:snapshotId/files/:fileId/original',
    { schema: { params: obj({ sourceId: id('src_'), snapshotId: id('snp_'), fileId: id('f_') }, ['sourceId', 'snapshotId', 'fileId']),
      querystring: obj({ download: { enum: ['1'] }, line: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' } }) } }, async (request, reply: FastifyReply) => {
      const a = actor(request), download = request.query.download === '1';
      registry.requireSource(a, request.params.sourceId, download ? 'download_original' : 'view_original');
      const snapshot = registry.snapshotRow(request.params.snapshotId);
      if (!snapshot || snapshot.source_id !== request.params.sourceId || snapshot.state === 'archived') throw notFound();
      const file = registry.snapshotFile(snapshot.id, request.params.fileId);
      if (!file) throw notFound();
      registry.recordAudit({ actorId: a.id, action: download ? 'source.original.download' : 'source.original.view', targetId: file.file_id,
        details: { objectIds: { sourceId: snapshot.source_id, snapshotId: snapshot.id } } });
      if (!download) return reader.readLines(snapshot.id, file.file_id, Number(request.query.line ?? 1), 200);
      const blob = registry.db.prepare('SELECT object_key FROM blobs WHERE id=?').get(file.blob_id) as { object_key: string };
      const stream = await registry.storage.store!.stream(blob.object_key);
      const name = encodeURIComponent(file.path.split('/').at(-1)!).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
      return reply.type('application/octet-stream').header('Content-Disposition', "attachment; filename*=UTF-8''" + name).header('Content-Length', String(file.size)).send(stream);
    });

  // ---- uploads -------------------------------------------------------------------------------
  app.post<{ Params: { sourceId: string }; Body: { idempotencyKey: string; label: string; validFrom?: string; validTo?: string; totalFiles: number; totalBytes: number; exclusions: string[];
    baseSnapshotId?: string; skipUnchanged?: boolean } }>(base + '/:sourceId/uploads', { schema: { params: sourceParams, body: obj({
      idempotencyKey, label: { type: 'string', minLength: 1, maxLength: 120 }, validFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, validTo: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      totalFiles: { type: 'integer', minimum: 1, maximum: 10_000_000 }, totalBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      exclusions: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } }, baseSnapshotId: id('snp_'), skipUnchanged: { type: 'boolean' },
    }, ['idempotencyKey', 'label', 'totalFiles', 'totalBytes', 'exclusions']) } }, async (request, reply) => reply.code(201).send(registry.createUpload(actor(request), request.params.sourceId, request.body)));
  app.get<{ Params: { sourceId: string; uploadId: string }; Querystring: { cursor?: string } }>(base + '/:sourceId/uploads/:uploadId',
    { schema: { params: uploadParams, querystring: obj({ cursor: { type: 'string', pattern: '^-?[0-9]{1,9}$' } }) } },
    async request => registry.uploadStatus(actor(request), request.params.sourceId, request.params.uploadId, Number(request.query.cursor ?? -1)));
  app.put<{ Params: { sourceId: string; uploadId: string }; Body: { page: number; last: boolean; entries: { path: string; size: number; sha256: string; secretFindings?: string[] }[] } }>(
    base + '/:sourceId/uploads/:uploadId/manifest', { bodyLimit: 2_000_000, schema: { params: uploadParams, body: obj({
      page: { type: 'integer', minimum: 0, maximum: 100_000 }, last: { type: 'boolean' },
      entries: { type: 'array', maxItems: 1000, items: obj({ path: { type: 'string', minLength: 1, maxLength: 4096 }, size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, secretFindings: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } }, ['path', 'size', 'sha256']) },
    }, ['page', 'last', 'entries']) } }, async request => registry.putManifest(actor(request), request.params.sourceId, request.params.uploadId, request.body));
  app.post<{ Params: { sourceId: string; uploadId: string; fileId: string } }>(base + '/:sourceId/uploads/:uploadId/files/:fileId/secret-decision',
    { schema: { params: obj({ sourceId: id('src_'), uploadId: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, fileId: id('f_') }, ['sourceId', 'uploadId', 'fileId']) } },
    async request => registry.secretDecision(actor(request), request.params.sourceId, request.params.uploadId, request.params.fileId, 'include'));
  app.post<{ Params: { sourceId: string; uploadId: string }; Body: { idempotencyKey: string } }>(base + '/:sourceId/uploads/:uploadId/complete',
    { schema: { params: uploadParams, body: obj({ idempotencyKey }, ['idempotencyKey']) } },
    async (request, reply) => reply.code(202).send(await registry.completeUpload(actor(request), request.params.sourceId, request.params.uploadId, request.body.idempotencyKey)));
  app.post<{ Params: { sourceId: string; uploadId: string } }>(base + '/:sourceId/uploads/:uploadId/cancel', { schema: { params: uploadParams } },
    async request => registry.cancelUpload(actor(request), request.params.sourceId, request.params.uploadId));
  // Raw part bodies: parser scoped to this plugin; size bounded by the configured part size.
  void app.register(async scoped => {
    scoped.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: registry.limits.partBytes + 1024 }, (_request, body, done) => done(null, body));
    scoped.put<{ Params: { sourceId: string; uploadId: string; fileId: string; part: string }; Body: Buffer }>(base + '/:sourceId/uploads/:uploadId/files/:fileId/parts/:part', {
      bodyLimit: registry.limits.partBytes + 1024,
      schema: { params: obj({ sourceId: id('src_'), uploadId: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, fileId: id('f_'), part: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } },
        ['sourceId', 'uploadId', 'fileId', 'part']) },
    }, async request => {
      registry.authorizeUpload(actor(request), request.params.sourceId, request.params.uploadId);
      if (!Buffer.isBuffer(request.body)) throw new BridgeError('Передайте часть файла как application/octet-stream.', 415);
      const declared = request.headers['x-content-sha256'];
      if (declared !== undefined && (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared))) throw new BridgeError('Некорректный заголовок X-Content-SHA256.');
      return registry.putPart(actor(request), request.params.sourceId, request.params.uploadId, request.params.fileId, Number(request.params.part), request.body, declared);
    });
  });

  // ---- projects ------------------------------------------------------------------------------
  const project = '/api/projects/:projectId';
  app.get<{ Params: { projectId: string } }>(project + '/sources', { schema: { params: projectParams } }, async request => {
    const a = actor(request), { projectId } = request.params;
    if (!policy.canManageProject(a, projectId)) throw new BridgeError('Проект не найден.', 404);
    const bindings = policy.listBindings(a, projectId);
    return {
      settings: policy.settings(projectId), storage: { configured: !!registry.storage.store, problem: registry.storage.problem },
      matrix: policy.matrix(a, projectId), bundles: policy.bundles(a, projectId), activeRevision: policy.activeRevision(projectId),
      bindings: bindings.map(b => {
        const source = registry.sourceInfo(b.sourceId)!;
        const snapshots = (registry.db.prepare("SELECT * FROM snapshots WHERE source_id=? AND state NOT IN ('cancelled','archived') ORDER BY uploaded_at DESC LIMIT 200").all(b.sourceId) as Parameters<SourceRegistry['snapshotSummary']>[0][])
          .map(s => registry.snapshotSummary(s));
        return { ...b, source: { id: source.id, name: source.name, kind: source.kind, classification: source.classification, description: source.description }, snapshots,
          warnings: policy.periodWarnings(b.id), canUpload: registry.can(a, b.sourceId, 'upload_snapshot') };
      }),
      available: registry.listSources(a).filter(s => !s.archivedAt && !bindings.some(b => b.sourceId === s.id) && registry.can(a, s.id, 'manage_project_binding'))
        .map(s => ({ id: s.id, name: s.name, kind: s.kind })),
    };
  });
  app.post<{ Params: { projectId: string }; Body: { sourceId: string; selector: BindingSelector; snapshotId?: string; approvedSnapshotIds?: string[]; outputPolicy?: SourceOutputPolicy } }>(
    project + '/source-bindings', { schema: { params: projectParams, body: obj({ sourceId: id('src_'), selector: { enum: ['pinned', 'effective_date'] }, snapshotId: id('snp_'),
      approvedSnapshotIds: { type: 'array', maxItems: 500, uniqueItems: true, items: id('snp_') }, outputPolicy }, ['sourceId', 'selector']) } },
    async (request, reply) => reply.code(201).send(policy.attach(actor(request), request.params.projectId, request.body)));
  app.put<{ Params: { projectId: string; bindingId: string }; Body: { revision: number; selector?: BindingSelector; snapshotId?: string | null; approvedSnapshotIds?: string[]; outputPolicy?: SourceOutputPolicy; enabled?: boolean } }>(
    project + '/source-bindings/:bindingId', { schema: { params: obj({ projectId: anyId, bindingId: id('bnd_') }, ['projectId', 'bindingId']), body: obj({ revision,
      selector: { enum: ['pinned', 'effective_date'] }, snapshotId: { anyOf: [id('snp_'), { type: 'null' }] }, approvedSnapshotIds: { type: 'array', maxItems: 500, uniqueItems: true, items: id('snp_') },
      outputPolicy, enabled: { type: 'boolean' } }, ['revision']) } },
    async request => policy.updateBinding(actor(request), request.params.projectId, request.params.bindingId, request.body));
  app.delete<{ Params: { projectId: string; bindingId: string }; Body: { revision: number } }>(project + '/source-bindings/:bindingId',
    { schema: { params: obj({ projectId: anyId, bindingId: id('bnd_') }, ['projectId', 'bindingId']), body: obj({ revision }, ['revision']) } },
    async request => policy.detach(actor(request), request.params.projectId, request.params.bindingId, request.body.revision));
  app.put<{ Params: { projectId: string }; Body: { bindingId: string; profileId: string; enabled: boolean; outputPolicy?: SourceOutputPolicy | null; bindingRevision: number } }>(
    project + '/source-grants', { schema: { params: projectParams, body: obj({ bindingId: id('bnd_'), profileId: anyId, enabled: { type: 'boolean' },
      outputPolicy: { anyOf: [outputPolicy, { type: 'null' }] }, bindingRevision: revision }, ['bindingId', 'profileId', 'enabled', 'bindingRevision']) } },
    async request => policy.setGrant(actor(request), request.params.projectId, request.body));
  app.get<{ Params: { projectId: string } }>(project + '/source-matrix', { schema: { params: projectParams } }, async request => policy.matrix(actor(request), request.params.projectId));
  app.get<{ Params: { projectId: string } }>(project + '/source-bundles', { schema: { params: projectParams } }, async request => policy.bundles(actor(request), request.params.projectId));
  app.post<{ Params: { projectId: string }; Body: { label: string; items: { bindingId: string; snapshotId: string }[]; activate?: boolean; expectedActiveRevision?: number } }>(
    project + '/source-bundles', { schema: { params: projectParams, body: obj({ label: { type: 'string', minLength: 1, maxLength: 120 }, activate: { type: 'boolean' }, expectedActiveRevision: revision,
      items: { type: 'array', minItems: 1, maxItems: 50, items: obj({ bindingId: id('bnd_'), snapshotId: id('snp_') }, ['bindingId', 'snapshotId']) } }, ['label', 'items']) } },
    async (request, reply) => reply.code(201).send(policy.createBundle(actor(request), request.params.projectId, request.body)));
  app.post<{ Params: { projectId: string; bundleId: string }; Body: { expectedActiveRevision?: number } }>(project + '/source-bundles/:bundleId/activate',
    { schema: { params: obj({ projectId: anyId, bundleId: id('bdl_') }, ['projectId', 'bundleId']), body: obj({ expectedActiveRevision: revision }) } },
    async request => policy.activateBundle(actor(request), request.params.projectId, request.params.bundleId, request.body?.expectedActiveRevision));
  app.put<{ Params: { projectId: string }; Body: { businessTimeZone: string; currentDateRule: boolean; revision: number } }>(project + '/source-settings',
    { schema: { params: projectParams, body: obj({ businessTimeZone: { type: 'string', minLength: 1, maxLength: 64 }, currentDateRule: { type: 'boolean' }, revision }, ['businessTimeZone', 'currentDateRule', 'revision']) } },
    async request => policy.saveSettings(actor(request), request.params.projectId, request.body));
  // Chat indicator and explicit switch; employees cannot change project bindings or versions.
  const chatParams = obj({ projectId: anyId, chatId: anyId }, ['projectId', 'chatId']);
  app.get<{ Params: { projectId: string; chatId: string } }>(project + '/chats/:chatId/source-scope', { schema: { params: chatParams } }, async request => {
    const { userId, profileId } = deps.chat(request, request.params.projectId, request.params.chatId);
    return policy.chatScopeView(request.params.chatId, userId, request.params.projectId, profileId);
  });
  app.post<{ Params: { projectId: string; chatId: string } }>(project + '/chats/:chatId/source-scope/switch', { schema: { params: chatParams } }, async request => {
    const { userId, profileId } = deps.chat(request, request.params.projectId, request.params.chatId);
    policy.switchChat(request.params.chatId, userId, request.params.projectId, profileId);
    registry.recordAudit({ actorId: userId, action: 'source.chat.switch', targetId: request.params.chatId, details: { chatId: request.params.chatId } });
    return policy.chatScopeView(request.params.chatId, userId, request.params.projectId, profileId);
  });
  app.post<{ Params: { sourceId: string }; Body: { ttlMinutes?: number } }>(base + '/:sourceId/upload-tokens',
    { schema: { params: sourceParams, body: obj({ ttlMinutes: { type: 'integer', minimum: 5, maximum: 240 } }) } }, async (request, reply) => {
      if (isUploadToken(request.headers.authorization)) throw new BridgeError('Токен утилиты не выдаёт новые токены.', 403);
      return reply.code(201).send(registry.issueUploadToken(actor(request), request.params.sourceId, request.body?.ttlMinutes ?? 60));
    });
  app.delete<{ Params: { sourceId: string } }>(base + '/:sourceId/upload-tokens', { schema: { params: sourceParams } }, async request => {
    if (isUploadToken(request.headers.authorization)) throw new BridgeError('Недоступно для токена утилиты.', 403);
    return registry.revokeUploadTokens(actor(request), request.params.sourceId);
  });
  // Legacy Dataset migration: report, one versioned apply, explicit import of a registered server folder (no browser file navigation).
  if (deps.legacy) {
    const legacy = deps.legacy;
    app.get(base + '-legacy', async request => { admin(request); return legacyReport(legacy, registry); });
    app.post(base + '-legacy/apply', async request => applyLegacyMigration(admin(request), legacy, registry, policy));
    app.post<{ Params: { datasetId: string }; Body: { sourceId: string; label: string; dryRun?: boolean } }>(base + '-legacy/:datasetId/import', { schema: {
      params: obj({ datasetId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,63}$' } }, ['datasetId']),
      body: obj({ sourceId: id('src_'), label: { type: 'string', minLength: 1, maxLength: 120 }, dryRun: { type: 'boolean' } }, ['sourceId', 'label']) } }, async request => {
      const a = admin(request);
      const dataset = legacy.datasets().find(d => d.id === request.params.datasetId);
      if (!dataset?.directory) throw new BridgeError('Прежний источник не найден.', 404);
      registry.recordAudit({ actorId: a.id, action: 'source.legacy.import', targetId: request.body.sourceId, details: { objectIds: { datasetId: dataset.id, dryRun: String(!!request.body.dryRun) } } });
      return importServerDirectory(a, registry, dataset.directory, request.body.sourceId, request.body.label, { dryRun: request.body.dryRun });
    });
  }
  app.get(base + '-audit', async request => { admin(request); return registry.auditPage(); });
}
