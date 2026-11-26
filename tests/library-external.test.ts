import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DriveAuth } from '../server/library/drive-auth.js';
import { LibrarySettings } from '../server/library/settings.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LibraryRegistry } from '../server/library/registry.js';
import { LibraryIndexer } from '../server/library/indexer.js';
import { LibraryReader } from '../server/library/reader.js';
import { CloudDrive, providers } from '../server/library/cloud-drive.js';
import { admin, startOperation } from './library-helpers.js';

test('Dropbox app folder root can be selected and synced, but a full Dropbox root cannot', async t => {
  const { fixture } = await import('./library-app.js');
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  const f = await fixture();
  t.after(() => f.app.close());
  const registry = f.workspace.library.registry;
  registry.settings.write('dropbox', { id: 'test-client', secret: 'test-secret' });
  const file = { '.tag': 'file', id: 'id:file', name: 'manual.txt', size: 6, rev: 'example', path_display: '/manual.txt' };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === providers.dropbox.token) {
      const code = (init.body as URLSearchParams).get('code');
      return Response.json({ access_token: code, account_id: 'dbid:' + code, expires_in: 3600 });
    }
    if (url.endsWith('/files/download')) return new Response('manual');
    assert.ok(url.endsWith('/files/list_folder'));
    assert.equal(JSON.parse(String(init.body)).path, '');
    const headers = new Headers(init.headers);
    if (headers.has('Dropbox-API-Path-Root') && headers.get('Authorization') !== 'Bearer full') {
      return new Response('Error in call to API function "files/list_folder": Path root is not supported for sandbox app.', { status: 400 });
    }
    return Response.json({ entries: [file], has_more: false });
  });
  const api = '/api/library/external';
  async function connect(code: string) {
    const started = (await f.req('POST', api + '/authorize', f.admin, { provider: 'dropbox' })).json();
    assert.equal((await f.req('POST', api + '/authorize/finish', f.admin, { state: started.state, code })).statusCode, 200);
    const folders = await f.req('POST', api + '/folders', f.admin, { connection: started.state, includeAppFolder: true });
    assert.equal(folders.statusCode, 200);
    return { connection: started.state, folders: folders.json() };
  }
  const full = await connect('full');
  assert.deepEqual(full.folders, []);
  assert.equal((await f.req('POST', '/api/library', f.admin, { name: 'Full', external: { connection: full.connection, folder: '' } })).statusCode, 400);

  const scoped = await connect('scoped');
  assert.deepEqual(scoped.folders, [{ id: '', name: 'Папка приложения Dropbox' }]);
  const external = { connection: scoped.connection, folder: '' };
  const check = (name: string, source = external) => f.req('POST', api + '/check', f.admin, { name, external: source });
  assert.equal((await f.req('POST', '/api/library', f.admin, { name: 'Taken name' })).statusCode, 201);
  assert.deepEqual((await check(' TAKEN NAME ')).json(), { nameTaken: true });
  assert.deepEqual((await check('App Folder')).json(), { nameTaken: false });
  const created = await f.req('POST', '/api/library', f.admin, { name: 'App Folder', external });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  await registry.external.sync(id);
  assert.equal(registry.db.prepare('SELECT total_files FROM states WHERE folder_id=?').get(id)?.total_files, 1);
  const account = registry.external.auth.accounts().find(account => account.libraries === 1)!;
  const reopened = (await f.req('POST', api + '/accounts/use', f.admin, { provider: 'dropbox', account: account.id })).json();
  assert.equal((await f.req('POST', api + '/folders', f.admin, { connection: reopened.state, includeAppFolder: true })).statusCode, 200);
  const existing = { connection: reopened.state, folder: '' };
  const conflict = await check('New name', existing);
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.body, /App Folder/);
  assert.equal((await f.req('POST', '/api/library', f.admin, { name: 'New name', external: existing })).statusCode, 409);
  const other = await connect('different-account');
  assert.deepEqual((await check('Other folder', { connection: other.connection, folder: '' })).json(), { nameTaken: false });
  assert.equal((await f.req('POST', '/api/library/' + id + '/external/reconnect', f.admin, { connection: other.connection, folder: '' })).statusCode, 400);
});

