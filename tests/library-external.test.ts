import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryRegistry } from '../server/library/registry.js';
import { LibraryIndexer } from '../server/library/indexer.js';
import { LibraryReader } from '../server/library/reader.js';
import { CloudDrive, providers } from '../server/library/cloud-drive.js';
import { admin, startOperation } from './library-helpers.js';

test('private Drive library without S3: OAuth, picker, index updates, revocation and cleanup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'external-library-'));
  const registry = new LibraryRegistry(root, {}), indexer = new LibraryIndexer(registry), reader = new LibraryReader(registry);
  t.after(async () => { await registry.external.stop(); await indexer.stop(); registry.close(); await rm(root,{recursive:true,force:true}); });
  const auth = registry.external.auth;
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  process.env.BRIDGE_LIBRARY_GOOGLE_CLIENT_ID = 'client';
  process.env.BRIDGE_LIBRARY_GOOGLE_CLIENT_SECRET = 'test-secret';
  let revoked = false, removed = false, version = 1, downloads = 0;
  let content = 'first reference', filename = 'guide.txt';
  const fetchMock = t.mock.method(globalThis,'fetch',async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.href === providers.google.token) {
      assert.ok((init?.body as URLSearchParams).get('code_verifier'));
      return Response.json({ access_token: 'private-test-token', refresh_token: 'private-refresh', expires_in: 3600 });
    }
    assert.equal(url.host,'www.googleapis.com'); assert.equal(init?.method ?? 'GET','GET');
    if (revoked) return new Response(null,{status:403});
    if (url.searchParams.get('alt') === 'media') { downloads++; return new Response(content); }
    const dir = { id: 'docs', name: 'Документы', mimeType: 'application/vnd.google-apps.folder' };
    if (url.pathname.endsWith('/docs')) return Response.json(dir);
    if (url.searchParams.get('q')?.includes("'root'")) return Response.json({ files: [dir] });
    return Response.json({ files: removed ? [] : [{ id: 'file', name: filename, version: String(version), mimeType: 'text/plain', size: String(Buffer.byteLength(content)), capabilities: { canDownload: true } }] });
  });
  const flow = auth.begin(admin.id,'google'), url = new URL(flow.url);
  assert.equal(url.searchParams.get('scope'), providers.google.scope);
  assert.equal(url.searchParams.get('redirect_uri'),'https://platform.example/library-oauth.html');
  assert.ok(url.searchParams.get('code_challenge'));
  await assert.rejects(auth.finish('other',flow.state,'x'));
  await auth.finish(admin.id,flow.state,'x');
  await assert.rejects(auth.finish(admin.id,flow.state,'x'));
  assert.deepEqual(await auth.folders(admin.id,flow.state),[{id:'docs',name:'Документы'}]);
  const external = {connection:flow.state,folder:'docs'};
  assert.throws(() => registry.createFolder(admin,{name:'invalid',external:{...external,folder:'unselected'}}));
  const folder = registry.createFolder(admin,{name:'External', external});
  assert.equal(folder.canUpload,false);
  assert.doesNotMatch(JSON.stringify(folder),/private-test-token|private-refresh|credentials/);
  assert.doesNotMatch(String(registry.db.prepare('SELECT credentials FROM external_sources').get()?.credentials),/private-/);
  assert.throws(() => startOperation(registry,admin,folder.id,{'a':'b'}), /прав/);
  assert.throws(() => registry.removeFiles(admin,folder.id,{paths:[filename]}),/прав/);
  await registry.external.sync(folder.id); await indexer.drain();
  const state = registry.currentState(folder.id)!;
  await registry.external.verify(folder.id,state.id);
  const target = {stateId:state.id,folderId:folder.id};
  const hit = reader.search([target],'reference').hits[0];
  assert.equal(hit.path,filename);
  assert.equal((await reader.readLines(state.id,hit.fileId,1,1)).lines[0].text,content);
  assert.equal(registry.external.link(state.id,filename),'https://drive.google.com/open?id=file');
  await registry.external.sync(folder.id);
  assert.equal(registry.currentState(folder.id)?.id,state.id);
  filename = 'renamed.txt';
  await registry.external.sync(folder.id); await indexer.drain();
  assert.equal(downloads,1);
  version++; content = 'updated reference';
  await assert.rejects(registry.external.verify(folder.id,state.id),/изменилась/);
  await registry.external.sync(folder.id); await indexer.drain();
  const newer = registry.currentState(folder.id)!;
  assert.equal(reader.search([{...target,stateId:newer.id}],'updated').hits[0].path,filename);
  revoked = true;
  await assert.rejects(registry.external.verify(folder.id,newer.id),/недоступны/);
  revoked = false; removed = true;
  await registry.external.sync(folder.id);
  assert.equal(registry.currentState(folder.id)?.total_files,0);
  const before = fetchMock.mock.callCount();
  registry.deleteFolder(admin,folder.id,folder.revision);
  await registry.collectGarbage({graceMs:0});
  assert.equal(registry.external.has(folder.id),false);
  assert.equal(fetchMock.mock.callCount(),before);
});

