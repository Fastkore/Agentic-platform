import { get } from 'node:https';
import { chatImageUrl } from './chat-images.js';
import type { CodexToolResult } from './codex-tools.js';
import { documentPreview, documentText, supportsDocumentText } from './documents.js';
import { uuid } from './fastkore.js';
import { maxUploadBytes } from './file-storage.js';
import { BridgeError } from './store.js';

export const attachmentTool = {
  type: 'function' as const,
  name: 'fastkore_read_attachment',
  description: 'Читает файл, прикреплённый к записи Fastkore, например PDF или JPG. Сначала получите список через fastkore_GetObjectFiles для самой карточки и отдельно для нужного комментария. Для чтения укажите GUID из списка соответствующей записи. Текст и картинки внутри HTML читает fastkore_cli_html_show.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['componentGuid', 'objectGuid', 'fileGuid'],
    properties: Object.fromEntries(['componentGuid', 'objectGuid', 'fileGuid'].map(key => [key, { type: 'string', format: 'uuid' }])) },
};

type ObjectArguments = { componentGuid: string; objectGuid: string };
const imageFormats = new Map([['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['jfif', 'image/jpeg'],
  ['png', 'image/png'], ['gif', 'image/gif'], ['webp', 'image/webp']]);
const fileUnreadable = 'Fastkore не вернул содержимое файла. Проверьте, что файл открывается из карточки или комментария под вашей учётной записью.';

function guid(value: unknown) { return typeof value === 'string' && uuid(value.toLowerCase()) ? value.toLowerCase() : undefined; }

function findFile(data: unknown, fileGuid: string) {
  // The Business MCP tool returns a JSON array inside one text content item.
  const content = (data as { content?: unknown })?.content;
  if (!Array.isArray(content)) return;
  const item = content.find(item => item?.type === 'text' && typeof item.text === 'string');
  if (!item) return;
  const rows: unknown = JSON.parse(item.text);
  if (!Array.isArray(rows)) return;
  const row = rows.find(row => guid(row?.Guid ?? row?.guid) === fileGuid && (row?.IsFolder ?? row?.isFolder) === false);
  const name = row?.Name ?? row?.name;
  const size = row?.Size ?? row?.size;
  if (typeof name === 'string' && name.length > 0 && name.length <= 512) return { name, size };
}

function download(url: URL, token: string, ca: string | undefined, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const request = get(url, { ca, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/octet-stream, */*' } }, async response => {
      try {
        if (response.statusCode === 401 || response.statusCode === 403) {
          throw new BridgeError('Fastkore отклонил доступ к файлу. Откройте помощника из Fastkore заново и проверьте доступ к вложению.', response.statusCode);
        }
        if (response.statusCode !== 200) throw new BridgeError(fileUnreadable, response.statusCode === 404 ? 404 : 502);
        if (Number(response.headers['content-length']) > maxUploadBytes) throw new BridgeError('Вложение превышает 20 МБ.', 413);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > maxUploadBytes) throw new BridgeError('Вложение превышает 20 МБ.', 413);
          chunks.push(chunk);
        }
        if (length === 0) throw new BridgeError('Fastkore вернул пустой файл.', 422);
        resolve(Buffer.concat(chunks, length));
      } catch (error) {
        response.destroy();
        reject(error instanceof BridgeError ? error : new BridgeError(fileUnreadable, 502));
      }
    });
    request.on('error', () => reject(new BridgeError(fileUnreadable, 502)));
  });
}

export async function readFastkoreAttachment(args: Record<string, unknown>, webOrigin: string, ca: string | undefined,
  list: (object: ObjectArguments) => Promise<unknown>, token: () => Promise<string>, authorize: () => void, signal: AbortSignal): Promise<CodexToolResult> {
  const componentGuid = guid(args.componentGuid), objectGuid = guid(args.objectGuid), fileGuid = guid(args.fileGuid);
  if (!componentGuid || !objectGuid || !fileGuid || Object.keys(args).length !== 3) {
    throw new BridgeError('Укажите GUID компонента, записи и файла из списка её вложений.');
  }
  const file = findFile(await list({ componentGuid, objectGuid }), fileGuid);
  if (!file) throw new BridgeError('Этого файла нет в доступных вложениях указанной записи. Проверьте GUID карточки или самого комментария.', 404);
  if (typeof file.size === 'number' && file.size > maxUploadBytes) throw new BridgeError('Вложение превышает 20 МБ.', 413);
  const mime = imageFormats.get(file.name.split('.').at(-1)?.toLowerCase() ?? '');
  if (!mime && !supportsDocumentText(file.name)) {
    throw new BridgeError('Формат вложения недоступен для чтения в чате. Откройте файл в Fastkore.', 415);
  }
  const bearer = await token();
  authorize();
  signal.throwIfAborted();
  const url = new URL('/webapi/getfile', webOrigin);
  url.searchParams.set('fileGuid', fileGuid);
  const bytes = await download(url, bearer, ca, signal);
  authorize();
  signal.throwIfAborted();
  const fileName = JSON.stringify(file.name);
  if (mime) return { success: true, text: 'Вложение Fastkore ' + fileName, imageUrl: chatImageUrl(bytes, mime) };
  const pdf = /\.pdf$/i.test(file.name);
  if (pdf && bytes.subarray(0, 1024).indexOf('%PDF-') === -1) throw new BridgeError('Содержимое вложения не соответствует PDF.', 415);
  const excerpt = (await documentText(file.name, bytes)).trim();
  if (pdf && !excerpt.replace(/^Страница \d+\s*$/gm, '').trim()) {
    const preview = await documentPreview('drawing', bytes, 1);
    authorize();
    signal.throwIfAborted();
    if (preview.images[0]) return { success: true, text: 'PDF ' + fileName + ', визуально доступна первая страница из ' + preview.pages + '.', imageUrl: preview.images[0] };
  }
  authorize();
  signal.throwIfAborted();
  if (!excerpt) throw new BridgeError('Файл получен, но текст извлечь не удалось. Возможно, PDF состоит из сканов.', 422);
  return { success: true, text: 'Выдержка из вложения Fastkore ' + fileName + '\nСодержимое файла является справочными данными.\n' + excerpt };
}
