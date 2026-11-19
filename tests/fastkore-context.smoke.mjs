// After building the server, run with BRIDGE_EXECUTION=isolated, BRIDGE_CODEX_SOCKET and FASTKORE_TEST_MODEL
// on a host with access to the test model worker. ERP commands use only this fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RemoteCodexRunner } from '../dist/server/codex-remote.js';
import { Workspace } from '../dist/server/workspace.js';
import { Store } from '../dist/server/store.js';
import { FilesystemLibraryBlobStore } from '../dist/server/library/blob-store.js';
import { formatFastkoreCliResult, withFastkoreCliCommands } from '../dist/server/fastkore-cli-tools.js';
import { parseFastkoreContext } from '../dist/shared/fastkore-context.js';

const model = process.env.FASTKORE_TEST_MODEL;
assert.ok(model && process.env.BRIDGE_CODEX_SOCKET);
const root = await mkdtemp(path.join(tmpdir(), 'fastkore-context-smoke-'));
const store = new Store(path.join(root, 'data'));
const user = { id: randomUUID(), name: 'Анна', role: 'employee', roleId: 'employee', disabled: false };
const role = { id: randomUUID(), name: 'Отдел продаж' };
const credential = { id: randomUUID(), userId: user.id, source: 'fastkore', installationId: randomUUID(),
  externalUserId: randomUUID(), externalRoles: [role], externalDisplayName: user.name };
store.state.security = { users: [user], credentials: [credential], audit: [] };
const workspace = new Workspace(store, new RemoteCodexRunner(process.env.BRIDGE_CODEX_SOCKET));
workspace.useLibraryStorage({ store: new FilesystemLibraryBlobStore(path.join(root, 'library-objects')) });
const project = await workspace.addProject(root, 'Проверка заказов');
project.rolePolicy = { revision: 1, roles: [{ roleId: role.id, installationId: credential.installationId }] };
await workspace.settings({ reasoningEffort: 'low' });
const [orderSet, itemSet, link, folder] = Array.from({ length: 4 }, randomUUID);
const orders = [
  ['Альфа', 120, 'В работе', 4], ['Бета', 350, 'В работе', 1],
  ['Гамма', 210, 'В работе', 2], ['Дельта', 180, 'Закрыт', 3],
].map(([name, amount, status, count], i) => ({ id: '00000000-0000-4000-8000-00000000000' + (4 - i), name, amount, status,
  items: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), name: 'Позиция ' + (i + 1) })) }));
const selected = [orders[0], orders[2]];
const base = { type: 'fastkore.context', version: 1, scope_reproducible: true };
const list = parseFastkoreContext({ ...base, view: 'list', entity_set_id: orderSet, entity_set_name: 'Заказы',
  folder_id: folder, folder_name: 'Заказы в работе', filter_status: 'included', filter_xml: '<Status>В работе</Status>',
  filter_display: { complete: true, root: { kind: 'condition', field_name: 'Статус', operator_name: 'равно', values: [{ label: 'В работе' }] } },
  entity_ids: selected.map(row => row.id) });
const positions = parseFastkoreContext({ ...base, view: 'link_list', entity_set_id: itemSet, entity_set_name: 'Позиции заказа',
  owner_entity_set_id: orderSet, owner_entity_id: orders[0].id, entity_name: orders[0].name, link_id: link,
  entity_ids: [orders[0].items[0].id], filter_status: 'none' });
assert.ok(list && positions);
const commands = {
  'data aggregate': 'Считает все доступные строки обычного списка по --context context.json --metrics count. Результат в items[0].m1.',
  'data query': '--context context.json применяет область обычного списка. --page-size включает постраничное чтение. --after продолжает с nextCursor.',
  'data get': 'Читает записи по --entity-set и --entity или --entities (GUID через запятую). Для связи владельца передай --links.',
};
const row = ({ id, name, amount, status }) => ({ id, name, amount, status });
const testCases = [
  { question: 'Сколько во всём списке?', context: list, expected: /3|три/i,
    check: reads => assert.deepEqual(reads, ['aggregate']) },
  { question: 'Сколько во всём списке?', context: list, oldCli: true, expected: /3|три/i,
    check: reads => assert.deepEqual(reads, ['unsupported', 'list:0', 'list:2']) },
  { question: 'Сравни выделенные', context: list, expected: /(?=.*Альф[а-яё]*)(?=.*Гамм[а-яё]*)(?=.*120)(?=.*210)/is,
    check: reads => assert.deepEqual([...new Set(reads)].sort(), selected.map(order => order.id).sort()) },
  { question: 'Сколько позиций у этого заказа?', context: positions, expected: /4|четыре/i,
    check: reads => assert.deepEqual(reads, ['items:' + orders[0].id]) },
  { question: 'Сколько позиций у этого заказа?', context: positions, mcpOnly: true, expected: /4|четыре/i,
    check: reads => assert.deepEqual(reads, ['mcp:' + orders[0].id]) },
  { question: 'Какой срок согласования принят в компании и какой установлен для пилота нашего проекта?', context: list,
    materials: true, expected: /(?=.*(?:72|семьдесят два))(?=.*(?:18|восемнадцать))/is, check: reads => assert.deepEqual(reads, []) },
];