test('existing drive libraries retain their own encrypted credentials after the account migration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'library-account-migration-'));
  const before = new LibraryRegistry(root,{});
  const folder = before.createFolder(admin,{name:'Old docs'});
  const sealed = before.settings.seal({access:'old-access',expires:Date.now()+3600_000});
  before.db.exec('DROP INDEX external_sources_account; ALTER TABLE external_sources DROP COLUMN account_id; DROP TABLE drive_accounts; PRAGMA user_version=4');
  before.db.prepare('INSERT INTO external_sources(folder_id,provider,remote_id,identity,name,credentials) VALUES (?,?,?,?,?,?)')
    .run(folder.id,'google','docs','docs','Docs',sealed);
  before.close();
  const after = new LibraryRegistry(root,{});
  t.after(async () => { after.close(); await rm(root,{recursive:true,force:true}); });
  assert.deepEqual(after.external.auth.accounts().map(a=>({...a})),[{id:folder.id,provider:'google',name:'Old docs',libraries:1}]);
  assert.equal(after.db.prepare('SELECT credentials FROM drive_accounts WHERE id=?').get(folder.id)?.credentials,sealed);
  assert.equal(after.db.prepare('SELECT credentials FROM external_sources WHERE folder_id=?').get(folder.id)?.credentials,'');
});

test('named accounts are reusable across libraries, isolated by provider and restricted to administrators', async t => {
  const { fixture } = await import('./library-app.js');
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  const f = await fixture();
  t.after(() => f.app.close());
  const registry = f.workspace.library.registry;
  for (const provider of ['dropbox','yandex'] as const) registry.settings.write(provider,{ id: 'test', secret: 'private' });
  let logins = 0;
  t.mock.method(globalThis,'fetch',async (url: string, init: RequestInit) => {
    if (url === providers.dropbox.token || url === providers.yandex.token) {
      logins++;
      return Response.json({ access_token: (init.body as URLSearchParams).get('code'), expires_in: 3600 });
    }
    const account = new Headers(init.headers).get('authorization')!.split(' ')[1];
    if (url === providers.dropbox.authorize) throw Error('unexpected login');
    if (url.includes('cloud-api.yandex.net')) return Response.json({ type:'dir', _embedded:{ total:1,items:[{type:'dir',resource_id:account,path:'disk:/docs',name:account}] } });
    return Response.json({entries:JSON.parse(String(init.body)).path ? [] : [{'.tag':'folder',id:'id:docs',name:account,path_display:'/docs'}],has_more:false});
  });
  const base = '/api/library/external';
  for (const [provider,name] of [['dropbox','Sales'],['dropbox','Support'],['yandex','Office']]) {
    const {state,url} = (await f.req('POST',base+'/authorize',f.admin,{provider,accountName:name,switchAccount:true})).json();
    assert.ok(new URL(url).searchParams.has(provider === 'yandex' ? 'force_confirm' : 'force_reauthentication'));
    assert.equal((await f.req('POST',base+'/authorize/finish',f.admin,{state,code:name})).statusCode,200);
  }
  assert.equal((await f.req('GET',base+'/accounts',f.token)).statusCode,403);
  const listed = (await f.req('GET',base+'/accounts',f.admin)).json() as {id:string;name:string;provider:string;libraries:number}[];
  assert.equal(listed.length,3);
  for (const account of listed) {
    assert.deepEqual(Object.keys(account).sort(),['id','libraries','name','provider']);
    const use = await f.req('POST',base+'/accounts/use',f.admin,{provider:account.provider,account:account.id});
    const connection = use.json().state;
    const folders = (await f.req('POST',base+'/folders',f.admin,{connection})).json();
    assert.equal(folders[0].name,account.name);
    if (account.name === 'Sales') {
      const created = await f.req('POST','/api/library',f.admin,{name:'Docs',external:{connection,folder:folders[0].id}});
      assert.equal(created.statusCode,201);
      assert.equal(created.json().external.accountName,'Sales');
      const libraries = (await f.req('GET','/api/library',f.admin)).json() as {id:string;external?:{accountName:string}}[];
      assert.equal(libraries.find(f => f.id === created.json().id)?.external?.accountName,'Sales');
      assert.equal((await f.req('DELETE',base+'/accounts/'+account.id,f.admin)).statusCode,409);
      assert.equal((await f.req('POST',base+'/accounts/use',f.admin,{provider:'yandex',account:account.id})).statusCode,404);
      const again = (await f.req('POST',base+'/accounts/use',f.admin,{provider:'dropbox',account:account.id})).json().state;
      assert.notEqual(again,connection);
      assert.equal((await f.req('POST',base+'/folders',f.admin,{connection:again})).json()[0].name,'Sales');
    } else {
      assert.equal((await f.req('DELETE',base+'/accounts/'+account.id,f.admin)).statusCode,200);
      assert.equal((await f.req('POST',base+'/folders',f.admin,{connection})).statusCode,410);
    }
  }
  assert.equal(logins,3);
  assert.equal((await f.req('GET',base+'/accounts',f.admin)).json()[0].libraries,1);
});

