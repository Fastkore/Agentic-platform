import { X509Certificate } from 'node:crypto';
import { request } from 'node:http';
import type { Credential } from '../shared/types.js';
import type { FastkoreContext, FastkoreEntityContext } from '../shared/fastkore-context.js';
import type { FastkoreCliCommand } from './codex-tools.js';
import { postErpJson, type FastkoreSso } from './fastkore.js';
import { BridgeError, redact } from './store.js';
import { elapsedMs } from './run-timing.js';

export type FastkoreCliPage = { pageSize: number; orderBy?: string; descending?: boolean; after?: string; properties?: string[] };
export type FastkoreCliRead =
  | { operation: 'get'; entitySetId: string; entityId: string; properties?: string[] }
  | { operation: 'query'; entitySetId: string; limit: number; filter?: string }
  | { operation: 'get-many'; entitySetId: string; entityIds: string[]; properties?: string[] }
  | { operation: 'page'; page: FastkoreCliPage; context: FastkoreEntityContext }
  | { operation: 'page'; page: FastkoreCliPage; entitySetId: string; filter?: string };
export type FastkoreCliReadSupport = { contextPaging: boolean; batchGet: boolean };
export type FastkoreCliTiming = { trustMs?: number; ticketMs?: number; ticketStatus?: number; cliRpcMs?: number; cliProcessMs?: number; exitCode?: number };
export type FastkoreCliOperation = FastkoreCliRead | { operation: 'auth-info' } |
  { operation: 'execute'; command: string; args: string[]; workDirectoryId: string; context?: FastkoreContext };
export type FastkoreCliResult = { success: boolean; exitCode: number; data?: unknown; error?: undefined } |
  { success: boolean | null; exitCode: number | null; data?: undefined; error: { code: 'cli_stdout_too_large'; actualBytes: number; limitBytes: number } };
const audience = 'fastkore-cli';
const unavailable = 'Исполнитель Fastkore CLI недоступен.';
const reauth = 'Доступ к ERP завершён или отозван. Войдите в помощника из Fastkore заново.';
const ticketPattern = /^fkct1\.[A-Za-z0-9._-]{1,4096}$(?![\s\S])/;

export class FastkoreCli {
  private readonly transportLimitBytes: number;
  constructor(private readonly socketPath: string) {
    const stdoutLimit = Number(process.env.BRIDGE_FASTKORE_CLI_STDOUT_MAX_BYTES ?? 8 * 1024 * 1024);
    if (!Number.isSafeInteger(stdoutLimit) || stdoutLimit < 1 || stdoutLimit > 16 * 1024 * 1024) {
      throw new Error('BRIDGE_FASTKORE_CLI_STDOUT_MAX_BYTES must be an integer from 1 to 16777216');
    }
    // Worker responses wrap parsed JSON. Compact numbers can expand when reserialized.
    this.transportLimitBytes = Math.max(600_000, 6 * stdoutLimit + 64 * 1024);
  }

