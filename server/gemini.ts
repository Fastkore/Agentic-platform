import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexEvent, CodexRequest, CodexResult, CodexRunner } from './codex.js';
import type { CliInfo, ModelCatalog } from '../shared/types.js';
import { BridgeError, redact } from './store.js';

export class GeminiClient implements CodexRunner {
  readonly isolated = true;
  constructor(private readonly home: string, private readonly executable = '/usr/local/bin/gemini', private readonly prefix: string[] = []) {}
  async inspect(): Promise<CliInfo> {
    return { path: '', version: 'Gemini CLI 0.68.0', authentication: existsSync(path.join(this.home, '.gemini', 'oauth_creds.json')) ? 'google' : 'signed-out',
      status: 'Вход через Google на исполнителе Gemini CLI.' };
  }
  async listModels(): Promise<ModelCatalog> {
    return { models: [{ id: 'gemini-auto', name: 'Gemini CLI · авто', description: 'Модель выбирает Gemini CLI.', isDefault: true }],
      fetchedAt: new Date().toISOString(), source: 'gemini' };
  }
  async readLimits() { return null; }
  async run(request: CodexRequest, onEvent: (event: CodexEvent) => Promise<void>, signal: AbortSignal): Promise<CodexResult> {
    if (request.model && !request.model.startsWith('gemini-')) throw new BridgeError('Выберите модель Gemini в настройках диалога.', 409);
    const temporary = await mkdtemp(path.join(tmpdir(), 'bridge-gemini-'));
    const cwd = path.join(this.home, 'runtime');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    const definitions = [...(request.tools?.definitions ?? [])];
    const fileTool = 'workspace_files';
    if (request.workDirectoryId) definitions.push({
      type: 'function', name: fileTool, description: 'Файлы текущего задания. action list/read/write/remove. Пути относительны рабочей папке. Результаты сохраняй в output. Источники CLI находятся в cli.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'path'],
        properties: { action: { enum: ['list', 'read', 'write', 'remove'] }, path: { type: 'string' }, text: { type: 'string', maxLength: 200000 } } },
    });
    const files = async (args: Record<string, unknown>) => {
      if (typeof args.path !== 'string' || !request.workDirectoryId) throw Error('Invalid file path');
      const root = await realpath(request.workspace), target = path.resolve(root, args.path);
      if (target !== root && !target.startsWith(root + path.sep)) throw Error('File outside job');
      let current = root;
      for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1) throw Error('File link unavailable');
      }
      if (args.action === 'list') return JSON.stringify((await readdir(target, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })));
      if (args.action === 'read') {
        const info = await lstat(target);
        if (!info.isFile() || info.size > 200000) throw Error('File too large for text reading');
        return (await readFile(target, 'utf8')).slice(0, 80000);
      }
      if (!request.allowWrite || target === root) throw Error('Writing unavailable');
      if (args.action === 'write' && typeof args.text === 'string' && args.text.length <= 200000) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, args.text, { mode: 0o600, signal });
        return 'Сохранено';
      }
      if (args.action === 'remove' && (await lstat(target)).isFile()) { await rm(target); return 'Удалено'; }
      throw Error('Unknown file operation');
    };
    const server = createServer(async (req, res) => {
      const send = (status: number, value?: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
      if (req.headers.authorization !== 'Bearer ' + token || req.method !== 'POST') { send(403); return; }
      let rpcId: unknown = null;
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 300000) throw Error('Too large'); }
        const rpc = JSON.parse(body);
        rpcId = rpc.id;
        const reply = (result: unknown) => send(200, { jsonrpc: '2.0', id: rpc.id, result });
        if (rpc.method === 'initialize') { reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Agent Platform', version: '1' } }); return; }
        if (rpc.method?.startsWith('notifications/')) { send(202); return; }
        if (rpc.method === 'tools/list') { reply({ tools: definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }); return; }
        if (rpc.method !== 'tools/call') throw Error('Unknown method');
        const { name, arguments: args } = rpc.params;
        let result = { success: false, text: 'Инструмент недоступен.' };
        if (definitions.some(item => item.name === name)) {
          if (name === fileTool) result = { success: true, text: await files(args) };
          else if (request.tools) result = await request.tools.call(name, args, signal);
        }
        reply({ content: [{ type: 'text', text: result.text }], isError: !result.success });
      } catch { send(200, { jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'Не удалось выполнить инструмент.' } }); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No MCP endpoint');
    const settings = path.join(temporary, 'settings.json');
    await writeFile(settings, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' }, folderTrust: { enabled: false } },
      tools: { core: [] }, mcp: { allowed: ['bridge'] },
      mcpServers: { bridge: { httpUrl: 'http://127.0.0.1:' + address.port, headers: { Authorization: 'Bearer ' + token }, trust: true } },
      context: { fileName: [] }, experimental: { enableAgents: false }, hooksConfig: { enabled: false },
    }), { mode: 0o600 });
    const args = ['-p', 'Выполни запрос из stdin.', '--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust'];
    if (request.model && request.model !== 'gemini-auto') args.push('--model', request.model);
    if (request.sessionId) args.push('--resume', request.sessionId);
    const child = spawn(this.executable, [...this.prefix, ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: this.home, GEMINI_CLI_HOME: this.home,
        HTTPS_PROXY: process.env.HTTPS_PROXY, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings, NO_BROWSER: 'true' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '', response = '', sessionId: string | undefined, completed = false, failure = false;
    let usage: CodexResult['usage'];
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    void closed.catch(() => {});
    child.stderr.on('data', chunk => { stderr = redact((stderr + chunk.toString()).slice(-5000)); });
    const stop = () => child.kill('SIGKILL');
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 15 * 60000);
    child.stdin.on('error', () => {});
    child.stdin.end([request.developerInstructions, request.prompt].filter(Boolean).join('\n\n'));
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        signal.throwIfAborted();
        if (line.length > 4000000) throw Error('Gemini event too large');
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'init' && /^[0-9a-f-]{36}$/i.test(event.session_id)) {
          sessionId = event.session_id; await onEvent({ kind: 'session', text: sessionId });
        }
        if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') response += event.content;
        if (event.type === 'result') {
          completed = event.status === 'success';
          failure = !completed;
          if (event.stats) usage = { inputTokens: event.stats.input_tokens ?? 0, cachedInputTokens: event.stats.cached ?? 0, outputTokens: event.stats.output_tokens ?? 0 };
        }
      }
      const code = await closed;
      signal.throwIfAborted();
      if (code !== 0 || !completed || failure) throw new BridgeError(stderr || 'Gemini CLI не завершила запрос.', 502);
      if (response) await onEvent({ kind: 'message', text: response });
      if (usage) await onEvent({ kind: 'usage', usage });
      return { sessionId, response, usage };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', stop); stop();
      server.closeAllConnections(); server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
