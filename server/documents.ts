import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import readExcelFile from 'read-excel-file/node';
import { parse } from 'csv-parse/sync';
import type { Attachment } from '../shared/types.js';
import { BridgeError } from './store.js';

export async function uploadAttachment(directory: string, name: string, data: Buffer): Promise<Attachment> {
  const root = await realpath(directory);
  let parent = root;
  for (const part of ['.bridge', 'attachments']) {
    parent = path.join(parent, part); await mkdir(parent).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw new BridgeError('Папка вложений не должна быть ссылкой.');
  }
  const id = randomUUID(); const folder = path.join(parent, id); await mkdir(folder);
  const safeName = path.basename(name.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160) || 'attachment';
  const file = path.join(folder, safeName); await writeFile(file, data, { flag: 'wx' });
  return { id, name: safeName, path: file, size: data.length };
}
export async function documentText(file: string): Promise<string> {
  if ((await stat(file)).size > 25 * 1024 * 1024) return '[Файл слишком большой для выдержки]';
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx') {
    const sheets = await readExcelFile(file);
    return sheets.slice(0, 6).map(sheet => {
      const rows = sheet.data.slice(0, 25).map(row => row.slice(0, 16).map(cell => String(cell ?? '').slice(0, 250)).join(' | '));
      return `Лист: ${sheet.sheet}\n${rows.join('\n')}`;
    }).join('\n\n').slice(0, 8000);
  }
  if (ext === '.csv' || ext === '.tsv') {
    const raw = (await readFile(file, 'utf8')).slice(0, 256_000);
    const delimiter = ext === '.tsv' ? '\t' : (raw.split('\n')[0]?.split(';').length ?? 0) > (raw.split('\n')[0]?.split(',').length ?? 0) ? ';' : ',';
    return (parse(raw, { delimiter, relax_column_count: true, relax_quotes: true, to: 25, bom: true }) as string[][]).map(row => row.slice(0, 16).join(' | ')).join('\n').slice(0, 8000);
  }
  if (ext === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const task = getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: false,
      standardFontDataUrl: path.join(pdfRoot, 'standard_fonts').replaceAll('\\', '/') + '/',
      cMapUrl: path.join(pdfRoot, 'cmaps').replaceAll('\\', '/') + '/', wasmUrl: path.join(pdfRoot, 'wasm').replaceAll('\\', '/') + '/' });
    const doc = await task.promise;
    try {
      let text = '';
      for (let p = 1; p <= Math.min(5, doc.numPages); p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        text += `Страница ${p}\n` + content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n';
      }
      return text.slice(0, 8000);
    } finally { await task.destroy(); }
  }
  if (['.txt', '.md', '.json', '.xml', '.log'].includes(ext)) return (await readFile(file, 'utf8')).slice(0, 8000);
  return '[Путь передан Codex. Автоматическая выдержка этого формата не поддерживается]';
}
export async function buildContext(directory: string, attachments: Attachment[], includeProject: boolean, signal: AbortSignal) {
  const files = attachments.map(a => a.path); const supported = new Set(['.xlsx', '.csv', '.tsv', '.pdf']);
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
