import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { KnowledgeBase } from './knowledge.js';
import type { KnowledgeSection } from '../shared/knowledge.js';
import { BridgeError } from './store.js';
import type { UploadAdmission } from './upload-admission.js';
import type { User } from '../shared/types.js';

export function knowledgeRoutes(app: FastifyInstance, knowledge: KnowledgeBase, authorize: (request: FastifyRequest) => User, uploads: UploadAdmission) {
  type Params = { section: KnowledgeSection; id: string };
  const route = '/api/admin/knowledge/:section';
  const params = { type: 'object', required: ['section'], properties: { section: { enum: ['fastkore', 'company'] }, id: { type: 'string', maxLength: 100 } } };
  const revision = { type: 'string', minLength: 1, maxLength: 100 };
  const schema = { params };
  app.get<{ Params: Params }>(route, { schema }, request => { authorize(request); return knowledge.overview(request.params.section); });
  app.put<{ Params: Params; Body: { summary: string; revision: string } }>(route, { schema: { params, body: {
    type: 'object', additionalProperties: false, required: ['summary', 'revision'], properties: { summary: { type: 'string', maxLength: 4000 }, revision },
  } } }, request => {
    const { id: actorId } = authorize(request), { section } = request.params;
    return knowledge.summary(section, request.body.summary, request.body.revision, actorId);
  });
  app.post<{ Params: Params }>(route + '/files', { schema }, async (request, reply) => {
    const check = () => { authorize(request); };
    const { id: actorId } = authorize(request), { section } = request.params;
    const file = await uploads.receive(request, actorId, (name, data) => knowledge.upload(section, name, data, check, undefined, actorId));
    return reply.code(201).send(file);
  });
  app.put<{ Params: Params; Querystring: { revision: string } }>(route + '/files/:id', { schema: { params, querystring: {
    type: 'object', required: ['revision'], properties: { revision }, additionalProperties: false,
  } } }, async request => {
    const check = () => { authorize(request); };
    const { id: actorId } = authorize(request), { section, id } = request.params, previousRevision = request.query.revision;
    return uploads.receive(request, actorId, (name, data) => knowledge.upload(section, name, data, check, { id, revision: previousRevision }, actorId));
  });
  app.get<{ Params: Params }>(route + '/files/:id', { schema }, (request, reply) => {
    authorize(request);
    const { file, content } = knowledge.get(request.params.section, request.params.id);
    const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    return reply.type('application/octet-stream').header('Content-Disposition', "attachment; filename*=UTF-8''" + name).send(content);
  });
  app.delete<{ Params: Params; Body: { revision: string } }>(route + '/files/:id', { schema: { params, body: {
    type: 'object', required: ['revision'], properties: { revision }, additionalProperties: false,
  } } }, request => {
    const { id: actorId } = authorize(request), { section, id } = request.params;
    knowledge.remove(section, id, request.body.revision, actorId);
    return { ok: true };
  });
}