test('Dropbox pages use cursors, download the indexed revision and only call read endpoints', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis,'fetch',async (url:string, init:RequestInit) => {
    calls.push(url);
    if (url.endsWith('download')) {
      assert.deepEqual(JSON.parse(new Headers(init.headers).get('Dropbox-API-Arg')!),{path:'rev:123'});
      return new Response('text');
    }
    if (url.endsWith('continue')) {
      assert.deepEqual(JSON.parse(String(init.body)),{cursor:'two'});
      return Response.json({ entries: [{'.tag':'file',id:'id:x',name:'a.txt',size:4,rev:'123',path_display:'/Docs/a.txt'}], has_more:false });
    }
    return Response.json({ entries:[], has_more:true, cursor:'two' });
  });
  const drive = new CloudDrive('dropbox','test');
  const files = await Array.fromAsync(drive.children('id:folder'));
  assert.equal(files[0].link,'https://www.dropbox.com/home/Docs/a.txt');
  assert.equal((await drive.download(files[0],4)).toString(),'text');
  assert.equal(calls.length,3);
});

test('Yandex paginates folders, verifies their identity and downloads without forwarding the OAuth token', async t => {
  t.mock.method(globalThis,'fetch',async (input:string, init:RequestInit) => {
    const url = new URL(input);
    if (url.host === 'downloader.disk.yandex.ru') {
      assert.equal(new Headers(init.headers).has('Authorization'),false);
      return new Response('bytes');
    }
    assert.equal(new Headers(init.headers).get('Authorization'),'OAuth test');
    if (url.searchParams.has('fields')) return Response.json({type:'dir',resource_id:'stable'});
    if (url.pathname.endsWith('download')) return Response.json({href:'https://downloader.disk.yandex.ru/file'});
    const n = Number(url.searchParams.get('offset'));
    return Response.json({type:'dir',_embedded:{total:2,items:[{type:'file',resource_id:'f'+n,path:'disk:/Docs/'+n,name:String(n),revision:2,size:5}]}});
  });
  const drive = new CloudDrive('yandex','test');
  assert.equal(await drive.folderIdentity('disk:/Docs'),'stable');
  const files = await Array.fromAsync(drive.children('disk:/Docs'));
  assert.deepEqual(files.map(f=>f.id),['disk:/Docs/0','disk:/Docs/1']);
  await assert.rejects(drive.download(files[1],3),/лимит/);
  assert.equal((await drive.download(files[0],5)).toString(),'bytes');
});

test('Google Workspace documents and spreadsheets export to formats used by the index', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis,'fetch',async (input:string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/export')) { calls.push(url.searchParams.get('mimeType')!); return new Response('export'); }
    const files = ['document','spreadsheet','shortcut'].map(type => ({id:type, mimeType:'application/vnd.google-apps.'+type,
      name:type,version:'3',capabilities:{canDownload:true}}));
    return Response.json({files});
  });
  const drive = new CloudDrive('google','test');
  const files = await Array.fromAsync(drive.children('docs'));
  assert.deepEqual(files.map(f=>f.name),['document.docx','spreadsheet.xlsx']);
  for (const f of files) await drive.download(f,100);
  assert.deepEqual(calls,['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
});

