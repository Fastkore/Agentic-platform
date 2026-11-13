import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionAccountStore } from '../server/execution-accounts.js';
import { GeminiClient, AntigravityClient, geminiFailure } from '../server/gemini.js';
import { createCodexWorker } from '../server/codex-worker.js';
import { BridgeError } from '../server/store.js';
import { randomUUID } from 'node:crypto';

test('execution accounts preserve legacy auth, isolate tokens and retain the active selection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-accounts-'));
  const claims = Buffer.from(JSON.stringify({ email: 'first@example.test' })).toString('base64url');
  const auth = JSON.stringify({ tokens: { access_token: 'private-token', id_token: 'header.' + claims + '.signature' } });
  await writeFile(path.join(root, 'auth.json'), auth);
  let store = new ExecutionAccountStore(root);
  try {
    assert.equal((await store.list()).accounts[0].email, 'first@example.test');
    const second = await store.create('Второй');
    const legacyKey = await store.executionKey();
    assert.notEqual(store.home(second.id), root);
    await assert.rejects(store.activate(second.id), /Сначала выполните вход/);
    await writeFile(path.join(store.home(second.id), 'auth.json'), auth);
    await store.activate(second.id);
    assert.notEqual(await store.executionKey(), legacyKey);
    store = new ExecutionAccountStore(root);
    assert.equal(store.active, second.id);
    assert.equal(await readFile(path.join(root, 'auth.json'), 'utf8'), auth);
    const gemini = await store.create('Gemini', 'gemini');
    await mkdir(path.join(store.home(gemini.id), '.gemini'));
    await writeFile(path.join(store.home(gemini.id), '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'private-google-token' }));
    await store.activate(gemini.id);
    assert.ok(store.runner() instanceof GeminiClient);
    const list = JSON.stringify(await store.list());
    assert.ok(!list.includes('private-token') && !list.includes('private-google-token') && !list.includes('id_token'));
    await assert.rejects(store.activate('../../wrong'), /не найден/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Gemini executor bridges authorized tools and restricts file operations to its job', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-gemini-'));
  const home = path.join(root, 'home'), job = path.join(root, 'job');
  await Promise.all([mkdir(home), mkdir(job)]);
  const fake = path.join(root, 'fake.mjs'), id = randomUUID();
  await writeFile(fake, `
import{readFileSync}from'node:fs';
const settings=JSON.parse(readFileSync('.gemini/settings.json','utf8'));
if(settings.tools.core.length||settings.mcp.allowed.join(',')!=='bridge')throw Error('Unsafe tools');
const config=settings.mcpServers.bridge;
const call=async(method,params)=>{const r=await fetch(config.httpUrl,{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return r.json();};
const tools=await call('tools/list',{});
if(!tools.result.tools.some(t=>t.name==='knowledge'))throw Error('Tools missing');
const answer=await call('tools/call',{name:'knowledge',arguments:{action:'index'}});
if(answer.result.content[0].text!=='Allowed result')throw Error('Wrong result');
const denied=await call('tools/call',{name:'workspace_files',arguments:{action:'read',path:'../private'}});
if(!denied.error)throw Error('File escaped');
await call('tools/call',{name:'workspace_files',arguments:{action:'write',path:'output/test.txt',text:'Saved'}});
console.log(JSON.stringify({type:'init',session_id:'${id}'}));
console.log(JSON.stringify({type:'message',role:'assistant',content:'Проверено',delta:true}));
console.log(JSON.stringify({type:'result',status:'success',stats:{input_tokens:5,output_tokens:2,cached:0}}));
`);
  let calls = 0;
  try {
    const runner = new GeminiClient(home, process.execPath, [fake]);
    const result = await runner.run({ cliPath: '', workspace: job, workDirectoryId: randomUUID(), allowWrite: true,
      prompt: 'Test', tools: { definitions: [{ type: 'function', name: 'knowledge', description: '', inputSchema: { type: 'object' } }],
        call: async () => { calls++; return { success: true, text: 'Allowed result' }; } } }, async () => {}, AbortSignal.timeout(10000));
    assert.equal(result.sessionId, id);
    assert.equal(result.response, 'Проверено');
    assert.equal(calls, 1);
    assert.equal(await readFile(path.join(job, 'output', 'test.txt'), 'utf8'), 'Saved');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removing legacy and active accounts preserves other credentials and permits an empty account list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-remove-'));
  const store = new ExecutionAccountStore(root);
  try {
    await writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'private' } }));
    const gemini = await store.create('Google', 'gemini');
    const credentials = path.join(store.home(gemini.id), '.gemini', 'oauth_creds.json');
    await mkdir(path.dirname(credentials));
    await writeFile(credentials, JSON.stringify({ refresh_token: 'google-private' }));
    await store.remove('default');
    assert.equal(store.active, gemini.id);
    assert.match(await readFile(credentials, 'utf8'), /google-private/);
    await assert.rejects(readFile(path.join(root, 'auth.json')), { code: 'ENOENT' });
    assert.equal((await new ExecutionAccountStore(root).select()).account.id, gemini.id);
    await assert.rejects(store.remove('../../'), /не найден/);
    const removedHome = store.home(gemini.id);
    await store.remove(gemini.id);
    await assert.rejects(readFile(credentials), { code: 'ENOENT' });
    assert.deepEqual((await new ExecutionAccountStore(root).list()).accounts, []);
    await assert.rejects(store.select(), /Подключите/);
    assert.equal(store.active, '');
    const replacement = await store.create('Новый');
    assert.equal(store.active, replacement.id);
    assert.notEqual(store.home(replacement.id), removedHome);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('combined catalog deduplicates connections and routes native models and errors to the selected provider', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-routing-'));
  const store = new ExecutionAccountStore(root);
  const gemini = await store.create('Google', 'gemini');
  await mkdir(path.join(store.home(gemini.id), '.gemini'));
  await writeFile(path.join(store.home(gemini.id), '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'private-google' }));
  // Active Codex is signed out; Google must still be usable.
  assert.equal((await store.select()).account.id, gemini.id);
  await writeFile(path.join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'private-codex' } }));
  const duplicate = await store.create('Second Google', 'gemini');
  await mkdir(path.join(store.home(duplicate.id), '.gemini'));
  await writeFile(path.join(store.home(duplicate.id), '.gemini', 'oauth_creds.json'), JSON.stringify({ refresh_token: 'other-private' }));
  let failGoogle = false;
  store.runner = (id = store.active) => ({
    inspect: async () => ({ path: '', version: 'fake', authentication: id === 'default' ? 'chatgpt' : 'google', status: '' }),
    readLimits: async () => null,
    listModels: async () => {
      if (id === duplicate.id) throw Error('Catalog unavailable');
      return { models: [{ id: id === 'default' ? 'gpt-test' : 'gemini-test', name: 'Test', description: '', isDefault: true }],
        source: id === 'default' ? 'codex' : 'gemini', fetchedAt: new Date().toISOString() };
    },
    run: async request => {
      if (failGoogle && id === gemini.id) throw new BridgeError(geminiFailure('UNSUPPORTED_CLIENT'), 503);
      return { response: id + ':' + request.model };
    },
  });
  const worker = createCodexWorker(undefined, undefined, store);
  try {
    const models = (await worker.inject('/models')).json();
    assert.deepEqual(models.models.map((item: { id: string }) => item.id), ['codex/gpt-test', 'gemini/gemini-test']);
    assert.equal(models.models.filter((item: { isDefault: boolean }) => item.isDefault).length, 1);
    assert.ok(!JSON.stringify(models).includes('private'));
    const inspect = (await worker.inject('/inspect?model=gemini/gemini-test')).json();
    assert.equal(inspect.provider, 'gemini');
    assert.equal(inspect.accountId, await store.executionKey(gemini.id));
    for (const model of ['gemini/gemini-test', 'gemini-test', 'codex/gpt-test', 'gpt-test']) {
      const response = await worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Test', model } });
      const event = JSON.parse(response.body.trim().split('\n').at(-1)!);
      assert.equal(event.result.response, (model.startsWith('gemini') ? gemini.id : 'default') + ':' + model.replace(/^(codex|gemini)\//, ''));
    }
    failGoogle = true;
    const failed = await worker.inject({ method: 'POST', url: '/run', payload: { prompt: 'Test', model: 'gemini/gemini-test' } });
    assert.match(JSON.parse(failed.body.trim()).error, /UNSUPPORTED_CLIENT/);
    assert.ok(!failed.body.includes('Codex'));
    await worker.inject({ method: 'POST', url: '/accounts/' + gemini.id + '/activate', payload: {} });
    await worker.inject({ method: 'POST', url: '/accounts/' + gemini.id + '/remove', payload: {} });
    assert.equal((await store.select('gemini-test')).account.id, duplicate.id);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test('Gemini errors do not expose tokens, settings or provider stack traces', () => {
  assert.match(geminiFailure('UNSUPPORTED_CLIENT private-token stack path'), /Antigravity/);
  assert.match(geminiFailure('invalid_grant'), /вход Google/);
  assert.match(geminiFailure('RESOURCE_EXHAUSTED'), /лимит/);
  assert.ok(!geminiFailure('unknown private-token stack path').includes('private-token'));
});

test('Gemini models come from the CLI catalog rather than a hard-coded list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-models-'));
  const fake = path.join(root, 'models.mjs');
  try {
    await writeFile(fake, `if(process.argv.slice(2).join(' ')!=='models list --output-format json')throw Error('Wrong command');
console.log(JSON.stringify([{modelId:'auto'},{modelId:'gemini-new-model',description:'New model'}]));`);
    const models = await new GeminiClient(root, process.execPath, [fake]).listModels();
    assert.deepEqual(models.models.map(model => model.id), ['gemini-auto', 'gemini-new-model']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Antigravity transports MCP, streamed results, session IDs and usage with native file and shell access denied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-agy-'));
  const fake = path.join(root, 'agy.mjs'), id = randomUUID();
  const store = new ExecutionAccountStore(root);
  const account = await store.create('Antigravity', 'antigravity');
  const home = store.home(account.id);
  try {
    await writeFile(fake, `
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='models'){console.log('gemini-test-high   Gemini Test (High)');process.exit(0);}
const policy=JSON.parse(args[args.indexOf('--settings')+1]);
if(!policy.permissions.deny.includes('command(*)')||!policy.permissions.deny.includes('read_file(*)'))throw Error('Missing limits');
if(!args.includes('--input-format')||!args.includes('--conversation')||!args.includes('${id}'))throw Error('Missing session');
let input='';for await(const chunk of process.stdin)input+=chunk;
if(JSON.parse(input).message.content!=='Rules\\n\\nQuestion')throw Error('Wrong prompt');
const config=JSON.parse(readFileSync('.agents/mcp_config.json','utf8')).mcpServers.bridge;
const rpc=await fetch(config.serverUrl,{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'knowledge',arguments:{}}})}).then(r=>r.json());
if(rpc.result.content[0].text!=='ERP allowed')throw Error('MCP failed');
console.log(JSON.stringify({event:'init',conversation_id:'${id}',init:{}}));
console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'Partial'}}));
console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Готово',usage:{input_tokens:8,output_tokens:3,cache_read_tokens:2}}}));
`);
    await writeFile(path.join(home, '.antigravity-connected.json'), JSON.stringify({ session: randomUUID() }));
    const runner = new AntigravityClient(home, process.execPath, [fake]);
    const key = await store.executionKey(account.id);
    assert.equal((await store.select('antigravity/gemini-test-high')).account.id, account.id);
    assert.ok(store.runner(account.id) instanceof AntigravityClient);
    const models = await runner.listModels();
    assert.deepEqual(models.models.map(model => model.id), ['antigravity-auto', 'gemini-test-high']);
    const result = await runner.run({ cliPath: '', workspace: root, allowWrite: false, sessionId: id,
      developerInstructions: 'Rules', prompt: 'Question', model: 'gemini-test-high', tools: {
        definitions: [{ type: 'function', name: 'knowledge', description: '', inputSchema: { type: 'object' } }],
        call: async () => ({ success: true, text: 'ERP allowed' }),
      } }, async () => {}, AbortSignal.timeout(5000));
    assert.equal(result.response, 'Готово');
    assert.equal(result.sessionId, id);
    assert.deepEqual(result.usage, { inputTokens: 8, cachedInputTokens: 2, outputTokens: 3 });
    await writeFile(path.join(home, '.antigravity-connected.json'), JSON.stringify({ session: randomUUID() }));
    assert.notEqual(await store.executionKey(account.id), key);
    await assert.rejects(readFile(path.join(home, 'runtime', '.agents', 'mcp_config.json')), { code: 'ENOENT' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
