import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Credential } from '../shared/types.js';
import { FastkoreMcp } from '../server/fastkore-mcp.js';
import { testCertificate } from './test-certificate.js';

test('Fastkore MCP forwards native tool schemas and arguments, isolates SSO sessions and handles revocation without replay', async () => {
  const tls = testCertificate(), installationId = randomUUID(), key = 'fkap1.' + installationId + '.example';
  const credentials: Credential[] = ['alice', 'boris'].map(userId => ({ id: randomUUID(), userId, kind: 'session',
    hash: '', name: 'Fastkore', createdAt: new Date().toISOString(), source: 'fastkore', installationId, externalUserId: randomUUID() }));
  const issued = new Map<string, number>(), revoked = new Set<string>();
  const calls: { user: string; name: string; args: unknown }[] = [];
  const orderSchema = { type: 'object', properties: { guid: { type: 'string', format: 'uuid' } }, required: ['guid'], additionalProperties: false };
  let denyNext = false;
  let orderErrorStatus = 200;
  let catalogStatus = 200;
  const server = createServer(tls, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    if (req.url === '/api/ai/user-token') {
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      assert.equal(value.audience, 'fastkore-mcp');
      const user = String(value.delegation).split('.')[1];
      if (revoked.has(user)) { send(403, { code: 'invalid_delegation' }); return; }
      const count = (issued.get(user) ?? 0) + 1;
      issued.set(user, count);
      send(200, { version: 1, token_type: 'Bearer', access_token: `fkua1.${user}.${count}`, audience: 'fastkore-mcp', expires_in: 300 });
      return;
    }
    if (req.url === '/api/ai/revoke-delegation') {
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      revoked.add(String(value.delegation).split('.')[1]);
      send(200, { version: 1, revoked: true }); return;
    }
    assert.equal(req.url, '/webapi/mcp');
    const user = req.headers.authorization?.match(/^Bearer fkua1\.(alice|boris)\.\d+$/)?.[1];
    assert.ok(user);
    const rpc = (result: unknown) => send(200, { jsonrpc: '2.0', id: value.id, result });
    if (value.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-' + user });
      res.end('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { protocolVersion: '2025-06-18' } }) + '\r\n\r\n');
      return;
    }
    assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(req.headers['mcp-session-id'], 'session-' + user);
    if (value.method === 'notifications/initialized') { send(202); return; }
    if (value.method === 'tools/list') {
      if (catalogStatus !== 200) { send(catalogStatus); return; }
      const inputSchema = { type: 'object', properties: {} };
      if (value.params.cursor === 'next') rpc({ tools: [{ name: 'GetOrders', inputSchema }, { name: 'GetOrder', inputSchema: orderSchema }] });
      else rpc({ tools: [{ name: 'GetCurrentUserInfo', inputSchema }, { name: 'CreateSalesOrder', inputSchema }], nextCursor: 'next' });
      return;
    }
    assert.equal(value.method, 'tools/call');
    calls.push({ user, name: value.params.name, args: value.params.arguments });
    if (denyNext) { denyNext = false; send(401); return; }
    if (value.params.name === 'CreateSalesOrder') {
      send(orderErrorStatus, { jsonrpc: '2.0', id: value.id, error: {
        code: -32001, message: 'Невозможно создать заказ: fkua1.alice.should-redact', data: 'private diagnostic',
      } });
      return;
    }
    rpc({ content: [{ type: 'text', text: `user=${user}; fkua1.${user}.should-redact` }], isError: false });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `https://127.0.0.1:${address.port}`;
  const binding = { origin, key, ca: tls.cert, mcpCa: tls.cert, revision: 'rev', mcpUrl: origin + '/webapi/mcp', mcpEnabled: true };
  const invalidations: string[] = [];
  const manager = () => new FastkoreMcp({
    delegationBinding: () => ({ ...binding, mcpUrl: binding.mcpEnabled ? binding.mcpUrl : undefined }),
    openDelegation: c => c.erpDelegation && { grant: 'fkug1.' + c.userId, expiresAt: c.erpDelegation.expiresAt },
  }, async (id, reason) => {
    invalidations.push(reason);
    const credential = credentials.find(c => c.id === id)!;
    delete credential.erpDelegation;
    credential.erpDelegationRevoked = true;
  });
  const mcp = manager();
  const [alice, boris] = credentials;
  const attach = (c: Credential, expiresAt = Date.now() + 20_000) => {
    c.erpDelegation = { sealedGrant: 'test', expiresAt, revision: binding.revision };
  };
  const signal = new AbortController().signal;
  let readOnly = false;
  const prepare = (c: Credential) => mcp.prepare(c, () => {}, signal, undefined, () => readOnly);
  try {
    assert.equal((await prepare(alice)).tools, undefined);
    attach(alice); attach(boris);
    const [a, b] = await Promise.all([prepare(alice), prepare(boris)]);
    assert.ok(a.tools && b.tools);
    assert.deepEqual(a.tools.definitions.map(tool => tool.name), ['fastkore_GetCurrentUserInfo', 'fastkore_CreateSalesOrder', 'fastkore_GetOrders', 'fastkore_GetOrder']);
    assert.deepEqual(a.tools.definitions.find(tool => tool.name === 'fastkore_GetOrder')?.inputSchema, orderSchema);
    assert.equal((await a.tools.call('fastkore_UnknownTool', {}, signal)).success, false);
    binding.mcpEnabled = false;
    assert.equal(mcp.status(alice), 'unavailable');
    assert.match((await a.tools.call('fastkore_GetOrders', {}, signal)).text, /отключён в настройках/);
    assert.equal(calls.length, 0);
    binding.mcpEnabled = true;
    catalogStatus = 503;
    assert.match((await prepare(alice)).problem!, /MCP вернул HTTP 503/);
    assert.match(mcp.lastCatalogProblem(alice.id)!, /503/);
    assert.equal(mcp.lastCatalogProblem(boris.id), undefined);
    catalogStatus = 200;
    assert.ok((await prepare(alice)).tools);
    assert.equal(mcp.lastCatalogProblem(alice.id), undefined);
    assert.match((await a.tools.call('fastkore_GetCurrentUserInfo', {}, signal)).text, /user=alice/);
    assert.doesNotMatch((await b.tools.call('fastkore_GetCurrentUserInfo', {}, signal)).text, /fkua1/);
    assert.deepEqual([...issued.values()], [1, 1]);
    denyNext = true;
    const rejected = await a.tools.call('fastkore_GetOrders', {}, signal);
    assert.equal(rejected.success, false);
    assert.equal(calls.length, 3);
    await a.tools.call('fastkore_GetOrders', {}, signal);
    assert.equal(issued.get('alice'), 2);
    const args = { guid: randomUUID() };
    readOnly = true;
    const restricted = await prepare(alice);
    assert.deepEqual(restricted.tools?.definitions.map(tool => tool.name),
      ['fastkore_GetCurrentUserInfo', 'fastkore_GetOrders', 'fastkore_GetOrder']);
    const beforeBlockedCall = calls.length;
    const blockedWrite = await a.tools.call('fastkore_CreateSalesOrder', {}, signal);
    assert.equal(blockedWrite.success, false);
    assert.match(blockedWrite.text, /только чтение/);
    assert.equal(calls.length, beforeBlockedCall);
    assert.equal((await a.tools.call('fastkore_GetOrder', args, signal)).success, true);
    assert.deepEqual(calls.at(-1), { user: 'alice', name: 'GetOrder', args });
    assert.deepEqual(await mcp.revoke(alice), { revokeDelivery: 'http_response', status: 200 });
    assert.ok(revoked.has('alice'));
    assert.equal((await a.tools.call('fastkore_GetOrders', {}, signal)).success, false);
    assert.equal(calls.length, 5);
    readOnly = false;
    const orderAudit: { status?: number; mcpFailure?: string; mcpErrorCode?: number; success: boolean }[] = [];
    const orderTools = (await mcp.prepare(boris, () => {}, signal, event => orderAudit.push(event))).tools!;
    for (const status of [200, 400]) {
      orderErrorStatus = status;
      const before = calls.length;
      const order = { payload: { ContractorGuid: args.guid, Positions: [] } };
      const result = await orderTools.call('fastkore_CreateSalesOrder', order, signal);
      assert.equal(result.success, false);
      assert.deepEqual(JSON.parse(result.text), { error: { code: -32001, message: 'Невозможно создать заказ: [REDACTED]' } });
      assert.deepEqual(calls.slice(before), [{ user: 'boris', name: 'CreateSalesOrder', args: order }]);
      const event = orderAudit.at(-1)!;
      assert.equal(event.status, status);
      assert.equal(event.mcpFailure, 'rpc');
      assert.equal(event.mcpErrorCode, -32001);
      assert.equal(event.success, false);
    }
    const restarted = manager();
    assert.ok((await restarted.prepare(boris, () => {}, signal)).tools);
    assert.equal(issued.get('boris'), 2, 'restart obtains a fresh token for the same ERP user');
    revoked.add('boris');
    const denied = await manager().prepare(boris, () => {}, signal);
    assert.deepEqual(invalidations, ['mcp_token_denied']);
    assert.match(denied.problem!, /отклонила делегирование.*токена MCP/);
    assert.equal(boris.erpDelegation, undefined);
    assert.equal(manager().status(boris), 'reauth');
    const expired = { ...alice, id: randomUUID() };
    credentials.push(expired);
    attach(expired, Date.now() - 1);
    assert.equal(mcp.status(expired), 'reauth');
    assert.deepEqual(invalidations, ['mcp_token_denied', 'expired']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('Fastkore reads only files listed on the requested card or comment, using a separate WebAPI token', async () => {
  const tls = testCertificate(), card = randomUUID(), comment = randomUUID(), component = randomUUID(), commentComponent = randomUUID();
  const jpgId = randomUUID(), pdfId = randomUUID();
  const jpg = Buffer.from('ffd8ffe0ffd9', 'hex');
  let pdfText = '%PDF-1.4\n';
  const stream = 'BT /F1 12 Tf 10 100 Td (Material 42) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  const offsets = objects.map((object, i) => {
    const offset = pdfText.length;
    pdfText += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdfText.length;
  pdfText += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const audiences: string[] = [], downloads: string[] = [];
  const credential: Credential = { id: randomUUID(), userId: randomUUID(), kind: 'session', source: 'fastkore', name: 'Test',
    hash: '', createdAt: new Date().toISOString(), erpDelegation: { sealedGrant: 'test', revision: 'rev', expiresAt: Date.now() + 60_000 } };
  let redirect = false;
  const server = createServer(tls, async (req, res) => {
    const url = new URL(req.url!, 'https://erp.test');
    const send = (payload: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    if (url.pathname === '/webapi/getfile') {
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, 'Bearer fkua1.fastkore-webapi');
      const fileId = url.searchParams.get('fileGuid')!;
      downloads.push(fileId);
      if (redirect) return res.writeHead(302, { Location: '/other' }).end();
      return res.end(fileId === jpgId ? jpg : pdfText);
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (url.pathname === '/api/ai/user-token') {
      assert.equal(req.headers.authorization, 'Bearer test-key');
      assert.equal(body.delegation, 'fkug1.test');
      assert.ok(['fastkore-mcp', 'fastkore-webapi'].includes(body.audience));
      audiences.push(body.audience);
      return send({ version: 1, token_type: 'Bearer', audience: body.audience, expires_in: 300, access_token: 'fkua1.' + body.audience });
    }
    assert.equal(url.pathname, '/webapi/mcp');
    assert.equal(req.headers.authorization, 'Bearer fkua1.fastkore-mcp');
    const rpc = (result: unknown) => send({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return rpc({ protocolVersion: '2025-06-18' });
    if (body.method === 'notifications/initialized') return res.writeHead(202).end();
    if (body.method === 'tools/list') return rpc({ tools: [{ name: 'GetObjectFiles', inputSchema: { type: 'object' } }] });
    assert.equal(body.params.name, 'GetObjectFiles');
    const { componentGuid, objectGuid } = body.params.arguments;
    const files = componentGuid === component && objectGuid === card
      ? [{ Guid: jpgId, Name: 'screen.jpg', IsFolder: false, DownloadUrl: 'https://untrusted.test/' }]
      : componentGuid === commentComponent && objectGuid === comment
        ? [{ Guid: pdfId, Name: 'math.pdf', IsFolder: false }] : [];
    return rpc({ content: [{ type: 'text', text: JSON.stringify(files) }] });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = 'https://127.0.0.1:' + address.port;
    const mcp = new FastkoreMcp({
      delegationBinding: () => ({ origin, key: 'test-key', ca: tls.cert, mcpCa: tls.cert, revision: 'rev', mcpUrl: origin + '/webapi/mcp', mcpEnabled: true, cliEnabled: true }),
      openDelegation: () => ({ grant: 'fkug1.test', expiresAt: credential.erpDelegation!.expiresAt }),
    }, async () => { assert.fail('the delegation should remain active'); });
    const signal = AbortSignal.timeout(10000);
    const tools = (await mcp.prepare(credential, () => {}, signal, undefined, () => true)).tools!;
    assert.ok(tools.definitions.some(tool => tool.name === 'fastkore_GetObjectFiles'));
    assert.ok(tools.definitions.some(tool => tool.name === 'fastkore_read_attachment'));
    const read = (componentGuid: string, objectGuid: string, fileGuid: string) =>
      tools.call('fastkore_read_attachment', { componentGuid, objectGuid, fileGuid }, signal);
    assert.equal((await read(component, card, pdfId)).success, false);
    assert.deepEqual(audiences, ['fastkore-mcp']);
    assert.deepEqual(downloads, []);
    const image = await read(component, card, jpgId);
    assert.equal(image.imageUrl, 'data:image/jpeg;base64,' + jpg.toString('base64'));
    const pdf = await read(commentComponent, comment, pdfId);
    assert.equal(pdf.success, true, pdf.text);
    assert.match(pdf.text, /Material 42/);
    assert.deepEqual(audiences, ['fastkore-mcp', 'fastkore-webapi']);
    assert.deepEqual(downloads, [jpgId, pdfId]);
    redirect = true;
    assert.equal((await read(commentComponent, comment, pdfId)).success, false);
    assert.deepEqual(downloads, [jpgId, pdfId, pdfId]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
