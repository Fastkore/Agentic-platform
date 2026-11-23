import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fastkoreChatContextKey, fastkoreExecutionContext, fastkoreSelectionChatKey, parseFastkoreContext } from '../shared/fastkore-context.js';
import { fastkorePrompt } from '../server/fastkore-prompt.js';
import { fastkoreReadCommands } from '../server/erp-roles.js';

test('linked catalogs preserve folder scope and ordered links while sharing the tile chat', () => {
  const [set, tile, catalog, folder, folderSet, firstLink, secondLink] = Array.from({ length: 7 }, () => randomUUID());
  const raw = { type: 'fastkore.context', version: 2, view: 'list', entity_set_id: set, entity_set_name: 'Обращения',
    entity_ids: [], tile_id: tile, chat_key: 'tile:' + tile, catalog_id: catalog, catalog_kind: 'link', catalog_name: 'Контрагенты',
    catalog_link_path: [secondLink, firstLink], catalog_link_names: ['Контрагент', 'Группа'], folder_kind: 'link', folder_id: folder,
    folder_entity_set_id: folderSet, folder_name: 'МЕДЕЛИЯ', filter_status: 'none', filter_xml: null, scope_reproducible: true, deleted: null };
  const context = parseFastkoreContext(raw);
  assert.ok(context && context.view === 'list');
  const execution = fastkoreExecutionContext(context);
  assert.ok(execution && execution.view === 'list');
  assert.equal(execution.version, 2);
  assert.deepEqual(execution.catalog_link_path, [secondLink, firstLink]);
  assert.equal(execution.folder_entity_set_id, folderSet);
  assert.equal(execution.deleted, null);
  const root = parseFastkoreContext({ ...raw, folder_id: null, folder_kind: null, folder_entity_set_id: null });
  assert.ok(root && root.view === 'list');
  assert.equal(root.folder_name, undefined);
  assert.equal(fastkoreChatContextKey(root), fastkoreChatContextKey(context));
  assert.notEqual(fastkoreSelectionChatKey(root), fastkoreSelectionChatKey(context));
  assert.equal(parseFastkoreContext({ ...raw, folder_entity_set_id: undefined }), null);
  assert.equal(parseFastkoreContext({ ...raw, catalog_link_path: [] }), null);
  assert.equal(parseFastkoreContext({ ...raw, folder_id: null }), null);
  assert.equal(parseFastkoreContext({ ...raw, version: 1 }), null);
  const prompt = fastkorePrompt(context, { definitions: [{ type: 'function', name: 'fastkore_cli_execute', description: '', inputSchema: {} }], call: async () => { throw Error(); } });
  assert.match(prompt, /Каталог "Контрагенты"/);
  assert.match(prompt, /Папка "МЕДЕЛИЯ"/);
  assert.match(prompt, /Цепочка связей/);
  assert.match(prompt, /data aggregate/);
  assert.ok(fastkoreReadCommands.has('catalog tree'));
  const stored = parseFastkoreContext({ ...raw, version: 1, catalog_kind: 'stored', folder_kind: 'search', catalog_link_path: undefined });
  assert.ok(stored && stored.view === 'list');
  assert.equal(stored.catalog_kind, 'stored');
  assert.equal(stored.folder_kind, 'search');
});