  private exchange(path: string, payload?: object, signal?: AbortSignal, timing?: FastkoreCliTiming): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const fail = () => new BridgeError(unavailable, 503);
      const body = payload && JSON.stringify(payload);
      const timeout = AbortSignal.timeout(95_000);
      const req = request({
        socketPath: this.socketPath, path, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : undefined,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      }, async res => {
        try {
          const processMs = res.headers['x-fastkore-cli-process-ms'];
          if (timing && typeof processMs === 'string' && /^\d{1,6}$/.test(processMs)) timing.cliProcessMs = Number(processMs);
          if (res.statusCode === 409 || res.statusCode === 429) throw new BridgeError('Исполнитель Fastkore CLI занят. Повторите позже.', 429);
          if (res.statusCode === 422) throw new BridgeError('Установленная Fastkore CLI не поддерживает этот режим чтения.', 422);
          if (res.statusCode === 400) throw new BridgeError('Проверьте имя команды, её параметры и пути. CLI использует подключение текущего сотрудника и рабочую папку cli.', 400);
          if (res.statusCode !== 200) throw fail();
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            bytes += chunk.length;
            if (bytes > this.transportLimitBytes) throw fail();
            chunks.push(chunk);
          }
          resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
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
  describeCommand(command: string, signal?: AbortSignal) {
    return this.exchange('/command-description?name=' + encodeURIComponent(command), undefined, signal);
  }

  async checkTrust(binding: { origin: string; ca?: string }, signal: AbortSignal) {
    if (!binding.ca) throw new BridgeError('Для Fastkore CLI требуется подтверждённый CA установки ERP.', 424);
    const authority = new URL(binding.origin).host;
    const caFingerprint = new X509Certificate(binding.ca).fingerprint256;
    // Verify the runner's fixed address and CA before sending a ticket.
    const trust = await this.exchange('/trust', undefined, AbortSignal.any([signal, AbortSignal.timeout(2000)])) as
      { authority?: string; caFingerprint?: string; contextPaging?: boolean; batchGet?: boolean; contextVersions?: Record<string, number[]> } | null;
    if (trust?.authority !== authority) throw new BridgeError(`Исполнитель CLI настроен на ${trust?.authority ?? 'неизвестный адрес'}, а установка ERP использует ${authority}. Исправьте адрес исполнителя.`, 424);
    if (trust.caFingerprint !== caFingerprint) throw new BridgeError('CA исполнителя CLI отличается от подтверждённого CA ERP. Обновите сертификат исполнителя.', 424);
    return { authority, caFingerprint, contextPaging: trust.contextPaging === true, batchGet: trust.batchGet === true, contextVersions: trust.contextVersions };
  }

  async run(operation: FastkoreCliOperation, sso: Pick<FastkoreSso, 'delegationBinding' | 'openDelegation'>,
    current: () => Credential, forget: (id: string) => Promise<void>, signal: AbortSignal, timing?: FastkoreCliTiming): Promise<FastkoreCliResult> {
    signal.throwIfAborted();
    const credential = current();
    const binding = sso.delegationBinding(credential);
    if (binding?.cliEnabled === false) throw new BridgeError('Fastkore CLI отключена в настройках установки.', 403);
    const grant = binding && sso.openDelegation(credential, binding.revision);
    if (!binding || !grant) throw new BridgeError(reauth, 403);
    const check = () => {
      signal.throwIfAborted();
      const session = current();
      const now = sso.delegationBinding(session);
      if (session.id !== credential.id || session.erpDelegationRevoked ||
        now?.cliEnabled === false ||
        session.erpDelegation?.sealedGrant !== credential.erpDelegation?.sealedGrant ||
        now?.revision !== binding.revision || now.origin !== binding.origin || grant.expiresAt <= Date.now()) {
        throw new BridgeError(reauth, 403);
      }
    };
    const trustStarted = performance.now();
    const { authority, caFingerprint, contextPaging, batchGet, contextVersions } = await this.checkTrust(binding, signal)
      .finally(() => { if (timing) timing.trustMs = elapsedMs(trustStarted); });
    if ('context' in operation && operation.context?.version === 2 && (operation.operation === 'page' ||
      operation.operation === 'execute' && operation.args.some(arg => arg === '--context' || arg.startsWith('--context=')))) {
      const command = operation.operation === 'execute' ? operation.command : 'data query';
      if (!contextVersions?.[command]?.includes(2)) throw new BridgeError('Исполнитель Fastkore CLI не поддерживает контекст папки v2. Обновите CLI до 27.0.62.0 или новее.', 424);
    }
    if ((operation.operation === 'page' && !contextPaging) || (operation.operation === 'get-many' && !batchGet)) {
      throw new BridgeError('Установленная Fastkore CLI не поддерживает этот режим чтения.', 422);
    }
    check();
    const started = Date.now(), ticketStarted = performance.now();
    const failed = () => new BridgeError('ERP не выдала билет Fastkore CLI.', 502);
    const { status, value } = await postErpJson(binding.origin + '/api/ai/cli-ticket',
      JSON.stringify({ version: 1, delegation: grant.grant }), { ...binding, signal }, failed)
      .finally(() => { if (timing) timing.ticketMs = elapsedMs(ticketStarted); });
    if (timing) timing.ticketStatus = status;
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
    const rpcStarted = performance.now();
    const result = await this.exchange('/read', { ...operation, ticket: ticket.ticket, authority, caFingerprint }, signal, timing)
      .finally(() => { if (timing) timing.cliRpcMs = elapsedMs(rpcStarted); }) as FastkoreCliResult;
    check();
    if (result?.error?.code === 'cli_stdout_too_large' &&
      (result.exitCode === null || Number.isInteger(result.exitCode)) && result.success === (result.exitCode === null ? null : result.exitCode === 0) &&
      Number.isSafeInteger(result.error.actualBytes) && Number.isSafeInteger(result.error.limitBytes) &&
      result.error.limitBytes > 0 && result.error.actualBytes > result.error.limitBytes) {
      if (timing && result.exitCode !== null) timing.exitCode = result.exitCode;
      return { success: result.success, exitCode: result.exitCode, error: result.error };
    }
    if (!result || typeof result.success !== 'boolean' || !Number.isInteger(result.exitCode) ||
      result.exitCode === null || result.error ||
      (result.success ? result.exitCode !== 0 || !Object.hasOwn(result, 'data') : result.exitCode === 0)) throw new BridgeError(unavailable, 502);
    if (timing) timing.exitCode = result.exitCode;
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
      : { success: false, exitCode: result.exitCode,
        data: result.data === undefined ? undefined : JSON.parse(redact(JSON.stringify(result.data))) };
  }
}
