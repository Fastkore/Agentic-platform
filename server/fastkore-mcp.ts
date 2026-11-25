import { request } from 'node:https';
import type { AuditEvent, Credential, ErpDelegationLoss } from '../shared/types.js';
import { erpReadOnlyMessage } from './erp-roles.js';
import type { CodexTools, CodexToolDefinition } from './codex-tools.js';
import { delegationLossMessage, postErpJson, type ErpDelegation, type FastkoreSso } from './fastkore.js';
import { BridgeError, redact } from './store.js';
import { elapsedMs } from './run-timing.js';
import { attachmentTool, readFastkoreAttachment } from './fastkore-attachments.js';
import { maxChatImagePayload } from './chat-images.js';

type Binding = NonNullable<ReturnType<FastkoreSso['delegationBinding']>>;
type Token = { value: string; expiresAt: number };
type Tool = { upstream: string; definition: CodexToolDefinition };
type Catalog = { url: string; tools: Map<string, Tool>; sessionId?: string; protocol?: string; expiresAt: number };
type Session = {
  credential: Credential;
  delegation: ErpDelegation;
  revision: string;
  nextId: number;
  token?: Token;
  refresh?: Promise<Token>;
  webApiToken?: Token;
  webApiRefresh?: Promise<Token>;
  catalog?: Catalog;
  catalogPending?: Promise<Catalog>;
  catalogProblem?: string;
};
type RpcTiming = { mcpTokenMs?: number; mcpHttpMs?: number };
type CallDiagnostic = Pick<NonNullable<AuditEvent['details']>, 'status' | 'mcpFailure' | 'mcpErrorCode'>;
type ReadAudit = RpcTiming & CallDiagnostic & { tool: string; parameters: Record<string, unknown>; success: boolean; elapsedMs: number };
const audience = 'fastkore-mcp';
const reauth = 'Доступ к ERP завершён или отозван. Откройте помощника из Fastkore заново.';
const unavailable = 'Не удалось получить корректный ответ от сервера MCP. Повторите запрос. Если ошибка повторится, попросите администратора проверить адрес MCP и журнал ERP.';
const maxResponse = 768 * 1024;
// Methods verified as read-only in Fastkore.Business. Unknown methods require write access.
const readTools = new Set([
  'GetObjectFiles',
  'GetCurrentUserInfo', 'GetOrder', 'GetOrders', 'GetOrderRange', 'GetOrderByCustomer', 'GetOrdersModifiedInPeriod',
  'GetOrderCommunications', 'GetOrderStageList', 'GetPurchaseOrder', 'GetPurchaseOrders', 'GetPurchaseOrderRange',
  'GetPurchaseOrderBySupplier', 'GetPurchaseOrdersModifiedInPeriod', 'GetPurchaseOrderStageList',
  'GetCommunicationEntryBody', 'GetCommunicationEntryRange', 'GetCommunicationEntryStatusList', 'GetCommunicationEntriesModifiedInPeriod',
  'GetContact', 'GetContactAddresses', 'GetContactCommunications', 'GetContractor', 'GetContractorRange',
  'GetNomenclature', 'GetNomenclatureById', 'GetNomenclatureByBarCode', 'GetNomenclatureGroup', 'SearchNomenclature',
  'GetProject', 'GetProjects', 'GetTask', 'GetTasks', 'GetTaskRange', 'GetTasksModifiedInPeriod',
  'GetEquipment', 'GetEquipmentGroup', 'GetEquipments', 'GetProductionOperation', 'GetProductionOperations',
  'GetProductionPosition', 'GetProductionPositions', 'GetStoreAction', 'GetStoreActions', 'GetStoreActionItems',
]);

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function postMcp(url: string, token: string, ca: string | undefined, body: unknown, headers: Record<string, string>, signal: AbortSignal,
  diagnostic?: CallDiagnostic) {
  return new Promise<{ status: number; value?: unknown; sessionId?: string }>((resolve, reject) => {
    const json = JSON.stringify(body);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const req = request(url, { method: 'POST', ca, signal: requestSignal, headers: {
      ...headers, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json),
      Accept: 'application/json, text/event-stream',
    } }, async res => {
      try {
        const status = res.statusCode ?? 502;
        if (diagnostic) diagnostic.status = status;
        if (status === 401 || status === 202 || status === 204 || (!diagnostic && (status < 200 || status >= 300))) {
          res.destroy(); resolve({ status }); return;
        }
        const rawId = res.headers['mcp-session-id'];
        if (rawId !== undefined && (typeof rawId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(rawId))) throw new Error();
        const sessionId = typeof rawId === 'string' ? rawId : undefined;
        const type = res.headers['content-type'] ?? '';
        const sse = /^text\/event-stream(?:\s*;|$)/i.test(type);
        if (!sse && !/^application\/json(?:\s*;|$)/i.test(type)) throw new Error();
        let text = '', bytes = 0;
        res.setEncoding('utf8');
        for await (const chunk of res) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxResponse) throw new Error();
          text += chunk;
          if (!sse) continue;
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(text))) {
            const event = text.slice(0, boundary.index);
            text = text.slice(boundary.index + boundary[0].length);
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const value = JSON.parse(data);
            if (record(value)?.id === record(body)?.id) { res.destroy(); resolve({ status, value, sessionId }); return; }
          }
        }
        if (sse) throw new Error();
        resolve({ status, value: JSON.parse(text), sessionId });
      } catch { res.destroy(); reject(new BridgeError(unavailable, 502)); }
    });
    req.on('error', () => reject(new BridgeError(requestSignal.aborted
      ? 'Сервер MCP не ответил вовремя. Повторите запрос.'
      : 'Не удалось установить соединение с MCP. Попросите администратора проверить адрес, сеть и сертификат сервера ERP.', 502)));
    req.end(json);
  });
}

