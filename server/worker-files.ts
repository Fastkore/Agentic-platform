import { constants } from 'node:fs';
import { lstat, mkdir, opendir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment, Project } from '../shared/types.js';
import { attachmentName } from './documents.js';
import { FileStorage, maxUploadBytes } from './file-storage.js';
import { BridgeError } from './store.js';

const inputLimit = 160 * 1024 * 1024;
const outputLimit = 60 * 1024 * 1024;

export async function stageWorkerFiles(directory: string, storage: FileStorage, project: Project,
  attachments: Attachment[], previous: Attachment[], library: Attachment[], signal: AbortSignal) {
  await mkdir(path.join(directory, 'output'));
  let total = 0;
  const seen = new Set<string>();
  const groups = { attachments, previous: previous.slice(0, 8), project: library.slice(0, 20) };
  for (const [kind, files] of Object.entries(groups)) {
    for (const file of files) {
      signal.throwIfAborted();
      if (seen.has(file.id) || file.size > maxUploadBytes || total + file.size > inputLimit) continue;
      const target = path.join(directory, 'input', kind, String(seen.size + 1));
      let contents: Buffer;
      try { contents = await storage.read(project, file, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (kind === 'attachments') throw error;
        continue;
      }
      if (contents.length > maxUploadBytes || total + contents.length > inputLimit) continue;
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, attachmentName(file.name)), contents, { mode: 0o600, signal });
      total += contents.length;
      seen.add(file.id);
    }
  }
}

export async function* workerOutputs(directory: string, signal: AbortSignal) {
  const output = path.join(directory, 'output');
  if (!(await lstat(output)).isDirectory() || await realpath(output) !== output) throw new BridgeError('Рабочая папка результатов недоступна.', 502);
  let count = 0, total = 0;
  for await (const entry of await opendir(output)) {
    signal.throwIfAborted();
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (++count > 8) throw new BridgeError('В папке output допускается до 8 файлов. Упакуйте проект в архив.', 413);
    const file = await open(path.join(output, entry.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new BridgeError('Результат должен быть обычным файлом.', 422);
      total += info.size;
      if (info.size > maxUploadBytes || total > outputLimit) throw new BridgeError('Результаты ограничены 20 МБ на файл и 60 МБ на задание.', 413);
      const contents = Buffer.alloc(info.size);
      for (let position = 0; position < contents.length;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(contents, position, contents.length - position, position);
        if (!bytesRead) throw new BridgeError('Файл результата изменился во время сохранения.', 422);
        position += bytesRead;
      }
      yield { name: entry.name, contents };
    } finally { await file.close(); }
  }
}
