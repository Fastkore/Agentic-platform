import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { normalizeFastkoreTicketUrl } from '../shared/fastkore-url.js';
import type { Credential, FastkoreInstallation, FastkoreKeyIssue, FastkorePairingAttempt, FastkoreTlsTrust, StoredFastkoreInstallation, User } from '../shared/types.js';
import type { Access } from './access.js';
import { discoverFastkoreTls, verifyFastkoreTls } from './fastkore-tls.js';
import { BridgeError, type Store } from './store.js';

export const sessionCookie = '__Host-bridge_session';
export const startCookie = '__Host-bridge_sso_start';
export const audience = 'fastkore-agent-platform';
const startTtl = 120;
const pairingTtl = 5 * 60_000;
const maxAttempts = 5000;
export type Theme = 'light' | 'dark';
export interface TicketIdentity { installationId: string; externalUserId: string; displayName: string }
interface ExchangeInput { installation_id: string; ticket: string; login_challenge: string }
type ErpTlsOptions = { ca: string };
export type TicketValidator = (url: string, key: string, payload: ExchangeInput, trust?: ErpTlsOptions) => Promise<unknown>;
export interface PairingInput {
  version: 1; pairing_code: string; platform_origin: string; installation_id: string; erp_key_verifier: string;
}
export type PairingClient = (url: string, payload: PairingInput, trust?: ErpTlsOptions) => Promise<unknown>;
export type InstallationPatch = { name?: string; validateTicketUrl?: string; confirmValidateTicketUrl?: boolean; enabled?: boolean };

export const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const opaque = (v: string) => v.length === 43 && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const normalizeTheme = (value: unknown): Theme => value === 'dark' ? 'dark' : 'light';
export const csrfFor = (token: string) => hash('bridge-csrf:' + token);
export function validCsrf(token: string, candidate: unknown) {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(csrfFor(token)));
}
export function cookieToken(header?: string, name = sessionCookie) {
  const matches = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (!matches.length) return '';
  const value = matches[0].slice(name.length + 1);
  if (matches.length !== 1 || !(name === startCookie ? opaque(value) : /^ccb_s_[a-f0-9]{64}$/.test(value))) {
    throw new BridgeError('Недействительная сессия Fastkore. Откройте помощника из ERP заново.', 401);
  }
  return value;
}
const setCookie = (name: string, value: string, maxAge: number) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
export const setSessionCookie = (token: string, maxAge = 1800) => setCookie(sessionCookie, token, maxAge);
export const setStartCookie = (token: string, maxAge = startTtl) => setCookie(startCookie, token, maxAge);

