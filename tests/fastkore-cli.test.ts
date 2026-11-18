import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Credential } from '../shared/types.js';
import { FastkoreCli, type FastkoreCliTiming } from '../server/fastkore-cli.js';
import { formatFastkoreCliResult } from '../server/fastkore-cli-tools.js';
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
  let denied = false, forgotten = false, wrongAudience = false, wrongTrust = false, wrongUser = false, cliEnabled = true;
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
    if (input.command === 'oversized') {
      res.end(JSON.stringify({ success: true, exitCode: 0, error: { code: 'cli_stdout_too_large', actualBytes: 9000000, limitBytes: 8388608 } }));
      return;
    }
    const data = input.operation === 'auth-info' ? { user: { guid: wrongUser ? randomUUID() : externalUserId } }
      : input.operation === 'execute' ? { templateSha256: 'abc', revision: 'rev', template: 'Ж'.repeat(540_000) }
      : { entitySetId: input.entitySetId, entityId: input.entityId, note: input.ticket };
    res.setHeader('X-Fastkore-Cli-Process-Ms', '3');
    res.end(JSON.stringify({ success: true, exitCode: 0, data }));
  });
  runner.listen(socket);
  await once(runner, 'listening');
  const cli = new FastkoreCli(socket);
  const sso = {
    delegationBinding: () => ({ origin: 'https://' + authority, ca: tls.cert, revision: '1', key, mcpUrl: undefined, mcpCa: undefined, cliEnabled }),
    openDelegation: () => forgotten ? undefined : grant,
  };
  const run = (operation: Parameters<FastkoreCli['run']>[0], timing?: FastkoreCliTiming) => cli.run(operation, sso, () => credential,
    async id => { assert.equal(id, credential.id); forgotten = true; }, new AbortController().signal, timing);
  try {
    assert.deepEqual(await run({ operation: 'auth-info' }), {
      success: true, exitCode: 0, data: { user: { guid: externalUserId } },
    });
    const timing: FastkoreCliTiming = {};
    const result = await run({ operation: 'get', entitySetId, entityId }, timing);
    assert.equal(timing.ticketStatus, 200);
    assert.equal(timing.cliProcessMs, 3);
    assert.equal(timing.exitCode, 0);
    assert.ok(timing.trustMs! >= 0 && timing.ticketMs! >= 0 && timing.cliRpcMs! >= 0);
    assert.match(JSON.stringify(result.data), /REDACTED/);
    assert.doesNotMatch(JSON.stringify(result), /fkct1\./);
    assert.equal((await run({ operation: 'query', entitySetId, limit: 2 })).success, true);
    assert.deepEqual(used, ['auth-info', 'get', 'query']);
    const report = await run({ operation: 'execute', command: 'report definition show', args: [], workDirectoryId: randomUUID() });
    assert.deepEqual(JSON.parse(formatFastkoreCliResult(report, 'report definition show', ['data.templateSha256', 'data.revision']).text),
      { success: true, exitCode: 0, data: { templateSha256: 'abc', revision: 'rev' } });
    const overflow = await run({ operation: 'execute', command: 'oversized', args: [], workDirectoryId: randomUUID() });
    const output = formatFastkoreCliResult(overflow, 'data create');
    assert.equal(output.success, true);
    assert.equal(JSON.parse(output.text).error.code, 'cli_stdout_too_large');
    assert.equal(JSON.parse(output.text).exitCode, 0);
    assert.equal(tickets.size, 0);
    cliEnabled = false;
    await assert.rejects(run({ operation: 'auth-info' }), /отключена/);
    assert.equal(tickets.size, 0);
    cliEnabled = true;
    wrongTrust = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не совпадает с привязкой/);
    assert.equal(tickets.size, 0);
    wrongTrust = false;
    wrongAudience = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не выдала билет/);
    assert.equal(used.length, 5);
    wrongAudience = false;
    wrongUser = true;
    await assert.rejects(run({ operation: 'auth-info' }), /не совпал с пользователем SSO/);
    denied = true;
    await assert.rejects(run({ operation: 'auth-info' }), /отозван/);
    assert.ok(forgotten);
    assert.equal(used.length, 6);
  } finally {
    await Promise.all([erp, runner].map(server => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  }
});

test('field selection keeps native partial results and oversized output keeps mutation status', () => {
  const data = { success: false, exitCode: 5, error: { message: 'Журнал недоступен' }, data: { created: { guid: 'example' } } };
  const partial = formatFastkoreCliResult({ success: false, exitCode: 5, data }, 'data create', ['data.unrelated']);
  assert.deepEqual(JSON.parse(partial.text), { success: false, exitCode: 5, partial: true, data });
  const large = formatFastkoreCliResult({ success: false, exitCode: 5, data: { ...data, data: { ...data.data, items: ['Ж'.repeat(100_000)] } } }, 'data create');
  const limited = JSON.parse(large.text);
  assert.equal(limited.error.code, 'response_too_large');
  assert.equal(limited.partial, true);
  assert.deepEqual(limited.data, data);
});
