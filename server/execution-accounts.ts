import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ExecutionAccount, ExecutionAccounts, ExecutionProvider } from '../shared/execution-accounts.js';
import { CodexClient, type CodexRunner } from './codex.js';
import { BridgeError } from './store.js';
import { GeminiClient } from './gemini.js';

type RecordAccount = Pick<ExecutionAccount, 'id' | 'name' | 'provider'>;
type Manifest = { active: string; accounts: RecordAccount[] };
export class ExecutionAccountStore {
  private state: Manifest;
  private readonly file: string;
  private readonly logins = new Map<string, { child: ChildProcess; status: NonNullable<ExecutionAccount['login']> }>();
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'accounts.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      active: 'default', accounts: [{ id: 'default', name: 'Основной Codex', provider: 'codex' }],
    };
  }
  private find(id: string) {
    const account = this.state.accounts.find(item => item.id === id);
    if (!account) throw new BridgeError('Аккаунт не найден.', 404);
    return account;
  }
  home(id: string) {
    this.find(id);
    return id === 'default' ? this.root : path.join(this.root, 'accounts', id);
  }
  get active() { return this.state.active; }
  runner(): CodexRunner {
    return this.find(this.active).provider === 'gemini' ? new GeminiClient(this.home(this.active)) : new CodexClient([], 'worker', this.home(this.active));
  }
  get provider() { return this.find(this.active).provider; }
  async executionKey() {
    const account = this.find(this.active);
    const home = this.home(account.id);
    let identity = account.id;
    try {
      const file = account.provider === 'gemini' ? path.join('.gemini', 'oauth_creds.json') : 'auth.json';
      const auth = JSON.parse(await readFile(path.join(home, file), 'utf8'));
      const token = account.provider === 'gemini' ? auth.id_token : auth.tokens?.id_token;
      const claims = typeof token === 'string' ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) : {};
      identity = auth.tokens?.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.sub ?? claims.email ?? identity;
      if (account.provider === 'gemini' && identity === account.id) {
        const google = JSON.parse(await readFile(path.join(home, '.gemini', 'google_accounts.json'), 'utf8'));
        if (typeof google.active === 'string') identity = google.active;
      }
    } catch { /* Signed-out profiles keep a stable key until login finishes. */ }
    return account.id + ':' + createHash('sha256').update(String(identity)).digest('hex').slice(0, 16);
  }
  private async save(next: Manifest) {
    const temporary = this.file + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await rename(temporary, this.file);
    this.state = next;
  }
  async list(): Promise<ExecutionAccounts> {
    return { accounts: await Promise.all(this.state.accounts.map(async account => {
      let email: string | undefined, signedIn = false;
      try {
        const file = account.provider === 'gemini' ? path.join('.gemini', 'oauth_creds.json') : 'auth.json';
        const auth = JSON.parse(await readFile(path.join(this.home(account.id), file), 'utf8'));
        signedIn = account.provider === 'gemini' ? typeof auth.refresh_token === 'string' : typeof auth.tokens?.access_token === 'string';
        if (account.provider === 'codex' && typeof auth.tokens?.id_token === 'string') {
          const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
          if (typeof claims.email === 'string') email = claims.email;
        }
      } catch { /* A signed-out account is still available for login. */ }
      const login = this.logins.get(account.id);
      if (signedIn && account.provider === 'gemini' && login?.status.state === 'waiting') {
        login.status.state = 'complete';
        login.status.needsCode = false;
        login.child.kill();
      }
      return { ...account, email, signedIn, active: account.id === this.active, login: this.logins.get(account.id)?.status };
    })) };
  }
  async create(name: string, provider: ExecutionProvider = 'codex') {
    if (!name.trim() || name.length > 100) throw new BridgeError('Укажите название аккаунта.');
    if (this.state.accounts.length >= 20) throw new BridgeError('Допускается до 20 аккаунтов.');
    const account: RecordAccount = { id: randomUUID(), name: name.trim(), provider };
    await mkdir(path.join(this.root, 'accounts', account.id), { recursive: true, mode: 0o700 });
    await this.save({ ...this.state, accounts: [...this.state.accounts, account] });
    return account;
  }
  async activate(id: string) {
    this.find(id);
    const account = (await this.list()).accounts.find(item => item.id === id)!;
    if (!account.signedIn) throw new BridgeError('Сначала выполните вход в аккаунт.', 409);
    await this.save({ ...this.state, active: id });
    return this.list();
  }
  async login(id: string) {
    const account = this.find(id);
    const existing = this.logins.get(id);
    if (existing?.status.state === 'waiting') return existing.status;
    const home = this.home(id);
    if (account.provider === 'gemini') {
      await mkdir(path.join(home, '.gemini'), { recursive: true, mode: 0o700 });
      await rm(path.join(home, '.gemini', 'oauth_creds.json'), { force: true });
      await writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } }, tools: { core: [] },
      }), { mode: 0o600 });
    }
    const child = spawn(account.provider === 'gemini' ? '/usr/bin/script' : '/usr/local/bin/codex',
      account.provider === 'gemini' ? ['-q', '-f', '-c', '/usr/local/bin/gemini --skip-trust', '/dev/null'] : ['login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: home, ...(account.provider === 'gemini' ? { HOME: home, GEMINI_CLI_HOME: home, NO_BROWSER: 'true', TERM: 'xterm' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const state: NonNullable<ExecutionAccount['login']> = { state: 'waiting' };
    const lifetime = setTimeout(() => {
      state.state = 'error'; state.error = 'Срок ожидания входа истёк. Запросите новую ссылку.';
      child.kill();
    }, account.provider === 'gemini' ? 6 * 60000 : 16 * 60000).unref();
    child.once('close', () => clearTimeout(lifetime));
    this.logins.set(id, { child, status: state });
    return await new Promise<typeof state>(resolve => {
      let output = '', returned = false;
      const finish = () => { if (!returned) { returned = true; clearTimeout(timer); resolve(state); } };
      const timer = setTimeout(() => { child.kill(); state.state = 'error'; state.error = 'Не удалось начать вход. Повторите попытку.'; finish(); }, 30000);
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).replace(/\x1b\[[0-9;]*m/g, '').slice(-12000);
        const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
        if (code && output.includes('https://auth.openai.com/codex/device')) {
          state.url = 'https://auth.openai.com/codex/device'; state.code = code; finish();
        }
        const googleUrl = output.match(/https:\/\/accounts\.google\.com\/[^\s]+/)?.[0];
        if (account.provider === 'gemini' && googleUrl && output.includes('Enter the authorization code:')) {
          state.url = googleUrl; state.needsCode = true; finish();
        }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.once('error', () => { state.state = 'error'; state.error = 'Не удалось запустить вход Codex.'; finish(); });
      child.once('close', code => {
        if (state.state === 'complete') { finish(); return; }
        state.state = code === 0 ? 'complete' : 'error';
        if (code !== 0) state.error = 'Вход не завершён. Запросите новый код.';
        delete state.code;
        finish();
      });
    });
  }
  authorizationCode(id: string, code: string) {
    const login = this.logins.get(id);
    if (!login || login.status.state !== 'waiting' || !login.status.needsCode) throw new BridgeError('Запросите новый вход Google.', 409);
    if (!code.trim() || code.length > 2048 || /[\r\n]/.test(code)) throw new BridgeError('Некорректный код авторизации.');
    login.child.stdin?.write(code.trim() + '\n');
    login.status.needsCode = false;
    return { ok: true };
  }
  close() { for (const login of this.logins.values()) login.child.kill(); }
}