export class FastkoreMcp {
  private readonly sessions = new Map<string, Session>();
  private readonly expired = new Map<string, ErpDelegationLoss>();

  constructor(private readonly sso: Pick<FastkoreSso, 'delegationBinding' | 'openDelegation'>,
    private readonly forgetDelegation: (credentialId: string, reason: ErpDelegationLoss) => Promise<void>) {}

  status(credential: Credential, binding = this.sso.delegationBinding(credential)): 'unavailable' | 'ready' | 'reauth' {
    if (credential.erpDelegationRevoked || this.expired.has(credential.id)) return 'reauth';
    const stored = credential.erpDelegation;
    if (!stored) return 'unavailable';
    if (stored.expiresAt <= Date.now() || (binding && stored.revision !== binding.revision)) {
      void this.invalidate(credential.id, stored.expiresAt <= Date.now() ? 'expired' : 'binding_changed');
      return 'reauth';
    }
    if (!binding) {
      const session = this.sessions.get(credential.id);
      if (session) session.catalog = undefined;
      return 'unavailable';
    }
    if (!this.sessions.has(credential.id) && !this.sso.openDelegation(credential, binding.revision)) {
      void this.invalidate(credential.id, 'grant_unreadable');
      return 'reauth';
    }
    if (!binding.mcpUrl) {
      const session = this.sessions.get(credential.id);
      if (session) session.catalog = undefined;
      return 'unavailable';
    }
    return 'ready';
  }

  reconnectReason(credential: Credential) {
    return delegationLossMessage(credential.erpDelegationLoss ?? this.expired.get(credential.id));
  }

  lastCatalogProblem(id: string) { return this.sessions.get(id)?.catalogProblem; }

  invalidate(id: string, reason: ErpDelegationLoss) {
    this.sessions.delete(id);
    this.expired.set(id, reason);
    return this.forgetDelegation(id, reason).catch(() => {
      // Still fail closed in this process if SQLite is temporarily unavailable.
      console.error(JSON.stringify({ event: 'erp.delegation.persist_failed', sessionId: id, delegationReason: reason }));
    });
  }

