import { parseFilterDisplay, type FastkoreFilterDisplay } from './fastkore-filter-display.js';

const guidFields = ['tile_id', 'catalog_id', 'folder_id', 'tree_parent_id', 'owner_entity_set_id', 'owner_entity_id', 'link_id'] as const;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxSelection = 2000;

type ContextHeader = { type: 'fastkore.context'; version: 1 | 2; entity_ids: string[]; chat_key?: string | null };
export type FastkoreEntityContext = ContextHeader & {
  view: 'card' | 'list' | 'link_list'; entity_set_id: string; entity_set_name: string | null; filter_xml: string | null;
  entity_name?: string;
  entity_uri?: string;
  tile_name?: string;
  entity_type_ids?: string[];
  entity_types?: { id: string; name: string }[];
  folder_name?: string;
  catalog_name?: string;
  catalog_kind?: 'stored' | 'link' | null;
  folder_kind?: 'custom' | 'search' | 'link' | null;
  catalog_link_path?: string[];
  catalog_link_names?: string[];
  folder_entity_set_id?: string | null;
  filter_display?: FastkoreFilterDisplay;
  filter_status: 'included' | 'none' | 'unavailable'; control_uid: string | null;
  deleted: boolean | null; scope_reproducible: boolean;
} & Record<typeof guidFields[number], string | null>;
export type FastkoreContext = FastkoreEntityContext | (ContextHeader & { view: 'none' });

export function isFastkoreContextMessage(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).type === 'fastkore.context';
}

