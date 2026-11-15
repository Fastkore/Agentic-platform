import type { RunToolContext } from '../shared/types.js';

const visibleCliCommands = new Set(['auth info', 'auth test', 'data get', 'data query', 'data aggregate',
  'schema entity-set show', 'schema entity-set list', 'schema property show', 'object show', 'agent describe', 'agent capabilities']);

export function describeToolContext(tool: string, args: unknown): RunToolContext | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const input = args as Record<string, unknown>;
  if (tool === 'fastkore_cli_data_query') {
    const scope = input.scope === 'erp' ? 'erp' : 'current';
    const pageSize = input.pageSize ?? (scope === 'current' ? 50 : undefined);
    return { scope,
      pageSize: typeof pageSize === 'number' && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 1000 ? pageSize : undefined,
      continuation: input.after ? true : undefined };
  }
  if (tool === 'fastkore_cli_data_get') {
    return { scope: input.scope === 'erp' ? 'erp' : 'current', selection: input.selection === true ? true : undefined };
  }
  if (tool === 'fastkore_cli_execute' || tool === 'fastkore_cli_command_describe' || tool === 'fastkore_cli_describe') {
    return typeof input.command === 'string' && visibleCliCommands.has(input.command) ? { operation: input.command } : undefined;
  }
}
