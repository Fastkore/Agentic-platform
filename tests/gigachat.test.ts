import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { functionSchema, GigaChatClient } from '../server/gigachat.js';

function response(statusCode: number, body: string, contentType = 'application/json') {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers: { 'content-type': contentType } }) as IncomingMessage;
}

function stream(delta: object, finish_reason: string) {
  return response(200, 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n', 'text/event-stream');
}

test('GigaChat streams a tool chain and refreshes HTTP 401 without executing a finished action again', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bridge-gigachat-'));
  const calls: string[] = [];
  let grants = 0, requests = 0, rejectedRequest = '';
  const client = new GigaChatClient(home, async (url, headers, _signal, body) => {
    if (url.endsWith('/oauth')) {
      assert.equal(body, 'scope=GIGACHAT_API_PERS');
      return response(200, JSON.stringify({ access_token: 'token-' + (++grants), expires_at: Date.now() + 30 * 60_000 }));
    }
    if (url.endsWith('/models')) return response(200, JSON.stringify({ data: [{ id: 'GigaChat-2-Max' }, { id: 'GigaChat-3-Ultra' }, { id: 'Embeddings' }] }));
    assert.match(url, /\/v1\/chat\/completions$/);
    const payload = JSON.parse(String(body));
    assert.equal(payload.stream, true);
    assert.equal(payload.functions[0].parameters.properties.mode.type, 'string');
    if (++requests === 1) {
      assert.equal(headers.Authorization, 'Bearer token-1');
      return stream({ functions_state_id: 'state-search', function_call: { name: 'library_search', arguments: { mode: 'exact' } } }, 'function_call');
    }
    const replay = payload.messages;
    assert.equal(replay[1].functions_state_id, 'state-search');
    assert.equal(JSON.parse(replay[2].content).text, 'fixture-record-id');
    if (requests === 2) { rejectedRequest = String(body); return response(401, ''); }
    assert.equal(headers.Authorization, 'Bearer token-2');
    if (requests === 3) {
      assert.equal(body, rejectedRequest);
      return stream({ functions_state_id: 'state-erp', function_call: { name: 'fastkore_read', arguments: { id: 'fixture-record-id' } } }, 'function_call');
    }
    assert.equal(replay[3].functions_state_id, 'state-erp');
    return stream({ content: JSON.parse(replay[4].content).text }, 'stop');
  });
  try {
    await client.setKey(Buffer.from('fixture-id:fixture-secret').toString('base64'), 'GIGACHAT_API_PERS');
    assert.equal((await client.inspect()).authentication, 'gigachat');
    assert.deepEqual((await client.listModels()).models.map(item => item.id), ['GigaChat-2-Max', 'GigaChat-3-Ultra']);
    const deltas: string[] = [];
    const result = await client.run({ cliPath: '', workspace: home, prompt: 'Продолжи', allowWrite: false, tools: {
      definitions: [
        { type: 'function', name: 'library_search', description: 'Find', inputSchema: { type: 'object', properties: { mode: { enum: ['exact'] } } } },
        { type: 'function', name: 'fastkore_read', description: 'Read', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      ],
      async call(name, args) {
        calls.push(name);
        if (name === 'library_search') return { success: true, text: 'fixture-record-id' };
        assert.deepEqual(args, { id: 'fixture-record-id' });
        return { success: true, text: 'fixture final result' };
      },
    } }, async event => { if (event.kind === 'message-delta') deltas.push(event.text ?? ''); }, AbortSignal.timeout(5000));
    assert.deepEqual(calls, ['library_search', 'fastkore_read']);
    assert.deepEqual(deltas, [result.response]);
    assert.equal(result.response, 'fixture final result');
      assert.equal(grants, 2);
      assert.equal(requests, 4);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('GigaChat functionSchema strips unsupported JSON Schema keywords and normalizes nullable unions', () => {
  const cleaned = functionSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['guid', 'missing'],
    properties: {
      guid: { type: ['string', 'null'], format: 'uuid', minLength: 36, maxLength: 36, description: 'ID заказа' },
      limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { type: 'null' }], description: 'Лимит' },
      kind: { const: 'function' },
      tags: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[a-z]+$' } },
    },
  });
  assert.deepEqual(cleaned, {
    type: 'object',
    properties: {
      guid: { type: 'string', description: 'ID заказа' },
      limit: { type: 'integer', description: 'Лимит' },
      kind: { type: 'string', enum: ['function'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['guid'],
  });
});