export function parseFastkoreContext(value: unknown): FastkoreContext | null {
  if (!isFastkoreContextMessage(value) || (value.version !== 1 && value.version !== 2)) return null;
  const { view, entity_set_id, filter_status, scope_reproducible } = value;
  if (value.version === 2 && view !== 'list') return null;
  const modern = Object.hasOwn(value, 'chat_key');
  if (modern && (value.chat_key !== null && typeof value.chat_key !== 'string' || Object.hasOwn(value, 'entity_id'))) return null;
  if (modern && !Array.isArray(value.entity_ids)) return null;
  const legacyId = value.entity_id;
  const selected = Object.hasOwn(value, 'entity_ids') ? value.entity_ids : (legacyId == null ? [] : [legacyId]);
  if (!Array.isArray(selected) || selected.length > maxSelection || selected.some(id => typeof id !== 'string' || !guid.test(id))) return null;
  const entity_ids = [...new Set<string>(selected.map(id => id.toLowerCase()))].sort();
  const header: ContextHeader = { type: 'fastkore.context', version: value.version, entity_ids };
  if (modern) header.chat_key = typeof value.chat_key === 'string' ? value.chat_key.toLowerCase() : null;
  if (view === 'none') {
    if (entity_ids.length || (modern && header.chat_key !== 'home')) return null;
    return { ...header, view };
  }
  if ((view !== 'card' && view !== 'list' && view !== 'link_list') || typeof entity_set_id !== 'string' || !guid.test(entity_set_id)
    || (filter_status !== 'included' && filter_status !== 'none' && filter_status !== 'unavailable') || typeof scope_reproducible !== 'boolean') return null;
  if (view === 'card' && entity_ids.length > 1) return null;
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
  const setId = entity_set_id.toLowerCase();
  const catalog: Pick<FastkoreEntityContext, 'catalog_name' | 'catalog_kind' | 'folder_kind' | 'catalog_link_path' | 'catalog_link_names' | 'folder_entity_set_id'> = {};
  if (value.version === 2) {
    if (view !== 'list' || value.catalog_kind !== 'link' || !ids.catalog_id || ids.link_id || ids.owner_entity_set_id || ids.owner_entity_id ||
      !Array.isArray(value.catalog_link_path) || !value.catalog_link_path.length || value.catalog_link_path.length > 32 ||
      value.catalog_link_path.some(id => typeof id !== 'string' || !guid.test(id)) ||
      !['folder_id', 'folder_kind', 'folder_entity_set_id'].every(field => Object.hasOwn(value, field))) return null;
    const folderSet = value.folder_entity_set_id;
    if (ids.folder_id ? value.folder_kind !== 'link' || typeof folderSet !== 'string' || !guid.test(folderSet)
      : value.folder_kind !== null || folderSet !== null) return null;
    catalog.catalog_kind = 'link';
    catalog.catalog_link_path = value.catalog_link_path.map(id => id.toLowerCase());
    catalog.folder_kind = ids.folder_id ? 'link' : null;
    catalog.folder_entity_set_id = typeof folderSet === 'string' ? folderSet.toLowerCase() : null;
    if (value.catalog_link_names != null) {
      if (!Array.isArray(value.catalog_link_names) || value.catalog_link_names.length > 32 ||
        value.catalog_link_names.some(name => typeof name !== 'string' || name.length > 200)) return null;
      catalog.catalog_link_names = value.catalog_link_names.map(name => contextName(name) ?? '');
    }
  } else {
    if (value.catalog_kind != null && value.catalog_kind !== 'stored' || value.folder_kind != null && !['custom', 'search'].includes(String(value.folder_kind))) return null;
    if (Object.hasOwn(value, 'catalog_kind')) catalog.catalog_kind = value.catalog_kind as 'stored' | null;
    if (Object.hasOwn(value, 'folder_kind')) catalog.folder_kind = value.folder_kind as 'custom' | 'search' | null;
  }
  const catalogName = contextName(value.catalog_name);
  if (catalogName) catalog.catalog_name = catalogName;
  if (modern) {
    const expected = view === 'card' ? (entity_ids[0] ? `card:${setId}:${entity_ids[0]}` : null)
      : view === 'list' ? (ids.tile_id ? `tile:${ids.tile_id}` : `list:${setId}`)
      : ids.owner_entity_set_id && ids.owner_entity_id ? `card:${ids.owner_entity_set_id}:${ids.owner_entity_id}` : null;
    if (header.chat_key !== null && header.chat_key !== expected) return null;
  }
  const entityName = view === 'card' || (view === 'link_list' && ids.owner_entity_set_id && ids.owner_entity_id)
    ? contextName(value.entity_name) : undefined;
  const tileName = view !== 'card' ? contextName(value.tile_name) : undefined;
  const rawTypeIds = value.entity_type_ids;
  if (rawTypeIds !== undefined && rawTypeIds !== null &&
    (!Array.isArray(rawTypeIds) || rawTypeIds.length > 128 || rawTypeIds.some(id => typeof id !== 'string' || !guid.test(id)))) return null;
  const namedTypes = new Map<string, string>();
  if (Array.isArray(value.entity_types) && value.entity_types.length <= 128) {
    for (const item of value.entity_types) {
      if (typeof item?.id === 'string' && guid.test(item.id)) namedTypes.set(item.id.toLowerCase(), contextName(item.name) ?? '');
    }
  }
  const typeIds = [...new Set<string>(namedTypes.size ? namedTypes.keys() : Array.isArray(rawTypeIds) ? rawTypeIds.map(id => id.toLowerCase()) : [])].sort();
  const entityTypes = typeIds.flatMap(id => namedTypes.get(id) ? [{ id, name: namedTypes.get(id)! }] : []);
  const folderName = ids.folder_id ? contextName(value.folder_name) : undefined;
  const filterDisplay = filter_status === 'included' ? parseFilterDisplay(value.filter_display) : undefined;
  const entityUri = view === 'card' ? entityNavigationUri(value.entity_uri, setId, entity_ids[0])
    : view === 'link_list' ? entityNavigationUri(value.entity_uri, ids.owner_entity_set_id, ids.owner_entity_id) : undefined;
  return { ...header, view, entity_set_id: setId, entity_set_name, ...(entityName ? { entity_name: entityName } : {}), ...(tileName ? { tile_name: tileName } : {}),
    ...(entityUri ? { entity_uri: entityUri } : {}),
    ...(typeIds.length ? { entity_type_ids: typeIds } : {}),
    ...(entityTypes.length ? { entity_types: entityTypes } : {}),
    ...(folderName ? { folder_name: folderName } : {}),
    ...(filterDisplay ? { filter_display: filterDisplay } : {}),
    filter_xml: filter_xml as string | null, filter_status, control_uid, deleted, scope_reproducible, ...ids, ...catalog };
}