test('Dropbox account switching and replacing application keys are separate flows', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dropbox-replace-'));
  const registry = new LibraryRegistry(root, {});
  t.after(async () => { await registry.external.stop(); registry.close(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/files/list_folder')) return Response.json({ entries: [{ '.tag': 'folder', id: 'id:docs', name: 'Docs', path_display: '/Docs' }], has_more: false });
    assert.equal(url, providers.dropbox.token);
    const body = init.body as URLSearchParams;
    if (body.get('code') === 'invalid') return Response.json({}, { status: 400 });
    return Response.json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 });
  });
  const previous = { id: 'old-client', secret: 'old-secret' };
  const replacement = { id: 'new-client', secret: 'new-secret' };
  registry.settings.write('dropbox', previous);
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  const auth = registry.external.auth;
  const switchAccount = auth.begin(admin.id, 'dropbox', undefined, { switchAccount: true });
  assert.equal(new URL(switchAccount.url).searchParams.get('force_reauthentication'), 'true');
  await auth.finish(admin.id, switchAccount.state, 'valid');
  await auth.folders(admin.id, switchAccount.state);
  const failed = auth.begin(admin.id, 'dropbox', replacement, { replaceDropbox: true });
  assert.equal(new URL(failed.url).searchParams.get('client_id'), replacement.id);
  await assert.rejects(auth.finish(admin.id, failed.state, 'invalid'), /отклонил авторизацию/);
  assert.deepEqual(registry.settings.read('dropbox'), previous);
  const started = auth.begin(admin.id, 'dropbox', replacement, { replaceDropbox: true });
  const folder = registry.createFolder(admin, { name: 'Connected', external: { connection: switchAccount.state, folder: 'id:docs' } });
  assert.throws(() => auth.begin(admin.id, 'dropbox', replacement, { replaceDropbox: true }), /ещё привязаны библиотеки/);
  await assert.rejects(auth.finish(admin.id, started.state, 'valid'), /ещё привязаны библиотеки/);
  registry.deleteFolder(admin, folder.id, folder.revision);
  const confirmed = auth.begin(admin.id, 'dropbox', replacement, { replaceDropbox: true });
  await auth.finish(admin.id, confirmed.state, 'valid');
  assert.deepEqual(registry.settings.read('dropbox'), replacement);
  await assert.rejects(auth.folders(admin.id, switchAccount.state), /Сеанс подключения завершён/);
  assert.deepEqual(await auth.folders(admin.id, confirmed.state), [{ id: 'id:docs', name: 'Docs' }]);
});

