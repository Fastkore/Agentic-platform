import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { KnowledgeBase } from './knowledge.js';
import type { KnowledgeSection } from '../shared/knowledge.js';
import { BridgeError } from './store.js';

export function knowledgeRoutes(app: FastifyInstance, knowledge: KnowledgeBase, authorize: (request: FastifyRequest) => unknown) {
  type Params = { section: KnowledgeSection; id: string };
  const route = '/api/admin/knowledge/:section';
  const params = { type: 'object', required: ['section'], properties: { section: { enum: ['fastkore', 'company'] }, id: { type: 'string', maxLength: 100 } } };
  const revision = { type: 'string', minLength: 1, maxLength: 100 };
  const schema = { params };
  app.get<{ Params: Params }>(route, { schema }, request => { authorize(request); return knowledge.overview(request.params.section); });
  app.put<{ Params: Params; Body: { summary: string; revision: string } }>(route, { schema: { params, body: {
    type: 'object', additionalProperties: false, required: ['summary', 'revision'], properties: { summary: { type: 'string', maxLength: 4000 }, revision },
  } } }, request => { authorize(request); return knowledge.summary(request.params.section, request.body.summary, request.body.revision); });
  app.post<{ Params: Params }>(route + '/files', { schema }, async (request, reply) => {
    const check = () => { authorize(request); };
    check();
    const file = await request.file();
    if (!file) throw new BridgeError('Выберите файл.');
    return reply.code(201).send(await knowledge.upload(request.params.section, file.filename, await file.toBuffer(), check));
  });
  app.put<{ Params: Params; Querystring: { revision: string } }>(route + '/files/:id', { schema: { params, querystring: {
    type: 'object', required: ['revision'], properties: { revision }, additionalProperties: false,
  } } }, async request => {
    const check = () => { authorize(request); };
    check();
    const file = await request.file();
    if (!file) throw new BridgeError('Выберите файл.');
    return knowledge.upload(request.params.section, file.filename, await file.toBuffer(), check, { id: request.params.id, revision: request.query.revision });
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
    authorize(request);
    knowledge.remove(request.params.section, request.params.id, request.body.revision);
    return { ok: true };
  });
}