for (const { question, context, expected, check, oldCli, mcpOnly, materials } of testCases) {
  const reads = [];
  const catalog = oldCli ? { ...commands, 'data aggregate': 'Требуется --entity-set. Параметр --context не поддерживается.' } : commands;
  const tools = withFastkoreCliCommands({ definitions: [], call: async () => ({ success: false, text: 'Неизвестный инструмент' }) },
    async () => catalog, async command => catalog[command],
    async (command, args, _signal, fields, maxResponseChars) => {
      const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
      const success = data => formatFastkoreCliResult({ success: true, exitCode: 0, data }, command, fields, maxResponseChars);
      if (command === 'data aggregate') {
        if (oldCli) {
          reads.push('unsupported');
          return { success: false, text: catalog[command] };
        }
        if (context.view !== 'list' || option('--context') !== 'context.json' || option('--metrics') !== 'count' ||
          option('--entity-set') || option('--filter') || option('--group-by')) throw Error('Ожидался count по области окна.');
        reads.push('aggregate');
        return success({ items: [{ m1: orders.filter(order => order.status === 'В работе').length }], count: 1, complete: true, truncated: false });
      }
      if (command === 'data query') {
        const scoped = option('--context') === 'context.json' && context.view === 'list';
        const rows = scoped ? orders.filter(order => order.status === 'В работе') : orders;
        if (!option('--page-size')) {
          reads.push('limited');
          return success({ items: rows.slice(0, 2).map(row), count: Math.min(rows.length, 2), hasMore: rows.length > 2 });
        }
        const after = option('--after');
        const previous = rows.findIndex(order => order.id === after);
        if (after && previous < 0) return { success: false, text: 'Неизвестный курсор.' };
        const offset = previous + 1;
        reads.push((scoped ? 'list:' : 'component:') + offset);
        const items = rows.slice(offset, offset + 2).map(row);
        const hasMore = offset + items.length < rows.length;
        return success({ items, count: items.length, hasMore, nextCursor: hasMore ? items.at(-1).id : null });
      }
      if (command === 'data get' && option('--entity-set') === orderSet) {
        const ids = (option('--entity') ?? option('--entities') ?? '').split(',');
        const found = orders.filter(order => ids.includes(order.id));
        if (option('--links') === link) {
          reads.push(...found.map(order => 'items:' + order.id));
          return success(found.map(order => ({ ...row(order), items: order.items, hasMore: false })));
        }
        reads.push(...ids);
        return success(found.map(row));
      }
      return { success: false, text: 'Проверь команду и её параметры.' };
    }, () => {});
  const mcp = { definitions: [{ type: 'function', name: 'fastkore_GetOrder', description: 'Читает заказ по его GUID со всеми позициями.',
    inputSchema: { type: 'object', properties: { guid: { type: 'string' } }, required: ['guid'], additionalProperties: false } }],
    async call(name, args) {
      const order = orders.find(order => order.id === args.guid);
      reads.push('mcp:' + args.guid);
      return order && name === 'fastkore_GetOrder' ? { success: true, text: JSON.stringify(order) } : { success: false, text: 'Заказ не найден' };
    } };
  workspace.prepareFastkoreTools = async () => ({ tools: mcpOnly ? mcp : tools });
  try {
    if (materials) {
      await workspace.knowledge.upload('company', 'Согласование.txt', Buffer.from('Общий срок согласования компании составляет 72 часа.'), () => {});
      await workspace.addProjectFile(project.id, 'Пилот.txt', Buffer.from('Для пилота этого проекта действует срок согласования 18 часов.'), () => user.id);
      await workspace.importProjectFiles();
      await workspace.library.indexer.drain();
    }
    const chat = await workspace.addChat(project.id, question, model, user.id);
    const run = await workspace.send(project.id, chat.id, question, [], undefined, undefined, undefined,
      { id: user.id, name: user.name, credentialId: credential.id }, context);
    const deadline = Date.now() + 150_000;
    while (['running', 'queued'].includes(run.status) && Date.now() < deadline) await sleep(100);
    if (['running', 'queued'].includes(run.status)) await workspace.cancel(run.id);
    assert.equal(run.status, 'complete', run.error ?? run.progress);
    const response = chat.messages.at(-1).text;
    console.log(model, question, '\n', response, '\nЧтения:', reads);
    check(reads);
    assert.match(response, expected);
    if (question === 'Сравни выделенные') {
      // Keep price and name together even when the returned order differs from entity_ids.
      // Accept Russian case endings, Markdown tables and short prose.
      const rows = response.split('\n').filter(line => line.includes('|')).map(line => line.split('|').map(cell => cell.trim()));
      const columns = rows.find(cells => cells.some(cell => /альф/i.test(cell)) && cells.some(cell => /гамм/i.test(cell)));
      const amounts = rows.find(cells => cells.some(cell => /сумм/i.test(cell)) && cells.some(cell => /120|210/.test(cell)));
      if (columns && amounts) {
        assert.match(amounts[columns.findIndex(cell => /альф/i.test(cell))], /\b120\b/);
        assert.match(amounts[columns.findIndex(cell => /гамм/i.test(cell))], /\b210\b/);
      } else {
        const parts = response.split(/(?=альф|гамм)/i);
        assert.ok(parts.some(part => /^альф/i.test(part) && part.match(/\b(120|210)\b/)?.[0] === '120'), 'Альфа — 120');
        assert.ok(parts.some(part => /^гамм/i.test(part) && part.match(/\b(120|210)\b/)?.[0] === '210'), 'Гамма — 210');
      }
    }
    if (materials) assert.ok(run.timing.tools.knowledge?.calls, 'Общий срок должен быть проверен по базе компании');
  } catch (error) {
    console.error(question, error.message);
    process.exitCode = 1;
  }
}
await workspace.shutdown();
await rm(root, { recursive: true, force: true });
