import { request } from 'node:https';
import type { FastkoreContext } from '../shared/fastkore-context.js';
import type { Credential } from '../shared/types.js';
import type { CodexTools, CodexToolDefinition } from './codex-tools.js';
import { postErpJson, type ErpDelegation, type FastkoreSso } from './fastkore.js';
import { BridgeError, redact } from './store.js';

type Binding = NonNullable<ReturnType<FastkoreSso['delegationBinding']>>;
type Token = { value: string; expiresAt: number };
type Session = { credential: Credential; delegation: ErpDelegation; revision: string; token?: Token; refresh?: Promise<Token> };
type Tool = { upstream: string; definition: CodexToolDefinition; fixed?: Record<string, unknown> };
type ReadAudit = { tool: string; scope?: 'current' | 'erp'; parameters: Record<string, unknown>; status?: number; success: boolean; elapsedMs: number };
const audience = 'fastkore-mcp';
const reauth = 'Доступ к ERP завершён или отозван. Откройте помощника из Fastkore заново.';
const scopeError = 'Текущая выборка Fastkore недоступна через этот инструмент. Другие разделы ERP доступны по запросу сотрудника с scope=erp.';
const unavailable = 'Инструменты Fastkore сейчас недоступны. Чат доступен.';
const maxResponse = 768 * 1024;
// The production pilot exposes only methods verified as reads in Fastkore.Business.
const readTools = new Set([
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

function scopedArguments(context: FastkoreContext | undefined, schema: Record<string, any>, tool: string) {
  const fixed: Record<string, unknown> = {};
  if (!context || tool === 'GetCurrentUserInfo') return fixed;
  if (!context.scope_reproducible || context.filter_status === 'unavailable') return undefined;
  if (context.view === 'card') return context.entity_id ? fixed : undefined;
  const restrictions = {
    filterXml: context.filter_xml, catalogId: context.catalog_id, folderId: context.folder_id,
    treeParentId: context.tree_parent_id, ownerEntitySetId: context.owner_entity_set_id,
    ownerEntityId: context.owner_entity_id, linkId: context.link_id, deleted: context.deleted,
  };
  if (Object.values(restrictions).every(value => value === null)) return fixed;
  const properties = record(schema.properties);
  for (const [key, value] of Object.entries({ entitySetId: context.entity_set_id, ...restrictions })) {
    if (value === null) continue;
    const parameter = Object.keys(properties ?? {}).find(name => name.replaceAll('_', '').toLowerCase() === key.toLowerCase());
    if (!parameter) return undefined;
    fixed[parameter] = value;
  }
  return fixed;
}

function postMcp(url: string, token: string, ca: string | undefined, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
  return new Promise<{ status: number; value?: unknown; sessionId?: string }>((resolve, reject) => {
    const json = JSON.stringify(body);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const req = request(url, { method: 'POST', ca, signal: requestSignal, headers: {
      ...headers, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json),
      Accept: 'application/json, text/event-stream',
    } }, async res => {
      try {
        const status = res.statusCode ?? 502;
        if (status < 200 || status >= 300 || status === 202 || status === 204) { res.destroy(); resolve({ status }); return; }
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
    req.on('error', () => reject(new BridgeError(unavailable, 502)));
    req.end(json);
  });
}

export class FastkoreMcp {
  private readonly sessions = new Map<string, Session>();
  private readonly expired = new Set<string>();

  constructor(private readonly sso: Pick<FastkoreSso, 'delegationBinding' | 'openDelegation'>,
    private readonly forgetDelegation: (credentialId: string) => Promise<void>) {}

  status(credential: Credential): 'unavailable' | 'ready' | 'reauth' {
    if (credential.erpDelegationRevoked || this.expired.has(credential.id)) return 'reauth';
    const stored = credential.erpDelegation;
    if (!stored) return 'unavailable';
    const binding = this.sso.delegationBinding(credential);
    if (stored.expiresAt <= Date.now() || (binding && stored.revision !== binding.revision)) {
      void this.invalidate(credential.id);
      return 'reauth';
    }
    if (!binding?.mcpUrl) return 'unavailable';
    if (!this.sessions.has(credential.id)) {
      if (this.sessions.size >= 4096) return 'unavailable';
      const delegation = this.sso.openDelegation(credential, binding.revision);
      if (!delegation) { void this.invalidate(credential.id); return 'reauth'; }
      this.sessions.set(credential.id, { credential, delegation, revision: binding.revision });
    }
    return 'ready';
  }

  invalidate(id: string) {
    this.sessions.delete(id);
    this.expired.add(id);
    return this.forgetDelegation(id).catch(() => {
      // Still fail closed in this process if SQLite is temporarily unavailable.
    });
  }

  async revoke(credential: Credential) {
    const invalidated = this.expired.delete(credential.id);
    this.sessions.delete(credential.id);
    if (invalidated || !credential.erpDelegation) return;
    try {
      const binding = this.sso.delegationBinding(credential);
      const delegation = binding && this.sso.openDelegation(credential, binding.revision);
      if (!binding || !delegation) return;
      await postErpJson(binding.origin + '/api/ai/revoke-delegation', JSON.stringify({ version: 1, delegation: delegation.grant }),
        binding, () => new BridgeError(unavailable, 502));
    } catch { /* The local session is already revoked. ERP also enforces its own expiry. */ }
  }

  private async token(state: Session, binding: Binding): Promise<Token> {
    if (state.token && state.token.expiresAt > Date.now() + 10_000) return state.token;
    if (!state.refresh) {
      const { credential, delegation } = state;
      state.refresh = (async () => {
        const fail = () => new BridgeError(unavailable, 502);
        const { status, value } = await postErpJson(binding.origin + '/api/ai/user-token',
          JSON.stringify({ version: 1, delegation: delegation.grant, audience }), binding, fail);
        if (status === 403) {
          if (this.sessions.get(credential.id) === state) await this.invalidate(credential.id);
          throw new BridgeError(reauth, 403);
        }
        if (status === 401) throw new BridgeError('ERP отклонила ключ привязки Fastkore. Проверьте подключение.', 424);
        if (status === 404) throw new BridgeError('На сервере ERP недоступна выдача токенов MCP.', 424);
        if (status === 429) throw new BridgeError('Fastkore ограничил частоту запросов. Повторите позже.', 429);
        const result = record(value);
        if (status !== 200 || result?.version !== 1 || result.token_type !== 'Bearer' || result.audience !== audience
          || !Number.isInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 300
          || typeof result.access_token !== 'string' || !/^fkua1\.[A-Za-z0-9._-]{1,4096}$/.test(result.access_token)) throw fail();
        if (this.sessions.get(credential.id) !== state || delegation.expiresAt <= Date.now()) throw new BridgeError(reauth, 403);
        return state.token = { value: result.access_token, expiresAt: Math.min(Date.now() + result.expires_in * 1000, delegation.expiresAt) };
      })().finally(() => { state.refresh = undefined; });
    }
    return state.refresh;
  }

  async prepare(credential: Credential, context: FastkoreContext | undefined, authorize: () => void, signal: AbortSignal,
    audit?: (event: ReadAudit) => void): Promise<{ tools?: CodexTools; problem?: string }> {
    const status = this.status(credential);
    if (status === 'reauth') return { problem: reauth };
    const state = status === 'ready' ? this.sessions.get(credential.id) : undefined;
    const binding = state && this.sso.delegationBinding(credential);
    if (!state || !binding?.mcpUrl) return { problem: context ? 'Доступ к инструментам ERP для этого сеанса не предоставлен. После разрешения доступа откройте помощника из Fastkore заново.' : undefined };
    const url = binding.mcpUrl;
    const check = () => {
      authorize();
      const current = this.sso.delegationBinding(credential);
      if (this.sessions.get(credential.id) !== state || state.delegation.expiresAt <= Date.now()
        || current?.revision !== state.revision || current.mcpUrl !== url) throw new BridgeError(reauth, 403);
    };
    let sessionId: string | undefined;
    let protocol: string | undefined;
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
      check(); signal.throwIfAborted();
      const token = await this.token(state, binding);
      check(); signal.throwIfAborted();
      const notification = method === 'notifications/initialized';
      const requestId = ++id;
      const response = await postMcp(url, token.value, binding.mcpCa,
        { jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params },
        { ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}), ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}) }, signal);
      if (response.status === 401 && state.token === token) state.token = undefined;
      if (response.status < 200 || response.status >= 300) return { status: response.status };
      check();
      if (method === 'initialize') sessionId = response.sessionId;
      if (notification) return { status: response.status };
      const value = record(response.value);
      if (value?.jsonrpc !== '2.0' || value.id !== requestId || value.error || !record(value.result)) throw new BridgeError(unavailable, 502);
      return { status: response.status, result: value.result };
    };
    try {
      const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agent Platform', version: '1' } };
      let initialized = await rpc('initialize', init, signal);
      if (initialized.status === 401) initialized = await rpc('initialize', init, signal);
      if (initialized.status === 401 || initialized.status === 403) throw new BridgeError('MCP Fastkore отклонил доступ сотрудника.', 424);
      if (initialized.status === 404) throw new BridgeError('MCP Fastkore не найден. Проверьте HTTPS-адрес в настройках установки.', 424);
      if (!['2025-06-18', '2025-03-26', '2025-11-25'].includes(initialized.result?.protocolVersion)) throw new BridgeError(unavailable, 502);
      if (process.env.NODE_ENV === 'production') console.info(JSON.stringify({ event: 'fastkore.mcp.initialized', status: initialized.status }));
      protocol = initialized.result!.protocolVersion;
      const notified = await rpc('notifications/initialized', {}, signal);
      if (notified.status >= 300) throw new BridgeError(unavailable, 502);
      const tools = new Map<string, Tool>();
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const { result } = await rpc('tools/list', cursor ? { cursor } : {}, signal);
        if (!Array.isArray(result?.tools)) throw new BridgeError(unavailable, 502);
        for (const value of result.tools) {
          if (typeof value?.name !== 'string' || !readTools.has(value.name) || !record(value.inputSchema)) continue;
          const fixed = scopedArguments(context, value.inputSchema, value.name);
          const name = 'fastkore_' + value.name;
          const upstreamSchema = JSON.parse(redact(JSON.stringify(value.inputSchema)));
          const inputSchema = context ? {
            type: 'object', additionalProperties: false, required: ['scope', 'arguments'],
            properties: {
              scope: { type: 'string', enum: ['current', 'erp'],
                description: 'current — открытая карточка или список. erp — другой раздел или самостоятельный запрос сотрудника в пределах его прав.' },
              arguments: upstreamSchema,
            },
          } : upstreamSchema;
          const description = typeof value.description === 'string' && value.description.trim() ? value.description : value.name;
          tools.set(name, { upstream: value.name, fixed, definition: { type: 'function', name, description: redact(description).slice(0, 4000), inputSchema } });
        }
        if (tools.size > 200) throw new BridgeError(unavailable, 502);
        const next = result.nextCursor;
        if (!next) break;
        if (typeof next !== 'string' || next === cursor || next.length > 512 || page === 7) throw new BridgeError(unavailable, 502);
        cursor = next;
      }
      if (!tools.size) return { problem: context ? scopeError : unavailable };
      const cannotReproduce = !!context && [...tools.values()].every(tool => !tool.fixed || tool.upstream === 'GetCurrentUserInfo');
      return { problem: cannotReproduce ? scopeError : undefined, tools: {
        definitions: [...tools.values()].map(tool => tool.definition),
        async call(name, args, callSignal) {
          const tool = tools.get(name);
          const supplied = record(args);
          if (!tool || !supplied || Buffer.byteLength(JSON.stringify(supplied)) > 128_000) return { success: false, text: 'Инструмент или его аргументы недоступны.' };
          const wrapped = !!context && Object.hasOwn(supplied, 'scope');
          if (wrapped && (Object.keys(supplied).length !== 2 || !['current', 'erp'].includes(supplied.scope) || !record(supplied.arguments))) {
            return { success: false, text: 'Укажите scope current или erp и объект arguments.' };
          }
          const fixed = wrapped && supplied.scope === 'erp' ? {} : tool.fixed;
          if (!fixed) return { success: false, text: scopeError };
          const parameters = wrapped ? supplied.arguments : supplied;
          const fixedKeys = new Set(Object.keys(fixed).map(key => key.replaceAll('_', '').toLowerCase()));
          const forwarded = Object.fromEntries(Object.entries(parameters).filter(([key]) => !fixedKeys.has(key.replaceAll('_', '').toLowerCase())));
          const effective = { ...forwarded, ...fixed };
          const started = Date.now();
          let status: number | undefined;
          let success = false;
          try {
            const result = await rpc('tools/call', { name: tool.upstream, arguments: effective }, callSignal);
            status = result.status;
            if (result.status === 401) return { success: false, text: 'Fastkore отклонил токен. Повторный вызов не отправлен. Проверьте состояние операции чтением.' };
            if (!result.result) return { success: false, text: 'Fastkore не подтвердил результат операции. Проверьте состояние чтением.' };
            const text = redact(JSON.stringify(result.result));
            if (text.length > 96_000) return { success: false, text: 'Ответ Fastkore слишком большой. Уточните выборку.' };
            success = result.result.isError !== true;
            return { success, text };
          } catch (error) {
            if (error instanceof BridgeError && error.message === reauth) return { success: false, text: reauth };
            return { success: false, text: 'Fastkore не подтвердил результат операции. Проверьте состояние чтением перед повтором.' };
          } finally {
            audit?.({ tool: tool.upstream, scope: wrapped && supplied.scope === 'erp' ? 'erp' : context ? 'current' : 'erp',
              parameters: effective, status, success, elapsedMs: Date.now() - started });
          }
        },
      } };
    } catch (error) {
      signal.throwIfAborted();
      return { problem: error instanceof BridgeError && [403, 424, 429].includes(error.statusCode) ? error.message : unavailable };
    }
  }
}
