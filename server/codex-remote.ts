import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliInfo, CodexLimits, ModelCatalog } from '../shared/types.js';
import type { CodexEvent, CodexRequest, CodexResult, CodexRunner } from './codex.js';
import type { CodexToolDefinition, CodexToolResult } from './codex-tools.js';
import { BridgeError } from './store.js';
import type { ExecutionAccounts, ExecutionProvider } from '../shared/execution-accounts.js';

export type WorkerRun = Pick<CodexRequest, 'prompt' | 'developerInstructions' | 'sessionId' | 'ephemeral' | 'consultation' | 'consultationKey' | 'model' | 'reasoningEffort' | 'workDirectoryId'> & { toolDefinitions?: CodexToolDefinition[] };
export type WorkerToolResult = CodexToolResult & { id: string };
export type WorkerMessage = { event: CodexEvent } | { result: CodexResult } | { error: string }
  | { toolCall: { id: string; name: string; args: unknown } };

export class RemoteCodexRunner implements CodexRunner {
  readonly isolated = true;
  private readonly consultationContext = new AsyncLocalStorage<string>();
  constructor(private readonly socketPath: string) {}

  private request(path: string, body?: WorkerRun | WorkerToolResult | { name: string; provider?: ExecutionProvider } | { code: string } | { key: string } | { query: string } | Record<string, never>, signal?: AbortSignal): Promise<IncomingMessage> {
    const timeout = AbortSignal.timeout(body ? 16 * 60_000 : 35_000);
    return new Promise((resolve, reject) => {
      const payload = body && JSON.stringify(body);
      const req = httpRequest({
        socketPath: this.socketPath, path, method: body ? 'POST' : 'GET',
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      }, res => {
        if (res.statusCode === 200) resolve(res);
        else {
          res.resume();
          reject(new BridgeError('Исполнитель Codex отклонил запрос.', res.statusCode === 409 ? 409 : 502));
        }
      });
      req.on('error', () => reject(new BridgeError('Не удалось связаться с исполнителем Codex.', 503)));
      req.end(payload);
    });
  }
  private async read<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.request(path, undefined, signal);
    let text = '';
    res.setEncoding('utf8');
    for await (const chunk of res) {
      text += chunk;
      if (text.length > 2_000_000) throw new BridgeError('Ответ исполнителя слишком большой.', 502);
    }
    return JSON.parse(text) as T;
  }
  inspect(_path: string, signal?: AbortSignal, model?: string) { return this.read<CliInfo>('/inspect' + (model ? '?model=' + encodeURIComponent(model) : ''), signal); }
  listModels() { return this.read<ModelCatalog>('/models'); }
  async readLimits(_path?: string, model?: string) { return (await this.read<{ limits: CodexLimits | null }>('/limits' + (model ? '?model=' + encodeURIComponent(model) : ''))).limits; }
  accounts() { return this.read<ExecutionAccounts>('/accounts'); }
  async searchInternet(query: string, signal: AbortSignal): Promise<CodexToolResult> {
    const response = await this.request('/internet/search', { query }, signal);
    let body = '';
    for await (const chunk of response) { body += chunk; if (body.length > 1_000_000) throw new BridgeError('Ответ поиска слишком большой.', 502); }
    return JSON.parse(body);
  }
  async accountAction(action: 'create' | 'login' | 'activate' | 'deactivate' | 'code' | 'key' | 'remove', id?: string, name?: string, provider?: ExecutionProvider) {
    const response = await this.request(action === 'create' ? '/accounts' : '/accounts/' + encodeURIComponent(id!) + '/' + action,
      action === 'create' ? { name: name!, provider } : action === 'code' ? { code: name! } : action === 'key' ? { key: name! } : {});
    let body = '';
    for await (const chunk of response) body += chunk;
    return JSON.parse(body);
  }
  async run(r: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal) {
    const { prompt, developerInstructions, sessionId, ephemeral, consultation, model, reasoningEffort, workDirectoryId, tools } = r;
    const res = await this.request('/run', { prompt, developerInstructions, sessionId, ephemeral, consultation,
      consultationKey: consultation ? this.consultationContext.getStore() : undefined, model, reasoningEffort, workDirectoryId, toolDefinitions: tools?.definitions }, signal);
    const stream = createInterface({ input: res, crlfDelay: Infinity });
    try {
      for await (const line of stream) {
        signal.throwIfAborted();
        if (line.length > 4_000_000) throw new BridgeError('Событие исполнителя слишком большое.', 502);
        const message = JSON.parse(line) as WorkerMessage;
        if ('event' in message) await onEvent(message.event);
        else if ('toolCall' in message) {
          const { id, name, args } = message.toolCall;
          let result = { success: false, text: 'Инструмент недоступен.' };
          if (tools) {
            try { result = await this.consultationContext.run(id, () => tools.call(name, args, signal)); } catch { /* Reply without disclosing the backend exception. */ }
          }
          signal.throwIfAborted();
          const reply = await this.request('/tool-result', { id, ...result }, signal);
          reply.resume();
        }
        else if ('result' in message) return message.result;
        else if ('error' in message) throw new BridgeError(message.error, 502);
      }
      throw new BridgeError('Связь с исполнителем Codex прервалась.', 502);
    } finally {
      stream.close();
      res.destroy();
    }
  }
}
