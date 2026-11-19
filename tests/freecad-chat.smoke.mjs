import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// Run inside a disposable app instance with a fresh database and a real model
// worker. All administration below applies to the new test instance only.
const origin = 'http://127.0.0.1:8787';
let token;
async function request(method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(method + ' ' + url + ' ' + response.status + ' ' + await response.text());
  return response;
}
async function json(method, url, body, headers) {
  return (await request(method, url, body, headers)).json();
}
token = (await json('POST','/api/local-login', {}, {'x-bridge-local':'1'})).token;
const password = process.env.FREECAD_TEST_PASSWORD ?? randomUUID() + randomUUID();
token = (await json('POST','/api/auth/setup', {
  username:'cad-demo', name:'CAD demo', password,
})).token;
await json('PATCH','/api/settings',{allowWrite:true,reasoningEffort:'low'});
const profile = (await json('GET','/api/admin/profiles')).find(p => p.id === 'universal');
delete profile.unavailableReason;
delete profile.id;
await json('PUT','/api/admin/profiles/universal',{...profile,allowWrite:true});
const project = await json('POST','/api/projects',{name:'FreeCAD pilot'});
const base = '/api/projects/' + project.id + '/chats';
const chat = await json('POST',base,{title:'Шарнирная тяга',model:process.env.FREECAD_TEST_MODEL || undefined});
const route = base + '/' + chat.id;
await mkdir('/results',{recursive:true});
for (const [distance,text] of [[86,'Собери шарнирную тягу с двумя вилками и болтами М12. Межосевое расстояние 86 мм. Дай FCStd и GLB.'],
  [100,'Измени межосевое расстояние этой сборки на 100 мм. Сохрани новую версию FCStd и GLB.']]) {
  if (distance === 100) {
    await json('PATCH',route+'/visibility',{visibility:'project'});
    await request('POST','/api/auth/logout',{});
    token = undefined;
    token = (await json('POST','/api/auth/login',{username:'cad-demo',password})).token;
  }
  const started = await json('POST',route+'/messages',{text});
  const end = Date.now() + 240_000;
  let run = started;
  console.log('Started',distance,run.id);
  while (['running','queued'].includes(run.status) && Date.now() < end) {
    await sleep(1000);
    run = await json('GET','/api/runs/'+run.id);
  }
  assert.equal(run.status,'complete',run.error ?? run.progress);
  const answer = (await json('GET',route+'/messages')).at(-1);
  console.log(distance,answer.text,answer.attachments.map(f=>f.name));
  assert.equal(answer.role,'assistant');
  assert.deepEqual(answer.attachments.map(f=>f.name).sort(),['linkage-'+distance+'mm.FCStd','linkage-'+distance+'mm.glb']);
  for (const file of answer.attachments) {
    const response = await request('GET',route+'/messages/'+answer.id+'/files/'+file.id);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length,file.size);
    await writeFile('/results/'+file.name,bytes);
  }
}
