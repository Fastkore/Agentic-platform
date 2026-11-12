import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './store.js';

const chatLimit = 128 * 1024 * 1024;
const totalLimit = 2 * 1024 * 1024 * 1024;
const retention = 30 * 86400_000;

async function treeSize(directory: string, limit: number): Promise<number> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new BridgeError('Рабочая папка CLI должна быть обычным каталогом.', 422);
  let bytes = 0, entries = 0;
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++entries > 10000) throw new BridgeError('В рабочей папке CLI слишком много файлов. Удалите промежуточные файлы.', 413);
      const file = path.join(folder, entry.name), info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || info.isFile() && info.nlink !== 1) {
        throw new BridgeError('Рабочая папка CLI содержит неподдерживаемый тип файла.', 422);
      }
      bytes += info.isFile() ? info.size : 0;
      if (bytes > limit) throw new BridgeError('Превышен лимит локальных файлов CLI. Удалите промежуточные файлы.', 413);
      if (info.isDirectory()) await visit(file);
    }
  }
  await visit(directory);
  return bytes;
}

export class CliWorkspace {
  private readonly root: string;
  private readonly saved: string;
  private readonly previous: string;
  constructor(dataRoot: string, identity: string[]) {
    this.root = path.join(dataRoot, 'cli-workspaces');
    this.saved = path.join(this.root, createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
    this.previous = this.saved + '.previous';
  }
  async restore(jobDirectory: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root)) {
      if (!entry.startsWith(path.basename(this.saved) + '.next-')) continue;
      await rm(path.join(this.root, entry), { recursive: true, force: true });
    }
    const old = await lstat(this.previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const current = await lstat(this.saved).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (old && !current) await rename(this.previous, this.saved);
    else if (old) await rm(this.previous, { recursive: true, force: true });
    const target = path.join(jobDirectory, 'cli');
    await mkdir(target, { mode: 0o700 });
    if (current || old) {
      await treeSize(this.saved, chatLimit);
      await cp(this.saved, target, { recursive: true, force: false, errorOnExist: false });
    }
    for (const folder of ['source', 'backups', 'tmp']) await mkdir(path.join(target, folder), { recursive: true, mode: 0o700 });
  }
  async save(jobDirectory: string) {
    const source = path.join(jobDirectory, 'cli');
    const bytes = await treeSize(source, chatLimit);
    let used = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const folder = path.join(this.root, entry.name);
      if (folder === this.saved) continue;
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError('Локальное хранилище CLI повреждено.', 500);
      if (info.mtimeMs < Date.now() - retention) await rm(folder, { recursive: true, force: true });
      else used += await treeSize(folder, totalLimit);
    }
    if (used + bytes > totalLimit) throw new BridgeError('Локальное хранилище CLI заполнено (2 ГиБ).', 413);
    const staging = this.saved + '.next-' + randomUUID();
    try {
      await cp(source, staging, { recursive: true, preserveTimestamps: false });
      const exists = await lstat(this.saved).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (exists) await rename(this.saved, this.previous);
      try { await rename(staging, this.saved); }
      catch (error) { if (exists) await rename(this.previous, this.saved); throw error; }
      await rm(this.previous, { recursive: true, force: true });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
