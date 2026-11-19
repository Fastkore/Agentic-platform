import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodexRequest } from './codex.js';
import type { CodexToolDefinition } from './codex-tools.js';

export const jobFilesTool: CodexToolDefinition = {
  type: 'function', name: 'workspace_files',
  description: 'Файлы текущего задания. Действия list/read/write/remove. Пути относительны рабочей папке. Вложения находятся в input, исходники CLI в cli. Готовые файлы сохраняй в output.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'path'],
    properties: { action: { type: 'string', enum: ['list', 'read', 'write', 'remove'] },
      path: { type: 'string' }, text: { type: 'string', maxLength: 200000 } } },
};

export async function useJobFiles(request: CodexRequest, input: unknown, signal: AbortSignal) {
  const args = input as Record<string, unknown> | null;
  if (typeof args?.path !== 'string' || !request.workDirectoryId) throw Error('Некорректный путь к файлу задания.');
  const root = await realpath(request.workspace), target = path.resolve(root, args.path);
  if (target !== root && !target.startsWith(root + path.sep)) throw Error('Файл находится вне задания.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1) throw Error('Ссылка на файл недоступна.');
  }
  signal.throwIfAborted();
  if (args.action === 'list') return JSON.stringify((await readdir(target, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })));
  if (args.action === 'read') {
    const info = await lstat(target);
    if (!info.isFile() || info.size > 200000) throw Error('Файл слишком большой для чтения текста.');
    return (await readFile(target, { encoding: 'utf8', signal })).slice(0, 80000);
  }
  if (!request.allowWrite || target === root) throw Error('Запись недоступна.');
  if (args.action === 'write' && typeof args.text === 'string' && args.text.length <= 200000) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, args.text, { mode: 0o600, signal });
    return 'Сохранено';
  }
  if (args.action === 'remove' && (await lstat(target)).isFile()) { await rm(target); return 'Удалено'; }
  throw Error('Неизвестная операция с файлом.');
}
