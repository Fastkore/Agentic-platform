import { createHash, randomUUID } from 'node:crypto';
import { excluded, suspiciousSecret, pathKey, profileExclusions, type ExternalProvider, type ExternalSelection, type ExternalSummary } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { blobKey } from './blob-store.js';
import { CloudDrive, entryPath, type DriveEntry } from './cloud-drive.js';
import { DriveAuth } from './drive-auth.js';
import type { FolderRow, LibraryRegistry, StateFileRow } from './registry.js';

interface Source { provider: ExternalProvider; remote_id: string; identity: string; account_id: string; name: string; checked_at: string | null; error: string | null; lease_until: number | null }
type ExternalFile = DriveEntry & { path: string };
type Prepared = Omit<StateFileRow, 'content' | 'state_id'>;
const changed = () => new BridgeError('Папка на диске изменилась. Дождитесь синхронизации и повторите запрос.', 409);
const message = (e: unknown) => e instanceof BridgeError ? e.message : 'Не удалось прочитать внешний диск. Повторите подключение или синхронизацию.';
export class ExternalLibraries {
  readonly auth: DriveAuth;
  private running = new Map<string, Promise<void>>();
  private opening = new Map<string, Promise<CloudDrive>>();
  private lifetimes = new Map<string, AbortController>();
  private stopped = false;
  signal(id: string) {
    let controller = this.lifetimes.get(id);
    if (!controller) { controller = new AbortController(); this.lifetimes.set(id, controller); }
    return controller.signal;
  }
  cancel(id: string) {
    this.lifetimes.get(id)?.abort();
    this.lifetimes.delete(id);
    return this.running.get(id);
  }
  constructor(private registry: LibraryRegistry) {
    this.auth = new DriveAuth(registry.settings, registry.db);
  }
  private get db() { return this.registry.db; }
  has(id: string) { return !!this.db.prepare('SELECT 1 FROM external_sources WHERE folder_id=?').get(id); }
  private source(id: string) { return this.db.prepare('SELECT * FROM external_sources WHERE folder_id=?').get(id) as Source | undefined; }
  summary(id: string): ExternalSummary | undefined {
    const row = this.source(id);
    if (!row) return;
    const preparing = this.db.prepare("SELECT total_files FROM states WHERE folder_id=? AND status='preparing'").get(id) as { total_files: number } | undefined;
    return { provider: row.provider, folder: row.name, checkedAt: row.checked_at ?? undefined, error: row.error ?? undefined,
      preparingFiles: preparing?.total_files, syncing: this.running.has(id) || (row.lease_until ?? 0) > Date.now() || !!preparing };
  }
  attach(owner: string, id: string, selection: ExternalSelection) {
    const { provider, name, identity, account } = this.auth.selected(owner, selection);
    this.db.prepare("INSERT INTO external_sources(folder_id,provider,remote_id,identity,name,account_id,credentials) VALUES (?,?,?,?,?,?,'')").run(id, provider, selection.folder, identity, name, account);
  }
  reconnect(owner: string, id: string, selection: ExternalSelection) {
    const next = this.auth.selected(owner, selection), old = this.source(id);
    if (!old || old.provider !== next.provider || old.identity !== next.identity) throw new BridgeError('Для восстановления связи выберите исходную папку библиотеки.');
    this.db.prepare('UPDATE external_sources SET account_id=?,remote_id=?,name=?,error=NULL WHERE folder_id=?').run(next.account, selection.folder, next.name, id);
    this.auth.discard(selection.connection);
  }
  private drive(id: string, source: Source) {
    const existing = this.opening.get(id);
    if (existing) return existing;
    const task = this.auth.openAccount(source.provider,source.account_id,this.signal(id)).finally(() => this.opening.delete(id));
    this.opening.set(id, task);
    return task;
  }
  private async inventory(drive: CloudDrive, source: Source, folder: FolderRow) {
    if (await drive.folderIdentity(source.remote_id) !== source.identity) throw changed();
    const pending = [{ id: source.remote_id, prefix: '' }], visited = new Set<string>(), paths = new Set<string>();
    const files: ExternalFile[] = [], rules = profileExclusions(folder.profile);
    while (pending.length) {
      this.checkActive(folder.id);
      const dir = pending.pop()!;
      if (visited.has(dir.id)) throw new BridgeError('Обнаружена повторная ссылка на каталог.', 422);
      visited.add(dir.id);
      for await (const item of drive.children(dir.id)) {
        const path = entryPath(dir.prefix, item);
        if (excluded(item.dir ? path + '/_' : path, rules)) continue;
        const key = pathKey(path);
        if (paths.has(key)) throw new BridgeError('Совпадают имена в папке: ' + path + '. Переименуйте один из файлов на диске.', 422);
        paths.add(key);
        if (paths.size > this.registry.limits.maxFiles * 2 || files.length >= this.registry.limits.maxFiles && !item.dir) throw new BridgeError('Превышен лимит файлов библиотеки.', 413);
        if (item.dir) pending.push({ id: item.id, prefix: path + '/' });
        else files.push({ ...item, path });
      }
    }
    files.sort((a,b) => a.path < b.path ? -1 : 1);
    const signature = createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.id, f.identity, f.revision, f.size]))).digest('hex');
    return { signature, files };
  }
  private checkActive(id: string) {
    if (this.stopped || !this.has(id)) throw new BridgeError('Подключение закрыто.', 409);
  }
  private signature(state: string) {
    return this.db.prepare('SELECT drive_signature FROM states WHERE id=?').get(state)?.drive_signature;
  }
  /** Validate the live folder before disclosing cached names, excerpts, original bytes or an agent answer. */
  async verify(id: string, state: string) {
    const source = this.source(id);
    if (!source) return;
    const folder = this.registry.folderRow(id)!;
    const drive = await this.drive(id, source);
    const inventory = await this.inventory(drive, source, folder);
    if (!this.has(id) || inventory.signature !== this.signature(state)) {
      this.schedule(id);
      throw changed();
    }
  }
  link(state: string, path: string) {
    return this.db.prepare('SELECT link FROM external_files WHERE state_id=? AND path=?').get(state,path)?.link as string | undefined;
  }
  schedule(id: string) { void this.sync(id).catch(() => {}); }
  async poll() {
    for (const row of this.db.prepare('SELECT e.folder_id FROM external_sources e JOIN folders f ON f.id=e.folder_id WHERE f.active=1').all()) {
      if (this.stopped) return;
      await this.sync(String(row.folder_id)).catch(() => {});
    }
  }
  async stop() {
    this.stopped = true;
    for (const id of this.lifetimes.keys()) this.cancel(id);
    await Promise.allSettled([...this.running.values(), ...this.opening.values()]);
  }
  sync(id: string) {
    if (this.stopped) return Promise.resolve();
    const existing = this.running.get(id);
    if (existing) return existing;
    const owner = randomUUID(), leaseMs = 120_000;
    const acquired = this.registry.tx(() => {
      const row = this.db.prepare('UPDATE external_sources SET sync_owner=?,lease_until=? WHERE folder_id=? AND (sync_owner IS NULL OR lease_until<=?)')
        .run(owner,Date.now() + leaseMs,id,Date.now());
      if (!row.changes) return false;
      // Recover unpublished objects after an interrupted import.
      this.db.prepare("UPDATE blobs SET state='orphan',orphaned_at=? WHERE folder_id=? AND state='pending' AND kind='original'").run(Date.now(),id);
      return true;
    });
    if (!acquired) return Promise.resolve();
    const heartbeat = setInterval(() => {
      this.db.prepare('UPDATE external_sources SET lease_until=? WHERE folder_id=? AND sync_owner=?').run(Date.now() + leaseMs,id,owner);
    }, leaseMs / 3);
    heartbeat.unref();
    const task = this.synchronize(id, owner).catch(e => {
      this.db.prepare('UPDATE external_sources SET error=? WHERE folder_id=? AND sync_owner=?').run(message(e), id, owner);
      throw new BridgeError(message(e), e instanceof BridgeError ? e.statusCode : 503);
    }).finally(() => {
      clearInterval(heartbeat); this.running.delete(id);
      this.db.prepare('UPDATE external_sources SET sync_owner=NULL,lease_until=NULL WHERE folder_id=? AND sync_owner=?').run(id,owner);
    });
    this.running.set(id, task); return task;
  }
  private async synchronize(id: string, owner: string) {
    const source = this.source(id), folder = this.registry.folderRow(id);
    if (!source || !folder) throw new BridgeError('Внешняя библиотека не найдена.', 404);
    if (this.db.prepare("SELECT 1 FROM states WHERE folder_id=? AND status='preparing'").get(id)) return;
    const drive = await this.drive(id, source), { signature, files } = await this.inventory(drive, source, folder);
    const checked = () => this.db.prepare('UPDATE external_sources SET checked_at=?,error=NULL WHERE folder_id=?').run(new Date().toISOString(), id);
    const failed = this.db.prepare("SELECT drive_signature FROM states WHERE folder_id=? AND base_state IS ? AND status='failed' AND failure='partial_index' ORDER BY created_at DESC LIMIT 1").get(id,folder.current_state);
    if (failed?.drive_signature === signature || folder.current_state && signature === this.signature(folder.current_state)) { checked(); return; }
    const cached = this.db.prepare('SELECT f.*,e.remote_id,e.revision FROM external_files e JOIN state_files f ON f.state_id=e.state_id AND f.path=e.path WHERE e.state_id=?').all(folder.current_state) as (StateFileRow & { remote_id: string; revision: string })[];
    const previous = new Map(cached.map(f => [f.remote_id, f]));
    const prepared: Prepared[] = [], staged: string[] = [];
    let total = 0;
    try {
      for (const file of files) {
        this.checkActive(id);
        const limit = Math.min(this.registry.limits.maxFileBytes, folder.quota_bytes - total);
        const old = previous.get(file.identity ?? file.id);
        let entry: Prepared;
        if (old && old.revision === file.revision) {
          entry = { ...old, path: file.path, path_key: pathKey(file.path) };
        } else {
          if ((file.size ?? 0) > limit) throw new BridgeError('Превышен лимит размера: ' + file.path, 413);
          const data = await drive.download(file, limit);
          this.checkActive(id);
          if (file.size !== undefined && file.size !== data.length) throw changed();
          const sample = data.subarray(0, 256 * 1024);
          if (!sample.includes(0) && suspiciousSecret(sample.toString('utf8')).length) {
            throw new BridgeError('Возможный секрет в файле ' + file.path + '. Уберите файл из подключённой папки и повторите синхронизацию.', 422);
          }
          const blob = 'b_' + randomUUID(), key = blobKey('external_' + id, blob);
          const sha256 = createHash('sha256').update(data).digest('hex');
          this.db.prepare("INSERT INTO blobs(id,folder_id,object_key,sha256,size,kind,state,created_at) VALUES (?,?,?,?,?,'original','pending',?)").run(blob,id,key,sha256,data.length,Date.now());
          staged.push(blob);
          await this.registry.objectStore(key).put(key, data);
          entry = { file_id: '', blob_id: blob, size: data.length, sha256, path: file.path, path_key: pathKey(file.path) };
        }
        if (entry.size > limit) throw new BridgeError('Превышен лимит размера: ' + file.path, 413);
        prepared.push(entry); total += entry.size;
      }
      this.checkActive(id);
      if (staged.length && (await this.inventory(drive, source, folder)).signature !== signature) throw changed();
      this.registry.tx(() => {
        this.checkActive(id);
        if (!this.db.prepare('SELECT 1 FROM external_sources WHERE folder_id=? AND sync_owner=?').get(id,owner)) throw changed();
        const current = this.registry.folderRow(id)!;
        if (current.current_state !== folder.current_state || current.revision !== folder.revision) throw changed();
        const state = this.registry.prepareState(current, prepared, current.current_state, 'system', profileExclusions(folder.profile));
        const insert = this.db.prepare('INSERT INTO external_files(state_id,path,remote_id,revision,link) VALUES (?,?,?,?,?)');
        for (const file of files) insert.run(state,file.path,file.identity ?? file.id,file.revision,file.link ?? null);
        this.db.prepare('UPDATE states SET drive_signature=? WHERE id=?').run(signature,state);
        const verified = this.db.prepare("UPDATE blobs SET state='verified' WHERE id=?");
        for (const blob of staged) verified.run(blob);
        this.registry.tryPublish(state); checked();
      });
    } catch (e) {
      const orphan = this.db.prepare("UPDATE blobs SET state='orphan',orphaned_at=? WHERE id=? AND state IN ('pending','deleted','orphan')");
      for (const blob of staged) orphan.run(Date.now(),blob);
      throw e;
    }
  }
}
