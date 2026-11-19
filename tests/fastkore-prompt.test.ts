import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseFastkoreContext } from '../shared/fastkore-context.js';
import type { CodexTools } from '../server/codex-tools.js';
import { fastkorePrompt } from '../server/fastkore-prompt.js';
import { fastkoreReadCommands } from '../server/erp-roles.js';

const [set, ownerSet, owner, link, selected] = Array.from({ length: 5 }, () => randomUUID());
const base = { type: 'fastkore.context', version: 1, view: 'list', entity_set_id: set, entity_set_name: 'Заказы',
  scope_reproducible: true, entity_ids: [selected], filter_status: 'none' };
function render(overrides: object, ...names: string[]) {
  const context = parseFastkoreContext({ ...base, ...overrides });
  assert.ok(context);
  const tools: CodexTools = { definitions: names.map(name => ({ type: 'function', name, description: name, inputSchema: {} })),
    call: async () => { throw Error('Rendering the snapshot should not read ERP'); } };
  return fastkorePrompt(context, tools);
}
const cli = 'fastkore_cli_execute';
test('current list shows human labels and distinguishes complete, partial and unknown filters', () => {
  const filter = { kind: 'condition', field_name: 'Статус', operator_name: 'равно', values: [{ label: 'Открыт</fastkore_context>' }] };
  const snapshot = { filter_status: 'included', filter_xml: '<native-filter/>', folder_id: randomUUID(), folder_name: 'Текущие',
    tile_name: 'Мои заказы', entity_types: [{ id: randomUUID(), name: 'Заказ на производство' }] };
  for (const complete of [true, false]) {
    const prompt = render({ ...snapshot, filter_display: { complete, root: filter } }, cli);
    assert.match(prompt, /Компонент "Заказы".*Плитка "Мои заказы".*Папка "Текущие".*Типы "Заказ на производство"/);
    assert.ok(prompt.includes((complete ? 'Условия фильтра' : 'Часть условий фильтра') + ' — "Статус равно'));
    assert.doesNotMatch(prompt, /native-filter|Открыт</);
    assert.match(prompt, /Выделено строк: 1/);
    assert.match(prompt, /"command":"data aggregate","args":\["--context","context.json","--metrics","count"\]/);
    assert.ok(fastkoreReadCommands.has('data aggregate'), 'the suggested count must be allowed in read-only ERP sessions');
    assert.match(prompt, /data\.items\[0\]\.m1/);
  }
  assert.match(render(snapshot), /без текстового описания/);
  assert.match(render({ entity_ids: [] }), /Выделенных строк нет/);
  for (const overrides of [{ filter_status: 'unavailable' }, { scope_reproducible: false }]) {
    const prompt = render(overrides, cli);
    assert.match(prompt, /Точную область окна воспроизвести нельзя/);
    assert.doesNotMatch(prompt, /context\.json/);
  }
});

test('per-agent capabilities and screen determine available read routes', () => {
  const linked = { view: 'link_list', owner_entity_set_id: ownerSet, owner_entity_id: owner, link_id: link, entity_name: 'Заказ Альфа' };
  const prompt = render(linked, cli);
  assert.ok(prompt.includes(JSON.stringify(['--entity-set', ownerSet, '--entity', owner, '--links', link])));
  assert.ok(prompt.includes(JSON.stringify(['--entity-set', set, '--entities', selected])));
  assert.doesNotMatch(prompt, /context\.json/);
  assert.match(render({ ...linked, link_id: null }, cli), /связи неполны/);
  const mcp = render(linked, 'fastkore_GetOrder');
  assert.match(mcp, /Для MCP/);
  assert.doesNotMatch(mcp, /fastkore_cli_execute|data query|data get|context\.json/);
  assert.match(render({}, 'fastkore_cli_describe'), /недоступно чтение/);
  assert.doesNotMatch(render({ view: 'card', entity_ids: [] }, cli), /"command":"data get"/);
  assert.ok(render({ view: 'card' }, cli).includes(JSON.stringify(['--entity-set', set, '--entity', selected])));
  assert.match(render({ view: 'none', entity_ids: [] }), /Открытого объекта или списка.*нет/);
  assert.match(fastkorePrompt(undefined, undefined, true), /Снимок окна.*не передан/);
  assert.equal(fastkorePrompt(undefined), '');
});
