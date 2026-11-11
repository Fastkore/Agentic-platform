import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { BridgeError, redact } from './store.js';
import type { CliInfo, CodexLimits, LimitWindow, ModelCatalog, ModelOption, Usage } from '../shared/types.js';

export interface CodexEvent { kind: 'session' | 'message' | 'progress' | 'usage'; text?: string; usage?: Usage }
export interface CodexRequest { cliPath: string; workspace: string; prompt: string; sessionId?: string; allowWrite: boolean; ephemeral?: boolean; model?: string; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' }
export interface CodexRunner { inspect(cliPath: string, signal?: AbortSignal): Promise<CliInfo>; listModels?(cliPath: string): Promise<ModelCatalog>; readLimits?(cliPath: string): Promise<CodexLimits | null>; run(request: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal): Promise<{ sessionId?: string; response: string; usage?: Usage }> }
type RateWindow = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null };
type RateBucket = { limitId?: string | null; limitName?: string | null; primary?: RateWindow | null; secondary?: RateWindow | null };
type RateResponse = {
  rateLimits?: RateBucket;
  rateLimitsByLimitId?: Record<string, RateBucket> | null;
  rateLimitResetCredits?: { availableCount?: number } | null;
};

function rateWindow(window?: RateWindow | null): LimitWindow[] {
  if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return [];
  return [{
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  }];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function buildArguments(r: CodexRequest) {
  const args = ['-a', 'never', '-c', 'model_provider="openai"', 'exec', '--sandbox', r.allowWrite ? 'workspace-write' : 'read-only', '--cd', path.resolve(r.workspace), '--skip-git-repo-check', '--json', '--color', 'never'];
  if (r.model) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(r.model)) throw new BridgeError('Некорректный идентификатор модели.'); args.push('--model', r.model); }
  if (r.reasoningEffort) { if (!['low', 'medium', 'high', 'xhigh'].includes(r.reasoningEffort)) throw new BridgeError('Некорректный уровень рассуждения.'); args.push('-c', `model_reasoning_effort="${r.reasoningEffort}"`); }
  if (r.ephemeral) args.push('--ephemeral');
  if (r.sessionId) { if (!uuid.test(r.sessionId)) throw new BridgeError('Некорректный ID сессии Codex.'); args.push('resume', r.sessionId); }
  return [...args, '-'];
}
export function authentication(text: string, code: number | null): CliInfo['authentication'] {
  if (code !== 0) return /not (logged|signed)/i.test(text) ? 'signed-out' : 'unknown';
  if (/API[ _-]?key/i.test(text)) return 'api-key';
  return /ChatGPT/i.test(text) ? 'chatgpt' : 'unknown';
}
export async function discoverCli(): Promise<string> {
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) { if (!dir.trim()) continue; const exe = path.join(dir.replaceAll('"', ''), executable); if (existsSync(exe)) return exe; }
  if (process.platform !== 'win32') return '';
  const roots = [path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin'), path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai')];
  const found: { file: string; date: number }[] = [];
  async function walk(root: string, depth: number) {
    if (depth > 8) return;
    for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (item.isSymbolicLink()) continue;
      const file = path.join(root, item.name);
      if (item.isDirectory()) await walk(file, depth + 1);
      else if (item.name.toLowerCase() === 'codex.exe') found.push({ file, date: (await stat(file)).mtimeMs });
    }
  }
  for (const root of roots) await walk(root, 0);
  return found.sort((a, b) => b.date - a.date)[0]?.file ?? '';
}
async function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') await new Promise<void>(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', () => resolve());
  });
}
export class CodexClient implements CodexRunner {
  // Prefix is injected by process integration tests only. No HTTP route can change it.
  constructor(private readonly testPrefix: string[] = []) {}
  private start(exe: string, args: string[], cwd?: string) {
    if (!existsSync(exe) || (process.platform === 'win32' && path.extname(exe).toLowerCase() !== '.exe')) throw new BridgeError('Укажите существующий исполняемый файл Codex CLI.');
    return spawn(exe, [...this.testPrefix, ...args], { cwd, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  private async capture(exe: string, args: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const child = this.start(exe, args); let text = '';
    const result = new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      child.on('error', reject); child.on('close', code => resolve({ code, text: redact(text) }));
    });
    const timer = setTimeout(() => { void killTree(child); }, 20_000);
    const abort = () => { void killTree(child); }; signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { text = (text + chunk.toString('utf8')).slice(-16_000); });
    child.stderr.on('data', chunk => { text = (text + chunk.toString('utf8')).slice(-16_000); }); child.stdin.end();
    try { const captured = await result; signal?.throwIfAborted(); return captured; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async inspect(cliPath: string, signal?: AbortSignal): Promise<CliInfo> {
    const version = await this.capture(cliPath, ['--version'], signal);
    if (version.code !== 0) throw new BridgeError('Не удалось проверить версию Codex CLI.');
    const status = await this.capture(cliPath, ['login', 'status'], signal);
    return { path: cliPath, version: version.text.trim(), authentication: authentication(status.text, status.code), status: status.text.trim() };
  }
  private appServer(cliPath: string) {
    const child = this.start(cliPath, ['-c', 'model_provider="openai"', 'app-server', '--listen', 'stdio://']);
    let timedOut = false;
    const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
    void closed.catch(() => {});
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, 25_000);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_chat_bridge', version: '0.5.0' }, capabilities: { experimentalApi: false } } });
    return {
      lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
      send,
      closed,
      timedOut: () => timedOut,
      close: async () => { clearTimeout(timer); child.stdin.end(); await killTree(child); },
    };
  }
  async listModels(cliPath: string): Promise<ModelCatalog> {
    // Metadata only. Inference still uses codex exec; no OAuth tokens or API keys are read.
    const server = this.appServer(cliPath);
    const models = new Map<string, ModelOption>();
    let page = 0, finished = false;
    const { send } = server;
    const requestPage = (cursor?: string) => { page++; send({ id: 100 + page, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } }); };
    try {
      for await (const line of server.lines) {
        if (line.length > 4_000_000) throw new BridgeError('Слишком большой каталог моделей Codex.', 502);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 && message.id !== 100 + page) continue;
        if (message.error) throw new BridgeError('Codex не вернул каталог моделей: ' + redact(String(message.error.message ?? 'ошибка протокола')), 502);
        if (message.id === 1) { send({ method: 'initialized' }); requestPage(); continue; }
        if (!Array.isArray(message.result?.data)) throw new BridgeError('Неизвестный формат каталога Codex.', 502);
        for (const model of message.result.data) {
          const id = model.model ?? model.id;
          if (model.hidden || typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id)) continue;
          models.set(id, { id, name: String(model.displayName || id), description: String(model.description ?? ''), isDefault: model.isDefault === true });
        }
        if (message.result.nextCursor) {
          if (page >= 10) throw new BridgeError('Каталог моделей превышает ограничение.', 502);
          requestPage(message.result.nextCursor);
        } else { finished = true; break; }
      }
      if (!finished || !models.size) { await server.closed; throw new BridgeError(server.timedOut() ? 'Codex не ответил на запрос списка моделей за 25 секунд.' : 'Каталог моделей Codex недоступен. Проверьте подключение.', 502); }
      return { models: [...models.values()], fetchedAt: new Date().toISOString(), source: 'codex' };
    } finally { await server.close(); }
  }
  async readLimits(cliPath: string): Promise<CodexLimits | null> {
    const server = this.appServer(cliPath);
    try {
      for await (const line of server.lines) {
        if (line.length > 4_000_000) return null;
        let message: { id?: number; error?: unknown; result?: RateResponse };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) return null;
        if (message.id === 1) {
          server.send({ method: 'initialized' });
          server.send({ id: 2, method: 'account/rateLimits/read' });
          continue;
        }
        const result = message.result;
        if (!result) return null;
        const sources = Object.entries(result.rateLimitsByLimitId ?? {});
        if (!sources.length && result.rateLimits) sources.push(['codex', result.rateLimits]);
        const buckets = sources.flatMap(([id, bucket]) => {
          const windows = [...rateWindow(bucket?.primary), ...rateWindow(bucket?.secondary)];
          return windows.length ? [{ name: bucket?.limitName || (id === 'codex' ? 'Codex' : id), windows }] : [];
        });
        const resetsAvailable = result.rateLimitResetCredits?.availableCount ?? null;
        return buckets.length || resetsAvailable !== null ? { buckets, resetsAvailable } : null;
      }
      await server.closed;
      return null;
    } finally { await server.close(); }
  }
  async run(request: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal) {
    signal.throwIfAborted();
    const child = this.start(request.cliPath, buildArguments(request), request.workspace);
    let stderr = '', response = '', sessionId = request.sessionId, usage: Usage | undefined, completed = false, failed = false, error = '';
    const seen = new Set<string>();
    const closed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    // Attach a rejection handler before processing stdout to avoid unhandled spawn errors.
    void closed.catch(() => {});
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + redact(chunk)).slice(-6000); });
    const abort = () => { void killTree(child); }; signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 15 * 60_000);
    child.stdin.on('error', () => {}); child.stdin.end(request.prompt, 'utf8');
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        signal.throwIfAborted();
        if (line.length > 2_000_000) throw new BridgeError('Слишком большое событие Codex.');
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && uuid.test(ev.thread_id)) {
          if (sessionId && sessionId !== ev.thread_id) throw new BridgeError('Codex вернул другую сессию. Исходный ID сохранён.');
          sessionId = ev.thread_id; await onEvent({ kind: 'session', text: sessionId });
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
          if (ev.item.id && seen.has(ev.item.id)) continue;
          if (ev.item.id) seen.add(ev.item.id);
          response += (response ? '\n\n' : '') + ev.item.text; await onEvent({ kind: 'message', text: ev.item.text });
        } else if (ev.type === 'turn.completed') {
          completed = true;
          if (ev.usage) { usage = { inputTokens: Number(ev.usage.input_tokens) || 0, cachedInputTokens: Number(ev.usage.cached_input_tokens) || 0, outputTokens: Number(ev.usage.output_tokens) || 0 }; await onEvent({ kind: 'usage', usage }); }
        } else if (ev.type === 'turn.failed' || ev.type === 'error') {
          if (ev.type === 'turn.failed') failed = true;
          error = redact(ev.error?.message ?? ev.message ?? 'Ошибка Codex');
        } else if (['turn.started', 'item.started', 'item.updated'].includes(ev.type)) {
          await onEvent({ kind: 'progress', text: ev.item?.type === 'command_execution' ? 'Codex работает с файлами…' : 'Codex выполняет задание…' });
        }
      }
      const code = await closed; signal.throwIfAborted();
      if (code !== 0 || failed || !completed) throw new BridgeError(error || stderr || 'Codex завершился без готового ответа.', 502);
      if (!sessionId && !request.ephemeral) throw new BridgeError('Codex не вернул ID сессии.', 502);
      return { sessionId, response, usage };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await killTree(child); }
  }
}
