import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, grantedFolder, idle, json } from './library-app.js';

const code = 'public class Pricing {\n  // north region markup\n  public decimal Price(decimal cost) {\n    return cost * 1.35m;\n  }\n}\n';

test('the agent explores the project library like a directory: list, tree, search, read; the answer names its basis', async () => {
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'library_read')) return 'Без библиотеки';
    const folders = json((await request.tools.call('library_list', {}, signal)).text).folders;
    const tree = json((await request.tools.call('library_tree', { folder: folders[0].folder }, signal)).text);
    const found = json((await request.tools.call('library_search', { query: 'Price(' }, signal)).text).matches;
    const read = json((await request.tools.call('library_read', { folder: folders[0].folder, path: found[0].path, startLine: found[0].lines }, signal)).text);
    return `Папок ${folders.length}; в корне ${tree.entries.map((e: { name: string }) => e.name).join(',')}; найдено в ${found[0].path}:${found[0].lines}; прочитано ${read.lines.length} строк.`;
  });
  try {
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const ask = async (text: string) => {
      await f.req('POST', route, f.token, { text }); await idle(f.workspace);
      return (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string;
    };
    assert.equal(await ask('Вопрос до подключения'), 'Без библиотеки');
    const { folder } = await grantedFolder(f, { 'Pricing.cs': code, 'Docs/readme.md': '# Наценка\n' }, { name: 'Fastkore Business' });
    assert.match(await ask('Как считается цена?'), /Папок 1; в корне Docs,Pricing\.cs; найдено в Pricing\.cs:3; прочитано/);
    const instructions = f.calls.at(-1)!.developerInstructions!;
    assert.match(f.calls.at(-1)!.prompt, /"название":"Fastkore Business"/);
    assert.doesNotMatch(instructions, /Fastkore Business/);
    assert.match(instructions, /library_search/);
    // An employee does not manage the library; the second project does not see the folder.
    assert.equal((await f.req('GET', `/api/projects/${f.project.id}/library`, f.token)).statusCode, 404);
    assert.equal((await f.req('GET', `/api/library/${folder.id}`, f.token)).statusCode, 404);
    const view = (await f.req('GET', `/api/projects/${f.project2.id}/library`, f.admin)).json();
    assert.equal(view.connections.length, 0);
    assert.deepEqual(view.available.map((a: { id: string }) => a.id), [folder.id]);
  } finally { await f.app.close(); }
});

test('after an update the next question uses the current content; an update during an answer does not block its publication; revocation does', async () => {
  let release: () => void = () => {};
  let hold = false;
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'library_read')) return 'Без библиотеки';
    const folder = json((await request.tools.call('library_list', {}, signal)).text).folders[0]?.folder;
    if (!folder) return 'Папок нет';
    const read = async () => { const r = await request.tools!.call('library_read', { folder, path: 'Price.txt' }, signal); return r.success ? json(r.text).lines[0] : 'нет доступа'; };
    if (hold) {
      hold = false;
      const before = await read();
      await new Promise<void>(resolve => { release = resolve; });
      return `до: ${before}; после: ${await read()}`;
    }
    return 'Цена: ' + await read();
  });
  try {
    const { folder, connection } = await grantedFolder(f, { 'Price.txt': '100\n' });
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const last = async () => (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string;
    await f.req('POST', route, f.token, { text: 'Цена?' }); await idle(f.workspace);
    assert.equal(await last(), 'Цена: 1: 100');
    // Update while an answer is running: the answer finishes with the content it started with and is published.
    hold = true;
    await f.req('POST', route, f.token, { text: 'Подожди' });
    const deadline = Date.now() + 4000;
    while (f.calls.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    await f.upload(folder.id, { 'Price.txt': '200\n' });
    release();
    await idle(f.workspace);
    assert.equal(await last(), 'до: 1: 100; после: 1: 100');
    await f.req('POST', route, f.token, { text: 'Цена?' }); await idle(f.workspace);
    assert.equal(await last(), 'Цена: 1: 200', 'the next question uses the current content');
    // Revocation during an answer blocks further reads and the publication.
    hold = true;
    await f.req('POST', route, f.token, { text: 'Подожди ещё' });
    while (f.calls.length < 4 && Date.now() < deadline + 4000) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    const revoked = await f.req('PUT', `/api/projects/${f.project.id}/library/${folder.id}/grants`, f.admin, { profileId: 'universal', enabled: false, revision: (await connection()).revision });
    assert.equal(revoked.statusCode, 200, revoked.body);
    release();
    await idle(f.workspace);
    assert.match(await last(), /Ответ не опубликован: доступ к библиотеке изменился/);
    await f.req('POST', route, f.token, { text: 'Цена?' }); await idle(f.workspace);
    assert.equal(await last(), 'Без библиотеки');
  } finally { await f.app.close(); }
});

