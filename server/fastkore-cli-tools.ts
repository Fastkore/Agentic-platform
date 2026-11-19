import { redact } from './store.js';
import type { CodexTools, CodexToolDefinition, CodexToolResult } from './codex-tools.js';
import type { FastkoreCliResult } from './fastkore-cli.js';
import { defaultToolResponseChars, isFastkoreCliResponseLimit, maxFastkoreCliResponseChars } from '../shared/fastkore-cli-response-limit.js';

const maxFields = 64, maxFieldLength = 200;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fieldPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > maxFieldLength || /[\u0000-\u001f]/.test(value)) return false;
  const parts = value.split('.');
  return parts[0] === 'data' && parts.length <= 20 && parts.every(key => key && key === key.trim() && !forbiddenKeys.has(key));
}

type FieldMask = Map<string, FieldMask | null>;
function selectFields(value: Record<string, unknown>, fields: string[]) {
  const mask: FieldMask = new Map();
  for (const field of fields) {
    const parts = field.split('.');
    let level = mask;
    for (const [index, key] of parts.entries()) {
      const previous = level.get(key);
      if (previous === null) break;
      if (index === parts.length - 1) { level.set(key, null); break; }
      const next = previous ?? new Map();
      level.set(key, next);
      level = next;
    }
  }
  function project(source: Record<string, unknown>, mask: FieldMask): Record<string, unknown> {
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of mask) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (child === null) output[key] = value;
      else if (record(value)) {
        const nested = project(value, child);
        if (Object.keys(nested).length) output[key] = nested;
      }
    }
    return output;
  }
  return project(value, mask);
}

const diagnostics = new Set(['success', 'exitCode', 'status', 'message', 'error', 'errors', 'warnings', 'agentContext', 'partial', 'partialResult',
  'requested', 'count', 'failed', 'truncated', 'hasMore', 'nextCursor', 'changed', 'serverChanged', 'created', 'committed',
  'verificationPassed', 'auditError', 'instruction']);

function keepDiagnostics(value: unknown): unknown {
  if (!record(value)) return undefined;
  const entries = Object.entries(value).filter(([key]) => diagnostics.has(key));
  if (record(value.data)) {
    const nested = Object.entries(value.data).filter(([key]) => diagnostics.has(key));
    if (nested.length) entries.push(['data', Object.fromEntries(nested)]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function formatFastkoreCliResult(result: FastkoreCliResult, command: string, fields?: string[], maxResponseChars?: number): CodexToolResult & { responseChars?: number } {
  const responseLimitChars = isFastkoreCliResponseLimit(maxResponseChars) ? maxResponseChars : defaultToolResponseChars;
  const { success, exitCode } = result;
  const partial = exitCode === 5 ? true : undefined;
  const retryAdvice = ' Перед повтором команды записи проверьте состояние чтением.';
  if (result.error) return { success: success === true, text: JSON.stringify({ success, exitCode, partial, error: { ...result.error,
    message: 'Вывод Fastkore CLI превысил предел чтения stdout. Сократите нативный вывод CLI или размер страницы.' + retryAdvice } }) };

  // Error and partial-result payloads carry native diagnostics independently of the field mask.
  const selected = success && fields ? selectFields({ data: result.data }, fields).data : result.data;
  const metadata = success && fields && record(result.data) ? keepDiagnostics(result.data) : undefined;
  const data = record(metadata) && record(selected) ? { ...selected, ...metadata } : metadata ?? selected;
  const text = JSON.stringify({ success, exitCode, partial, data });
  if (text.length <= responseLimitChars) return { success: success === true, text };

  const advice = command === 'data get' ? ' Для чтения доступны --detail brief и --properties.'
    : command === 'data query' ? ' Для чтения доступны --properties и пагинация.'
      : command === 'report definition show' ? ' Для печатной формы используйте --detail brief --json.' : '';
  const error = { code: 'response_too_large', actualChars: text.length, limitChars: responseLimitChars,
    message: 'Ответ Fastkore CLI слишком большой. Сузьте fields или размер страницы.' +
      (text.length <= maxFastkoreCliResponseChars ? ' Если нужен весь ответ, укажите maxResponseChars для вызова.' : '') + advice + retryAdvice };
  const summary = { success, exitCode, partial, error };
  const details = success ? undefined : keepDiagnostics(result.data);
  const compact = JSON.stringify({ ...summary, data: details });
  return { success: success === true, responseChars: text.length, text: compact.length <= responseLimitChars ? compact : JSON.stringify({ ...summary, diagnosticsOmitted: true }) };
}

export function withFastkoreCliCommands(tools: CodexTools, catalog: () => Promise<unknown>,
  describe: (command: string, signal: AbortSignal) => Promise<unknown>,
  execute: (command: string, args: string[], signal: AbortSignal, fields?: string[], maxResponseChars?: number) => Promise<CodexToolResult>,
  authorize: () => void): CodexTools {
  const definitions: CodexToolDefinition[] = [
    { type: 'function', name: 'fastkore_cli_catalog', description: 'Каталог всех команд установленной Fastkore CLI с назначением и параметрами.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
    { type: 'function', name: 'fastkore_cli_command_describe', description: 'Штатное agent describe для команды установленной Fastkore CLI.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } },
    { type: 'function', name: 'fastkore_cli_execute',
      description: 'Запускает Fastkore CLI. command — имя команды, args — её штатные параметры отдельными строками. fields выбирает поля JSON-ответа по путям, например data.templateSha256. maxResponseChars повышает лимит ответа для этого вызова с 96000 до 200000 символов. Для чтения определения печатной формы перед генерацией PDF используйте report definition show с --detail brief --json. Пути относительны рабочей папке cli этого чата. Соединение и билет сотрудника передаёт исполнитель.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['command', 'args'],
        properties: { command: { type: 'string' }, args: { type: 'array', maxItems: 160, items: { type: 'string', maxLength: 32000 } },
          fields: { type: 'array', minItems: 1, maxItems: maxFields, items: { type: 'string', maxLength: maxFieldLength } },
          maxResponseChars: { type: 'integer', minimum: defaultToolResponseChars, maximum: maxFastkoreCliResponseChars } } } },
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
      else if (name === 'fastkore_cli_execute' && Object.keys(input).every(key => ['command', 'args', 'fields', 'maxResponseChars'].includes(key)) && typeof input.command === 'string' &&
        Array.isArray(input.args) && input.args.length <= 160 && input.args.every(arg => typeof arg === 'string' && arg.length <= 32000) &&
        (input.fields === undefined || Array.isArray(input.fields) && input.fields.length > 0 && input.fields.length <= maxFields && input.fields.every(fieldPath)) &&
        (input.maxResponseChars === undefined || isFastkoreCliResponseLimit(input.maxResponseChars))) {
        return await execute(input.command, input.args, signal, input.fields, input.maxResponseChars);
      } else return { success: false, text: 'Проверьте command, args, пути fields внутри data и целочисленный maxResponseChars от 96000 до 200000.' };
      authorize(); signal.throwIfAborted();
      return { success: true, text: redact(JSON.stringify(result)) };
    } catch (error) {
      return { success: false, text: error instanceof Error ? redact(error.message) : 'Fastkore CLI недоступна.' };
    }
  } };
}
