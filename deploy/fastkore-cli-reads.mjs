const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$(?![\s\S])/;
const only = (input, fields) => input && typeof input === 'object' && !Array.isArray(input) &&
  Object.keys(input).every(key => fields.includes(key));
const id = value => typeof value === 'string' && guid.test(value);
const ids = (list, max) => Array.isArray(list) && list.length > 0 && list.length <= max && list.every(id) && new Set(list).size === list.length;
const validText = value => typeof value === 'string' && !!value.trim() && value.length <= 8192 && !/[\x00\r\n]/.test(value) && !value.startsWith('--');
const fields = ['type','version','view','entity_set_id','entity_set_name','entity_ids','chat_key','tile_id','filter_status','filter_xml',
  'catalog_id','folder_id','tree_parent_id','deleted','scope_reproducible','owner_entity_set_id','owner_entity_id','link_id','control_uid'];

function listContext(value) {
  if (!only(value, fields) || value.type !== 'fastkore.context' || value.version !== 1 || value.view !== 'list' ||
    !id(value.entity_set_id) || value.scope_reproducible !== true || !Array.isArray(value.entity_ids) ||
    value.entity_ids.length > 2000 || !value.entity_ids.every(id) || ![null, false, true].includes(value.deleted) ||
    [value.owner_entity_set_id, value.owner_entity_id, value.link_id].some(field => field != null)) return false;
  if (value.entity_set_name != null && (typeof value.entity_set_name !== 'string' || value.entity_set_name.length > 200) ||
    value.control_uid != null && (typeof value.control_uid !== 'string' || value.control_uid.length > 128)) return false;
  if (['tile_id','catalog_id','folder_id','tree_parent_id'].some(key => value[key] != null && !id(value[key]))) return false;
  if (value.chat_key !== undefined && value.chat_key !== null && value.chat_key !== (value.tile_id ? `tile:${value.tile_id}` : `list:${value.entity_set_id}`)) return false;
  return value.filter_status === 'none' ? value.filter_xml == null
    : value.filter_status === 'included' && typeof value.filter_xml === 'string' && !!value.filter_xml.trim() && Buffer.byteLength(value.filter_xml) <= 32768;
}

export function readCommandOptions(operation, args, support) {
  const flags = ['--user-ticket-stdin', '--json'];
  if (operation === 'auth-info' && only(args, [])) return { argv: ['auth', 'info', ...flags] };
  if (operation === 'get' && only(args, ['entitySetId', 'entityId', 'properties']) && id(args.entitySetId) && id(args.entityId) &&
    (args.properties === undefined || ids(args.properties, 64))) {
    const argv = ['data', 'get', '--entity-set', args.entitySetId, '--entity', args.entityId];
    if (args.properties) argv.push('--properties', args.properties.join(','));
    return { argv: [...argv, ...flags] };
  }
  if (operation === 'query' && only(args, ['entitySetId', 'limit', 'filter']) && id(args.entitySetId) && Number.isInteger(args.limit) &&
    args.limit >= 1 && args.limit <= 50 && (args.filter === undefined || validText(args.filter))) {
    const argv = ['data', 'query', '--entity-set', args.entitySetId, '--limit', String(args.limit)];
    if (args.filter) argv.push('--filter', args.filter);
    return { argv: [...argv, ...flags] };
  }
  if (operation === 'get-many' && support.batchGet && only(args, ['entitySetId', 'entityIds', 'properties']) && id(args.entitySetId) &&
    ids(args.entityIds, 50) && (args.properties === undefined || ids(args.properties, 64))) {
    const argv = ['data', 'get', '--entity-set', args.entitySetId, '--entities', args.entityIds.join(',')];
    if (args.properties) argv.push('--properties', args.properties.join(','));
    return { argv: [...argv, ...flags] };
  }
  if (operation !== 'page' || !support.contextPaging || !only(args, ['context', 'entitySetId', 'filter', 'page'])) return;
  if (Object.hasOwn(args, 'context') ? !listContext(args.context) || Object.hasOwn(args, 'entitySetId') || Object.hasOwn(args, 'filter') :
    !id(args.entitySetId) || (args.filter !== undefined && !validText(args.filter))) return;
  const page = args.page;
  if (!only(page, ['pageSize','orderBy','descending','after','properties']) || !Number.isInteger(page.pageSize) || page.pageSize < 1 || page.pageSize > 1000 ||
    (page.orderBy !== undefined && !id(page.orderBy) && page.orderBy !== '$Created' && page.orderBy !== '$Modified') ||
    (page.descending !== undefined && typeof page.descending !== 'boolean') || (page.descending && !page.orderBy) ||
    (page.after !== undefined && !id(page.after)) || (page.properties !== undefined && !ids(page.properties, 64))) return;
  const argv = ['data', 'query', '--page-size', String(page.pageSize)];
  if (args.entitySetId) argv.push('--entity-set', args.entitySetId);
  if (args.filter) argv.push('--filter', args.filter);
  if (page.orderBy) argv.push('--order-by', page.orderBy);
  if (page.descending) argv.push('--descending');
  if (page.after) argv.push('--after', page.after);
  if (page.properties) argv.push('--properties', page.properties.join(','));
  return { argv: [...argv, ...flags], context: args.context };
}