test('Yandex API apps use the verification page and exchange the displayed code with PKCE', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'yandex-library-'));
  const registry = new LibraryRegistry(root,{});
  t.after(async () => { registry.close(); await rm(root,{ recursive: true, force: true }); });
  const settings = registry.settings, auth = registry.external.auth;
  const keys = { id: 'test-client', secret: 'test-secret' };
  const redirect = 'https://oauth.yandex.ru/verification_code';
  assert.equal(auth.status('yandex').redirectUri, redirect);
  const login = auth.begin('owner', 'yandex', keys);
  const params = new URL(login.url).searchParams;
  assert.equal(params.get('redirect_uri'), redirect);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('scope'), 'cloud_api:disk.read');
  assert.equal(params.get('code_challenge_method'), 'S256');
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, providers.yandex.token);
    const body = init.body as URLSearchParams;
    assert.equal(body.get('code'), '0123456');
    assert.equal(body.get('redirect_uri'), redirect);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), params.get('code_challenge'));
    return Response.json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600 });
  });
  await assert.rejects(auth.finish('other', login.state, '0123456'));
  await auth.finish('owner', login.state, '0123456');
  await assert.rejects(auth.finish('owner', login.state, '0123456'));
  const reopened = new DriveAuth(settings,registry.db);
  assert.equal(new URL(reopened.begin('owner','yandex').url).searchParams.get('redirect_uri'), redirect);
  settings.write('yandex', keys);
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  assert.equal(new URL(reopened.begin('owner','yandex').url).searchParams.get('redirect_uri'), 'https://platform.example/library-oauth.html');
});

