import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './store.js';

const chatLimit = 128 * 1024 * 1024;
const totalLimit = 2 * 1024 * 1024 * 1024;
const retention = 30 * 86400_000;
const workspaceName = /^([a-f0-9]{64})(?:\.revisions|\.previous)?$/;
const revisionName = /^\d{13}-[a-f0-9-]{36}$/;
const storageOperations = new Map<string, Promise<unknown>>();

async function withStorage<T>(root: string, operation: () => Promise<T>): Promise<T> {
  // Serialize quota checks and publication across the chats using this store.
  const previous = storageOperations.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  storageOperations.set(root, pending);
  try { return await pending; }
  finally { if (storageOperations.get(root) === pending) storageOperations.delete(root); }
}

const statIfPresent = (file: string) => lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });

async function revisions(saved: string) {
  const directory = saved + '.revisions';
  const info = await statIfPresent(directory);
  if (!info) return [];
  if (!info.isDirectory()) throw new BridgeError('Локальное хранилище CLI повреждено.', 500);
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && revisionName.test(entry.name))
    .map(entry => entry.name).sort().reverse();
}

async function savedWorkspace(saved: string, versions: string[]) {
  for (const name of versions) {
    const revision = path.join(saved + '.revisions', name);
    const marker = await statIfPresent(path.join(revision, 'ready'));
    if (marker?.isFile() && marker.size === 0) return { directory: path.join(revision, 'files'), updatedAt: marker.mtimeMs };
  }
  // Read the legacy layout, including backups left by an interrupted legacy save.
  for (const directory of [saved, saved + '.previous']) {
    const info = await statIfPresent(directory);
    if (!info) continue;
    if (!info.isDirectory()) throw new BridgeError('Локальное хранилище CLI повреждено.', 500);
    return { directory, updatedAt: info.mtimeMs };
  }
}

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
  constructor(dataRoot: string, identity: string[]) {
    this.root = path.join(dataRoot, 'cli-workspaces');
    this.saved = path.join(this.root, createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
  }
  async restore(jobDirectory: string) {
    await withStorage(this.root, () => this.restoreSnapshot(jobDirectory));
  }
  private async restoreSnapshot(jobDirectory: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const current = await savedWorkspace(this.saved, await revisions(this.saved));
    const target = path.join(jobDirectory, 'cli');
    await mkdir(target, { mode: 0o700 });
    if (current) {
      await treeSize(current.directory, chatLimit);
      await cp(current.directory, target, { recursive: true, force: false, errorOnExist: false });
    }
    for (const folder of ['source', 'backups', 'tmp']) await mkdir(path.join(target, folder), { recursive: true, mode: 0o700 });
  }
  async save(jobDirectory: string) {
    await withStorage(this.root, () => this.saveSnapshot(jobDirectory));
  }
  private async saveSnapshot(jobDirectory: string) {
    const source = path.join(jobDirectory, 'cli');
    const bytes = await treeSize(source, chatLimit);
    const names = await readdir(this.root);
    let used = 0;
    const keys = new Set(names.flatMap(name => workspaceName.exec(name)?.[1] ?? []));
    for (const key of keys) {
      const folder = path.join(this.root, key);
      if (folder === this.saved) continue;
      const snapshot = await savedWorkspace(folder, await revisions(folder));
      if (!snapshot) continue;
      if (snapshot.updatedAt < Date.now() - retention) {
        await Promise.all([folder, folder + '.previous', folder + '.revisions'].map(directory => rm(directory, { recursive: true, force: true })));
      } else used += await treeSize(snapshot.directory, totalLimit);
    }
    if (used + bytes > totalLimit) throw new BridgeError('Локальное хранилище CLI заполнено (2 ГиБ).', 413);
    const oldRevisions = await revisions(this.saved);
    const revisionRoot = this.saved + '.revisions';
    const timestamp = Math.max(Date.now(), Number(oldRevisions[0]?.slice(0, 13) ?? 0) + 1);
    const staging = path.join(revisionRoot, `${timestamp}-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await cp(source, path.join(staging, 'files'), { recursive: true });
      // Publish a complete copy without renaming any directory on a bind mount.
      await writeFile(path.join(staging, 'ready'), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const legacyStaging = names.filter(name => name.startsWith(path.basename(this.saved) + '.next-'));
    await Promise.allSettled([
      this.saved, this.saved + '.previous', ...oldRevisions.map(name => path.join(revisionRoot, name)),
      ...legacyStaging.map(name => path.join(this.root, name)),
    ].map(directory => rm(directory, { recursive: true, force: true })));
  }
}
