import path from 'node:path';
import type { Attachment, Project } from '../shared/types.js';
import type { ExecutionProvider } from '../shared/execution-accounts.js';
import { maxUploadBytes, type FileStorage } from './file-storage.js';
import { BridgeError } from './store.js';

const imageTypes = new Map([
  ['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.jfif', 'jpeg'], ['.png', 'png'], ['.webp', 'webp'], ['.gif', 'gif'],
]);
const otherImageTypes = new Set(['.avif', '.bmp', '.heic', '.heif', '.ico', '.svg', '.tif', '.tiff']);
export const maxChatImages = 8;
export const maxChatImageBytes = maxUploadBytes;
// Base64 encoding rounds each file up separately. Allow space for up to eight prefixes.
export const maxChatImageUrlLength = 4 * Math.ceil(maxChatImageBytes / 3) + 32;
export const maxChatImagePayload = maxChatImageUrlLength + maxChatImages * 64;
export const chatImageUrlPattern = '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$';
export const chatImagesUnsupportedProvider = 'Для просмотра изображений выберите модель ChatGPT или GLM в этом чате.';

export function supportsChatImages(provider?: ExecutionProvider) {
  return !provider || provider === 'codex' || provider === 'glm';
}

function extension(name: string) { return path.extname(name).toLowerCase(); }

export function isChatImage(file: Attachment) {
  const ext = extension(file.name);
  return imageTypes.has(ext) || otherImageTypes.has(ext);
}

export function validateChatImages(files: Attachment[]) {
  if (files.some(file => !imageTypes.has(extension(file.name)))) {
    throw new BridgeError('Для просмотра прикрепите изображение в формате JPG, PNG, WebP или GIF.', 415);
  }
  if (files.length > maxChatImages || files.reduce((total, file) => total + file.size, 0) > maxChatImageBytes) {
    throw new BridgeError('К сообщению можно прикрепить до 8 изображений общим размером до 20 МБ.', 413);
  }
}

function imageType(contents: Buffer) {
  if (contents.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const header = contents.toString('ascii', 0, 12);
  if (header.startsWith('RIFF') && header.endsWith('WEBP')) return 'webp';
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
}

export async function readChatImages(files: Attachment[], project: Project, storage: FileStorage, signal: AbortSignal) {
  if (!files.length) return undefined;
  validateChatImages(files);
  const urls: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const contents = await storage.read(project, file, signal);
    bytes += contents.length;
    if (bytes > maxChatImageBytes) throw new BridgeError('Общий размер изображений превышает 20 МБ.', 413);
    const type = imageType(contents);
    if (type !== imageTypes.get(extension(file.name))) {
      throw new BridgeError('Формат изображения не совпадает с расширением файла.', 415);
    }
    urls.push('data:image/' + type + ';base64,' + contents.toString('base64'));
  }
  return urls;
}
