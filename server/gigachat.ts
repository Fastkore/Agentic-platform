import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { getCACertificates } from 'node:tls';
import { gigaChatScopes, type GigaChatScope } from '../shared/execution-accounts.js';
import type { CliInfo, CodexLimits, ModelCatalog, Usage } from '../shared/types.js';
import type { CodexEvent, CodexRequest, CodexRunner } from './codex.js';
import { BridgeError } from './store.js';
import { describeToolContext } from './tool-context.js';

const api = 'https://api.giga.chat/v1';
const oauth = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const defaultModel = 'GigaChat-2-Max';
const modelId = /^GigaChat(?:[.:-][a-zA-Z0-9.:-]+)?$/;
const credentialPath = (home: string) => path.join(home, 'gigachat-auth.json');
const unavailable = (message: string) => new BridgeError('GigaChat: ' + message, 503);
type Credentials = { key: string; scope: GigaChatScope; revision: string };
type FunctionCall = { name?: string; arguments?: Record<string, unknown> };
type Message = { role: 'system' | 'user' | 'assistant' | 'function'; content: string; name?: string;
  function_call?: FunctionCall; functions_state_id?: string; attachments?: string[] };
type Chunk = { choices?: { delta?: Partial<Message>; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; precached_prompt_tokens?: number; completion_tokens?: number } };
type Transport = (url: string, headers: Record<string, string>, signal: AbortSignal, body?: string | Buffer) => Promise<IncomingMessage>;

export async function readGigaChatCredentials(home: string): Promise<Credentials | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialPath(home), 'utf8')) as Partial<Credentials>;
    return typeof parsed.key === 'string' && typeof parsed.revision === 'string' && parsed.scope && gigaChatScopes.includes(parsed.scope)
      ? parsed as Credentials : null;
  } catch { return null; }
}

async function requestGigaChat(url: string, headers: Record<string, string>, signal: AbortSignal, body?: string | Buffer) {
  const ca = await readFile(path.resolve('deploy/gigachat-ca.crt'), 'utf8').catch(() => {
    throw unavailable('файл сертификатов НУЦ Минцифры недоступен в воркере.');
  });
  signal.throwIfAborted();
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(url, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    }, signal, ca: [...getCACertificates('default'), ca] }, resolve);
    request.on('error', error => {
      if (signal.aborted) return reject(signal.reason);
      const code = (error as NodeJS.ErrnoException).code;
      reject(unavailable(code && /CERT|ISSUER|SELF_SIGNED/.test(code)
        ? 'не удалось подтвердить TLS-сертификат API.' : 'не удалось связаться с API.'));
    });
    request.end(body);
  });
}

async function readJson<T>(response: IncomingMessage): Promise<T> {
  try {
    let body = '';
    for await (const chunk of response.setEncoding('utf8')) {
      body += chunk;
      if (body.length > 1_000_000) throw unavailable('ответ API слишком велик.');
    }
    return JSON.parse(body) as T;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw unavailable('сервер вернул некорректный ответ.');
  }
}

function requireSuccess(response: IncomingMessage, operation: string) {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) return response;
  response.destroy();
  const hint = status === 401 || status === 403 ? ' Проверьте ключ, scope и доступность модели.'
    : status === 429 || status === 402 ? ' Проверьте квоту аккаунта.' : '';
  throw unavailable(`${operation}: HTTP ${status}.${hint}`);
}

function modelCatalog(ids: unknown[]): ModelCatalog {
  const models = [...new Set(ids.filter((id): id is string => typeof id === 'string' && modelId.test(id)))];
  if (!models.length) throw unavailable('аккаунт не вернул моделей для генерации.');
  const preferred = [defaultModel, 'GigaChat-Max', 'GigaChat-2-Pro', 'GigaChat-Pro', 'GigaChat'].find(id => models.includes(id)) ?? models[0];
  return { source: 'gigachat', fetchedAt: new Date().toISOString(), models: models.map(id => ({
    id, name: id === 'GigaChat-3-Ultra' ? 'GigaChat Ultra 3.5' : id, description: 'GigaChat API · Сбер', isDefault: id === preferred,
  })) };
}

function functionSchema(input: unknown): Record<string, unknown> {
  const schema = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, Record<string, unknown>> : undefined;
  const items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
    ? schema.items as Record<string, unknown> : undefined;
  const first = Array.isArray(schema.enum) ? schema.enum.find(value => value != null) : undefined;
  const primitive = typeof first === 'string' || typeof first === 'boolean' || typeof first === 'number' ? typeof first : undefined;
  // The v1 API requires an explicit type even for enum properties.
  return { ...schema, type: schema.type ?? (properties ? 'object' : items ? 'array' : primitive ?? 'string'),
    ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, functionSchema(value)])) } : {}),
    ...(items ? { items: functionSchema(items) } : {}) };
}

