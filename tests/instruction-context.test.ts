import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFastkoreContext } from '../shared/fastkore-context.js';
import { instructionTile } from '../shared/personal-instructions.js';
import { instructionComponent } from '../server/instruction-context.js';
import { editPersonalInstructions, withPersonalInstructions } from '../server/personal-instructions.js';
import { Store } from '../server/store.js';

test('role notes follow the component across tiles and match overlapping type GUIDs', async () => {
  const [componentId, otherComponent, purchase, sale, returns, claim] = Array.from({ length: 6 }, () => randomUUID());
  const type = (id: string, or = '') => `<EqualTo FirstValueDescriptor="[$Type]" SecondValue="${id}"${or}/>`;
  const list = (entitySetId: string, condition: string) => {
    const selection = parseFastkoreContext({
      type: 'fastkore.context', version: 1, view: 'list', entity_set_id: entitySetId, entity_set_name: 'Заказы', entity_ids: [],
      tile_id: randomUUID(), tile_name: 'Рабочий список', scope_reproducible: true, filter_status: 'included',
      filter_xml: `<?xml version="1.0"?><EntitySetFilter EntitySetGuid="${entitySetId}">${condition}</EntitySetFilter>`,
    });
    assert.ok(selection);
    return selection;
  };
  const selection = list(componentId, `<IsAnyOf FirstValueDescriptor="[$Type]"><Values>${[purchase, sale, returns, claim]
    .map(id => '<Value>' + id + '</Value>').join('')}</Values></IsAnyOf>`);
  const component = instructionComponent(selection)!;
  assert.deepEqual(component.typeIds, [purchase, sale, returns, claim].sort());
  assert.deepEqual(instructionComponent(list(componentId, `<Group>${type(purchase)}${type(returns, ' Or="True"')}</Group>${type(purchase)}`))?.typeIds, [purchase]);
  assert.equal(instructionComponent(list(componentId, type(purchase) + `<EqualTo Or="True" FirstValueDescriptor="[Other]" SecondValue="${returns}"/>`))?.typeIds, undefined);
  assert.equal(instructionComponent(list(componentId, `<NotEqualTo FirstValueDescriptor="[$Type]" SecondValue="${sale}"/>`))?.typeIds, undefined);

  const store = new Store(await mkdtemp(path.join(tmpdir(), 'bridge-instruction-context-')));
  try {
    const erp = { kind: 'erp' as const, id: 'installation', label: 'Fastkore' };
    const tools = (userId: string, roleId: string, selectionContext = selection) => withPersonalInstructions(
      undefined, store, userId, { erp, component: instructionComponent(selectionContext) },
      () => {}, () => false, { roleId, tile: instructionTile(selectionContext) },
    );
    const call = (executor: ReturnType<typeof tools>, args: unknown) => executor.call('my_instructions', args, new AbortController().signal);
    const remember = await call(tools('author', 'accounting'), { action: 'remember', title: 'Проверка отчёта', text: 'Сверить итог.', scope: 'erp' });
    assert.equal(remember.success, true, remember.text);
    const note = store.personalInstructions('author').notes[0];
    assert.deepEqual(note.component, component);
    assert.equal(note.tile?.tileName, 'Рабочий список');
    const otherTile = list(componentId, type(purchase));
    assert.notEqual(instructionTile(otherTile)?.tileId, note.tile?.tileId);
    const read = async (roleId: string, context = otherTile) => (await call(tools('colleague', roleId, context), { action: 'read', noteId: note.id })).success;
    const card = parseFastkoreContext({ ...otherTile, view: 'card', entity_ids: [randomUUID()],
      filter_xml: null, filter_status: 'none', entity_type_ids: [purchase.toUpperCase()] });
    assert.ok(card);
    assert.deepEqual(instructionComponent(card)?.typeIds, [purchase]);
    assert.equal(await read('accounting', card), true);
    assert.equal(await read('accounting'), true);
    assert.equal(await read('production'), false);
    assert.equal(await read('accounting', list(otherComponent, type(purchase))), false);
    assert.equal(await read('accounting', list(componentId, type(randomUUID()))), false);
    assert.equal(await read('accounting', list(componentId, '<Group/>')), true);
    assert.equal(await read('production', list(componentId, '<Group/>')), false);
    const document = store.personalInstructions('author');
    const edit = { ...document, notes: [{ id: note.id, title: note.title, text: note.text, common: true }] };
    assert.throws(() => editPersonalInstructions(store, 'author', edit, {}), /администратору/);
    editPersonalInstructions(store, 'author', edit, {}, { admin: true });
    assert.equal(await read('production', otherTile), true);
    assert.equal(await read('production', list(otherComponent, type(purchase))), false);
  } finally { await store.close(); }
});
