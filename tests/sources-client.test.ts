import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collect, hashFiles, prepareUpload, type Request } from '../client/source-upload.js';
import { defaultExclusions, sourceDefaults } from '../shared/sources.js';

const file = (relative: string, content: string | Buffer) => Object.assign(new File([content], relative.split('/').at(-1)!), { webkitRelativePath: relative });
const limits = { maxFileBytes: sourceDefaults.maxFileBytes, maxPathLength: sourceDefaults.maxPathLength, maxDepth: sourceDefaults.maxDepth };

test('browser scan keeps relative paths without the absolute root, applies exclusions, rejects collisions and flags secrets', async () => {
  const list = [
    file('Business/Заказы/Модуль.cs', 'class A {}\n'), file('Business/Склад/Модуль.cs', 'class B {}\n'),
    file('Business/.git/config', '[core]'), file('Business/bin/app.dll', 'MZ'), file('Business/node_modules/x/index.js', ''),
    file('Business/Native/Runtime.DLL', 'MZ'), file('Business/Native/Runtime.dll.config', '<configuration/>'),
    file('Business/Downloads/Platform.nupkg', 'PK'), file('Business/Lib/lib.so.1', 'ELF'),
    file('Business/dist/app.js', 'built'), file('Business/Sdk/app.js.map', '{}'), file('Business/Sdk/app.js', 'source'),
    file('Business/Документы/Описание.pdf', '%PDF'), file('Business/Business.csproj', '<Project/>'),
    file('Business/.env', 'PASSWORD=x'), file('Business/keys/server.pem', '-----BEGIN PRIVATE KEY-----'),
    file('Business/Docs/Readme.md', '# A'), file('Business/docs/README.md', '# B'),
    file('Business/app.config.json', '{ "password": "VerySecret123" }'),
    file('Business/Settings.export', 'password = "SyntheticSample123"'),
    file('Business/big.bin', Buffer.alloc(100)),
  ] as unknown as FileList;
  const scan = collect(list, defaultExclusions, { ...limits, maxFileBytes: 50 });
  assert.equal(scan.root, 'Business');
  assert.deepEqual(scan.files.map(f => f.path).sort(), ['app.config.json', 'Settings.export', 'Заказы/Модуль.cs', 'Склад/Модуль.cs',
    'Native/Runtime.dll.config', 'Sdk/app.js', 'Документы/Описание.pdf', 'Business.csproj'].sort());
  assert.deepEqual(scan.excluded.map(e => e.rule).sort(), ['*.pem', '.env', '.git/', 'bin/', 'node_modules/',
    '*.dll', '*.nupkg', '*.so.*', 'dist/', '*.js.map'].sort());
  assert.ok(scan.problems.some(p => p.path === 'big.bin' && p.problem === 'too_large'));
  assert.ok(scan.problems.some(p => p.problem.startsWith('collision:')), 'case collision Docs/docs reported');
  await hashFiles(scan, 4, () => {}, new AbortController().signal);
  for (const f of scan.files) assert.equal(f.sha256, createHash('sha256').update(Buffer.from(await f.file.arrayBuffer())).digest('hex'));
  assert.deepEqual(scan.secrets.map(s => s.path).sort(), ['Settings.export', 'app.config.json']);
});

test('browser preparation resumes the same upload and confirms selected files on later status pages', async () => {
  const files = Array.from({ length: 1001 }, (_, i) => ({ path: `file${i}.txt`, size: 1,
    file: file(`Root/file${i}.txt`, 'a'), sha256: createHash('sha256').update('a').digest('hex'), secretFindings: i === 1000 ? ['test finding'] : undefined }));
  const scan = { ...collect([] as unknown as FileList, defaultExclusions, limits), files };
  const options = { label: 'Test', exclusions: defaultExclusions, includeSecrets: new Set([files[1000].path]) };
  let createCalls = 0;
  let interrupt = true;
  const pages = new Map<number, unknown>();
  const decisions: string[] = [];
  const request: Request = async <T>(url: string, init?: RequestInit) => {
    if (url.endsWith('/uploads')) { createCalls++; return { id: 'upload' } as T; }
    if (url.endsWith('/manifest')) {
      const page = JSON.parse(init!.body as string);
      if (page.page === 1 && interrupt) { interrupt = false; throw new Error('connection lost'); }
      if (pages.has(page.page)) assert.deepEqual(page, pages.get(page.page));
      pages.set(page.page, page);
      return {} as T;
    }
    if (url.endsWith('/secret-decision')) { decisions.push(url); return {} as T; }
    if (url.endsWith('?cursor=999')) return { files: [{ fileId: 'file-id', path: files[1000].path, secretFindings: ['test finding'] }] } as T;
    return { upload: { id: 'upload' }, files: [], next: 999 } as T;
  };
  await assert.rejects(prepareUpload(request, 'source', scan, options), /connection lost/);
  assert.equal(pages.size, 1);
  await prepareUpload(request, 'source', scan, options, 'upload');
  assert.equal(createCalls, 1);
  assert.equal(pages.size, 2);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0], /\/file-id\/secret-decision$/);
});