export async function loadSsoKey(file?: string) {
  if (!file) return undefined;
  if (!path.isAbsolute(file)) throw new Error('BRIDGE_SSO_KEY_FILE должен быть абсолютным путём.');
  try {
    const key = await readFile(file);
    if (key.length !== 32) throw new Error();
    return key;
  } catch { throw new Error('Не удалось загрузить ключ шифрования Fastkore SSO. Ожидается файл из 32 байтов.'); }
}
function validationUrl(value: string) {
  const url = normalizeFastkoreTicketUrl(value);
  if (!url) throw new BridgeError('Укажите домен ERP или HTTPS-адрес /api/ai/validate-ticket без параметров.');
  return url;
}
function nameOf(value: string) {
  const name = value.trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new BridgeError('Укажите название установки Fastkore.');
  return name;
}
/** No redirects, client-supplied destinations, retries or unbounded responses. */
function postErpJson(url: string, body: string, options: { ca?: string; key?: string }, fail: () => BridgeError) {
  return new Promise<{ status?: number; value?: unknown }>((resolve, reject) => {
    const req = request(url, {
      ca: options.ca, method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { ...(options.key ? { Authorization: 'Bearer ' + options.key } : {}),
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json' },
    }, res => {
      res.on('error', () => reject(fail()));
      if (res.statusCode !== 200) { res.destroy(); resolve({ status: res.statusCode }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) {
        res.destroy(); reject(fail()); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) { res.destroy(); reject(fail()); } else chunks.push(chunk); });
      res.on('end', () => { try { resolve({ status: 200, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(fail()); } });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      const tlsError = /^(?:ERR_TLS_CERT_|CERT_|UNABLE_TO_(?:VERIFY|GET_ISSUER)|(?:DEPTH_ZERO_)?SELF_SIGNED_CERT|INVALID_CA)/.test(error.code ?? '');
      reject(options.ca && tlsError ? new BridgeError('TLS-сертификат ERP изменился или недействителен. Проверьте подключение и подтвердите CA в настройках Fastkore.', 424) : fail());
    });
    req.end(body);
  });
}

export async function validateTicketHttps(url: string, key: string, payload: ExchangeInput, trust?: { ca: string }): Promise<unknown> {
  const fail = () => new BridgeError('Fastkore не подтвердил вход. Откройте помощника из ERP заново.', 502);
  const { status, value } = await postErpJson(url, JSON.stringify({ version: 1, ...payload, audience }), { ...trust, key }, fail);
  if (status !== 200) throw fail();
  return value;
}

export async function pairErpHttps(url: string, payload: PairingInput, trust?: { ca: string }): Promise<unknown> {
  const fail = () => new BridgeError('Fastkore не подтвердил подключение. Повторите с тем же кодом, пока он действует.', 502);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4096) throw new BridgeError('Запрос сопряжения слишком большой.');
  const { status, value } = await postErpJson(url, body, { ...trust }, fail);
  switch (status) {
    case 200: return value;
    case 400: throw new BridgeError('ERP отклонила формат запроса сопряжения.', 400);
    case 403: throw new BridgeError('ERP отклонила код. Проверьте базовый адрес платформы и выпустите новый код.', 403);
    case 404: throw new BridgeError('ERP вернула HTTP 404 на /api/ai/pair. Проверьте адрес ERP в настройках установки.', 424);
    case 409: throw new BridgeError('ERP сообщила о конфликте подключения. Подтвердите замену в ERP.', 409);
    case 429: throw new BridgeError('ERP ограничила частоту запросов. Повторите позже.', 429);
    case 503: throw new BridgeError('ERP не смогла сохранить подключение. Повторите с тем же кодом.', 503);
    default: throw new BridgeError('ERP вернула неожиданный ответ на сопряжение. Проверьте настройки установки.', 502);
  }
}

type StartAttempt = { challenge: string; theme: Theme; expires: number; used: boolean };
type PairingPreparation = { receipt: FastkoreInstallation } | { attempt: FastkorePairingAttempt; url: string; payload: PairingInput; trust?: ErpTlsOptions };

export class FastkoreSso {
  private readonly attempts = new Map<string, StartAttempt>();
  private readonly pairingInFlight = new Set<string>();
  constructor(
    private readonly store: Store, private readonly key: Buffer, private readonly origin: string,
    private readonly validate: TicketValidator = validateTicketHttps, private readonly pairClient: PairingClient = pairErpHttps,
  ) {
    if (key.length !== 32) throw new Error('Некорректный ключ шифрования Fastkore SSO.');
    // Fail at startup if a deployed key file cannot decrypt the saved installations.
    for (const item of this.items()) this.decrypt(item);
  }
  private items() { return this.store.state.sso?.installations ?? []; }
  reconcileOrigin() {
    for (const item of this.items()) {
      if (item.pairing?.binding && item.pairing.binding.origin !== this.origin) {
        delete item.pairing.binding;
        item.enabled = false;
        item.revision = randomUUID();
      }
    }
  }
  private find(id: string, items = this.items()) {
    const item = items.find(entry => entry.id === id);
    if (!item) throw new BridgeError('Установка Fastkore не найдена.', 404);
    return item;
  }
  exists(id: string) { return this.items().some(item => item.id === id); }
  private tlsTrust(item: StoredFastkoreInstallation) {
    const trust = item.tls?.trust;
    return trust?.origin === new URL(item.validateTicketUrl).origin ? trust : undefined;
  }
  private tlsOptions(item: StoredFastkoreInstallation): ErpTlsOptions | undefined {
    const trust = this.tlsTrust(item);
    if (item.tls && !trust) throw new BridgeError('Проверьте подключение и подтвердите отпечаток CA ERP.', 409);
    return trust && { ca: trust.pem };
  }
  private canUse(item: StoredFastkoreInstallation) {
    return (!item.tls || !!this.tlsTrust(item)) && (!item.pairing?.required || item.pairing.binding?.origin === this.origin);
  }
  private enabled(id: string) {
    const item = this.items().find(entry => entry.id === id && entry.enabled && this.canUse(entry));
    if (!item) throw new BridgeError('Вход для этой установки Fastkore выключен.', 403);
    return item;
  }
  private publicInstallation(item: StoredFastkoreInstallation): FastkoreInstallation {
    const { id, name, validateTicketUrl, enabled, autoProvision, defaultRoleId, sessionTtlSeconds, pairing } = item;
    const pairedAt = pairing?.binding?.origin === this.origin ? pairing.binding.pairedAt : undefined;
    const attempt = pairing?.attempt;
    const pending = attempt && !attempt.completed && attempt.origin === this.origin && attempt.revision === item.revision && attempt.expiresAt > Date.now();
    const pairingStatus = pending ? 'pending' : pairedAt ? 'paired' : pairing?.required ? 'unpaired' : 'manual';
    const tlsFingerprint = this.tlsTrust(item)?.fingerprint;
    return {
      id, name, validateTicketUrl, enabled: enabled && this.canUse(item), autoProvision, defaultRoleId, sessionTtlSeconds,
      pairingStatus, pairedAt, pairingRotationPending: pending ? attempt.rotate : undefined,
      tlsFingerprint, tlsConfirmationRequired: item.tls && !tlsFingerprint || undefined,
    };
  }
  list() { return this.items().map(item => this.publicInstallation(item)); }
  private issue(id: string): { issue: FastkoreKeyIssue; encryptedKey: string } {
    const connectionKey = 'fkap1.' + id + '.' + randomBytes(32).toString('base64url');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(connectionKey, 'utf8'), cipher.final()]);
    const encryptedKey = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
    return { issue: { installationId: id, connectionKey, erpKeyVerifier: 'fkap1.' + id + '.' + hash(connectionKey) }, encryptedKey };
  }
  private decrypt(item: StoredFastkoreInstallation) {
    try {
      const buffer = Buffer.from(item.encryptedKey, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
      cipher.setAAD(Buffer.from(item.id, 'utf8'));
      cipher.setAuthTag(buffer.subarray(12, 28));
      const secret = Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
      if (!secret.startsWith('fkap1.' + item.id + '.') || !opaque(secret.slice(43))) throw new Error();
      return secret;
    } catch { throw new BridgeError('Ключ установки Fastkore недоступен. Проверьте файл ключа шифрования.', 503); }
  }
  create(items: StoredFastkoreInstallation[], name: string, url: string) {
    if (items.length >= 50) throw new BridgeError('Достигнут предел регистраций Fastkore.', 409);
    const id = randomUUID(), validatedName = nameOf(name), validateTicketUrl = validationUrl(url);
    const { issue, encryptedKey } = this.issue(id);
    items.push({ id, name: validatedName, validateTicketUrl, enabled: false, autoProvision: true, defaultRoleId: 'sso_pending', sessionTtlSeconds: 1800, revision: randomUUID(), encryptedKey });
    return { id, result: issue };
  }
  registerForPairing(items: StoredFastkoreInstallation[], name: string, url: string, trust?: FastkoreTlsTrust) {
    const { id } = this.create(items, name, url);
    const item = this.find(id, items);
    item.pairing = { required: true };
    if (trust) item.tls = { trust };
    return { id, result: this.publicInstallation(item) };
  }
  async inspectTls(url: string) {
    const { origin, fingerprint, subject, expiresAt } = await discoverFastkoreTls(validationUrl(url));
    return { origin, fingerprint, subject, expiresAt };
  }
  async confirmTls(url: string, fingerprint: string) {
    const trust = await discoverFastkoreTls(validationUrl(url));
    if (trust.fingerprint !== fingerprint.toUpperCase()) {
      throw new BridgeError('CA ERP изменился. Проверьте подключение и сверьте новый отпечаток с консолью Fastkore.', 409);
    }
    await verifyFastkoreTls(trust);
    return trust;
  }
  async confirmInstallationTls(access: Access, authorize: () => User, id: string, fingerprint: string) {
    this.assertNoPairing(id);
    const { validateTicketUrl, revision } = this.find(id);
    const trust = await this.confirmTls(validateTicketUrl, fingerprint);
    return access.changeInstallation(authorize, 'sso.installation.tls.confirm', items => {
      this.assertNoPairing(id);
      const item = this.find(id, items);
      if (item.revision !== revision) throw new BridgeError('Установка изменилась. Проверьте подключение заново.', 409);
      const changed = this.tlsTrust(item)?.fingerprint !== trust.fingerprint;
      if (changed) {
        item.tls = { trust };
        item.revision = randomUUID();
        if (item.pairing?.attempt?.revision === revision) item.pairing.attempt.revision = item.revision;
      }
      return { id, result: this.publicInstallation(item), revoke: changed };
    });
  }
  private assertNoPairing(id: string) {
    if (this.pairingInFlight.has(id)) throw new BridgeError('Подключение уже выполняется. Дождитесь ответа ERP.', 409);
  }
  update(items: StoredFastkoreInstallation[], id: string, patch: InstallationPatch) {
    this.assertNoPairing(id);
    const item = this.find(id, items);
    const url = patch.validateTicketUrl === undefined ? item.validateTicketUrl : validationUrl(patch.validateTicketUrl);
    const urlChanged = url !== item.validateTicketUrl;
    if (urlChanged && ((item.enabled && this.canUse(item)) || patch.enabled === true || patch.confirmValidateTicketUrl !== true)) {
      throw new BridgeError('Отключите установку и отдельно подтвердите новый адрес проверки.', 409);
    }
    if (patch.enabled === true && !this.canUse(item)) throw new BridgeError('Сначала подключите установку кодом из ERP.', 409);
    const enabled = urlChanged ? false : patch.enabled ?? item.enabled, revoke = urlChanged || enabled !== item.enabled;
    if (patch.name !== undefined) item.name = nameOf(patch.name);
    item.validateTicketUrl = url; item.enabled = enabled;
    if (urlChanged && item.pairing) delete item.pairing.binding;
    if (urlChanged && item.tls) delete item.tls.trust;
    if (revoke) item.revision = randomUUID();
    return { id, result: this.publicInstallation(item), revoke };
  }
  rotate(items: StoredFastkoreInstallation[], id: string) {
    this.assertNoPairing(id);
    const item = this.find(id, items);
    if (item.pairing?.required) throw new BridgeError('Для замены ключа выпустите новый код в ERP.', 409);
    const { issue, encryptedKey } = this.issue(id);
    item.encryptedKey = encryptedKey; item.revision = randomUUID();
    return { id, result: issue, revoke: true };
  }
  async pair(access: Access, authorize: () => User, id: string, code: string, rotate: boolean) {
    if (!opaque(code)) throw new BridgeError('Введите код сопряжения из ERP.');
    this.assertNoPairing(id);
    this.pairingInFlight.add(id);
    try {
      const codeHash = hash(code);
      const prepared = await access.changeInstallation<PairingPreparation>(authorize, 'sso.installation.pair.prepare', items => {
        const item = this.find(id, items);
        const trust = this.tlsOptions(item);
        const pairing = item.pairing ??= { required: false };
        const previous = pairing.attempt;
        let attempt: FastkorePairingAttempt;
        if (previous?.codeHash === codeHash) {
          if (previous.expiresAt <= Date.now()) throw new BridgeError('Код сопряжения истёк. Выпустите новый код в ERP.', 403);
          if (previous.origin !== this.origin || previous.revision !== item.revision || previous.rotate !== rotate) {
            throw new BridgeError('Этот код использовался с другими настройками. Выпустите новый код в ERP.', 409);
          }
          if (previous.completed) return { id, result: { receipt: this.publicInstallation(item) } };
          attempt = previous;
        } else {
          attempt = {
            codeHash, origin: this.origin, revision: item.revision, expiresAt: Date.now() + pairingTtl, rotate,
            ...(rotate ? { encryptedKey: this.issue(id).encryptedKey } : {}),
          };
          pairing.attempt = attempt;
        }
        const key = this.decrypt({ ...item, encryptedKey: attempt.encryptedKey ?? item.encryptedKey });
        const url = new URL('/api/ai/pair', validationUrl(item.validateTicketUrl)).href;
        const payload: PairingInput = {
          version: 1, pairing_code: code, platform_origin: this.origin,
          installation_id: id, erp_key_verifier: 'fkap1.' + id + '.' + hash(key),
        };
        return { id, result: { attempt, url, payload, trust } };
      });
      if ('receipt' in prepared) return prepared.receipt;
      const { url, payload, attempt, trust } = prepared;
      authorize();
      let response: unknown;
      try {
        response = await this.pairClient(url, payload, trust);
      } catch (error) {
        if (!(error instanceof BridgeError && error.statusCode === 502) || attempt.expiresAt <= Date.now()) throw error;
        authorize();
        response = await this.pairClient(url, payload, trust);
      }
      const result = response as { version?: unknown; paired?: unknown; installation_id?: unknown } | null;
      if (result?.version !== 1 || result.paired !== true || result.installation_id !== id) {
        throw new BridgeError('ERP не подтвердила выбранную установку. Повторите с тем же кодом, пока он действует.', 502);
      }
      return await access.changeInstallation(authorize, 'sso.installation.pair.confirm', items => {
        const item = this.find(id, items);
        if (item.revision !== attempt.revision || item.pairing?.attempt?.codeHash !== codeHash) {
          throw new BridgeError('Настройки установки изменились. Выпустите новый код в ERP.', 409);
        }
        if (attempt.encryptedKey) item.encryptedKey = attempt.encryptedKey;
        item.enabled = true;
        item.revision = randomUUID();
        item.pairing = {
          required: true,
          binding: { origin: this.origin, pairedAt: new Date().toISOString() },
          attempt: { codeHash, origin: this.origin, expiresAt: attempt.expiresAt, revision: item.revision, rotate, completed: true },
        };
        return { id, result: this.publicInstallation(item), revoke: rotate };
      });
    } finally {
      this.pairingInFlight.delete(id);
    }
  }
  credentialValid(c: Credential) {
    return this.items().some(item => item.enabled && item.id === c.installationId && this.canUse(item))
      && (this.store.state.externalIdentities?.some(i => i.installationId === c.installationId && i.externalUserId === c.externalUserId && i.userId === c.userId) ?? false);
  }
  start(theme: Theme, previousCookie: string) {
    const now = Date.now();
    for (const [key, attempt] of this.attempts) if (attempt.expires <= now) this.attempts.delete(key);
    if (previousCookie) this.attempts.delete(hash(previousCookie));
    if (this.attempts.size >= maxAttempts) throw new BridgeError('Слишком много попыток входа. Повторите позже.', 429);
    const cookie = randomBytes(32).toString('base64url'), challenge = randomBytes(32).toString('base64url');
    this.attempts.set(hash(cookie), { challenge, theme, expires: now + startTtl * 1000, used: false });
    return { cookie, challenge };
  }
  attemptTheme(cookie: string) { return this.attempts.get(hash(cookie))?.theme ?? 'light'; }
  async exchange(input: ExchangeInput, cookie: string) {
    const { installation_id: id, ticket, login_challenge: challenge } = input;
    if (!uuid(id) || !opaque(ticket) || !opaque(challenge)) throw new BridgeError('Некорректные поля входа Fastkore.');
    const attempt = cookie && this.attempts.get(hash(cookie));
    if (!attempt || attempt.used || attempt.expires <= Date.now() || !timingSafeEqual(Buffer.from(challenge), Buffer.from(attempt.challenge))) {
      throw new BridgeError('Подготовка входа недействительна. Откройте помощника из ERP заново.', 401);
    }
    const installation = this.enabled(id);
    attempt.used = true;
    if (!this.store.claimLaunchTicket(hash(id + '\0' + ticket))) throw new BridgeError('Билет уже предъявлялся. Откройте помощника из ERP заново.', 401);
    const recheck = () => {
      if (this.enabled(id).revision !== installation.revision) throw new BridgeError('Настройки установки изменились. Откройте помощника из ERP заново.', 403);
    };
    const key = this.decrypt(installation);
    let value: any;
    try { value = await this.validate(installation.validateTicketUrl, key, input, this.tlsOptions(installation)); }
    catch (error) {
      if (error instanceof BridgeError && error.statusCode === 424) throw error;
      throw new BridgeError('Fastkore не подтвердил вход. Откройте помощника из ERP заново.', 502);
    }
    recheck();
    if (!value || value.version !== 1 || value.valid !== true || value.installation_id !== id || value.audience !== audience || !uuid(value.user?.id)
      || typeof value.user.display_name !== 'string' || !value.user.display_name.trim() || value.user.display_name.length > 200 || /[\x00-\x1f\x7f]/.test(value.user.display_name)) {
      throw new BridgeError('Fastkore отклонил билет или вернул неподходящий ответ.', 401);
    }
    const identity: TicketIdentity = { installationId: id, externalUserId: value.user.id, displayName: value.user.display_name.trim() };
    return { identity, theme: attempt.theme, recheck };
  }
}
