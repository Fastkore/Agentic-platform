import type { CodexToolResult } from './codex-tools.js';
import { BridgeError } from './store.js';

// Official GLM Coding Plan MCP endpoint. The key remains on the executor.
export async function searchZai(query: string, key: string, signal: AbortSignal,
  transport: typeof fetch = fetch): Promise<CodexToolResult> {
  const endpoint = 'https://api.z.ai/api/mcp/web_search_prime/mcp';
  let session: string | undefined, protocol: string | undefined, id = 0;
  const rpc = async (method: string, params: unknown, notification = false): Promise<any> => {
    const callId = ++id;
    const response = await transport(endpoint, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: callId }), method, params }),
    });
    if (!response.ok) throw new BridgeError('Сервис поиска Z.ai отклонил запрос. Проверьте доступ и лимиты Coding Plan.', 502);
    session = response.headers.get('Mcp-Session-Id') ?? session;
    if (notification) { await response.body?.cancel(); return; }
    let body = ''; const decoder = new TextDecoder();
    if (response.body) for await (const chunk of response.body) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length > 1_000_000) throw new BridgeError('Ответ поиска слишком большой.', 502);
    }
    body += decoder.decode();
    const values = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).flatMap(line => { try { return [JSON.parse(line.slice(5))]; } catch { return []; } })
      : [JSON.parse(body)];
    const value = values.find(value => value.id === callId);
    if (!value || value.error || !value.result) throw new BridgeError('Сервис поиска Z.ai не подтвердил результат.', 502);
    return value.result;
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Agent Platform', version: '1' } });
    if (typeof initialized.protocolVersion === 'string') protocol = initialized.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    const catalog = await rpc('tools/list', {});
    const tool = catalog.tools?.find((tool: { name: string }) => ['webSearchPrime', 'web_search_prime'].includes(tool.name));
    const field = ['search_query', 'query'].find(field => tool?.inputSchema?.properties?.[field]);
    if (!tool || !field) throw new BridgeError('Сервис Z.ai не предоставил ожидаемый инструмент поиска.', 502);
    const result = await rpc('tools/call', { name: tool.name, arguments: { [field]: query } });
    const text = (result.content ?? []).filter((item: { type: string; text?: string }) => item.type === 'text' && typeof item.text === 'string')
      .map((item: { text: string }) => item.text).join('\n').replaceAll(key, '[REDACTED]').slice(0, 80000);
    return { success: result.isError !== true, text: text || 'Поиск не вернул результатов.' };
  } catch (error) {
    signal.throwIfAborted();
    return { success: false, text: error instanceof BridgeError ? error.message : 'Поиск Z.ai недоступен. Повторите позже.' };
  }
}
