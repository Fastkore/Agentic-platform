import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Credential } from '../shared/types.js';
import { parseFastkoreContext } from '../shared/fastkore-context.js';
import { FastkoreMcp } from '../server/fastkore-mcp.js';
import { testCertificate } from './test-certificate.js';

test('Fastkore MCP scopes tokens to two SSO sessions, blocks writes and handles revocation without replay', async () => {
  const tls = testCertificate(), installationId = randomUUID(), key = 'fkap1.' + installationId + '.example';
  const credentials: Credential[] = ['alice', 'boris'].map(userId => ({ id: randomUUID(), userId, kind: 'session',
    hash: '', name: 'Fastkore', createdAt: new Date().toISOString(), source: 'fastkore', installationId, externalUserId: randomUUID() }));
  const issued = new Map<string, number>(), revoked = new Set<string>();
  const calls: { user: string; name: string }[] = [];
  let denyNext = false;
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
      const inputSchema = { type: 'object', properties: {} };
      if (value.params.cursor === 'next') rpc({ tools: [{ name: 'GetOrders', inputSchema }] });
      else rpc({ tools: [{ name: 'GetCurrentUserInfo', inputSchema }, { name: 'CreateTask', inputSchema }], nextCursor: 'next' });
      return;
    }
    assert.equal(value.method, 'tools/call');
    calls.push({ user, name: value.params.name });
    if (denyNext) { denyNext = false; send(401); return; }
    rpc({ content: [{ type: 'text', text: `user=${user}; fkua1.${user}.should-redact` }], isError: false });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `https://127.0.0.1:${address.port}`;
  const binding = { origin, key, ca: tls.cert, mcpCa: tls.cert, revision: 'rev', mcpUrl: origin + '/webapi/mcp' };
  const manager = () => new FastkoreMcp({
    delegationBinding: () => binding,
    openDelegation: c => c.erpDelegation && { grant: 'fkug1.' + c.userId, expiresAt: c.erpDelegation.expiresAt },
  }, async id => {
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
  const prepare = (c: Credential) => mcp.prepare(c, undefined, () => {}, signal);
  try {
    assert.equal((await prepare(alice)).tools, undefined);
    attach(alice); attach(boris);
    const [a, b] = await Promise.all([prepare(alice), prepare(boris)]);
    assert.ok(a.tools && b.tools);
    assert.deepEqual(a.tools.definitions.map(tool => tool.name), ['fastkore_GetCurrentUserInfo', 'fastkore_GetOrders']);
    assert.ok(!a.tools.definitions.some(tool => tool.name.includes('CreateTask')));
    assert.equal((await a.tools.call('fastkore_CreateTask', {}, signal)).success, false);
    assert.match((await a.tools.call('fastkore_GetCurrentUserInfo', {}, signal)).text, /user=alice/);
    assert.doesNotMatch((await b.tools.call('fastkore_GetCurrentUserInfo', {}, signal)).text, /fkua1/);
    assert.deepEqual([...issued.values()], [1, 1]);
    denyNext = true;
    const rejected = await a.tools.call('fastkore_GetOrders', {}, signal);
    assert.equal(rejected.success, false);
    assert.equal(calls.length, 3);
    await a.tools.call('fastkore_GetOrders', {}, signal);
    assert.equal(issued.get('alice'), 2);
    const context = parseFastkoreContext({ type: 'fastkore.context', version: 1, view: 'list', entity_set_id: randomUUID(),
      filter_status: 'included', filter_xml: '<Filter/>', scope_reproducible: true });
    assert.ok(context);
    const scoped = await mcp.prepare(alice, context, () => {}, signal);
    assert.match(scoped.problem!, /Текущая выборка/);
    assert.deepEqual(scoped.tools?.definitions.map(tool => tool.name), ['fastkore_GetCurrentUserInfo', 'fastkore_GetOrders']);
    assert.equal((await scoped.tools!.call('fastkore_GetOrders', { scope: 'current', arguments: {} }, signal)).success, false);
    assert.equal((await scoped.tools!.call('fastkore_GetOrders', { scope: 'erp', arguments: {} }, signal)).success, true);
    assert.equal(calls.at(-1)?.user, 'alice');
    await mcp.revoke(alice);
    assert.ok(revoked.has('alice'));
    assert.equal((await a.tools.call('fastkore_GetOrders', {}, signal)).success, false);
    assert.equal(calls.length, 5);
    const restarted = manager();
    assert.ok((await restarted.prepare(boris, undefined, () => {}, signal)).tools);
    assert.equal(issued.get('boris'), 2, 'restart obtains a fresh token for the same ERP user');
    revoked.add('boris');
    const denied = await manager().prepare(boris, undefined, () => {}, signal);
    assert.match(denied.problem!, /доступ к ERP завершён или отозван/i);
    assert.equal(boris.erpDelegation, undefined);
    assert.equal(manager().status(boris), 'reauth');
    const expired = { ...alice, id: randomUUID() };
    credentials.push(expired);
    attach(expired, Date.now() - 1);
    assert.equal(mcp.status(expired), 'reauth');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
