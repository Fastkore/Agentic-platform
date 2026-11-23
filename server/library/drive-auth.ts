import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExternalProvider, ExternalSelection } from '../../shared/library.js';
import { externalLabels } from '../../shared/library.js';
import { BridgeError } from '../store.js';
import { CloudDrive, providers } from './cloud-drive.js';

interface Tokens { access: string; refresh?: string; expires: number }
interface Draft { owner: string; provider: ExternalProvider; expires: number; verifier?: string; tokens?: Tokens; folders: Map<string, { name: string; identity: string }> }
const expired = () => new BridgeError('Подключение истекло. Нажмите «Подключить» ещё раз.', 409);
function settings(provider: ExternalProvider) {
  const prefix = 'BRIDGE_LIBRARY_' + provider.toUpperCase();
  const id = process.env[prefix + '_CLIENT_ID'], secret = process.env[prefix + '_CLIENT_SECRET'], origin = process.env.BRIDGE_PUBLIC_ORIGIN;
  if (!id || !secret || !origin) throw new BridgeError('Для ' + externalLabels[provider] + ' администратору сервера нужно настроить OAuth-приложение и публичный адрес платформы.', 503);
  return { id, secret, redirect: new URL('/library-oauth.html', origin).href };
}
async function exchange(provider: ExternalProvider, body: Record<string, string>, previous?: string): Promise<Tokens> {
  const { id, secret } = settings(provider);
  let response: Response;
  try {
    response = await fetch(providers[provider].token, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }) });
  } catch { throw new BridgeError('Сервис авторизации временно недоступен.', 503); }
  if (!response.ok) throw new BridgeError('Сервис отклонил авторизацию. Подключите аккаунт повторно.', 403);
  const result = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (typeof result.access_token !== 'string' || !result.access_token) throw expired();
  return { access: result.access_token, refresh: result.refresh_token || previous, expires: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : Number.MAX_SAFE_INTEGER };
}
export class DriveAuth {
  private drafts = new Map<string, Draft>();
  constructor(private root: string) {}
  private key() {
    const file = join(this.root, 'drive-oauth.key');
    try { return readFileSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const key = randomBytes(32);
    try { writeFileSync(file, key, { flag: 'wx', mode: 0o600 }); return key; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return readFileSync(file); }
  }
  seal(tokens: Tokens) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  async open(provider: ExternalProvider, sealed: string, save: (sealed: string) => void) {
    const data = Buffer.from(sealed, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    let tokens: Tokens = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
    if (tokens.expires < Date.now() + 60_000) {
      if (!tokens.refresh) throw expired();
      tokens = await exchange(provider, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, tokens.refresh);
      save(this.seal(tokens));
    }
    return new CloudDrive(provider, tokens.access);
  }
  begin(owner: string, provider: ExternalProvider) {
    const { id, redirect } = settings(provider);
    for (const [key, draft] of this.drafts) if (draft.expires <= Date.now()) this.drafts.delete(key);
    const state = randomUUID(), verifier = randomBytes(48).toString('base64url');
    this.drafts.set(state, { provider, owner, verifier, expires: Date.now() + 900_000, folders: new Map() });
    const params = new URLSearchParams({ client_id: id, redirect_uri: redirect, state, response_type: 'code', scope: providers[provider].scope,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (provider === 'dropbox') params.set('token_access_type', 'offline');
    if (provider === 'google') { params.set('access_type', 'offline'); params.set('prompt', 'consent select_account'); }
    return { state, url: providers[provider].authorize + '?' + params };
  }
  private draft(owner: string, id: string) {
    const draft = this.drafts.get(id);
    if (!draft || draft.owner !== owner || draft.expires <= Date.now()) throw expired();
    return draft;
  }
  async finish(owner: string, state: string, code: string) {
    const draft = this.draft(owner, state), verifier = draft.verifier;
    if (!verifier) throw expired();
    delete draft.verifier;
    draft.tokens = await exchange(draft.provider, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: settings(draft.provider).redirect });
    return { ok: true };
  }
  async folders(owner: string, id: string, parent?: string) {
    const draft = this.draft(owner, id);
    if (!draft.tokens || parent !== undefined && !draft.folders.has(parent)) throw expired();
    const drive = new CloudDrive(draft.provider, draft.tokens.access);
    const folders = [];
    for await (const entry of drive.children(parent ?? drive.root())) if (entry.dir) {
      folders.push({ id: entry.id, name: entry.name });
      draft.folders.set(entry.id, { name: entry.name, identity: entry.identity ?? entry.id });
      if (draft.folders.size > 50000) throw new BridgeError('Слишком много папок для выбора.', 413);
    }
    return folders.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  }
  selected(owner: string, selection: ExternalSelection) {
    const draft = this.draft(owner, selection.connection), folder = draft.folders.get(selection.folder);
    if (!draft.tokens || !folder) throw new BridgeError('Выберите папку подключённого диска.');
    return { provider: draft.provider, ...folder, sealed: this.seal(draft.tokens) };
  }
  discard(id: string) { this.drafts.delete(id); }
}
