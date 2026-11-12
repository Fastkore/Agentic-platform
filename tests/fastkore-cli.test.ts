import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Credential } from '../shared/types.js';
import { parseFastkoreContext } from '../shared/fastkore-context.js';
import { withFastkoreCliReads } from '../server/codex-tools.js';
import { FastkoreCli } from '../server/fastkore-cli.js';
import { testCertificate } from './test-certificate.js';

async function requestJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('Fastkore CLI uses a fresh ticket per command and stops after ERP revokes the grant', async () => {
  const tls = testCertificate();
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\fastkore-cli-' + randomUUID() : path.join(tmpdir(), randomUUID() + '.sock');
  const externalUserId = randomUUID(), entitySetId = randomUUID(), entityId = randomUUID();
  const credential = { id: randomUUID(), externalUserId, erpDelegation: { sealedGrant: 'test', revision: '1' } } as Credential;
  const grant = { grant: 'fkug1.test-grant', expiresAt: Date.now() + 120_000 };
  const key = 'test-binding-key';
  const tickets = new Set<string>();
  const used: string[] = [];
  let denied = false, forgotten = false, wrongAudience = false, wrongTrust = false, wrongUser = false;
  const erp = httpsServer(tls, async (req, res) => {
    assert.equal(req.url, '/api/ai/cli-ticket');
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    assert.deepEqual(await requestJson(req), { version: 1, delegation: grant.grant });
    if (denied) { res.writeHead(403).end(); return; }
    const ticket = 'fkct1.' + randomUUID();
    tickets.add(ticket);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      version: 1, ticket, audience: wrongAudience ? 'fastkore-mcp' : 'fastkore-cli', expires_in: 30,
    }));
  });
  erp.listen(0, '127.0.0.1');
  await once(erp, 'listening');
  const address = erp.address();
  assert.ok(address && typeof address !== 'string');
  const authority = `127.0.0.1:${address.port}`;
  const caFingerprint = new X509Certificate(tls.cert).fingerprint256;
  const runner = httpServer(async (req, res) => {
    if (req.url === '/trust') {
      res.end(JSON.stringify({ authority, caFingerprint: wrongTrust ? 'different' : caFingerprint }));
      return;
    }
    assert.equal(req.url, '/read');
    const input = await requestJson(req);
    assert.equal(input.authority, authority);
    assert.equal(input.caFingerprint, caFingerprint);
    assert.ok(tickets.delete(input.ticket), 'every process receives a different unused ticket');
    used.push(input.operation);
    const data = input.operation === 'auth-info' ? { user: { guid: wrongUser ? randomUUID() : externalUserId } }
      : { entitySetId: input.entitySetId, entityId: input.entityId, note: input.ticket };
    res.end(JSON.stringify({ success: true, exitCode: 0, data }));
  });
  runner.listen(socket);
  await once(runner, 'listening');
  const cli = new FastkoreCli(socket);
  const sso = {
    delegationBinding: () => ({ origin: 'https://' + authority, ca: tls.cert, revision: '1', key, mcpUrl: undefined, mcpCa: undefined }),
    openDelegation: () => forgotten ? undefined : grant,
  };
  const run = (operation: Parameters<FastkoreCli['run']>[0]) => cli.run(operation, sso, () => credential,
    async id => { assert.equal(id, credential.id); forgotten = true; }, new AbortController().signal);
  try {
    assert.equal((await run({ operation: 'auth-info' })).success, true);
    const result = await run({ operation: 'get', entitySetId, entityId });
    assert.match(JSON.stringify(result.data), /REDACTED/);
    assert.doesNotMatch(JSON.stringify(result), /fkct1\./);
    assert.equal((await run({ operation: 'query', entitySetId, limit: 2 })).success, true);
    assert.deepEqual(used, ['auth-info', 'get', 'query']);
    assert.equal(tickets.size, 0);
    wrongTrust = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не совпадает с привязкой/);
    assert.equal(tickets.size, 0);
    wrongTrust = false;
    wrongAudience = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не выдала билет/);
    assert.equal(used.length, 3);
    wrongAudience = false;
    wrongUser = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не совпал с пользователем SSO/);
    denied = true;
    await assert.rejects(run({ operation: 'auth-info' }), /отозван/);
    assert.ok(forgotten);
    assert.equal(used.length, 4);
  } finally {
    await Promise.all([erp, runner].map(server => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  }
});

test('Fastkore CLI arguments cannot change the ERP selection or pass flags', async () => {
  const entitySetId = randomUUID(), entityId = randomUUID(), signal = new AbortController().signal;
  const current = { type: 'fastkore.context', version: 1, entity_set_id: entitySetId, scope_reproducible: true };
  const base = { definitions: [], call: async () => ({ success: false, text: '' }) };
  let reads = 0;
  const read = async () => { reads++; return { success: true, text: '' }; };
  const card = parseFastkoreContext({ ...current, view: 'card', entity_id: entityId, filter_status: 'none' });
  assert.ok(card);
  const cardTools = withFastkoreCliReads(base, card, read);
  assert.deepEqual(cardTools.definitions.map(tool => tool.name), ['fastkore_cli_data_get']);
  assert.equal((await cardTools.call('fastkore_cli_data_get', { entitySetId, entityId }, signal)).success, true);
  assert.equal((await cardTools.call('fastkore_cli_data_get', { entitySetId, entityId: randomUUID() }, signal)).success, false);
  const filtered = parseFastkoreContext({ ...current, view: 'list', filter_status: 'included', filter_xml: '<Filter/>' });
  assert.ok(filtered);
  assert.equal((await withFastkoreCliReads(base, filtered, read).call('fastkore_cli_data_query', { entitySetId }, signal)).success, false);
  const general = withFastkoreCliReads(base, undefined, read);
  assert.equal((await general.call('fastkore_cli_data_query', { entitySetId, limit: 51 }, signal)).success, false);
  assert.equal((await general.call('fastkore_cli_data_query', { entitySetId, server: 'grpc://example.test' }, signal)).success, false);
  assert.equal((await general.call('fastkore_cli_data_query', { entitySetId, limit: 10 }, signal)).success, true);
  assert.equal(reads, 2);
});
