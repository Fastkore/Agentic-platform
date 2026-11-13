import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionAccountStore } from '../server/execution-accounts.js';
import { GeminiClient } from '../server/gemini.js';
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
const settings=JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,'utf8'));
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
