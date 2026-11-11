import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';
import type { CliInfo, CodexLimits, ModelCatalog } from '../shared/types.js';
import type { CodexEvent, CodexRequest, CodexResult, CodexRunner } from './codex.js';
import { BridgeError } from './store.js';

export type WorkerRun = Pick<CodexRequest, 'prompt' | 'sessionId' | 'ephemeral' | 'model' | 'reasoningEffort'>;
export type WorkerMessage = { event: CodexEvent } | { result: CodexResult } | { error: string };

export class RemoteCodexRunner implements CodexRunner {
  readonly isolated = true;
  constructor(private readonly socketPath: string) {}

  private request(path: string, body?: WorkerRun, signal?: AbortSignal): Promise<IncomingMessage> {
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
  inspect(_path: string, signal?: AbortSignal) { return this.read<CliInfo>('/inspect', signal); }
  listModels() { return this.read<ModelCatalog>('/models'); }
  async readLimits() { return (await this.read<{ limits: CodexLimits | null }>('/limits')).limits; }
  async run(r: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal) {
    const { prompt, sessionId, ephemeral, model, reasoningEffort } = r;
    const res = await this.request('/run', { prompt, sessionId, ephemeral, model, reasoningEffort }, signal);
    const stream = createInterface({ input: res, crlfDelay: Infinity });
    try {
      for await (const line of stream) {
        signal.throwIfAborted();
        if (line.length > 4_000_000) throw new BridgeError('Событие исполнителя слишком большое.', 502);
        const message = JSON.parse(line) as WorkerMessage;
        if ('event' in message) await onEvent(message.event);
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
