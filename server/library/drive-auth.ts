import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { LibrarySettings } from './settings.js';
import type { ExternalProvider, ExternalSelection } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { CloudDrive, providers } from './cloud-drive.js';

interface Tokens { access: string; refresh?: string; expires: number; accountId?: string; appFolder?: boolean }
export interface DriveKeys { id: string; secret: string }
type AppKeys = DriveKeys & { screenCode?: boolean };
interface Draft { redirect: string; keys: AppKeys; setup?: AppKeys; replacing?: AppKeys; owner: string; provider: ExternalProvider; expires: number; verifier?: string; tokens?: Tokens; folders: Map<string, { name: string; identity: string }> }
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
  constructor(private settings: LibrarySettings, private hasDropboxLibraries = () => false) {}
  private requireReplaceableDropbox() {
    if (this.hasDropboxLibraries()) throw new BridgeError('К текущим ключам Dropbox ещё привязаны библиотеки. Сначала отключите эти библиотеки или войдите в другой аккаунт с текущими ключами.', 409);
  }
  private keys(provider: ExternalProvider) {
    return this.settings.read<AppKeys>(provider) ?? environmentKeys(provider);
  }
  private requireKeys(provider: ExternalProvider) {
    const keys = this.keys(provider);
    if (!keys) throw new BridgeError('Введите ключи приложения в мастере подключения.', 409);
    return keys;
  }
  async open(provider: ExternalProvider, sealed: string, save: (sealed: string) => void, signal?: AbortSignal) {
    let tokens = this.settings.unseal<Tokens>(sealed);
    if (tokens.expires < Date.now() + 60_000) {
      if (!tokens.refresh) throw expired();
      const refreshed = await exchange(provider, this.requireKeys(provider), { grant_type: 'refresh_token', refresh_token: tokens.refresh }, tokens.refresh, signal);
      signal?.throwIfAborted();
      if (tokens.accountId && refreshed.accountId && tokens.accountId !== refreshed.accountId) throw expired();
      tokens = { ...refreshed, accountId: refreshed.accountId ?? tokens.accountId, appFolder: tokens.appFolder };
      save(this.settings.seal(tokens));
    }
    return new CloudDrive(provider, tokens.access, signal, tokens.appFolder ? tokens.accountId : undefined);
  }
  status(provider: ExternalProvider) {
    const keys = this.keys(provider);
    return { configured: !!keys, redirectUri: redirectUri(provider, keys) };
  }
  begin(owner: string, provider: ExternalProvider, setup?: DriveKeys, options?: { replaceDropbox?: boolean; switchAccount?: boolean }) {
    const existing = this.keys(provider);
    const replacing = provider === 'dropbox' && options?.replaceDropbox && setup && existing;
    if (existing && setup && !replacing) throw new BridgeError('Сервис уже настроен. Обновите форму, чтобы войти.', 409);
    if (replacing && setup && !sameKeys(replacing, setup)) this.requireReplaceableDropbox();
    const newKeys = setup && (provider === 'yandex' ? { ...setup, screenCode: true } : setup);
    const keys = newKeys ?? existing ?? this.requireKeys(provider);
    const redirect = redirectUri(provider, keys);
    for (const [key, draft] of this.drafts) if (draft.expires <= Date.now()) this.drafts.delete(key);
    const state = randomUUID(), verifier = randomBytes(48).toString('base64url');
    this.drafts.set(state, { provider, owner, keys, setup: newKeys, replacing: replacing || undefined, redirect, verifier, expires: Date.now() + draftLifetime, folders: new Map() });
    const params = new URLSearchParams({ client_id: keys.id, redirect_uri: redirect, state, response_type: 'code', scope: providers[provider].scope,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (provider === 'dropbox') {
      params.set('token_access_type', 'offline');
      if (options?.switchAccount || options?.replaceDropbox) params.set('force_reauthentication', 'true');
    }
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
    if (setup) {
      const current = this.keys(draft.provider);
      if (current && !sameKeys(current, setup)) {
        if (!draft.replacing || !sameKeys(current, draft.replacing)) throw new BridgeError('Другой администратор уже подключил сервис. Войдите ещё раз.', 409);
        this.requireReplaceableDropbox();
        this.settings.write(draft.provider, setup);
        for (const [id, entry] of this.drafts) {
          if (id !== state && entry.provider === 'dropbox') this.drafts.delete(id);
        }
      } else if (!current) this.settings.write(draft.provider, setup);
    }
    draft.tokens = tokens;
    draft.expires = Math.min(tokens.expires, Date.now() + draftLifetime);
    return { ok: true };
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
      draft.tokens.appFolder ??= await drive.isDropboxAppFolder().catch(() => undefined);
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
    if (!draft.tokens || !folder) throw new BridgeError('Выберите папку подключённого диска.');
    return { provider: draft.provider, ...folder, sealed: this.settings.seal(draft.tokens) };
  }
  discard(id: string) { this.drafts.delete(id); }
}
