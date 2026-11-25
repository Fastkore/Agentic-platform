import type { CodexTools } from './codex-tools.js';
import type { FastkoreCliResult, FastkoreHtmlOperation } from './fastkore-cli.js';
import { formatFastkoreCliResult } from './fastkore-cli-tools.js';
import { maxChatImageBytes, maxChatImagePayload, maxChatImages } from './chat-images.js';
import { redact } from './store.js';

const readTool = 'fastkore_cli_html_show';
const imageTool = 'fastkore_cli_html_image';
const fieldPattern = /^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,199}$/u;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const mimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const fields = {
  entitySet: { type: 'string', maxLength: 200, description: 'GUID или системное имя компонента.' },
  entity: { type: 'string', format: 'uuid', description: 'GUID записи, содержащей поле, например GUID самого комментария.' },
  property: { type: 'string', maxLength: 200, description: 'Системное имя HTML-поля.' },
};
const required = Object.keys(fields);
const index = { type: 'integer', minimum: 1, maximum: 2147483647 };

export function withFastkoreHtml(tools: CodexTools, execute: (operation: FastkoreHtmlOperation, signal: AbortSignal) => Promise<FastkoreCliResult>): CodexTools {
  let images = 0, payload = 0;
  return {
    definitions: [...tools.definitions, {
      type: 'function', name: readTool,
      description: 'Читает HtmlTextFormat напрямую. Возвращает видимый текст и метаданные встроенных изображений. Пустой текст возможен при imageCount > 0. Для следующей страницы передайте nextOffset как offset или nextIndex как index.',
      inputSchema: { type: 'object', additionalProperties: false, required,
        properties: { ...fields, offset: { type: 'integer', minimum: 0, maximum: 2147483647 }, index } },
    }, {
      type: 'function', name: imageTool,
      description: 'Передаёт модели встроенное изображение из HTML-поля. Возьмите index, mimeType и sha256 изображения со статусом available из fastkore_cli_html_show. При конфликте перечитайте поле. Внешние ссылки и недоступные изображения сообщите по статусу.',
      inputSchema: { type: 'object', additionalProperties: false, required: [...required, 'index', 'mimeType', 'sha256'],
        properties: { ...fields, index, mimeType: { type: 'string', enum: mimeTypes }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
    }],
    async call(name, args, signal) {
      if (name !== readTool && name !== imageTool) return tools.call(name, args, signal);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { success: false, text: 'Укажите компонент, GUID записи и HTML-поле.' };
      const { entitySet, entity, property, offset, index: imageIndex, mimeType, sha256 } = args as Record<string, unknown>;
      const integer = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 2147483647;
      if (typeof entitySet !== 'string' || !fieldPattern.test(entitySet) || typeof entity !== 'string' || !guid.test(entity) ||
        typeof property !== 'string' || !fieldPattern.test(property) || offset !== undefined && !integer(offset, 0) ||
        imageIndex !== undefined && !integer(imageIndex, 1)) return { success: false, text: 'Проверьте идентификаторы HTML-поля и номера страниц.' };
      const field = { entitySet, entity, property };
      try {
        if (name === readTool) return formatFastkoreCliResult(await execute({ ...field, operation: 'html-show',
          offset: offset as number | undefined, index: imageIndex as number | undefined }, signal), 'data html show');
        if (!integer(imageIndex, 1) || typeof mimeType !== 'string' || !mimeTypes.includes(mimeType) ||
          typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return { success: false, text: 'Выберите доступную картинку из списка HTML и передайте её index, mimeType и sha256.' };
        if (images >= maxChatImages || payload >= maxChatImagePayload) return { success: false, text: 'Достигнут лимит изображений на запрос. Выберите нужную картинку в следующем сообщении.' };
        const result = await execute({ ...field, operation: 'html-image', index: imageIndex, mimeType, sha256 }, signal);
        if (result.exitCode === 4) return { success: false, text: 'HTML-поле или изображение изменилось. Заново прочитайте поле и выберите актуальное изображение.' };
        if (!result.success) return formatFastkoreCliResult(result, 'data html export');
        if (!result.imageUrl) return { success: false, text: 'CLI не вернула изображение.' };
        if (images >= maxChatImages || payload + result.imageUrl.length > maxChatImagePayload) {
          return { success: false, text: `Изображения из HTML превышают общий лимит ${maxChatImageBytes / 1024 / 1024} МБ на запрос.` };
        }
        images++;
        payload += result.imageUrl.length;
        return { success: true, text: 'Изображение ' + imageIndex + ' из HTML-поля. ' + JSON.stringify(result.data), imageUrl: result.imageUrl };
      } catch (error) {
        signal.throwIfAborted();
        return { success: false, text: error instanceof Error ? redact(error.message) : 'Не удалось прочитать HTML-поле.' };
      }
    },
  };
}