test('private Drive library without S3: OAuth, picker, index updates, revocation and cleanup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'external-library-'));
  const registry = new LibraryRegistry(root, {}), indexer = new LibraryIndexer(registry), reader = new LibraryReader(registry);
  t.after(async () => { await registry.external.stop(); await indexer.stop(); registry.close(); await rm(root,{recursive:true,force:true}); });
  const auth = registry.external.auth;
  process.env.BRIDGE_PUBLIC_ORIGIN = 'https://platform.example';
  process.env.BRIDGE_LIBRARY_GOOGLE_CLIENT_ID = 'client';
  process.env.BRIDGE_LIBRARY_GOOGLE_CLIENT_SECRET = 'test-secret';
  let revoked = false, removed = false, version = 1, downloads = 0;
  const downloadStarted = Promise.withResolvers<AbortSignal>();
  let blockDownload = false;
  let content = 'first reference', filename = 'guide.txt';
  const fetchMock = t.mock.method(globalThis,'fetch',async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.href === providers.google.token) {
      assert.ok((init?.body as URLSearchParams).get('code_verifier'));
      return Response.json({ access_token: 'private-test-token', refresh_token: 'private-refresh', expires_in: 3600 });
    }
    assert.equal(url.host,'www.googleapis.com'); assert.equal(init?.method ?? 'GET','GET');
    if (revoked) return new Response(null,{status:403});
    if (url.searchParams.get('alt') === 'media') {
      downloads++;
      if (blockDownload) {
        const signal = init!.signal!;
        downloadStarted.resolve(signal);
        return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return new Response(content);
    }
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
  removed = false; version++; content = 'new text to index';
  await registry.external.sync(folder.id);
  const startedIndex = Promise.withResolvers<AbortSignal>();
  const cache = registry.objectStore('library/external_' + folder.id);
  const stream = t.mock.method(cache, 'stream', (_key: string, signal: AbortSignal) => {
    startedIndex.resolve(signal);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const indexing = indexer.runOnce();
  const indexSignal = await startedIndex.promise;
  const before = fetchMock.mock.callCount();
  registry.deleteFolder(admin,folder.id,folder.revision);
  await registry.collectGarbage({graceMs:0});
  assert.equal(registry.external.has(folder.id),false);
  assert.ok(indexSignal.aborted);
  await indexing;
  stream.mock.restore();
  assert.equal(registry.db.prepare('SELECT count(*) n FROM index_jobs').get()?.n,0);
  assert.equal(fetchMock.mock.callCount(),before);

  const other = registry.createFolder(admin,{name:'Disconnect during download', external});
  blockDownload = true;
  const sync = registry.external.sync(other.id);
  const signal = await downloadStarted.promise;
  assert.throws(() => registry.deleteFolder(admin,other.id,other.revision + 1), /изменена/);
  assert.equal(signal.aborted,false);
  registry.deleteFolder(admin,other.id,other.revision);
  assert.ok(signal.aborted);
  await assert.rejects(sync);
  await registry.external.sync(other.id);
  assert.equal(registry.db.prepare('SELECT count(*) n FROM states WHERE folder_id=?').get(other.id)?.n,0);
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
  const statusUrl = base + '/status/dropbox';
  assert.equal((await f.req('POST',base+'/folders',f.admin,{connection:'expired-draft'})).statusCode,410);
  assert.equal((await f.req('POST','/api/library',f.admin,{name:'Expired',external:{connection:'expired-draft',folder:'id:docs'}})).statusCode,410);
  assert.equal((await f.req('GET',statusUrl,f.token)).statusCode,403);
  const redirectUri = 'https://agents.example.test/library-oauth.html';
  assert.deepEqual((await f.req('GET',statusUrl,f.admin)).json(),{configured:true, redirectUri});
  delete process.env.BRIDGE_LIBRARY_DROPBOX_CLIENT_SECRET;
  t.after(() => { process.env.BRIDGE_LIBRARY_DROPBOX_CLIENT_SECRET = 'secret'; });
  assert.deepEqual((await f.req('GET',statusUrl,f.admin)).json(),{configured:false, redirectUri});
  const setup = { id: 'wizard-client', secret: 'private-wizard-secret' };
  const draft = { provider: 'dropbox', setup };
  assert.equal((await f.req('POST',base+'/authorize',f.token,draft)).statusCode,403);
  const started = (await f.req('POST',base+'/authorize',f.admin,draft)).json();
  assert.equal(new URL(started.url).searchParams.get('client_id'), setup.id);
  assert.ok(!JSON.stringify(started).includes(setup.secret));
  assert.equal((await f.req('GET',statusUrl,f.admin)).json().configured,false);
  assert.equal((await f.req('POST',base+'/authorize/finish',f.admin,{state:started.state,code:'code'})).statusCode,200);
  assert.deepEqual((await f.req('GET',statusUrl,f.admin)).json(),{configured:true, redirectUri});
  const dataDir = path.join(f.root, 'data');
  const fresh = new DriveAuth(new LibrarySettings(dataDir),f.workspace.library.registry.db);
  assert.equal(new URL(fresh.begin('owner', 'dropbox').url).searchParams.get('client_id'),setup.id);
  assert.ok(!(await readFile(path.join(dataDir, 'dropbox.env'), 'utf8')).includes(setup.secret));
  const selection = {connection:started.state,folder:(await f.req('POST',base+'/folders',f.admin,{connection:started.state})).json()[0].id};
  const created = await f.req('POST','/api/library',f.admin,{name:'Docs',external:selection});
  assert.equal(created.statusCode,201,created.body);
  const folder = created.json(), registry = f.workspace.library.registry;
  assert.equal(folder.external.syncing, true);
  const deadline = Date.now() + 15_000;
  let latest = folder;
  while (latest.external.syncing && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    latest = (await f.req('GET','/api/library/'+folder.id,f.admin)).json();
  }
  assert.equal(latest.external.syncing, false);
  assert.equal(latest.current?.files, 1, 'saving starts both import and indexing without a manual sync');
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
