import test from 'node:test';
import assert from 'node:assert/strict';
import { withInternetTools } from '../server/internet-tools.js';
import { publicAddress, publicTarget, publicHttp } from '../server/public-http.js';
import { searchZai } from '../server/internet-search.js';
import { internetCredentialPermissions } from '../server/erp-roles.js';
import type { Credential, State } from '../shared/types.js';

test('internet roles default to denied, combine grants and remain scoped to installation', () => {
  const credential = { source: 'fastkore', installationId: 'a', userId: 'user', externalRoles: [{ id: 'role', name: 'Role' }] } as Credential;
  const state = {} as State;
  assert.deepEqual(internetCredentialPermissions(state, credential), { read: false, requests: false });
  state.sso = { rolePermissions: [{ installationId: 'a', roleId: 'role', mcp: true, cli: true, webRead: true, webRequests: false, revision: 1 }] };
  assert.deepEqual(internetCredentialPermissions(state, credential), { read: true, requests: false });
  credential.installationId = 'b';
  assert.deepEqual(internetCredentialPermissions(state, credential), { read: false, requests: false });
  credential.source = 'local';
  assert.deepEqual(internetCredentialPermissions(state, credential), { read: false, requests: false });
});

test('public HTTP rejects private, encoded, transition and service destinations before making a request', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const url of ['http://0x7f000001/', 'http://2130706433/', 'http://169.254.169.254/', 'https://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'http://8.8.8.8:9000/', 'https://user:password@8.8.8.8/']) await assert.rejects(publicTarget(url));
  await assert.rejects(publicHttp({ url: 'https://8.8.8.8/', headers: { Host: 'internal' } }, AbortSignal.timeout(1000), () => {}), /заголовок/);
  await assert.rejects(publicHttp({ url: 'https://8.8.8.8/', method: 'POST', body: 'x'.repeat(64001) }, AbortSignal.timeout(1000), () => {}), /размер/);
});

test('read access never grants API writes, redirects recheck permissions, and revocation hides an in-flight result', async () => {
  let read = true, requests = false, calls = 0;
  const http = async (input: { url: string }) => { calls++; return { status: 200, url: input.url, contentType: 'text/html', text: '<script>hidden()</script><h1>Documentation</h1>' }; };
  const tools = withInternetTools(undefined, () => ({ read, requests }), () => {}, async () => ({ success: true, text: 'Found' }), http);
  assert.deepEqual(tools.definitions.map(tool => tool.name), ['internet_search', 'internet_read']);
  const signal = AbortSignal.timeout(5000);
  assert.equal((await tools.call('internet_request', { url: 'https://example.test', method: 'POST' }, signal)).success, false);
  assert.equal(calls, 0);
  const result = await tools.call('internet_read', { url: 'https://example.test/docs' }, signal);
  assert.equal(result.success, true); assert.match(result.text, /Documentation/); assert.ok(!result.text.includes('hidden'));
  let reached = 0;
  const redirecting = withInternetTools(undefined, () => ({ read, requests }), () => {}, async () => ({ success: true, text: '' }), async input => {
    await publicTarget(input.url); reached++;
    return { status: 302, url: input.url, contentType: 'text/html', location: 'http://169.254.169.254/', text: '' };
  })!;
  assert.equal((await redirecting.call('internet_read', { url: 'https://8.8.8.8/' }, signal)).success, false);
  assert.equal(reached, 1, 'a redirect must not reach the internal destination');
  requests = true;
  assert.equal((await tools.call('internet_request', { url: 'https://example.test', method: 'POST', body: '{}' }, signal)).success, true);
  const interrupted = withInternetTools(undefined, () => ({ read, requests }), () => {}, async () => ({ success: false, text: '' }), async () => { throw Error('socket closed after the API accepted the write'); })!;
  const unknown = await interrupted.call('internet_request', { url: 'https://example.test', method: 'POST', body: '{}' }, signal);
  assert.equal(unknown.success, false); assert.match(unknown.text, /результат операции не подтверждён/);
  assert.match(unknown.text, /проверьте фактическое состояние/);
  const revoking = withInternetTools(undefined, () => ({ read, requests }), () => {}, async () => { read = false; return { success: true, text: 'Must not be returned' }; }, http);
  const revoked = await revoking.call('internet_search', { query: 'Docs' }, signal);
  assert.equal(revoked.success, false); assert.ok(!revoked.text.includes('Must not'));
});

test('Z.ai search discovers the official tool, keeps authentication out of results and decodes streamed UTF-8', async () => {
  const methods: string[] = [], key = 'fixture-private-key';
  const transport: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://api.z.ai/api/mcp/web_search_prime/mcp');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer ' + key);
    const call = JSON.parse(init!.body as string); methods.push(call.method);
    if (call.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (call.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    else if (call.method === 'tools/list') result = { tools: [{ name: 'webSearchPrime', inputSchema: { properties: { search_query: { type: 'string' } } } }] };
    else {
      assert.deepEqual(call.params, { name: 'webSearchPrime', arguments: { search_query: 'Документация' } });
      const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: 'Ссылка ' + key }] } }) + '\n\n');
      const at = bytes.indexOf(0xd0) + 1;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, at)); controller.enqueue(bytes.slice(at)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  };
  const result = await searchZai('Документация', key, AbortSignal.timeout(5000), transport);
  assert.equal(result.success, true); assert.equal(result.text, 'Ссылка [REDACTED]');
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});
