import type { ExternalProvider } from '../../shared/library.js';
import { pathProblem } from '../../shared/library.js';
import { BridgeError } from '../store.js';

export const providers = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/drive.readonly' },
  dropbox: { authorize: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', scope: 'files.metadata.read files.content.read' },
  yandex: { authorize: 'https://oauth.yandex.ru/authorize', token: 'https://oauth.yandex.ru/token', scope: 'cloud_api:disk.read' },
};
export interface DriveEntry { id: string; name: string; dir: boolean; revision: string; size?: number; link?: string; exportMime?: string; identity?: string }
interface GooglePage {
  nextPageToken?: string; incompleteSearch?: boolean;
  files: { id: string; name: string; mimeType: string; size?: string; version: string; capabilities?: { canDownload?: boolean } }[];
}
interface DropboxPage {
  cursor: string; has_more: boolean;
  entries: { '.tag': string; id: string; name: string; rev: string; size?: number; path_display: string; is_downloadable?: boolean }[];
}
interface DiskPage {
  type: string;
  _embedded: { total: number; items: { path: string; resource_id: string; name: string; type: string; revision?: number; sha256?: string; size?: number }[] };
}
const googleDrive = 'https://www.googleapis.com/drive/v3/files';
const disk = 'https://cloud-api.yandex.net/v1/disk/resources';
const dropboxFolders = 'https://api.dropboxapi.com/2/files/list_folder';
const exportsByMime: Record<string, [string, string]> = {
  'application/vnd.google-apps.document': ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  'application/vnd.google-apps.spreadsheet': ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  'application/vnd.google-apps.presentation': ['.pdf', 'application/pdf'],
};
const invalid = () => new BridgeError('Диск вернул неполные данные. Повторите синхронизацию.', 502);
async function cloudRequest(url: string, init: RequestInit = {}, downloadHost?: (host: string) => boolean, redirects = 0): Promise<Response> {
  let res: Response;
  const timeout = AbortSignal.timeout(45_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try { res = await fetch(url, { ...init, redirect: downloadHost ? 'manual' : 'error', signal }); }
  catch { init.signal?.throwIfAborted(); throw new BridgeError('Не удалось связаться с внешним диском.', 503); }
  if (downloadHost && [301,302,303,307,308].includes(res.status)) {
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location || redirects >= 5) throw invalid();
    const next = new URL(location,url);
    if (next.protocol !== 'https:' || next.username || next.password || next.port || !downloadHost(next.hostname)) throw invalid();
    return cloudRequest(next.href, next.origin === new URL(url).origin ? init : { signal: init.signal }, downloadHost, redirects + 1);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new BridgeError([401,403,404,409].includes(res.status) ? 'Файл или подключение недоступны. Проверьте права на диске.' : 'Сервис диска временно недоступен.', [401,403,404,409].includes(res.status) ? 403 : 503);
  }
  return res;
}
export class CloudDrive {
  constructor(readonly provider: ExternalProvider, private token: string, private signal?: AbortSignal, private dropboxAppAccount?: string) {}
  private request(url: string, init: RequestInit, downloadHost?: (host: string) => boolean) {
    this.signal?.throwIfAborted();
    return cloudRequest(url, { ...init, signal: this.signal }, downloadHost);
  }
  private get headers() { return { Authorization: (this.provider === 'yandex' ? 'OAuth ' : 'Bearer ') + this.token }; }
  root() { return this.provider === 'google' ? 'root' : this.provider === 'yandex' ? 'disk:/' : ''; }
  async isDropboxAppFolder(): Promise<boolean | undefined> {
    // Only App Folder tokens reject a valid Path-Root header with this specific error.
    const response = await fetch(dropboxFolders, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { ...this.headers, 'Content-Type': 'application/json', 'Dropbox-API-Path-Root': '{".tag":"home"}' },
      body: JSON.stringify({ path: '', limit: 1 }),
    });
    if (response.status === 400) {
      if (/Path root is not supported for sandbox app\.?\s*$/.test(await response.text())) return true;
      return undefined;
    }
    await response.body?.cancel();
    return response.ok ? false : undefined;
  }
  private google(folder: string) {
    if (!/^[\w-]+$/.test(folder)) throw invalid();
    return googleDrive + '/' + folder;
  }
  /** A folder disappearing (or being replaced at the same path) must never look like an empty listing. */
  async folderIdentity(folder: string) {
    if (this.provider === 'google') {
      const row = await (await this.request(this.google(folder) + '?fields=id,mimeType,trashed&supportsAllDrives=true', { headers: this.headers })).json() as {id: string; mimeType: string; trashed: boolean};
      if (row.trashed || row.mimeType !== 'application/vnd.google-apps.folder' || !row.id) throw invalid();
      return String(row.id);
    }
    if (this.provider === 'yandex') {
      const row = await (await this.request(disk + '?' + new URLSearchParams({ path: folder, fields: 'type,resource_id' }), { headers: this.headers })).json() as {type: string; resource_id: string};
      if (row.type !== 'dir' || !row.resource_id) throw invalid();
      return String(row.resource_id);
    }
    if (folder === '') {
      if (!this.dropboxAppAccount) throw new BridgeError('Корень можно подключить только для приложения Dropbox с доступом App Folder.', 403);
      return 'dropbox-app-folder:' + this.dropboxAppAccount;
    }
    return folder; // Dropbox folder IDs survive moves. list_folder verifies access.
  }
  async *children(folder: string): AsyncGenerator<DriveEntry> {
    let cursor = '';
    const pages = new Set<string>();
    do {
      if (pages.has(cursor) || pages.size >= 10000) throw invalid();
      pages.add(cursor);
      if (this.provider === 'google') {
        this.google(folder);
        const params = new URLSearchParams({ q: "'" + folder + "' in parents and trashed=false", fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,version,webViewLink,capabilities(canDownload))', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
        if (cursor) params.set('pageToken', cursor);
        const page = await (await this.request(googleDrive + '?' + params, { headers: this.headers })).json() as GooglePage;
        if (page.incompleteSearch || !Array.isArray(page.files)) throw invalid();
        for (const f of page.files) {
          const dir = f.mimeType === 'application/vnd.google-apps.folder', exp = exportsByMime[f.mimeType];
          if (!dir && (!f.capabilities?.canDownload || (f.mimeType.startsWith('application/vnd.google-apps.') && !exp))) continue;
          yield { id: f.id, name: f.name + (exp?.[0] ?? ''), dir, revision: f.version, size: exp ? undefined : Number(f.size ?? 0), exportMime: exp?.[1], link: 'https://drive.google.com/open?id=' + encodeURIComponent(f.id) };
        }
        cursor = page.nextPageToken ?? '';
      } else if (this.provider === 'dropbox') {
        const url = dropboxFolders + (cursor ? '/continue' : '');
        const page = await (await this.request(url, { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor ? { cursor } : { path: folder, recursive: false, include_non_downloadable_files: false }) })).json() as DropboxPage;
        if (!Array.isArray(page.entries) || (page.has_more && !page.cursor)) throw invalid();
        for (const f of page.entries) {
          if (!['file','folder'].includes(f['.tag']) || f.is_downloadable === false) continue;
          yield { id: f.id, name: f.name, dir: f['.tag'] === 'folder', revision: f.rev, size: f.size,
            link: this.dropboxAppAccount ? undefined : 'https://www.dropbox.com/home' + f.path_display.split('/').map(encodeURIComponent).join('/') };
        }
        cursor = page.has_more ? page.cursor : '';
      } else {
        const offset = Number(cursor || 0);
        const params = new URLSearchParams({ path: folder, limit: '1000', offset: String(offset), sort: 'name' });
        const page = await (await this.request(disk + '?' + params, { headers: this.headers })).json() as DiskPage;
        const entries = page._embedded?.items;
        if (page.type !== 'dir' || !Array.isArray(entries) || !Number.isSafeInteger(page._embedded.total)) throw invalid();
        for (const f of entries) yield { id: f.path, identity: f.resource_id, name: f.name, dir: f.type === 'dir', revision: String(f.revision ?? f.sha256 ?? ''), size: f.size,
          link: 'https://disk.yandex.ru/client/disk' + f.path.replace(/^disk:/, '').split('/').map(encodeURIComponent).join('/') };
        if (!entries.length && offset < page._embedded.total) throw invalid();
        cursor = offset + entries.length < page._embedded.total ? String(offset + entries.length) : '';
      }
    } while (cursor);
  }
  async download(file: DriveEntry, limit: number) {
    let res: Response;
    if (this.provider === 'google') {
      const url = this.google(file.id) + (file.exportMime ? '/export?mimeType=' + encodeURIComponent(file.exportMime) : '?alt=media&supportsAllDrives=true');
      res = await this.request(url, { headers: this.headers }, host => /(^|\.)(googleapis\.com|googleusercontent\.com)$/.test(host));
    } else if (this.provider === 'dropbox') {
      res = await this.request('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { ...this.headers, 'Dropbox-API-Arg': JSON.stringify({ path: 'rev:' + file.revision }) } });
    } else {
      const { href } = await (await this.request(disk + '/download?' + new URLSearchParams({ path: file.id }), { headers: this.headers })).json() as {href: string};
      const url = new URL(href);
      const downloadHost = (host: string) => /(^|\.)(yandex\.(net|ru|com)|yandexcloud\.net)$/.test(host);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !downloadHost(url.hostname)) throw invalid();
      res = await this.request(url.href, {}, downloadHost); // Signed download URL must never receive the account token.
    }
    const chunks: Buffer[] = []; let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw invalid();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new BridgeError('Размер файла превышает лимит библиотеки.', 413);
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks, size);
  }
}
export function entryPath(parent: string, entry: DriveEntry) {
  if (!entry.id || !entry.name || entry.name.includes('/') || !entry.dir && !entry.revision) throw invalid();
  const path = (parent + entry.name).normalize('NFC');
  if (pathProblem(path)) throw new BridgeError('Недопустимый путь на внешнем диске: ' + path, 422);
  return path;
}