test('explanation only: code blocks, encoded copies and listings are not published; short quotes need the excerpts mode; raw text stays out of API responses', async () => {
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'library_read')) return 'Без библиотеки';
    const folder = json((await request.tools.call('library_list', {}, signal)).text).folders[0].folder;
    const read = json((await request.tools.call('library_read', { folder, path: 'Pricing.cs' }, signal)).text);
    const source = read.lines.map((l: string) => l.replace(/^\d+: /, '')).join('\n');
    if (request.prompt.includes('BLOCK')) return 'Вот код:\n```csharp\n' + source + '\n```';
    if (request.prompt.includes('BASE64')) return 'Содержимое: ' + Buffer.from(source).toString('base64');
    if (request.prompt.includes('LINES')) return source;
    if (request.prompt.includes('VISUAL')) return 'Результат.\n\n```fastkore-visual\n' + JSON.stringify({ version: 1, blocks: [
      { type: 'table', title: 'Выдержка', columns: ['Строка'], rows: source.split('\n').map(line => [line]) },
    ] }) + '\n```';
    if (request.prompt.includes('QUOTE')) return 'Наценка задаётся строкой `return cost * 1.35m;` (Pricing.cs:4).';
    return 'Наценка равна 35% от себестоимости (Pricing.cs, строка 4).';
  }, { workerFiles: true });
  try {
    await f.workspace.settings({ allowWrite: true });
    f.project.chatAllowWrite = true;
    const { folder, connection } = await grantedFolder(f, { 'Pricing.cs': code });
    const ask = async (text: string) => {
      const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
      const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
      await f.req('POST', route, f.token, { text }); await idle(f.workspace);
      const message = (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1);
      return { text: message.text as string, visuals: message.visuals, call: f.calls.at(-1)! };
    };
    const explained = await ask('Как считается наценка?');
    assert.equal(explained.call.workDirectoryId, undefined, 'no output files for explanation-only analysis');
    assert.match(explained.text, /35%/);
    for (const attempt of ['BLOCK', 'BASE64', 'LINES', 'QUOTE', 'VISUAL']) {
      const blocked = await ask(attempt);
      assert.match(blocked.text, /Ответ не опубликован/, attempt);
      assert.ok(!blocked.text.includes('1.35m'), attempt);
      assert.equal(blocked.visuals, undefined, attempt);
    }
    const c = await connection();
    assert.equal((await f.req('PATCH', `/api/projects/${f.project.id}/library/${folder.id}`, f.admin, { revision: c.revision, outputPolicy: 'excerpts_allowed' })).statusCode, 200);
    const summary = (await f.req('GET', `/api/library/${folder.id}`, f.admin)).json();
    assert.equal((await f.req('PATCH', `/api/library/${folder.id}`, f.admin, { revision: summary.revision, outputPolicy: 'excerpts_allowed' })).statusCode, 200);
    assert.match((await ask('QUOTE')).text, /return cost \* 1\.35m;/);
    assert.match((await ask('LINES')).text, /Ответ не опубликован/);
    for (const url of ['/api/status', `/api/projects/${f.project.id}/chats`]) assert.ok(!(await f.req('GET', url, f.token)).body.includes('north region'), url);
    assert.ok(!(await f.req('GET', '/api/library/audit', f.admin)).body.includes('north region'));
  } finally { await f.app.close(); }
});

