import { X509Certificate } from 'node:crypto';
import { request } from 'node:http';
import type { Credential } from '../shared/types.js';
import type { FastkoreCliCommand } from './codex-tools.js';
import { postErpJson, type FastkoreSso } from './fastkore.js';
import { BridgeError, redact } from './store.js';

export type FastkoreCliRead =
  | { operation: 'get'; entitySetId: string; entityId: string }
  | { operation: 'query'; entitySetId: string; limit: number };
export type FastkoreCliOperation = FastkoreCliRead | { operation: 'auth-info' };
type Result = { success: boolean; exitCode: number; data?: unknown };
const audience = 'fastkore-cli';
const unavailable = 'Исполнитель Fastkore CLI недоступен.';
const reauth = 'Доступ к ERP завершён или отозван. Войдите в помощника из Fastkore заново.';
const ticketPattern = /^fkct1\.[A-Za-z0-9._-]{1,4096}$(?![\s\S])/;

export class FastkoreCli {
  constructor(private readonly socketPath: string) {}

  private exchange(path: string, payload?: object, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const fail = () => new BridgeError(unavailable, 503);
      const body = payload && JSON.stringify(payload);
      const timeout = AbortSignal.timeout(28_000);
      const req = request({
        socketPath: this.socketPath, path, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      }, async res => {
        try {
          if (res.statusCode === 409) throw new BridgeError('Исполнитель Fastkore CLI занят. Повторите позже.', 409);
          if (res.statusCode !== 200) throw fail();
          let body = '';
          res.setEncoding('utf8');
          for await (const chunk of res) {
            body += chunk;
            if (body.length > 600_000) throw fail();
          }
          resolve(JSON.parse(body));
        } catch (error) {
          res.destroy();
          reject(error instanceof BridgeError ? error : fail());
        }
      });
      req.on('error', () => reject(fail()));
      req.end(body);
    });
  }

  describe(command?: FastkoreCliCommand, signal?: AbortSignal) {
    return this.exchange(command ? '/describe/' + command : '/capabilities', undefined, signal);
  }

  async checkTrust(binding: { origin: string; ca?: string }, signal: AbortSignal) {
    if (!binding.ca) throw new BridgeError('Для Fastkore CLI требуется подтверждённый CA установки ERP.', 424);
    const authority = new URL(binding.origin).host;
    const caFingerprint = new X509Certificate(binding.ca).fingerprint256;
    // Verify the runner's fixed address and CA before sending a ticket.
    const trust = await this.exchange('/trust', undefined, AbortSignal.any([signal, AbortSignal.timeout(2000)])) as
      { authority?: string; caFingerprint?: string } | null;
    if (trust?.authority !== authority || trust.caFingerprint !== caFingerprint) {
      throw new BridgeError('Адрес или CA исполнителя Fastkore CLI не совпадает с привязкой ERP.', 424);
    }
    return { authority, caFingerprint };
  }

  async run(operation: FastkoreCliOperation, sso: Pick<FastkoreSso, 'delegationBinding' | 'openDelegation'>,
    current: () => Credential, forget: (id: string) => Promise<void>, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    const credential = current();
    const binding = sso.delegationBinding(credential);
    const grant = binding && sso.openDelegation(credential, binding.revision);
    if (!binding || !grant) throw new BridgeError(reauth, 403);
    const check = () => {
      signal.throwIfAborted();
      const session = current();
      const now = sso.delegationBinding(session);
      if (session.id !== credential.id || session.erpDelegationRevoked ||
        session.erpDelegation?.sealedGrant !== credential.erpDelegation?.sealedGrant ||
        now?.revision !== binding.revision || now.origin !== binding.origin || grant.expiresAt <= Date.now()) {
        throw new BridgeError(reauth, 403);
      }
    };
    const trust = await this.checkTrust(binding, signal);
    check();
    const started = Date.now();
    const failed = () => new BridgeError('ERP не выдала билет Fastkore CLI.', 502);
    const { status, value } = await postErpJson(binding.origin + '/api/ai/cli-ticket',
      JSON.stringify({ version: 1, delegation: grant.grant }), { ...binding, signal }, failed);
    if (process.env.NODE_ENV === 'production') console.info(JSON.stringify({ event: 'fastkore.cli.ticket', status, elapsedMs: Date.now() - started }));
    if (status === 403) {
      await forget(credential.id);
      throw new BridgeError(reauth, 403);
    }
    if (status === 401) throw new BridgeError('ERP отклонила ключ привязки Fastkore. Проверьте подключение.', 424);
    if (status === 404) throw new BridgeError('Эта версия ERP ещё не выдаёт билеты Fastkore CLI.', 424);
    if (status === 400) throw new BridgeError('ERP отклонила параметры запроса билета Fastkore CLI.', 502);
    if (status === 429 || status === 503) throw new BridgeError('Выдача билетов Fastkore CLI временно недоступна. Повторите позже.', status);
    const ticket = value as { version?: number; ticket?: string; expires_in?: number; audience?: string } | undefined;
    if (status !== 200 || ticket?.version !== 1 || ticket.audience !== audience || typeof ticket.ticket !== 'string' ||
      !ticketPattern.test(ticket.ticket) || !Number.isInteger(ticket.expires_in) || ticket.expires_in! < 1 || ticket.expires_in! > 30 ||
      Date.now() >= started + ticket.expires_in! * 1000) throw failed();
    check();
    const result = await this.exchange('/read', { ...operation, ticket: ticket.ticket, ...trust }, signal) as Result;
    check();
    if (!result || typeof result.success !== 'boolean' || !Number.isInteger(result.exitCode) ||
      (result.success ? result.exitCode !== 0 || !Object.hasOwn(result, 'data') : result.exitCode === 0)) throw new BridgeError(unavailable, 502);
    if (operation.operation === 'auth-info' && result.success) {
      const data = result.data as { user?: { guid?: string } } | undefined;
      const guid = data?.user?.guid;
      if (typeof guid !== 'string' || guid.toLowerCase() !== credential.externalUserId) {
        throw new BridgeError('Пользователь Fastkore CLI не совпал с пользователем SSO.', 502);
      }
      return { success: true, exitCode: 0, data: { user: { guid: credential.externalUserId } } };
    }
    return result.success
      ? { success: true, exitCode: 0, data: JSON.parse(redact(JSON.stringify(result.data))) }
      : { success: false, exitCode: result.exitCode };
  }
}
