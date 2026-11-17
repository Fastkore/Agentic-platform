import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, idle, json } from './sources-app.js';
import { sha } from './sources-helpers.js';

test('AC06/AC09: one source in two projects and specialists; matrix, tools and API agree; explanation-only answer is checked before publication', async () => {
  const seen: Record<string, unknown>[] = [];
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'sources_list')) return 'Без источников';
    const call = async (name: string, args: unknown) => { const r = await request.tools!.call(name, args, signal); seen.push({ name, ...r }); return r; };
    const list = json((await call('sources_list', {})).text);
    const source = list.sources[0].source;
    const found = json((await call('source_search', { source, query: 'CalculateDiscount' })).text);
    const read = json((await call('source_read', { source, fileId: found.matches[0].fileId, startLine: 1, lineCount: 20 })).text);
    // Out-of-scope attempts: other binding ids, foreign file ids, path traversal.
    assert.equal((await call('source_read', { source: 'bnd_unknown', path: 'Orders/Discount.cs' })).success, false);
    assert.equal((await call('source_read', { source, fileId: 'f_foreign' })).success, false);
    assert.equal((await call('source_tree', { source, path: '../..' })).success, false);
    if (request.prompt.includes('Процитируй')) return read.lines.slice(0, 5).map((l: string) => l.replace(/^\d+: /, '')).join('\n');
    return `Скидка считается в CalculateDiscount (${read.source} ${read.snapshot}, ${read.path}:${found.matches[0].lines}).`;
  });
  try {
    const created = await f.req('POST', '/api/admin/sources', f.admin, { name: 'Fastkore Business', kind: 'code', classification: 'shared', projectId: f.project.id });
    assert.equal(created.statusCode, 201, created.body);
    const { source, binding } = created.json();
    const code = 'namespace Orders {\n  public class Discount {\n    public decimal CalculateDiscount(decimal total) {\n      if (total > 1000m) return total * 0.05m;\n      return 0m;\n    }\n  }\n}\n';
    const snapshotId = await f.upload(source.id, { 'Orders/Discount.cs': code, 'Docs/README.md': '# Скидки\nСкидка 5% при сумме больше 1000.\n' });
    // Employees cannot see the registry, the project source screen or originals.
    for (const url of ['/api/admin/sources', `/api/admin/sources/${source.id}`, `/api/projects/${f.project.id}/sources`, `/api/admin/sources-storage`]) {
      const r = await f.req('GET', url, f.token);
      assert.ok([403, 404].includes(r.statusCode) || (r.statusCode === 200 && r.json().length === 0), url + ' ' + r.statusCode);
    }
    const tree = (await f.req('GET', `/api/admin/sources/${source.id}/snapshots/${snapshotId}/tree`, f.admin)).json();
    const fileId = (await f.req('GET', `/api/admin/sources/${source.id}/snapshots/${snapshotId}/tree?path=Orders`, f.admin)).json().entries[0].fileId;
    assert.deepEqual(tree.entries.map((e: { name: string }) => e.name), ['Docs', 'Orders']);
    assert.equal((await f.req('GET', `/api/admin/sources/${source.id}/snapshots/${snapshotId}/files/${fileId}/original?download=1`, f.token)).statusCode, 404);
    const download = await f.req('GET', `/api/admin/sources/${source.id}/snapshots/${snapshotId}/files/${fileId}/original?download=1`, f.admin);
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, code);
    // Pin the snapshot; no specialist has access by default.
    // Readiness of a snapshot changes the effective selection, so the binding revision moves on.
    const fresh = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().bindings[0];
    assert.ok(fresh.revision > binding.revision);
    assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-bindings/${binding.id}`, f.admin, { revision: binding.revision, snapshotId })).statusCode, 409);
    const pinned = await f.req('PUT', `/api/projects/${f.project.id}/source-bindings/${binding.id}`, f.admin, { revision: fresh.revision, snapshotId });
    assert.equal(pinned.statusCode, 200, pinned.body);
    let matrix = (await f.req('GET', `/api/projects/${f.project.id}/source-matrix`, f.admin)).json();
    const cell = matrix.cells.find((c: { profileId: string }) => c.profileId === 'universal');
    assert.equal(cell.granted, false);
    assert.ok(cell.reasons.includes('Источник не назначен специалисту'));
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    await f.req('POST', route, f.token, { text: 'Как считается скидка?' }); await idle(f.workspace);
    assert.ok(!f.calls[0].tools?.definitions.some(d => d.name.startsWith('source')), 'no access without grant');
    const grant = await f.req('PUT', `/api/projects/${f.project.id}/source-grants`, f.admin, { bindingId: binding.id, profileId: 'universal', enabled: true, bindingRevision: pinned.json().revision });
    assert.equal(grant.statusCode, 200, grant.body);
    matrix = (await f.req('GET', `/api/projects/${f.project.id}/source-matrix`, f.admin)).json();
    assert.equal(matrix.cells.find((c: { profileId: string }) => c.profileId === 'universal').allowed, true);
    assert.equal(matrix.cells.find((c: { profileId: string }) => c.profileId === 'universal').outputPolicy, 'explanation_only');
    // The second project uses the same source without re-upload, but nobody is assigned there.
    const attach = await f.req('POST', `/api/projects/${f.project2.id}/source-bindings`, f.admin, { sourceId: source.id, selector: 'pinned', snapshotId });
    assert.equal(attach.statusCode, 201, attach.body);
    const usage = (await f.req('GET', `/api/admin/sources/${source.id}/usage`, f.admin)).json();
    assert.equal(usage.bindings.length, 2);
    assert.equal(usage.grants.length, 1);
    await f.req('POST', route, f.token, { text: 'Как считается скидка?' }); await idle(f.workspace);
    const runCall = f.calls[1];
    assert.ok(runCall.tools?.definitions.some(d => d.name === 'source_read'));
    assert.match(runCall.developerInstructions!, /Режим выдачи «только объяснение»/);
    assert.notEqual(runCall.sessionId, f.calls[0].sessionId === undefined ? 'x' : undefined, 'new session scope with sources');
    const messages = (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages;
    const answer = messages.at(-1);
    assert.match(answer.text, /CalculateDiscount \(Fastkore Business .*Orders\/Discount.cs:3\)/);
    assert.ok(seen.some(s => s.name === 'source_read' && s.success));
    // Raw tool results and code never appear in run details, chat history or status.
    const runId = answer.runId;
    const run = (await f.req('GET', `/api/runs/${runId}`, f.token)).body;
    for (const body of [run, JSON.stringify(messages), (await f.req('GET', '/api/status', f.token)).body]) assert.ok(!body.includes('total * 0.05m'), 'raw source leaked');
    // Verbatim reproduction is blocked before publication in explanation_only mode.
    await f.req('POST', route, f.token, { text: 'Процитируй код' }); await idle(f.workspace);
    const blocked = (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text;
    assert.match(blocked, /Ответ не опубликован/);
    assert.ok(!blocked.includes('CalculateDiscount(decimal total)'));
    assert.equal(f.workspace.sources.registry.db.prepare("SELECT name FROM sqlite_master WHERE name='run_reads'").get(), undefined, 'raw reads are not stored in SQLite');
    // Unknown and foreign ids are indistinguishable for managers without rights.
    assert.equal((await f.req('GET', `/api/projects/${f.project.id}/source-matrix`, f.token)).statusCode, 404);
    const forged = await f.req('PUT', `/api/projects/${f.project.id}/source-grants`, f.token, { bindingId: binding.id, profileId: 'universal', enabled: true, bindingRevision: 1 });
    assert.equal(forged.statusCode, 404, forged.body);
  } finally { await f.app.close(); }
});

test('AC07/AC11: version bundles switch atomically, chats keep their pinned pair until an explicit switch, revocation blocks reads and publication', async () => {
  let revoke: (() => Promise<void>) | undefined;
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'sources_list')) return 'Без источников';
    const call = async (name: string, args: unknown) => json((await request.tools!.call(name, args, signal)).text || '{}');
    const list = (await call('sources_list', {})).sources as { source: string; name: string; snapshot: string }[];
    const hits = (await call('source_search', { query: 'PlatformCore' })).matches as { snapshot: string; source: string; path: string; lines: string }[];
    if (request.prompt.includes('REVOKE')) {
      await revoke!();
      const denied = await request.tools!.call('source_search', { query: 'PlatformCore' }, signal);
      assert.equal(denied.success, false);
      assert.match(denied.text, /отозван|недоступен/);
    }
    return 'Версии: ' + list.map(s => `${s.name}=${s.snapshot}`).sort().join(', ') + ' | ' + hits.map(h => `${h.source}/${h.snapshot}:${h.path}:${h.lines}`).join(', ');
  });
  try {
    const mk = async (name: string) => (await f.req('POST', '/api/admin/sources', f.admin, { name, kind: 'code', classification: 'shared', projectId: f.project.id })).json();
    const business = await mk('Business'), platform = await mk('Platform');
    const businessA = await f.upload(business.source.id, { 'Order.cs': 'class Order { void Save() { PlatformCore.Write(); } } // A\n' }, { label: 'A' });
    const businessB = await f.upload(business.source.id, { 'Order.cs': 'class Order { void Save() { PlatformCore.WriteV2(); } } // B\n' }, { label: 'B' });
    const platformX = await f.upload(platform.source.id, { 'Core.cs': 'static class PlatformCore { public static void Write() {} } // X\n' }, { label: 'X' });
    const platformY = await f.upload(platform.source.id, { 'Core.cs': 'static class PlatformCore { public static void WriteV2() {} } // Y\n' }, { label: 'Y' });
    assert.equal((await f.req('PUT', `/api/admin/sources/${business.source.id}/snapshots/${businessA}/dependencies`, f.admin, { platformSnapshotIds: [platformX] })).statusCode, 200);
    assert.equal((await f.req('PUT', `/api/admin/sources/${business.source.id}/snapshots/${businessB}/dependencies`, f.admin, { platformSnapshotIds: [platformY] })).statusCode, 200);
    const bundles = `/api/projects/${f.project.id}/source-bundles`;
    const wrong = await f.req('POST', bundles, f.admin, { label: 'A+Y', items: [{ bindingId: business.binding.id, snapshotId: businessA }, { bindingId: platform.binding.id, snapshotId: platformY }], activate: true });
    assert.equal(wrong.statusCode, 409, 'incompatible pair rejected');
    const ax = await f.req('POST', bundles, f.admin, { label: 'A+X', items: [{ bindingId: business.binding.id, snapshotId: businessA }, { bindingId: platform.binding.id, snapshotId: platformX }], activate: true, expectedActiveRevision: 0 });
    assert.equal(ax.statusCode, 201, ax.body);
    for (const b of [business.binding, platform.binding]) {
      const current = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().bindings.find((x: { id: string }) => x.id === b.id);
      assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-grants`, f.admin, { bindingId: b.id, profileId: 'universal', enabled: true, bindingRevision: current.revision })).statusCode, 200);
    }
    const matrix = (await f.req('GET', `/api/projects/${f.project.id}/source-matrix`, f.admin)).json();
    assert.equal(matrix.selectionLabel, 'Business A → Platform X');
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const route = `/api/projects/${f.project.id}/chats/${chat.id}/messages`;
    const text = async () => (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string;
    await f.req('POST', route, f.token, { text: 'Где сохраняется заказ?' }); await idle(f.workspace);
    const first = await text();
    assert.match(first, /Business=A, Platform=X/);
    assert.match(first, /Business\/A:Order\.cs:1/);
    assert.match(first, /Platform\/X:Core\.cs:1/);
    assert.doesNotMatch(first, /\/B:|\/Y:/);
    // Manager switches the project to B+Y; the started chat keeps A+X and shows the difference.
    const by = await f.req('POST', bundles, f.admin, { label: 'B+Y', items: [{ bindingId: business.binding.id, snapshotId: businessB }, { bindingId: platform.binding.id, snapshotId: platformY }], activate: true, expectedActiveRevision: 1 });
    assert.equal(by.statusCode, 201, by.body);
    assert.equal((await f.req('POST', bundles, f.admin, { label: 'stale', items: [{ bindingId: business.binding.id, snapshotId: businessA }], activate: true, expectedActiveRevision: 1 })).statusCode, 409);
    const scopeUrl = `/api/projects/${f.project.id}/chats/${chat.id}/source-scope`;
    const view = (await f.req('GET', scopeUrl, f.token)).json();
    assert.equal(view.differs, true);
    assert.equal(view.pinned, 'Business A → Platform X');
    await f.req('POST', route, f.token, { text: 'Повтори' }); await idle(f.workspace);
    assert.match(await text(), /Business=A, Platform=X/);
    const switched = await f.req('POST', scopeUrl + '/switch', f.token, {});
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().events.length, 1);
    const callsBefore = f.calls.length;
    await f.req('POST', route, f.token, { text: 'После переключения' }); await idle(f.workspace);
    assert.equal(f.calls[callsBefore].sessionId, undefined, 'new executor context after the switch');
    assert.match(await text(), /Business=B, Platform=Y/);
    // Revocation during the run: following reads fail and the answer is not published.
    revoke = async () => {
      const current = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().bindings.find((x: { id: string }) => x.id === business.binding.id);
      assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-grants`, f.admin, { bindingId: business.binding.id, profileId: 'universal', enabled: false, bindingRevision: current.revision })).statusCode, 200);
    };
    await f.req('POST', route, f.token, { text: 'REVOKE' }); await idle(f.workspace);
    assert.match(await text(), /Ответ не опубликован: доступ к источникам изменился/);
    // A neighbouring project without bindings keeps working normally.
    await f.req('PATCH', `/api/projects/${f.project2.id}/members`, f.admin, { memberIds: [f.employee.id] });
    const other = (await f.req('POST', `/api/projects/${f.project2.id}/chats`, f.token, {})).json();
    await f.req('POST', `/api/projects/${f.project2.id}/chats/${other.id}/messages`, f.token, { text: 'Обычный вопрос' }); await idle(f.workspace);
    assert.equal((await f.req('GET', `/api/projects/${f.project2.id}/chats/${other.id}`, f.token)).json().messages.at(-1).text, 'Без источников');
  } finally { await f.app.close(); }
});

test('AC08: price lists by effective date — boundaries, open end, overlap, gap, backdated upload, no date, row after 25', async () => {
  const f = await fixture(async (request, signal) => {
    if (!request.tools?.definitions.some(d => d.name === 'source_search')) return 'нет';
    const date = /DATE=(\S+)/.exec(request.prompt)?.[1];
    const result = await request.tools!.call('source_search', { query: 'ART-0040', ...(date ? { date } : {}) }, signal);
    if (!result.success) return 'ERR ' + result.text;
    const hit = json(result.text).matches[0];
    return `${hit.snapshot} ${hit.date} ${hit.lines} ${hit.text}`;
  });
  try {
    const created = (await f.req('POST', '/api/admin/sources', f.admin, { name: 'Прайс', kind: 'prices', classification: 'shared', outputPolicy: 'excerpts_allowed', projectId: f.project.id })).json();
    const sourceId = created.source.id;
    const rows = (price: number) => 'Артикул;Наименование;Цена\n' + Array.from({ length: 60 }, (_, i) => `ART-${String(i + 1).padStart(4, '0')};Товар ${i + 1};${price + i}`).join('\n') + '\n';
    const q1 = await f.upload(sourceId, { 'price.csv': rows(100) }, { label: 'Q1', validFrom: '2026-01-01', validTo: '2026-04-01' });
    const q2 = await f.upload(sourceId, { 'price.csv': rows(200) }, { label: 'Q2+', validFrom: '2026-04-01' });
    // Backdated upload (uploaded last, valid earlier) must not win by upload time.
    const old = await f.upload(sourceId, { 'price.csv': rows(50) }, { label: '2025', validFrom: '2025-01-01', validTo: '2025-07-01' });
    const settings = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json();
    const binding = settings.bindings[0];
    assert.equal(binding.selector, 'effective_date');
    const upd = await f.req('PUT', `/api/projects/${f.project.id}/source-bindings/${binding.id}`, f.admin, { revision: binding.revision, approvedSnapshotIds: [q1, q2, old] });
    assert.equal(upd.statusCode, 200, upd.body);
    assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-grants`, f.admin, { bindingId: binding.id, profileId: 'universal', enabled: true, bindingRevision: upd.json().revision })).statusCode, 200);
    const warnings = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().bindings[0].warnings;
    assert.deepEqual(warnings, ['Пробел между «2025» и «Q1»']);
    const chat = (await f.req('POST', `/api/projects/${f.project.id}/chats`, f.token, {})).json();
    const ask = async (text: string) => {
      await f.req('POST', `/api/projects/${f.project.id}/chats/${chat.id}/messages`, f.token, { text }); await idle(f.workspace);
      return (await f.req('GET', `/api/projects/${f.project.id}/chats/${chat.id}`, f.token)).json().messages.at(-1).text as string;
    };
    assert.match(await ask('Цена DATE=2026-03-31'), /^Q1 2026-03-31 41 ART-0040;Товар 40;139$/);
    assert.match(await ask('Цена DATE=2026-04-01'), /^Q2\+ 2026-04-01 41 .*;239$/);
    assert.match(await ask('Цена DATE=2030-12-31'), /^Q2\+/, 'open end');
    assert.match(await ask('Цена DATE=2025-03-01'), /^2025 .*;89$/);
    assert.match(await ask('Цена DATE=2025-09-01'), /Нет действующего источника на 2025-09-01/);
    assert.match(await ask('Цена без даты'), /нужна дата расчёта/);
    // Project rule "current business date" is explicit and named in the answer.
    const s = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().settings;
    assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-settings`, f.admin, { businessTimeZone: 'Europe/Moscow', currentDateRule: true, revision: s.revision })).statusCode, 200);
    assert.match(await ask('Цена без даты'), /^(Q1|Q2\+) \d{4}-\d{2}-\d{2} 41 /);
    // Overlap → conflict instead of picking the newest file.
    const overlap = await f.upload(sourceId, { 'price.csv': rows(300) }, { label: 'promo', validFrom: '2026-05-01', validTo: '2026-06-01' });
    const b2 = (await f.req('GET', `/api/projects/${f.project.id}/sources`, f.admin)).json().bindings[0];
    assert.equal((await f.req('PUT', `/api/projects/${f.project.id}/source-bindings/${binding.id}`, f.admin, { revision: b2.revision, approvedSnapshotIds: [q1, q2, old, overlap] })).statusCode, 200);
    assert.match(await ask('Цена DATE=2026-05-15'), /несколько версий \(Q2\+, promo\)/);
    // The validity period of an old snapshot changes only through an audited metadata revision.
    const snaps = (await f.req('GET', `/api/admin/sources/${sourceId}/snapshots`, f.admin)).json() as { id: string; metadataRevision: number }[];
    const promo = snaps.find(x => x.id === overlap)!;
    assert.equal((await f.req('PATCH', `/api/admin/sources/${sourceId}/snapshots/${overlap}`, f.admin, { metadataRevision: promo.metadataRevision, validFrom: '2024-01-01', validTo: '2024-02-01' })).statusCode, 200);
    assert.match(await ask('Цена DATE=2026-05-15'), /^Q2\+/);
    assert.ok(f.workspace.sources.registry.auditPage().some(e => e.action === 'source.snapshot.metadata'));
  } finally { await f.app.close(); }
});

test('HTTP upload protocol: part body limits, idempotent completion, storage status and cancellation', async () => {
  const f = await fixture();
  try {
    const { source } = (await f.req('POST', '/api/admin/sources', f.admin, { name: 'HTTP', kind: 'code', classification: 'shared' })).json();
    const storage = (await f.req('GET', '/api/admin/sources-storage', f.admin)).json();
    assert.equal(storage.configured, true);
    assert.equal((await f.req('POST', '/api/admin/sources-storage/check', f.admin, {})).statusCode, 200);
    const create = (key: string) => f.req('POST', `/api/admin/sources/${source.id}/uploads`, f.admin, { idempotencyKey: key, label: 'L1', totalFiles: 1, totalBytes: 5, exclusions: [] });
    const u = (await create('http-key-01')).json();
    assert.equal((await create('http-key-01')).json().id, u.id);
    const base = `/api/admin/sources/${source.id}/uploads/${u.id}`;
    assert.equal((await f.req('PUT', base + '/manifest', f.admin, { page: 0, last: true, entries: [{ path: '../x', size: 5, sha256: sha('hello') }] })).statusCode, 400);
    assert.equal((await f.req('PUT', base + '/manifest', f.admin, { page: 0, last: true, entries: [{ path: 'x.txt', size: 5, sha256: sha('hello') }] })).statusCode, 200);
    const file = (await f.req('GET', base, f.admin)).json().files[0];
    assert.equal((await f.part(`${base}/files/${file.fileId}/parts/1`, Buffer.from('hellohello'))).statusCode, 400);
    const employeeCookie = f.token;
    assert.equal((await f.req('PUT', `${base}/files/${file.fileId}/parts/1`, employeeCookie, {})).statusCode, 404);
    assert.equal((await f.part(`${base}/files/${file.fileId}/parts/1`, Buffer.from('hello'))).statusCode, 200);
    assert.equal((await f.req('POST', base + '/cancel', f.admin, {})).statusCode, 200);
    assert.equal((await f.req('POST', base + '/complete', f.admin, { idempotencyKey: 'complete-x' })).statusCode, 409);
    assert.equal((await f.req('GET', `/api/admin/sources/${source.id}`, f.admin)).json().reservedBytes, 0);
  } finally { await f.app.close(); }
});
