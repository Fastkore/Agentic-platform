import { redact } from './store.js';

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