  async revoke(credential: Credential) {
    const invalidated = this.expired.delete(credential.id);
    this.sessions.delete(credential.id);
    if (invalidated || !credential.erpDelegation) return { revokeDelivery: 'not_sent' as const };
    try {
      const binding = this.sso.delegationBinding(credential);
      const delegation = binding && this.sso.openDelegation(credential, binding.revision);
      if (!binding || !delegation) return { revokeDelivery: 'not_sent' as const };
      const { status } = await postErpJson(binding.origin + '/api/ai/revoke-delegation', JSON.stringify({ version: 1, delegation: delegation.grant }),
        binding, () => new BridgeError(unavailable, 502));
      return { revokeDelivery: 'http_response' as const, status };
    } catch { return { revokeDelivery: 'no_response' as const }; }
  }

  private async token(state: Session, binding: Binding, target = audience): Promise<Token> {
    const webApi = target === 'fastkore-webapi';
    const tokenKey = webApi ? 'webApiToken' : 'token';
    const refreshKey = webApi ? 'webApiRefresh' : 'refresh';
    const cached = state[tokenKey];
    if (cached && cached.expiresAt > Date.now() + 10_000) return cached;
    if (!state[refreshKey]) {
      const { credential, delegation } = state;
      state[refreshKey] = (async () => {
        const fail = () => new BridgeError('Платформа не получила действительный токен ' + (webApi ? 'WebAPI' : 'MCP') + ' от ERP. Попросите администратора проверить службу выдачи токенов Fastkore.', 502);
        const { status, value } = await postErpJson(binding.origin + '/api/ai/user-token',
          JSON.stringify({ version: 1, delegation: delegation.grant, audience: target }), binding, fail);
        if (status === 403) {
          if (webApi) throw new BridgeError('ERP отклонила выдачу токена WebAPI для чтения вложений. Откройте помощника из Fastkore заново. Если ошибка повторится, обратитесь к администратору.', 403);
          if (this.sessions.get(credential.id) === state) await this.invalidate(credential.id, 'mcp_token_denied');
          throw new BridgeError(delegationLossMessage('mcp_token_denied'), 403);
        }
        if (status === 401) throw new BridgeError('ERP отклонила ключ привязки Fastkore. Проверьте подключение.', 424);
        if (status === 404) throw new BridgeError(webApi ? 'На сервере ERP недоступна выдача токенов WebAPI для вложений.' : 'На сервере ERP недоступна выдача токенов MCP.', 424);
        if (status === 429) throw new BridgeError('Fastkore ограничил частоту запросов. Повторите позже.', 429);
        const result = record(value);
        if (status !== 200 || result?.version !== 1 || result.token_type !== 'Bearer' || result.audience !== target
          || !Number.isInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 300
          || typeof result.access_token !== 'string' || !/^fkua1\.[A-Za-z0-9._-]{1,4096}$/.test(result.access_token)) throw fail();
        if (this.sessions.get(credential.id) !== state || delegation.expiresAt <= Date.now()) throw new BridgeError(reauth, 403);
        return state[tokenKey] = { value: result.access_token, expiresAt: Math.min(Date.now() + result.expires_in * 1000, delegation.expiresAt) };
      })().finally(() => { state[refreshKey] = undefined; });
    }
    return state[refreshKey];
  }

