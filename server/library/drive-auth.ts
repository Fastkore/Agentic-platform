import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DriveAccount } from '../../shared/library.js';
import { externalLabels } from '../../shared/library.js';
import { LibrarySettings } from './settings.js';
import type { ExternalProvider, ExternalSelection } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { CloudDrive, providers } from './cloud-drive.js';

interface Tokens { appKeys?: DriveKeys; access: string; refresh?: string; expires: number; accountId?: string; appFolder?: boolean }
export interface DriveKeys { id: string; secret: string }
type AppKeys = DriveKeys & { screenCode?: boolean };
interface Draft { savedId?: string; accountName?: string; redirect: string; keys: AppKeys; setup?: AppKeys; replacing?: AppKeys; owner: string; provider: ExternalProvider; expires: number; verifier?: string; tokens?: Tokens; folders: Map<string, { name: string; identity: string }> }
const sameKeys = (a: DriveKeys, b: DriveKeys) => a.id === b.id && a.secret === b.secret;
const draftLifetime = 15 * 60_000;
const expiredDraft = () => new BridgeError('Сеанс подключения завершён. Войдите в диск ещё раз, чтобы выбрать папку.', 410);
const expired = () => new BridgeError('Подключение истекло. Нажмите «Подключить» ещё раз.', 409);
function environmentKeys(provider: ExternalProvider): DriveKeys | undefined {
  const prefix = 'BRIDGE_LIBRARY_' + provider.toUpperCase();
  const id = process.env[prefix + '_CLIENT_ID'], secret = process.env[prefix + '_CLIENT_SECRET'];
  return id && secret ? { id, secret } : undefined;
}
function redirectUri(provider: ExternalProvider, keys?: AppKeys) {
  if (provider === 'yandex' && (!keys || keys.screenCode)) return 'https://oauth.yandex.ru/verification_code';
  if (!process.env.BRIDGE_PUBLIC_ORIGIN) throw new BridgeError('Публичный адрес платформы не задан.', 503);
  return new URL('/library-oauth.html', process.env.BRIDGE_PUBLIC_ORIGIN).href;
}
async function exchange(provider: ExternalProvider, { id, secret }: DriveKeys, body: Record<string, string>, previous?: string, signal?: AbortSignal): Promise<Tokens> {
  let response: Response;
  try {
    response = await fetch(providers[provider].token, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }) });
  } catch { signal?.throwIfAborted(); throw new BridgeError('Сервис авторизации временно недоступен.', 503); }
  if (!response.ok) throw new BridgeError('Сервис отклонил авторизацию. Подключите аккаунт повторно.', 403);
  const result = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; account_id?: string };
  if (typeof result.access_token !== 'string' || !result.access_token) throw expired();
  return { access: result.access_token, refresh: result.refresh_token || previous, expires: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : Number.MAX_SAFE_INTEGER,
    accountId: provider === 'dropbox' && typeof result.account_id === 'string' ? result.account_id : undefined };
}
export class DriveAuth {
  private drafts = new Map<string, Draft>();
  private refreshing = new Map<string, Promise<Tokens>>();
  constructor(private settings: LibrarySettings, private db: DatabaseSync) {}
  accounts(): DriveAccount[] {
    return this.db.prepare(`SELECT a.id,a.provider,a.name,count(s.folder_id) libraries FROM drive_accounts a
      LEFT JOIN external_sources s ON s.account_id=a.id GROUP BY a.id ORDER BY a.provider,a.name,a.id`).all() as unknown as DriveAccount[];
  }
  removeAccount(id: string) {
    const removed = this.db.prepare('DELETE FROM drive_accounts WHERE id=? AND NOT EXISTS (SELECT 1 FROM external_sources WHERE account_id=?)').run(id,id);
    if (!removed.changes) throw new BridgeError('Аккаунт уже удалён или используется библиотеками.', 409);
    for (const [key, draft] of this.drafts) if (draft.savedId === id) this.drafts.delete(key);
  }
  private accountTokens(provider: ExternalProvider, id: string): Promise<Tokens> {
    const row = this.db.prepare('SELECT credentials FROM drive_accounts WHERE id=? AND provider=?').get(id,provider);
    if (!row) throw new BridgeError('Подключённый аккаунт не найден.', 404);
    const active = this.refreshing.get(id);
    if (active) return active;
    const tokens = this.settings.unseal<Tokens>(String(row.credentials));
    if (tokens.expires >= Date.now() + 60_000) return Promise.resolve(tokens);
    if (!tokens.refresh) throw expired();
    const keys = tokens.appKeys ?? this.requireKeys(provider);
    const task = exchange(provider, keys, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, tokens.refresh).then(next => {
      if (tokens.accountId && next.accountId && tokens.accountId !== next.accountId) throw expired();
      const latest = this.db.prepare('SELECT credentials FROM drive_accounts WHERE id=?').get(id);
      if (!latest) throw expiredDraft();
      const saved = this.settings.unseal<Tokens>(String(latest.credentials));
      const updated = { ...saved, ...next, accountId: next.accountId ?? saved.accountId, appKeys: keys };
      if (!this.db.prepare('UPDATE drive_accounts SET credentials=? WHERE id=? AND credentials=?')
        .run(this.settings.seal(updated),id,String(latest.credentials)).changes) throw expiredDraft();
      return updated;
    }).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id,task);
    return task;
  }
  async openAccount(provider: ExternalProvider, id: string, signal?: AbortSignal) {
    const tokens = await this.accountTokens(provider,id);
    signal?.throwIfAborted();
    return new CloudDrive(provider,tokens.access,signal,tokens.appFolder ? tokens.accountId : undefined);
  }
  async useAccount(owner: string, provider: ExternalProvider, id: string) {
    const tokens = await this.accountTokens(provider,id);
    const state = randomUUID();
    this.clearExpired();
    this.drafts.set(state,{ owner,provider,savedId:id,tokens,keys:tokens.appKeys ?? this.requireKeys(provider),redirect:'',
      expires:Math.min(tokens.expires,Date.now()+draftLifetime),folders:new Map() });
    return { state };
  }
  private clearExpired() {
    for (const [key,draft] of this.drafts) if (draft.expires <= Date.now()) this.drafts.delete(key);
  }
  private checkAccountName(provider: ExternalProvider, name?: string) {
    if (name && this.db.prepare('SELECT 1 FROM drive_accounts WHERE provider=? AND name=?').get(provider,name)) {
      throw new BridgeError('Аккаунт с таким названием уже есть. Выберите его из списка или укажите другое название.', 409);
    }
  }
  private requireReplaceableDropbox() {
    if (this.db.prepare("SELECT 1 FROM external_sources WHERE provider='dropbox' LIMIT 1").get()) throw new BridgeError('К текущим ключам Dropbox ещё привязаны библиотеки. Сначала отключите эти библиотеки или войдите в другой аккаунт с текущими ключами.', 409);
  }
  private keys(provider: ExternalProvider) {
    return this.settings.read<AppKeys>(provider) ?? environmentKeys(provider);
  }
  private requireKeys(provider: ExternalProvider) {
    const keys = this.keys(provider);
    if (!keys) throw new BridgeError('Введите ключи приложения в мастере подключения.', 409);
    return keys;
  }
  status(provider: ExternalProvider) {
    const keys = this.keys(provider);
    return { configured: !!keys, redirectUri: redirectUri(provider, keys) };
  }
  begin(owner: string, provider: ExternalProvider, setup?: DriveKeys, options?: { replaceDropbox?: boolean; switchAccount?: boolean; accountName?: string }) {
    this.checkAccountName(provider, options?.accountName?.trim());
    const existing = this.keys(provider);
    const replacing = provider === 'dropbox' && options?.replaceDropbox && setup && existing;
    if (existing && setup && !replacing) throw new BridgeError('Сервис уже настроен. Обновите форму, чтобы войти.', 409);
    if (replacing && setup && !sameKeys(replacing, setup)) this.requireReplaceableDropbox();
    const newKeys = setup && (provider === 'yandex' ? { ...setup, screenCode: true } : setup);
    const keys = newKeys ?? existing ?? this.requireKeys(provider);
    const redirect = redirectUri(provider, keys);
    this.clearExpired();
    const state = randomUUID(), verifier = randomBytes(48).toString('base64url');
    this.drafts.set(state, { provider, owner, keys, accountName: options?.accountName?.trim(), setup: newKeys, replacing: replacing || undefined, redirect, verifier, expires: Date.now() + draftLifetime, folders: new Map() });
    const params = new URLSearchParams({ client_id: keys.id, redirect_uri: redirect, state, response_type: 'code', scope: providers[provider].scope,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (provider === 'dropbox') {
      params.set('token_access_type', 'offline');
      if (options?.switchAccount || options?.replaceDropbox) params.set('force_reauthentication', 'true');
    }
    if (provider === 'yandex' && options?.switchAccount) params.set('force_confirm', 'yes');
    if (provider === 'google') { params.set('access_type', 'offline'); params.set('prompt', 'consent select_account'); }
    return { state, url: providers[provider].authorize + '?' + params };
  }
  private draft(owner: string, id: string) {
    const draft = this.drafts.get(id);
    if (!draft || draft.owner !== owner || draft.expires <= Date.now()) throw expiredDraft();
    return draft;
  }
  async finish(owner: string, state: string, code: string) {
    const draft = this.draft(owner, state), verifier = draft.verifier;
    if (!verifier) throw expiredDraft();
    delete draft.verifier;
    const setup = draft.setup;
    delete draft.setup;
    const tokens = await exchange(draft.provider, draft.keys, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: draft.redirect });
    this.draft(owner, state);
    this.checkAccountName(draft.provider, draft.accountName);
    if (setup) {
      const current = this.keys(draft.provider);
      if (current && !sameKeys(current, setup)) {
        if (!draft.replacing || !sameKeys(current, draft.replacing)) throw new BridgeError('Другой администратор уже подключил сервис. Войдите ещё раз.', 409);
        this.requireReplaceableDropbox();
        // Older accounts may predate per-account client credentials. Keep their refresh tokens usable.
        for (const row of this.db.prepare("SELECT id,credentials FROM drive_accounts WHERE provider='dropbox'").all()) {
          const saved = this.settings.unseal<Tokens>(String(row.credentials));
          if (!saved.appKeys) this.db.prepare('UPDATE drive_accounts SET credentials=? WHERE id=?')
            .run(this.settings.seal({ ...saved, appKeys: current }), String(row.id));
        }
        this.settings.write(draft.provider, setup);
        for (const [id, entry] of this.drafts) {
          if (id !== state && entry.provider === 'dropbox') this.drafts.delete(id);
        }
      } else if (!current) this.settings.write(draft.provider, setup);
    }
    tokens.appKeys = { id: draft.keys.id, secret: draft.keys.secret };
    const id = randomUUID();
    const name = draft.accountName || externalLabels[draft.provider] + ' · ' + id.slice(0,8);
    this.db.prepare('INSERT INTO drive_accounts(id,provider,name,credentials) VALUES (?,?,?,?)')
      .run(id,draft.provider,name,this.settings.seal(tokens));
    draft.savedId = id;
    draft.tokens = tokens;
    draft.expires = Math.min(tokens.expires, Date.now() + draftLifetime);
    return { ok: true, account: draft.savedId };
  }
  async folders(owner: string, id: string, parent?: string, includeAppFolder = false) {
    const draft = this.draft(owner, id);
    if (!draft.tokens || parent !== undefined && !draft.folders.has(parent)) throw expiredDraft();
    const drive = new CloudDrive(draft.provider, draft.tokens.access);
    const folders = [];
    for await (const entry of drive.children(parent ?? drive.root())) if (entry.dir) {
      folders.push({ id: entry.id, name: entry.name });
      draft.folders.set(entry.id, { name: entry.name, identity: entry.identity ?? entry.id });
      if (draft.folders.size > 50000) throw new BridgeError('Слишком много папок для выбора.', 413);
    }
    if (includeAppFolder && draft.provider === 'dropbox' && parent === undefined && draft.tokens.accountId) {
      if (draft.tokens.appFolder === undefined) {
        draft.tokens.appFolder = await drive.isDropboxAppFolder().catch(() => undefined);
        if (draft.savedId && draft.tokens.appFolder !== undefined) {
          const row = this.db.prepare('SELECT credentials FROM drive_accounts WHERE id=?').get(draft.savedId);
          if (!row) throw expiredDraft();
          const saved = this.settings.unseal<Tokens>(String(row.credentials));
          saved.appFolder = draft.tokens.appFolder;
          this.db.prepare('UPDATE drive_accounts SET credentials=? WHERE id=?').run(this.settings.seal(saved),draft.savedId);
        }
      }
      if (draft.tokens.appFolder) {
        const name = 'Папка приложения Dropbox';
        draft.folders.set('', { name, identity: 'dropbox-app-folder:' + draft.tokens.accountId });
        folders.push({ id: '', name });
      }
    }
    draft.expires = Math.min(draft.tokens.expires, Date.now() + draftLifetime);
    return folders.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  }
  selected(owner: string, selection: ExternalSelection) {
    const draft = this.draft(owner, selection.connection), folder = draft.folders.get(selection.folder);
    if (!draft.savedId || !draft.tokens || !folder) throw new BridgeError('Выберите папку подключённого диска.');
    return { provider: draft.provider, ...folder, account: draft.savedId };
  }
  discard(id: string) { this.drafts.delete(id); }
}
