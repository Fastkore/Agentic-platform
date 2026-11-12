import { redact } from './store.js';
import type { FastkoreContext } from '../shared/fastkore-context.js';
import { uuid } from './fastkore.js';
import type { FastkoreCliRead } from './fastkore-cli.js';

export interface CodexToolDefinition {
  type: 'function'; name: string; description: string; inputSchema: Record<string, unknown>;
}
export interface CodexToolResult { success: boolean; text: string }
export interface CodexTools {
  definitions: CodexToolDefinition[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<CodexToolResult>;
}

export type FastkoreCliCommand = 'data-get' | 'data-query';

const cliDescribe: CodexToolDefinition = {
  type: 'function', name: 'fastkore_cli_describe',
  description: 'Показывает локальное описание команды чтения FastkoreCLI. Не читает ERP. Доступ к ERP через CLI требует пользовательского билета.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['command'],
    properties: { command: { type: 'string', enum: ['data get', 'data query'] } } },
};

export function withFastkoreCliDescription(tools: CodexTools, describe: (command: FastkoreCliCommand, signal: AbortSignal) => Promise<unknown>, authorize: () => void): CodexTools {
  return {
    definitions: [...tools.definitions, cliDescribe],
    async call(name, args, signal) {
      if (name !== cliDescribe.name) return tools.call(name, args, signal);
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined;
      if (!input || Object.keys(input).length !== 1 || (input.command !== 'data get' && input.command !== 'data query')) {
        return { success: false, text: 'Выберите описание data get или data query.' };
      }
      authorize();
      signal.throwIfAborted();
      const result = await describe(input.command === 'data get' ? 'data-get' : 'data-query', signal);
      authorize();
      signal.throwIfAborted();
      return { success: true, text: redact(JSON.stringify(result)) };
    },
  };
}

const entitySetId = { type: 'string', description: 'GUID набора данных Fastkore.' };
const cliGet: CodexToolDefinition = {
  type: 'function', name: 'fastkore_cli_data_get',
  description: 'Читает один объект Fastkore по известным GUID набора и объекта через CLI с правами текущего сотрудника.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['entitySetId', 'entityId'],
    properties: { entitySetId, entityId: { type: 'string', description: 'GUID объекта.' } } },
};
const cliQuery: CodexToolDefinition = {
  type: 'function', name: 'fastkore_cli_data_query',
  description: 'Читает ограниченное число объектов заданного набора Fastkore через CLI с правами текущего сотрудника. Укажите известный GUID набора.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['entitySetId'],
    properties: { entitySetId, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
};

function cliReadArgs(name: string, args: unknown): FastkoreCliRead | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const input = args as Record<string, unknown>;
  const setId = typeof input.entitySetId === 'string' && input.entitySetId.toLowerCase();
  if (!uuid(setId)) return;
  if (name === cliGet.name) {
    const entityId = typeof input.entityId === 'string' && input.entityId.toLowerCase();
    if (!uuid(entityId) || Object.keys(input).length !== 2) return;
    return { operation: 'get', entitySetId: setId, entityId };
  }
  if (Object.keys(input).some(key => key !== 'entitySetId' && key !== 'limit')) return;
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) return;
  return { operation: 'query', entitySetId: setId, limit };
}

export function withFastkoreCliReads(tools: CodexTools, context: FastkoreContext | undefined,
  read: (input: FastkoreCliRead, signal: AbortSignal) => Promise<CodexToolResult>): CodexTools {
  // This CLI interface cannot reproduce filter XML, links or folder restrictions.
  const allowGet = !context || (context.view === 'card' && context.scope_reproducible && !!context.entity_id);
  const allowQuery = !context || (context.view === 'list' && context.scope_reproducible && context.filter_status === 'none' &&
    [context.catalog_id, context.folder_id, context.tree_parent_id, context.owner_entity_set_id, context.owner_entity_id,
      context.link_id, context.deleted].every(value => value === null));
  return {
    definitions: [...tools.definitions, ...(allowGet ? [cliGet] : []), ...(allowQuery ? [cliQuery] : [])],
    async call(name, args, signal) {
      if (name !== cliGet.name && name !== cliQuery.name) return tools.call(name, args, signal);
      const input = cliReadArgs(name, args);
      if (!input) return { success: false, text: 'Укажите GUID набора и объекта или допустимый лимит выборки.' };
      if (context && (input.entitySetId !== context.entity_set_id ||
        (input.operation === 'get' && input.entityId !== context.entity_id)) ||
        (input.operation === 'get' ? !allowGet : !allowQuery)) {
        return { success: false, text: 'Fastkore CLI не может воспроизвести текущую область выборки ERP.' };
      }
      return read(input, signal);
    },
  };
}
