import { lstat, mkdir, readFile, readdir, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { parse } from 'csv-parse/sync';
import type { Attachment, Project, ProjectFile } from '../shared/types.js';
import { BridgeError } from './store.js';

export function attachmentName(name: string) {
  const safeName = path.basename(name.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160).replace(/[. ]+$/, '') || 'attachment';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safeName) ? '_' + safeName : safeName;
}

export async function uploadAttachment(directory: string, name: string, data: Buffer): Promise<Attachment & { path: string }> {
  const root = await realpath(directory);
  let parent = root;
  for (const part of ['.bridge', 'attachments']) {
    parent = path.join(parent, part); await mkdir(parent).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new BridgeError('Папка вложений не должна быть ссылкой.');
  }
  const id = randomUUID(); const folder = path.join(parent, id); await mkdir(folder);
  const safeName = attachmentName(name);
  const file = path.join(folder, safeName);
  try { await writeFile(file, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rmdir(folder).catch(() => {}); throw error; }
  return { id, name: safeName, path: file, size: data.length };
}
export function publicProjectFile({ id, name, size, libraryUploadedAt }: Attachment): ProjectFile {
  return { id, name, size, uploadedAt: libraryUploadedAt! };
}
export async function projectFilePath(project: Project, attachment: Attachment) {
  const missing = () => new BridgeError('Файл проекта не найден.', 404);
  try {
    const root = await realpath(project.directory);
    const file = path.join(root, '.bridge', 'attachments', attachment.id, attachment.name);
    if (file !== attachment.path || await realpath(file) !== file || !(await lstat(file)).isFile()) throw missing();
    return file;
  } catch { throw missing(); }
}
export function supportsDocumentText(name: string) {
  return ['.txt', '.md', '.json', '.xml', '.log', '.xlsx', '.csv', '.tsv', '.pdf'].includes(path.extname(name).toLowerCase());
}
let activePreviews = 0;
async function documentPreview(kind: 'pdf' | 'xlsx', input: Buffer) {
  if (activePreviews >= 2) throw new BridgeError('Предпросмотр документов занят.', 429);
  activePreviews++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const script = new URL(import.meta.url.endsWith('.ts') ? './document-preview.ts' : './document-preview.js', import.meta.url);
    worker = new Worker(script, {
      workerData: { kind, input },
      resourceLimits: { maxOldGenerationSizeMb: kind === 'pdf' ? 192 : 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 },
    });
    const preview = worker;
    return await new Promise<string>((resolve, reject) => {
      const invalid = () => new BridgeError('Документ повреждён или превышает лимиты предпросмотра.', 422);
      timer = setTimeout(() => reject(invalid()), 5000);
      preview.once('message', resolve);
      preview.once('error', () => reject(invalid()));
      preview.once('exit', () => reject(invalid()));
    });
  } finally {
    clearTimeout(timer);
    try { await worker?.terminate(); } finally { activePreviews--; }
  }
}
export async function documentText(file: string, contents?: Buffer): Promise<string> {
  if ((contents?.length ?? (await stat(file)).size) > 25 * 1024 * 1024) return '[Файл слишком большой для выдержки]';
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.pdf') return documentPreview(ext === '.xlsx' ? 'xlsx' : 'pdf', contents ?? await readFile(file));
  if (ext === '.csv' || ext === '.tsv') {
    const raw = (contents?.toString('utf8') ?? await readFile(file, 'utf8')).slice(0, 256_000);
    const delimiter = ext === '.tsv' ? '\t' : (raw.split('\n')[0]?.split(';').length ?? 0) > (raw.split('\n')[0]?.split(',').length ?? 0) ? ';' : ',';
    return (parse(raw, { delimiter, relax_column_count: true, relax_quotes: true, to: 25, bom: true }) as string[][]).map(row => row.slice(0, 16).join(' | ')).join('\n').slice(0, 8000);
  }
  if (['.txt', '.md', '.json', '.xml', '.log'].includes(ext)) return (contents?.toString('utf8') ?? await readFile(file, 'utf8')).slice(0, 8000);
  return '[Путь передан Codex. Автоматическая выдержка этого формата не поддерживается]';
}
export async function buildContext(directory: string, attachments: Attachment[], includeProject: boolean, signal: AbortSignal) {
  const files = attachments.flatMap(a => a.path ? [a.path] : []); const supported = new Set(['.xlsx', '.csv', '.tsv', '.pdf']);
  async function walk(folder: string, depth: number) {
    if (depth > 2 || files.length >= 8) return;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= 8) break;
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules', 'bin', 'obj', 'dist', 'vendor'].includes(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (supported.has(path.extname(file).toLowerCase()) && !files.includes(file)) files.push(file);
    }
  }
  if (includeProject) await walk(directory, 0);
  let text = '';
  for (const file of files.slice(0, 8)) {
    signal.throwIfAborted();
    try { text += `\nФайл: ${file}\n${await documentText(file)}\n`; }
    catch { text += `\nФайл: ${file}\n[Не удалось извлечь выдержку; используйте доступные инструменты чтения]\n`; }
    if (text.length >= 24_000) break;
  }
  return text.slice(0, 24_000);
}