  async prepare(credential: Credential, authorize: () => void, signal: AbortSignal,
    audit?: (event: ReadAudit) => void, readOnly: () => boolean = () => false): Promise<{ tools?: CodexTools; problem?: string }> {
    const binding = this.sso.delegationBinding(credential);
    const status = this.status(credential, binding);
    if (status === 'reauth') return { problem: this.reconnectReason(credential) };
    if (status !== 'ready' || !binding?.mcpUrl) return {};
    if (!this.sessions.has(credential.id)) {
      if (this.sessions.size >= 4096) {
        for (const [id, session] of this.sessions) if (session.delegation.expiresAt <= Date.now()) this.sessions.delete(id);
        if (this.sessions.size >= 4096) return { problem: 'Достигнут лимит одновременных сеансов MCP. Повторите запрос позже.' };
      }
      const delegation = this.sso.openDelegation(credential, binding.revision);
      if (!delegation) return { problem: delegationLossMessage('grant_unreadable') };
      this.sessions.set(credential.id, { credential, delegation, revision: binding.revision, nextId: 0 });
    }
    const state = this.sessions.get(credential.id)!;
    const url = binding.mcpUrl;
    const check = () => {
      authorize();
      const current = this.sso.delegationBinding(credential);
      if (current?.mcpEnabled === false) {
        state.catalog = undefined;
        throw new BridgeError('MCP отключён в настройках установки ERP.', 403);
      }
      if (this.sessions.get(credential.id) !== state || state.delegation.expiresAt <= Date.now()
        || current?.revision !== state.revision || current.mcpUrl !== url) {
        state.catalog = undefined;
        throw new BridgeError(reauth, 403);
      }
    };
    const rpc = async (method: string, params: Record<string, unknown>, rpcSignal: AbortSignal,
      connection: { sessionId?: string; protocol?: string }, timing?: RpcTiming, diagnostic?: CallDiagnostic) => {
      check(); rpcSignal.throwIfAborted();
      const tokenStarted = performance.now();
      const token = await this.token(state, binding).finally(() => { if (timing) timing.mcpTokenMs = elapsedMs(tokenStarted); });
      check(); rpcSignal.throwIfAborted();
      const notification = method === 'notifications/initialized';
      if (method === 'tools/call' && readOnly() && !readTools.has(String(params.name))) {
        throw new BridgeError(erpReadOnlyMessage, 403);
      }
      const requestId = ++state.nextId;
      const httpStarted = performance.now();
      const response = await postMcp(url, token.value, binding.mcpCa,
        { jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params },
        { ...(connection.sessionId ? { 'Mcp-Session-Id': connection.sessionId } : {}), ...(connection.protocol ? { 'MCP-Protocol-Version': connection.protocol } : {}) }, rpcSignal, diagnostic)
        .finally(() => { if (timing) timing.mcpHttpMs = elapsedMs(httpStarted); });
      if (response.status === 401 && state.token === token) state.token = undefined;
      check();
      if (method !== 'tools/call' && response.status >= 400 && !(method === 'initialize' && response.status === 401)) {
        if (response.status === 401 || response.status === 403) throw new BridgeError('Сервер MCP отказал в доступе к каталогу инструментов. Попросите администратора проверить права сотрудника в ERP.', 424);
        if (response.status === 404) throw new BridgeError('MCP Fastkore не найден. Проверьте HTTPS-адрес в настройках установки.', 424);
        if (response.status === 429) throw new BridgeError('Сервер MCP ограничил частоту запросов. Повторите запрос позже.', 429);
        throw new BridgeError(`Сервер MCP вернул HTTP ${response.status} при подключении. Если ошибка повторится, попросите администратора проверить службу MCP.`, 502);
      }
      const value = record(response.value);
      if (value?.jsonrpc === '2.0' && value.id === requestId && !('result' in value)) {
        const error = record(value.error);
        if (error && typeof error.code === 'number' && Number.isSafeInteger(error.code) && typeof error.message === 'string') {
          return { status: response.status, error: { code: error.code, message: redact(error.message).slice(0, 2000) } };
        }
      }
      if (response.status < 200 || response.status >= 300) return { status: response.status };
      if (method === 'initialize') connection.sessionId = response.sessionId;
      if (notification) return { status: response.status };
      if (value?.jsonrpc !== '2.0' || value.id !== requestId || value.error || !record(value.result)) throw new BridgeError(unavailable, 502);
      return { status: response.status, result: value.result };
    };
    try {
      check(); signal.throwIfAborted();
      let catalog = state.catalog && state.catalog.url === url && state.catalog.expiresAt > Date.now() ? state.catalog : undefined;
      if (!catalog) {
        if (!state.catalogPending) {
          state.catalogPending = (async () => {
            const connection: { sessionId?: string; protocol?: string } = {};
            const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agent Platform', version: '1' } };
            let initialized = await rpc('initialize', init, signal, connection);
            if (initialized.status === 401) initialized = await rpc('initialize', init, signal, connection);
            if (initialized.status === 401) throw new BridgeError('Сервер MCP отклонил новый токен сотрудника. Попросите администратора проверить настройки доступа MCP в Fastkore.', 424);
            if (!['2025-06-18', '2025-03-26', '2025-11-25'].includes(initialized.result?.protocolVersion)) throw new BridgeError('Сервер MCP не подтвердил поддерживаемую версию протокола. Попросите администратора проверить совместимость сервера с платформой.', 502);
            if (process.env.NODE_ENV === 'production') console.info(JSON.stringify({ event: 'fastkore.mcp.initialized', status: initialized.status }));
            connection.protocol = initialized.result!.protocolVersion;
            const notified = await rpc('notifications/initialized', {}, signal, connection);
            if (notified.status >= 300) throw new BridgeError(unavailable, 502);
            const tools = new Map<string, Tool>();
            let cursor: string | undefined;
            for (let page = 0; page < 8; page++) {
              const { result } = await rpc('tools/list', cursor ? { cursor } : {}, signal, connection);
              if (!Array.isArray(result?.tools)) throw new BridgeError(unavailable, 502);
              for (const value of result.tools) {
                if (typeof value?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,55}$/.test(value.name) || !record(value.inputSchema)) continue;
                const name = 'fastkore_' + value.name;
                const description = typeof value.description === 'string' && value.description.trim() ? value.description : value.name;
                tools.set(name, { upstream: value.name, definition: { type: 'function', name, description: redact(description).slice(0, 4000), inputSchema: value.inputSchema } });
              }
              if (tools.size > 200) throw new BridgeError(unavailable, 502);
              const next = result.nextCursor;
              if (!next) break;
              if (typeof next !== 'string' || next === cursor || next.length > 512 || page === 7) throw new BridgeError(unavailable, 502);
              cursor = next;
            }
            if (!tools.size) throw new BridgeError('ERP вернула пустой каталог MCP. Попросите администратора проверить доступные сотруднику операции в Fastkore.', 424);
            const loaded: Catalog = {
              url,
              tools,
              sessionId: connection.sessionId,
              protocol: connection.protocol,
              expiresAt: Math.min(Date.now() + 5 * 60_000, state.delegation.expiresAt),
            };
            state.catalog = loaded;
            state.catalogProblem = undefined;
            return loaded;
          })().finally(() => { state.catalogPending = undefined; });
        }
        catalog = await state.catalogPending;
        check(); signal.throwIfAborted();
      }
      const { tools } = catalog;
      const connection = { sessionId: catalog.sessionId, protocol: catalog.protocol };
      const restrictWrites = readOnly();
      const definitions = [...tools.values()].filter(tool => !restrictWrites || readTools.has(tool.upstream)).map(tool => tool.definition);
      const attachmentsAvailable = tools.has('fastkore_GetObjectFiles');
      const webToken = async () => (await this.token(state, binding, 'fastkore-webapi')).value;
      let attachmentReads = 0, attachmentImages = 0;
      if (attachmentsAvailable) definitions.push(attachmentTool);
      return { tools: {
        definitions,
        async call(name, args, callSignal) {
          const tool = tools.get(name);
          const supplied = record(args);
          if (name === attachmentTool.name && attachmentsAvailable && supplied) {
            const started = performance.now();
            let success = false, status: number | undefined;
            try {
              check();
              if (++attachmentReads > 8) throw new BridgeError('Достигнут лимит чтения вложений за один запрос.', 429);
              const result = await readFastkoreAttachment(supplied, url, binding.mcpCa, async object => {
                const listed = await rpc('tools/call', { name: 'GetObjectFiles', arguments: object }, callSignal, connection);
                if (listed.error || !listed.result || listed.result.isError === true) {
                  throw new BridgeError('Не удалось получить список вложений записи Fastkore.', 424);
                }
                return listed.result;
              }, webToken, check, callSignal);
              if (result.imageUrl) {
                if (attachmentImages + result.imageUrl.length > maxChatImagePayload) {
                  throw new BridgeError('Изображения во вложениях превышают общий лимит за один запрос.', 413);
                }
                attachmentImages += result.imageUrl.length;
              }
              success = result.success;
              return result;
            } catch (error) {
              callSignal.throwIfAborted();
              if (error instanceof BridgeError) { status = error.statusCode; if (status === 401) state.webApiToken = undefined; }
              return { success: false, text: error instanceof BridgeError ? redact(error.message) : 'Не удалось прочитать вложение Fastkore.' };
            } finally {
              audit?.({ tool: 'GetFile', parameters: supplied, success, status, elapsedMs: elapsedMs(started) });
            }
          }
          if (!tool || !supplied || Buffer.byteLength(JSON.stringify(supplied)) > 128_000) return { success: false, text: 'Инструмент или его аргументы недоступны.' };
          const started = performance.now(), timing: RpcTiming = {};
          const diagnostic: CallDiagnostic = {};
          let success = false;
          try {
            const result = await rpc('tools/call', { name: tool.upstream, arguments: supplied }, callSignal, connection, timing, diagnostic);
            if (result.status === 404 || result.status === 410) {
              if (state.catalog === catalog) state.catalog = undefined;
            }
            if (result.status === 401) {
              diagnostic.mcpFailure = 'http';
              return { success: false, text: 'Fastkore отклонил токен. Повторный вызов не отправлен. Проверьте состояние операции чтением.' };
            }
            if (result.error) {
              diagnostic.mcpFailure = 'rpc';
              diagnostic.mcpErrorCode = result.error.code;
              return { success: false, text: JSON.stringify({ error: result.error }) };
            }
            if (!result.result) throw new BridgeError(unavailable, 502);
            const text = redact(JSON.stringify(result.result));
            if (result.result.isError === true) diagnostic.mcpFailure = 'tool';
            if (text.length > 96_000) return { success: false, text: 'Ответ Fastkore слишком большой. Уточните выборку.' };
            success = result.result.isError !== true;
            return { success, text };
          } catch (error) {
            if (error instanceof BridgeError && error.statusCode === 403) return { success: false, text: error.message };
            const status = diagnostic.status;
            if (status !== undefined && (status < 200 || status >= 300)) {
              diagnostic.mcpFailure = 'http';
              return { success: false, text: `MCP Fastkore вернул HTTP ${status}. Проверьте состояние операции чтением перед повтором.` };
            }
            if (timing.mcpHttpMs !== undefined) diagnostic.mcpFailure = status === undefined ? 'transport' : 'invalid_response';
            return { success: false, text: 'Fastkore не подтвердил результат операции. Проверьте состояние чтением перед повтором.' };
          } finally {
            audit?.({ tool: tool.upstream, parameters: supplied, ...diagnostic, success, elapsedMs: elapsedMs(started), ...timing });
          }
        },
      } };
    } catch (error) {
      signal.throwIfAborted();
      const problem = error instanceof BridgeError ? error.message : unavailable;
      if (!(error instanceof BridgeError && error.statusCode === 403)) state.catalogProblem = problem;
      return { problem };
    }
  }
}