test('closed folders are stored but not offered to the agent in this delivery; folders are not open to specialists by default', async () => {
  const f = await fixture(async request => request.tools?.definitions.some(d => d.name === 'library_list') ? 'С библиотекой' : 'Без библиотеки');
  try {
    const created = (await f.req('POST', '/api/library', f.admin, { name: 'Не назначенная', profile: 'documents' })).json();
    assert.equal((await f.req('POST', `/api/projects/${f.project.id}/library`, f.admin, { folderId: created.id })).statusCode, 201);
    await f.upload(created.id, { 'a.txt': 'a\n' });
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const last = async () => (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string;
    await f.req('POST', route, f.token, { text: 'Вопрос' }); await idle(f.workspace);
    assert.equal(await last(), 'Без библиотеки', 'a connected folder is not assigned to specialists automatically');
    await grantedFolder(f, { 'secret.txt': 'closed\n' }, { classification: 'restricted' });
    const view = (await f.req('GET', `/api/projects/${f.project.id}/library`, f.admin)).json();
    const restricted = view.connections.find((c: { classification: string }) => c.classification === 'restricted');
    const cell = view.cells.find((c: { folderId: string; profileId: string }) => c.folderId === restricted.folderId && c.profileId === 'universal');
    assert.equal(cell.granted, true);
    assert.equal(cell.allowed, false);
    assert.match(cell.reasons.join(' '), /выключен/);
    await f.req('POST', route, f.token, { text: 'Вопрос' }); await idle(f.workspace);
    assert.equal(await last(), 'Без библиотеки');
  } finally { await f.app.close(); }
});

test('a folder toggle pauses access across projects without removing files or specialist grants', async () => {
  const f = await fixture();
  try {
    const { folder, connection } = await grantedFolder(f, { 'guide.txt': 'Instructions\n' });
    const url = '/api/library/' + folder.id;
    const before = (await f.req('GET', url, f.admin)).json();
    assert.equal(before.active, true);
    const policy = f.workspace.library.policy;
    const credentialId = f.workspace.store.state.security!.credentials.find(credential => credential.userId === f.employee.id)!.id;
    const scope = policy.runScope(f.employee.id, f.project.id, 'universal', credentialId);
    assert.equal(scope.entries.length, 1);
    const turnedOff = await f.req('PATCH', url, f.admin, { revision: before.revision, active: false });
    assert.equal(turnedOff.statusCode, 200, turnedOff.body);
    assert.equal(turnedOff.json().active, false);
    assert.equal(turnedOff.json().current.files, 1);
    assert.equal((await connection()).folderActive, false);
    assert.equal(policy.stillAllowed(scope, scope.entries[0]), false);
    assert.equal(policy.runScope(f.employee.id, f.project.id, 'universal', credentialId).entries.length, 0);

    const turnedOn = await f.req('PATCH', url, f.admin, { revision: turnedOff.json().revision, active: true });
    assert.equal(turnedOn.statusCode, 200, turnedOn.body);
    assert.equal(policy.runScope(f.employee.id, f.project.id, 'universal', credentialId).entries.length, 1);
  } finally { await f.app.close(); }
});

test('HTTP protocol: one operation per folder (409), "Библиотека актуальна", part limits, removal and folder deletion through the API', async () => {
  const f = await fixture();
  try {
    const folder = (await f.req('POST', '/api/library', f.admin, { name: 'API', profile: 'documents' })).json();
    assert.equal((await f.req('POST', '/api/library', f.token, { name: 'Чужая' })).statusCode, 403);
    await f.upload(folder.id, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    assert.equal((await f.upload(folder.id, { 'a.txt': 'a\n', 'b.txt': 'b\n' })).status, 'unchanged');
    const open = await f.req('POST', `/api/library/${folder.id}/operations`, f.admin, { idempotencyKey: 'open-1-xyz', mode: 'add', totalFiles: 1, totalBytes: 2, exclusions: [] });
    assert.equal(open.statusCode, 201);
    const second = await f.req('POST', `/api/library/${folder.id}/operations`, f.admin, { idempotencyKey: 'open-2-xyz', mode: 'add', totalFiles: 1, totalBytes: 2, exclusions: [] });
    assert.equal(second.statusCode, 409);
    assert.match(second.json().error, /уже обновляется/);
    assert.equal((await f.req('GET', `/api/library/${folder.id}`, f.admin)).json().operation.id, open.json().id, 'the unfinished upload is visible for «Продолжить загрузку»');
    const oversized = await f.part(`/api/library/${folder.id}/operations/${open.json().id}/files/f_x/parts/1`, Buffer.alloc(2048));
    assert.ok(oversized.statusCode >= 400);
    assert.equal((await f.req('POST', `/api/library/${folder.id}/operations/${open.json().id}/cancel`, f.admin, {})).statusCode, 200);
    assert.equal((await f.req('POST', `/api/library/${folder.id}/remove-files`, f.admin, { paths: ['a.txt'] })).statusCode, 200);
    const tree = (await f.req('GET', `/api/library/${folder.id}/tree`, f.admin)).json();
    assert.deepEqual(tree.entries.map((e: { name: string }) => e.name), ['b.txt']);
    const summary = (await f.req('GET', `/api/library/${folder.id}`, f.admin)).json();
    assert.equal((await f.req('DELETE', `/api/library/${folder.id}?revision=${summary.revision}`, f.admin)).statusCode, 200);
    assert.equal((await f.req('GET', `/api/library/${folder.id}`, f.admin)).statusCode, 404);
    // Retired routes and the former local upload utility give no access.
    for (const url of ['/api/admin/sources', `/api/projects/${f.project.id}/sources`, `/api/projects/${f.project.id}/files`]) assert.equal((await f.req('GET', url, f.admin)).statusCode, 404, url);
  } finally { await f.app.close(); }
});
test('the project routes a quote to an estimator with its own library grant and also supports explicit selection', async () => {
  const f = await fixture(async (request, signal) => {
    const tools = request.tools!;
    if (json(request.prompt.split('\n')[1]).агент === 'Оценщик') {
      const list = await tools.call('library_list', {}, signal);
      assert.equal(list.success, true, list.text);
      const [folder] = json(list.text).folders;
      const found = await tools.call('library_search', { query: 'SH-12' }, signal);
      assert.equal(found.success, true, found.text);
      const [match] = json(found.text).matches;
      const file = await tools.call('library_read', { folder: folder.folder, path: match.path }, signal);
      assert.match(file.text, /12000/);
      assert.equal((await tools.call('knowledge', { section: 'fastkore', action: 'index' }, signal)).success, true);
      return 'Стоимость позиции SH-12 составляет 12 000 рублей.';
    }
    assert.ok(!tools.definitions.some(tool => tool.name === 'library_read'));
    if (request.prompt.includes('Консультация по выбору сотрудника')) {
      assert.match(request.prompt, /12 000 рублей/);
      return 'КП: 12 000 рублей.';
    }
    const catalog = await tools.call('consult_specialist', {}, signal);
    assert.deepEqual(json(catalog.text), [{ id: 'estimator', name: 'Оценщик', description: 'Расчёт стоимости по прайсу проекта' }]);
    const result = await tools.call('consult_specialist', { specialistId: 'estimator', task: 'Проверь цену SH-12' }, signal);
    assert.equal(result.success, true);
    return result.text;
  });
  try {
    const original = f.workspace.corporate.data.profiles.find(profile => profile.id === 'estimator')!;
    await f.workspace.corporate.saveProfile({ role: 'admin', id: 'test-admin', disabled: false, name: 'Test', username: 'test' },
      { ...original, enabled: true, description: 'Расчёт стоимости по прайсу проекта' });
    await grantedFolder(f, { 'price.csv': 'sku,price\nSH-12,12000\n' }, { profileId: 'estimator', profile: 'documents' });
    const route = `/api/projects/${f.project.id}/chats`;
    async function ask(agentProfileId?: string, requiredSpecialistId?: string) {
      const created = await f.req('POST', route, f.token, { agentProfileId });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().agentProfileId, agentProfileId);
      const chat = route + '/' + created.json().id;
      const sent = await f.req('POST', chat + '/messages', f.token, { text: 'Подготовь КП на SH-12', requiredSpecialistId });
      assert.equal(sent.statusCode, 202, sent.body);
      await idle(f.workspace);
      assert.equal(f.workspace.getRun(sent.json().id).status, 'complete', f.workspace.getRun(sent.json().id).error);
      return (await f.req('GET', chat, f.token)).json().messages.at(-1);
    }
    for (const required of [undefined, 'estimator']) {
      const answer = await ask(undefined, required);
      assert.match(answer.text, /12 000 рублей/);
      assert.deepEqual(answer.consultedSpecialists, ['Оценщик']);
    }
    const direct = await ask('estimator');
    assert.match(direct.text, /12 000 рублей/);
    assert.equal(direct.consultedSpecialists, undefined);
    const denied = await f.req('POST', route, f.token, { agentProfileId: 'accountant' });
    assert.equal(denied.statusCode, 403);
    const projectChat = await f.req('POST', route, f.token, {});
    assert.equal((await f.req('POST', route + '/' + projectChat.json().id + '/messages', f.token,
      { text: 'Подготовь КП', requiredSpecialistId: 'accountant' })).statusCode, 403);
  } finally { await f.app.close(); }
});
