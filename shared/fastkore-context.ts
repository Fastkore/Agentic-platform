const guidFields = ['entity_id', 'tile_id', 'catalog_id', 'folder_id', 'tree_parent_id', 'owner_entity_set_id', 'owner_entity_id', 'link_id'] as const;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export type FastkoreContext = {
  type: 'fastkore.context'; version: 1; view: 'card' | 'list' | 'link_list';
  entity_set_id: string; entity_set_name: string | null; filter_xml: string | null;
  filter_status: 'included' | 'none' | 'unavailable'; control_uid: string | null;
  deleted: boolean | null; scope_reproducible: boolean;
} & Record<typeof guidFields[number], string | null>;

export function isFastkoreContextMessage(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).type === 'fastkore.context';
}

export function isFastkoreContextReset(value: unknown): boolean {
  return isFastkoreContextMessage(value) && value.version === 1 && value.view === 'none';
}

export function parseFastkoreContext(value: unknown): FastkoreContext | null {
  if (!isFastkoreContextMessage(value) || value.version !== 1) return null;
  const { view, entity_set_id, filter_status, scope_reproducible } = value;
  if ((view !== 'card' && view !== 'list' && view !== 'link_list') || typeof entity_set_id !== 'string' || !guid.test(entity_set_id)
    || (filter_status !== 'included' && filter_status !== 'none' && filter_status !== 'unavailable') || typeof scope_reproducible !== 'boolean') return null;
  const entity_set_name = value.entity_set_name ?? null, filter_xml = value.filter_xml ?? null;
  const control_uid = value.control_uid ?? null, deleted = value.deleted ?? null;
  if (entity_set_name !== null && (typeof entity_set_name !== 'string' || entity_set_name.length > 200)) return null;
  if (control_uid !== null && (typeof control_uid !== 'string' || control_uid.length > 128)) return null;
  if (deleted !== null && typeof deleted !== 'boolean') return null;
  if (filter_status === 'included' ? typeof filter_xml !== 'string' || !filter_xml.trim() || new TextEncoder().encode(filter_xml).length > 32 * 1024 : filter_xml !== null) return null;

  const ids = {} as Record<typeof guidFields[number], string | null>;
  for (const field of guidFields) {
    const id = value[field] ?? null;
    if (id !== null && (typeof id !== 'string' || !guid.test(id))) return null;
    ids[field] = id?.toLowerCase() ?? null;
  }
  return { type: 'fastkore.context', version: 1, view, entity_set_id: entity_set_id.toLowerCase(), entity_set_name,
    filter_xml: filter_xml as string | null, filter_status, control_uid, deleted, scope_reproducible, ...ids };
}

export function fastkoreContextProblem(context: FastkoreContext): string | undefined {
  if (!context.scope_reproducible) return 'Область выборки Fastkore нельзя воспроизвести. Откройте обычный список или сохранённую карточку.';
  if (context.filter_status === 'unavailable') return 'Фильтр Fastkore недоступен. Откройте список с воспроизводимым фильтром или сохранённую карточку.';
  if (context.view === 'card' && !context.entity_id) return 'Сохраните карточку Fastkore перед отправкой запроса.';
}

export function fastkoreChatContextKey(context: FastkoreContext): string | undefined {
  const { view, entity_set_id, entity_id } = context;
  if (view === 'card') return entity_id ? JSON.stringify([1, view, entity_set_id, entity_id]) : undefined;
  if (!context.scope_reproducible || context.filter_status === 'unavailable') return;
  // A selected row does not change the contents of the list.
  return JSON.stringify([1, view, entity_set_id, context.tile_id, context.control_uid, context.catalog_id,
    context.folder_id, context.tree_parent_id, context.owner_entity_set_id, context.owner_entity_id, context.link_id,
    context.deleted, context.filter_status, context.filter_xml?.trim() ?? null]);
}