export function fastkoreExecutionContext(context?: FastkoreContext) {
  if (!context || context.view === 'none') return context;
  const { entity_uri, filter_display, ...execution } = context;
  return execution;
}

function entityNavigationUri(value: unknown, setId: string | null, entityId: string | null | undefined) {
  if (!setId || !entityId || typeof value !== 'string' || value.length > 2048 || !/^fastkore:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!url.hostname || url.username || url.password || url.hash || !/^\/(?:[^/]+\/)?ShowEntity$/i.test(url.pathname)) return;
  const args = [...url.searchParams].map(([name, value]) => [name.toLowerCase(), value.toLowerCase()]);
  const sets = args.filter(([name]) => name === 'entityset');
  const entities = args.filter(([name]) => name === 'entity');
  if (sets.length === 1 && entities.length === 1 && sets[0][1] === setId && entities[0][1] === entityId) return value;
}

function contextName(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120).trimEnd() || undefined : undefined;
}

export function fastkoreChatTitle(context?: FastkoreContext) {
  if (!context || context.view === 'none') return;
  if (context.view === 'card') return context.entity_name;
  if (context.view === 'link_list' && context.entity_name) return context.entity_name;
  return context.tile_name ?? contextName(context.entity_set_name);
}

export function fastkoreContextProblem(context: FastkoreContext): string | undefined {
  if (context.view === 'none') return;
  if (!context.scope_reproducible) return 'Область выборки Fastkore нельзя воспроизвести. Откройте обычный список или сохранённую карточку.';
  if (context.filter_status === 'unavailable') return 'Фильтр Fastkore недоступен. Откройте список с воспроизводимым фильтром или сохранённую карточку.';
  if (context.view === 'card' && !context.entity_ids.length) return 'Карточка ещё не сохранена. Читать её через Fastkore пока нельзя.';
}

export function isFastkoreTileList(context: FastkoreContext): context is FastkoreEntityContext & { view: 'list'; tile_id: string } {
  return context.view === 'list' && !!context.tile_id;
}

export function fastkoreSelectionChatKey(context: FastkoreContext): string | undefined {
  if (context.view === 'none') return;
  const { view, entity_set_id, entity_ids } = context;
  if (view === 'card') return entity_ids[0] ? JSON.stringify([1, view, entity_set_id, entity_ids[0]]) : undefined;
  if (!context.scope_reproducible || context.filter_status === 'unavailable') return;
  // A selected row does not change the contents of the list.
  return JSON.stringify([1, view, entity_set_id, context.tile_id, context.control_uid, context.catalog_id,
    context.folder_id, context.tree_parent_id, context.owner_entity_set_id, context.owner_entity_id, context.link_id,
    context.deleted, context.filter_status, context.filter_xml?.trim() ?? null,
    ...(context.version === 2 ? [context.catalog_link_path, context.folder_entity_set_id] : [])]);
}

export function fastkoreChatContextKey(context: FastkoreContext): string | undefined {
  if (context.chat_key !== undefined) return context.chat_key ?? undefined;
  if (context.view === 'none') return;
  if (context.view === 'list') {
    // The tile identifies the conversation; the full snapshot still identifies each query.
    return JSON.stringify(context.tile_id ? [2, 'list', context.entity_set_id, context.tile_id] : [2, 'list', context.entity_set_id]);
  }
  return fastkoreSelectionChatKey(context);
}
