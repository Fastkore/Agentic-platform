import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import type { Credential, ErpContext } from '../shared/types.js';
import { BridgeError, type Store } from './store.js';

export const sessionCookie = '__Host-bridge_session';
export const audience = 'fastkore-agent-platform';
export interface TrustedInstallation {
  id: string; name: string; validationUrl: string; secretFile: string; entityTypes: string[]; enabled: boolean;
}
export interface SsoConfig { installations: TrustedInstallation[] }
export interface TicketIdentity { installationId: string; externalUserId: string; displayName: string }
export type TicketValidator = (installation: TrustedInstallation, ticket: string) => Promise<unknown>;
export const stableId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(v);
export const entityType = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(v);
export const csrfFor = (token: string) => createHash('sha256').update(`bridge-csrf:${token}`).digest('hex');
export function validCsrf(token: string, candidate: unknown) {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(csrfFor(token)));
}
export function cookieToken(header?: string) {
  const matches = (header ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(sessionCookie + '='));
  if (matches.length > 1) throw new BridgeError('Неоднозначная сессия. Войдите из Fastkore заново.', 401);
  if (!matches.length) return '';
  const token = matches[0].slice(sessionCookie.length + 1);
  if (!/^ccb_s_[a-f0-9]{64}$/.test(token)) throw new BridgeError('Недействительная сессия Fastkore.', 401);
  return token;
}
export const setSessionCookie = (token: string, maxAge = 1800) => `${sessionCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

export function validateSsoConfig(value: unknown): SsoConfig {
  if (!value || typeof value !== 'object' || !Array.isArray((value as SsoConfig).installations) || (value as SsoConfig).installations.length > 50) throw new Error('Некорректная конфигурация Fastkore SSO.');
  const config = value as SsoConfig, ids = new Set<string>();
  for (const item of config.installations) {
    if (!item || !stableId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || typeof item.enabled !== 'boolean'
      || typeof item.secretFile !== 'string' || !path.isAbsolute(item.secretFile) || !Array.isArray(item.entityTypes) || item.entityTypes.length > 100 || !item.entityTypes.every(entityType)) throw new Error('Некорректная доверенная установка Fastkore.');
    let url: URL; try { url = new URL(item.validationUrl); } catch { throw new Error('Некорректный адрес проверки Fastkore.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/ai/validate-ticket') throw new Error('Проверка Fastkore требует фиксированный HTTPS /api/ai/validate-ticket без параметров.');
    ids.add(item.id);
  }
  return structuredClone(config);
}
export async function loadSsoConfig(file?: string) {
  if (!file) return undefined;
  if (!path.isAbsolute(file)) throw new Error('BRIDGE_SSO_CONFIG должен быть абсолютным путём.');
  try { return validateSsoConfig(JSON.parse(await readFile(file, 'utf8'))); }
  catch { throw new Error('Не удалось прочитать конфигурацию Fastkore SSO. Проверьте файл на сервере.'); }
}

/** No redirects, arbitrary client URLs, automatic retries or unbounded responses. */
export async function validateTicketHttps(installation: TrustedInstallation, ticket: string, trust?: { ca: string }): Promise<unknown> {
  let secret: string;
  try { const data = await readFile(installation.secretFile); if (data.length > 512) throw new Error(); secret = data.toString('utf8').trim(); }
  catch { throw new BridgeError('Серверная настройка Fastkore недоступна. Обратитесь к администратору.', 503); }
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret)) throw new BridgeError('Серверная настройка Fastkore недоступна. Обратитесь к администратору.', 503);
  const body = JSON.stringify({ installation_id: installation.id, ticket, audience });
  return new Promise((resolve, reject) => {
    const fail = () => new BridgeError('Fastkore не подтвердил вход. Откройте помощника из ERP заново.', 502);
    const req = request(installation.validationUrl, { ...(trust ? { ca: trust.ca } : {}), method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) { res.destroy(); reject(fail()); return; }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) { res.destroy(); reject(fail()); } else chunks.push(chunk); });
      res.on('error', () => reject(fail()));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail()); } });
    });
    req.on('error', () => reject(fail())); req.end(body);
  });
}

/** Trusted server configuration supplies the endpoint; ERP asserts identity, never platform rights. */
export class FastkoreSso {
  readonly config: SsoConfig;
  constructor(readonly store: Store, config: SsoConfig, private readonly validate: TicketValidator = validateTicketHttps) {
    this.config = validateSsoConfig(config);
    store.state.sso ??= { disabledInstallationIds: [] };
  }
  installation(id: string) {
    const value = this.config.installations.find(i => i.id === id && i.enabled && !this.store.state.sso?.disabledInstallationIds.includes(id));
    if (!value) throw new BridgeError('Вход для этой установки Fastkore выключен.', 403);
    return value;
  }
  credentialValid(c: Credential) {
    try {
      this.installation(c.installationId ?? '');
      return this.store.state.externalIdentities?.some(i => i.installationId === c.installationId && i.externalUserId === c.externalUserId && i.userId === c.userId) ?? false;
    } catch { return false; }
  }
  list() { return this.config.installations.map(({ id, name, enabled, entityTypes }) => ({ id, name, entityTypes, enabled: enabled && !this.store.state.sso?.disabledInstallationIds.includes(id), configuredEnabled: enabled })); }
  async exchange(installationId: string, ticket: string): Promise<TicketIdentity> {
    const installation = this.installation(installationId);
    if (!/^[a-zA-Z0-9_-]{43,512}$/.test(ticket)) throw new BridgeError('Недействительный билет Fastkore.', 401);
    const hash = createHash('sha256').update(installationId + '\0' + ticket).digest('hex');
    if (!this.store.claimLaunchTicket(hash)) throw new BridgeError('Билет уже предъявлялся. Откройте помощника из ERP заново.', 401);
    let value: any;
    try { value = await this.validate(installation, ticket); } catch { throw new BridgeError('Fastkore не подтвердил вход. Откройте помощника из ERP заново.', 502); }
    // Recheck after the awaited network call: the installation may have been disabled.
    this.installation(installationId);
    if (!value || value.valid !== true || value.installation_id !== installationId || value.audience !== audience || !stableId(value.user?.id)
      || typeof value.user.display_name !== 'string' || !value.user.display_name.trim() || value.user.display_name.length > 100 || /[\x00-\x1f\x7f]/.test(value.user.display_name)) throw new BridgeError('Fastkore отклонил билет или вернул неподходящий ответ.', 401);
    return { installationId, externalUserId: value.user.id, displayName: value.user.display_name.trim() };
  }
  context(credential: Credential, value: { entityType: string; entityId: string }): ErpContext {
    if (credential.source !== 'fastkore' || credential.kind !== 'session' || !this.credentialValid(credential)) throw new BridgeError('Контекст объекта доступен в сеансе Fastkore.', 403);
    const installation = this.installation(credential.installationId!);
    if (!entityType(value.entityType) || !stableId(value.entityId) || !installation.entityTypes.includes(value.entityType)) throw new BridgeError('Этот тип объекта Fastkore не настроен.', 400);
    return { installationId: installation.id, entityType: value.entityType, entityId: value.entityId };
  }
}