test('external HTTP connection uses regular project grants and checks remote access again before publication', async t => {
  const {fixture,idle} = await import('./library-app.js');
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://agents.example.test';
  process.env.BRIDGE_LIBRARY_DROPBOX_CLIENT_ID = 'app';
  process.env.BRIDGE_LIBRARY_DROPBOX_CLIENT_SECRET = 'secret';
  let revoked = false, restrictAtPublication = false, refreshes = 0;
  const f = await fixture(async (r,signal) => {
    const found = await r.tools!.call('library_search',{query:'manual'},signal);
    const hit = JSON.parse(found.text).matches[0];
    const read = await r.tools!.call('library_read',{folder:hit.folderId,fileId:hit.fileId},signal);
    assert.ok(read.success);
    if (restrictAtPublication) revoked = true;
    return 'Основание ' + JSON.parse(read.text).source;
  });
  t.after(() => f.app.close());
  t.mock.method(globalThis,'fetch',async (input:string, init:RequestInit) => {
    if (input === providers.dropbox.token) {
      const refreshing = (init.body as URLSearchParams).get('grant_type') === 'refresh_token';
      if (refreshing) refreshes++;
      return Response.json({access_token:'test',refresh_token:'refresh',expires_in:refreshing ? 3600 : 1});
    }
    if (revoked) return new Response(null,{status:403});
    if (input.endsWith('download')) return new Response('manual');
    assert.ok(input.endsWith('list_folder'));
    const entries = JSON.parse(String(init.body)).path ? [{'.tag':'file',id:'id:file',rev:'r',size:6,name:'help.txt',path_display:'/Docs/help.txt'}]
      : [{'.tag':'folder',id:'id:docs',name:'Docs',path_display:'/Docs'}];
    return Response.json({entries,has_more:false});
  });
  const base = '/api/library/external';
  assert.equal((await f.req('POST',base+'/authorize',f.token,{provider:'dropbox'})).statusCode,403);
  const started = (await f.req('POST',base+'/authorize',f.admin,{provider:'dropbox'})).json();
  assert.ok(started.url.startsWith(providers.dropbox.authorize));
  assert.equal((await f.req('POST',base+'/authorize/finish',f.admin,{state:started.state,code:'code'})).statusCode,200);
  const selection = {connection:started.state,folder:(await f.req('POST',base+'/folders',f.admin,{connection:started.state})).json()[0].id};
  const created = await f.req('POST','/api/library',f.admin,{name:'Docs',external:selection});
  assert.equal(created.statusCode,201,created.body);
  const folder = created.json(), registry = f.workspace.library.registry;
  await registry.external.sync(folder.id); await f.workspace.library.indexer.drain();
  assert.equal(refreshes,1);
  assert.equal((await f.req('POST','/api/library/'+folder.id+'/remove-files',f.admin,{paths:['help.txt']})).statusCode,403);
  const project = '/api/projects/'+f.project.id;
  const conn = await f.req('POST',project+'/library',f.admin,{folderId:folder.id});
  assert.equal(conn.statusCode,201);
  const view = (await f.req('GET',project+'/library',f.admin)).json();
  assert.equal((await f.req('PUT',project+'/library/'+folder.id+'/grants',f.admin,{profileId:'universal',enabled:true,revision:view.connections[0].revision})).statusCode,200);
  async function ask() {
    const chat = (await f.req('POST',project+'/chats',f.token,{})).json();
    const url = project+'/chats/'+chat.id;
    await f.req('POST',url+'/messages',f.token,{text:'Документация?'});
    await idle(f.workspace);
    return (await f.req('GET',url,f.token)).json().messages.at(-1).text;
  }
  assert.match(await ask(),/www\.dropbox\.com\/home\/Docs\/help\.txt/);
  restrictAtPublication = true;
  assert.match(await ask(),/Ответ не опубликован/);
  const state = registry.currentState(folder.id)!;
  const file = registry.fileByPath(state.id,'help.txt')!;
  assert.equal((await f.req('GET','/api/library/'+folder.id+'/files/'+file.file_id+'/original?download=1',f.admin)).statusCode,403);
});