export class GigaChatClient implements CodexRunner {
  readonly isolated = true;
  private token?: { revision: string; value: string; expires: number };
  private catalog?: { revision: string; value: ModelCatalog; expires: number };
  constructor(private readonly home: string, private readonly transport: Transport = requestGigaChat) {}

  async inspect(): Promise<CliInfo> {
    const connected = !!await readGigaChatCredentials(this.home);
    return { path: '', version: 'GigaChat API v1', authentication: connected ? 'gigachat' : 'signed-out',
      status: connected ? 'Ключ GigaChat API сохранён.' : 'Сохраните ключ GigaChat API.' };
  }

  async setKey(key: string, scope: GigaChatScope) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || !/^[^:\s]+:[^:\s]+$/.test(Buffer.from(key, 'base64').toString())) {
      throw new BridgeError('Укажите Authorization Key проекта GigaChat API.');
    }
    const credentials = { key, scope, revision: randomUUID() };
    await this.loadModels(credentials, AbortSignal.timeout(25_000));
    const target = credentialPath(this.home), temporary = target + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  private async credentials() {
    const credentials = await readGigaChatCredentials(this.home);
    if (!credentials) throw unavailable('сохраните ключ в настройках исполнителя.');
    return credentials;
  }

  private async accessToken(credentials: Credentials, signal: AbortSignal) {
    if (this.token?.revision === credentials.revision && this.token.expires > Date.now() + 60_000) return this.token.value;
    const response = await this.transport(oauth, {
      Authorization: 'Basic ' + credentials.key, RqUID: randomUUID(), Accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    }, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), new URLSearchParams({ scope: credentials.scope }).toString());
    const { access_token: value, expires_at: expiry } = await readJson<{ access_token?: string; expires_at?: number }>(requireSuccess(response, 'получение токена'));
    if (typeof value !== 'string' || !value || /\s/.test(value)) throw unavailable('сервер не выдал токен доступа.');
    const expires = typeof expiry === 'number' && Number.isFinite(expiry)
      ? (expiry < 1e12 ? expiry * 1000 : expiry) : Date.now() + 30 * 60_000;
    this.token = { revision: credentials.revision, value, expires };
    return value;
  }

  private async apiRequest(credentials: Credentials, route: string, signal: AbortSignal, operation: string,
    body?: string | Buffer, headers: Record<string, string> = {}) {
    const send = (token: string) => this.transport(api + route, {
      Accept: 'application/json', ...headers, Authorization: 'Bearer ' + token,
    }, signal, body);
    const token = await this.accessToken(credentials, signal);
    let response = await send(token);
    if (response.statusCode === 401) {
      response.destroy();
      if (this.token?.value === token) this.token = undefined;
      response = await send(await this.accessToken(credentials, signal));
    }
    return requireSuccess(response, operation);
  }

  private async loadModels(credentials: Credentials, signal: AbortSignal) {
    if (this.catalog?.revision === credentials.revision && this.catalog.expires > Date.now()) return this.catalog.value;
    const response = await this.apiRequest(credentials, '/models', signal, 'список моделей');
    const { data } = await readJson<{ data?: { id?: unknown }[] }>(response);
    const value = modelCatalog(Array.isArray(data) ? data.map(entry => entry?.id) : []);
    this.catalog = { revision: credentials.revision, value, expires: Date.now() + 60_000 };
    return value;
  }

  async listModels(): Promise<ModelCatalog> {
    return this.loadModels(await this.credentials(), AbortSignal.timeout(25_000));
  }

  async readLimits(): Promise<CodexLimits> {
    return { provider: 'gigachat', buckets: [], resetsAvailable: null, unavailableReason: 'Остаток квоты смотрите в кабинете GigaChat API.' };
  }

  private async uploadImage(credentials: Credentials, url: string, signal: AbortSignal) {
    const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+=*)$/.exec(url);
    if (!match) throw unavailable('для изображений используйте JPG или PNG.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw unavailable('допускается до 15 МБ на изображение.');
    const boundary = randomUUID();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${match[1]}"\r\nContent-Type: image/${match[1]}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.apiRequest(credentials, '/files', AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      'загрузка изображения', body, { 'content-type': 'multipart/form-data; boundary=' + boundary });
    const { id } = await readJson<{ id?: unknown }>(response);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw unavailable('сервер не вернул идентификатор изображения.');
    return id;
  }

  private async stream(credentials: Credentials, body: string, onDelta: (text: string) => Promise<void>, signal: AbortSignal) {
    const response = await this.apiRequest(credentials, '/chat/completions', AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
      'генерация', body, { Accept: 'text/event-stream', 'content-type': 'application/json; charset=utf-8' });
    if (!/^text\/event-stream\b/i.test(String(response.headers['content-type']))) {
      response.destroy(); throw unavailable('сервер не вернул поток событий.');
    }
    const message: Message = { role: 'assistant', content: '' };
    let finish: string | undefined, usage: Chunk['usage'], size = 0;
    const lines = createInterface({ input: response, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        size += line.length;
        if (size > 2_000_000) throw unavailable('ответ модели слишком велик.');
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (value === '[DONE]') return { message, finish, usage };
        const event = JSON.parse(value) as Chunk;
        const choice = event.choices?.[0], delta = choice?.delta;
        usage = event.usage ?? usage;
        finish = choice?.finish_reason ?? finish;
        if (typeof delta?.content === 'string' && delta.content) {
          message.content += delta.content;
          await onDelta(delta.content);
        }
        if (delta?.function_call) message.function_call = delta.function_call;
        if (typeof delta?.functions_state_id === 'string') message.functions_state_id = delta.functions_state_id;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof BridgeError) throw error;
    } finally { lines.close(); response.destroy(); }
    throw unavailable('поток прервался до завершения ответа.');
  }

  async run(request: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal) {
    signal.throwIfAborted();
    const credentials = await this.credentials();
    const model = request.model ?? (await this.loadModels(credentials, signal)).models.find(entry => entry.isDefault)!.id;
    if (!modelId.test(model)) throw unavailable('выберите модель GigaChat из списка исполнителя.');
    const definitions = request.tools?.definitions ?? [];
    const tools = definitions.map(({ name, description, inputSchema }) => ({ name, description, parameters: functionSchema({
      type: 'object', properties: {}, ...inputSchema,
    }) }));
    const messages: Message[] = request.developerInstructions ? [{ role: 'system', content: request.developerInstructions }] : [];
    const images: string[] = [];
    try {
      for (const url of request.imageUrls ?? []) {
        if (!/(?:Max|Pro|Ultra)/i.test(model)) throw unavailable('для изображений выберите GigaChat Pro, Max или Ultra.');
        const id = await this.uploadImage(credentials, url, signal);
        images.push(id);
      }
      for (const [index, id] of images.slice(0, -1).entries()) {
        messages.push({ role: 'user', content: 'Изображение ' + (index + 1) + ' к запросу пользователя.', attachments: [id] });
      }
      messages.push({ role: 'user', content: request.prompt, ...(images.length ? { attachments: images.slice(-1) } : {}) });
      let response = '', used: Usage | undefined;
      for (let step = 0; step <= 64; step++) {
        const body = JSON.stringify({ model, messages, stream: true,
          ...(tools.length ? { functions: tools, function_call: 'auto' } : {}) });
        if (Buffer.byteLength(body) > 4_000_000) throw unavailable('контекст и результаты инструментов превысили лимит задания.');
        let started = false;
        const { message, finish, usage } = await this.stream(credentials, body, async text => {
          const delta = !started && response ? '\n\n' + text : text;
          started = true; response += delta;
          await onEvent({ kind: 'message-delta', text: delta });
        }, signal);
        if (usage) {
          used = {
            inputTokens: (used?.inputTokens ?? 0) + (usage.prompt_tokens ?? 0),
            cachedInputTokens: (used?.cachedInputTokens ?? 0) + (usage.precached_prompt_tokens ?? 0),
            outputTokens: (used?.outputTokens ?? 0) + (usage.completion_tokens ?? 0),
          };
          await onEvent({ kind: 'usage', usage: used });
        }
        if (finish === 'stop' && message.content.trim()) return { response, usage: used };
        const call = message.function_call;
        if (finish !== 'function_call' || !call?.name || !message.functions_state_id || !call.arguments ||
          typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
          throw unavailable(finish === 'length' ? 'достигнут лимит длины ответа.' : 'модель завершила ход без ответа или корректного вызова функции.');
        }
        if (step === 64) break;
        const name = call.name, args = call.arguments, toolCallId = randomUUID();
        let result = { success: false, text: 'Инструмент не разрешён для этого запроса.' };
        if (definitions.some(definition => definition.name === name)) {
          await onEvent({ kind: 'tool', text: name, toolCallId, toolContext: describeToolContext(name, args) });
          try { result = await request.tools!.call(name, args, signal); }
          catch { result = { success: false, text: 'Вызов инструмента не выполнен.' }; }
          finally { await onEvent({ kind: 'tool-end', toolCallId }); }
        }
        signal.throwIfAborted();
        messages.push(message, { role: 'function', name, content: JSON.stringify(result) });
      }
      throw unavailable('превышен лимит последовательных вызовов инструментов.');
    } finally {
      await Promise.allSettled(images.map(id => this.apiRequest(credentials, '/files/' + id + '/delete',
        AbortSignal.timeout(6000), 'удаление изображения', '').then(response => response.resume())));
    }
  }
}
