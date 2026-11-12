import { redact } from './store.js';
import type { CodexTools, CodexToolDefinition, CodexToolResult } from './codex-tools.js';

export function withFastkoreCliCommands(tools: CodexTools, catalog: () => Promise<unknown>,
  describe: (command: string, signal: AbortSignal) => Promise<unknown>,
  execute: (command: string, args: string[], signal: AbortSignal) => Promise<CodexToolResult>,
  authorize: () => void): CodexTools {
  const definitions: CodexToolDefinition[] = [
    { type: 'function', name: 'fastkore_cli_catalog', description: 'Каталог всех команд установленной Fastkore CLI с назначением и параметрами.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
    { type: 'function', name: 'fastkore_cli_command_describe', description: 'Офлайн-контракт любой команды Fastkore CLI. Прочитай перед первым использованием команды.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } },
    { type: 'function', name: 'fastkore_cli_execute',
      description: 'Выполняет команду CLI с правами текущего сотрудника ERP. command — имя из каталога, args — массив опций и значений. Рабочая папка cli общая для агента и CLI. Относительные пути отсчитываются от cli. Исходники source, бэкапы backups, временные файлы tmp. Каталог сохраняется между вопросами этого чата. Соединение и билет задаёт сервер. Изменения выполняй по явному запросу сотрудника, проверяй guards и результат. Не повторяй неуспешную запись автоматически.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command', 'args'],
        properties: { command: { type: 'string' }, args: { type: 'array', maxItems: 160, items: { type: 'string', maxLength: 32000 } } } } },
  ];
  return { definitions: [...tools.definitions, ...definitions], async call(name, args, signal) {
    if (!definitions.some(definition => definition.name === name)) return tools.call(name, args, signal);
    authorize(); signal.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { success: false, text: 'Укажите параметры CLI.' };
    const input = args as Record<string, unknown>;
    try {
      let result: unknown;
      if (name === 'fastkore_cli_catalog' && !Object.keys(input).length) result = await catalog();
      else if (name === 'fastkore_cli_command_describe' && Object.keys(input).length === 1 && typeof input.command === 'string') result = await describe(input.command, signal);
      else if (name === 'fastkore_cli_execute' && Object.keys(input).length === 2 && typeof input.command === 'string' &&
        Array.isArray(input.args) && input.args.length <= 160 && input.args.every(arg => typeof arg === 'string' && arg.length <= 32000)) {
        return await execute(input.command, input.args, signal);
      } else return { success: false, text: 'Проверьте имя команды и массив args.' };
      authorize(); signal.throwIfAborted();
      return { success: true, text: redact(JSON.stringify(result)) };
    } catch (error) {
      return { success: false, text: error instanceof Error ? redact(error.message) : 'Fastkore CLI недоступна.' };
    }
  } };
}
