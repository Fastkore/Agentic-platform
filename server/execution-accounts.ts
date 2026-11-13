import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { providerForModel, type ExecutionAccount, type ExecutionAccounts, type ExecutionProvider } from '../shared/execution-accounts.js';
import { CodexClient, type CodexRunner } from './codex.js';
import { BridgeError } from './store.js';
import { GeminiClient, AntigravityClient } from './gemini.js';
import { GlmClient, readGlmKey, writeGlmConfig } from './glm.js';
import type { ModelCatalog } from '../shared/types.js';

type RecordAccount = Pick<ExecutionAccount, 'id' | 'name' | 'provider'>;
// Several accounts may stay active at once: users see the models of every active account,
// inactive ones stay hidden. `active` in accounts.json is a list; a legacy string is upgraded on load.
type Manifest = { active: string[]; accounts: RecordAccount[] };
function normalizeManifest(parsed: Partial<Manifest> & { active?: string[] | string }): Manifest {
  const active = Array.isArray(parsed.active) ? parsed.active.filter(item => typeof item === 'string')
    : typeof parsed.active === 'string' ? [parsed.active] : ['default'];
  // An explicitly empty account list stays empty; the default account seeds only fresh stores.
  return { active: [...new Set(active)], accounts: parsed.accounts ?? [{ id: 'default', name: 'Основной Codex', provider: 'codex' }] };
}
export class ExecutionAccountStore {
  private state: Manifest;
  private readonly file: string;
  private readonly logins = new Map<string, { child: ChildProcess; status: NonNullable<ExecutionAccount['login']> }>();
  private stopLogin(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
  }
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'accounts.json');
    this.state = existsSync(this.file) ? normalizeManifest(JSON.parse(readFileSync(this.file, 'utf8'))) : normalizeManifest({});
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
  // The most recently activated account is the primary: it serves auto-resolved runs.
  get active() { return this.state.active.at(-1) ?? ''; }
  private get activeSet() { return new Set(this.state.active); }
  runner(id = this.active): CodexRunner {
    const provider = this.find(id).provider;
    return provider === 'antigravity' ? new AntigravityClient(this.home(id)) : provider === 'gemini' ? new GeminiClient(this.home(id))
      : provider === 'glm' ? new GlmClient(this.home(id)) : new CodexClient([], 'worker', this.home(id));
  }
  get provider() { return [...this.state.active].reverse().map(id => this.state.accounts.find(item => item.id === id)).find(Boolean)?.provider ?? 'codex'; }
  private async activeAccounts() {
    const { accounts } = await this.list();
    const signedIn = new Map(accounts.filter(account => account.signedIn).map(account => [account.id, account]));
    return [...this.state.active].reverse().map(id => signedIn.get(id)).filter((account): account is NonNullable<typeof account> => !!account);
  }
  async select(model?: string) {
    const provider = providerForModel(model);
    // Active accounts serve users; connected-but-inactive accounts stay hidden.
    const active = await this.activeAccounts();
    if (!active.length) throw new BridgeError('Включите хотя бы один активный аккаунт исполнителя в настройках сервера.', 503);
    const account = provider ? active.find(item => item.provider === provider) : active[0];
    if (!account) throw new BridgeError('Этот исполнитель не активен. Включите его аккаунт в настройках сервера.', 503);
    return { account, model: model?.replace(/^(codex|gemini|antigravity|glm)\//, '') };
  }
  async models(cli: string): Promise<ModelCatalog> {
    const active = await this.activeAccounts();
    if (!active.length) throw new BridgeError('Включите хотя бы один активный аккаунт исполнителя в настройках сервера.', 503);
    // Every active account contributes models; deduplicate without exposing account identities.
    const catalogs = await Promise.allSettled(active.map(account => this.runner(account.id).listModels!(cli)));
    const models: ModelCatalog['models'] = [];
    catalogs.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const account = active[index];
      for (const model of result.value.models) {
        const id = account.provider + '/' + model.id;
        if (!models.some(item => item.id === id)) models.push({ ...model, id, isDefault: index === 0 && model.isDefault });
      }
    });
    if (!models.length) throw new BridgeError('Активные аккаунты исполнителя не вернули модели.', 502);
    return { models, source: 'combined', fetchedAt: new Date().toISOString() };
  }
  async executionKey(id = this.active) {
    const account = this.find(id);
    const home = this.home(account.id);
    let identity = account.id;
    try {
      if (account.provider === 'glm') identity = readGlmKey(home) ?? identity;
      else if (account.provider === 'antigravity') {
        const marker = JSON.parse(await readFile(path.join(home, '.antigravity-connected.json'), 'utf8'));
        return account.id + ':' + marker.session;
      }
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
        if (account.provider === 'antigravity') {
          const marker = JSON.parse(await readFile(path.join(this.home(account.id), '.antigravity-connected.json'), 'utf8'));
          signedIn = typeof marker.session === 'string';
        } else if (account.provider === 'glm') {
          signedIn = readGlmKey(this.home(account.id)) !== null;
        } else {
        const file = account.provider === 'gemini' ? path.join('.gemini', 'oauth_creds.json') : 'auth.json';
        const auth = JSON.parse(await readFile(path.join(this.home(account.id), file), 'utf8'));
        signedIn = account.provider === 'gemini' ? typeof auth.refresh_token === 'string' : typeof auth.tokens?.access_token === 'string';
        if (account.provider === 'codex' && typeof auth.tokens?.id_token === 'string') {
          const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
          if (typeof claims.email === 'string') email = claims.email;
        }
        }
      } catch { /* A signed-out account is still available for login. */ }
      const login = this.logins.get(account.id);
      if (signedIn && account.provider === 'gemini' && login?.status.state === 'waiting') {
        login.status.state = 'complete';
        login.status.needsCode = false;
        this.stopLogin(login.child);
      }
      return { ...account, email, signedIn, active: this.activeSet.has(account.id), login: this.logins.get(account.id)?.status };
    })) };
  }
  async create(name: string, provider: ExecutionProvider = 'codex') {
    if (!name.trim() || name.length > 100) throw new BridgeError('Укажите название аккаунта.');
    if (this.state.accounts.length >= 20) throw new BridgeError('Допускается до 20 аккаунтов.');
    const account: RecordAccount = { id: randomUUID(), name: name.trim(), provider };
    await mkdir(path.join(this.root, 'accounts', account.id), { recursive: true, mode: 0o700 });
    await this.save({ ...this.state, active: this.state.active.length ? this.state.active : [account.id], accounts: [...this.state.accounts, account] });
    return account;
  }
  async remove(id: string) {
    const home = this.home(id);
    const login = this.logins.get(id);
    if (login?.status.state === 'waiting') {
      login.status.state = 'error';
      login.status.error = 'Подключение удалено.';
      const stopped = new Promise<void>(resolve => login.child.once('close', () => resolve()));
      this.stopLogin(login.child);
      await stopped;
    }
    const remaining = (await this.list()).accounts.filter(account => account.id !== id);
    // Drop the account from the active set; if it was the last one, promote the first
    // connected remainder so users do not silently lose their executor.
    const activeSet = new Set(this.state.active.filter(item => item !== id));
    if (!activeSet.size) { const next = (remaining.find(account => account.signedIn) ?? remaining[0])?.id; if (next) activeSet.add(next); }
    // The legacy profile shares its root with ALL other accounts. Remove only its credential file.
    const target = id === 'default' ? path.join(home, 'auth.json') : home;
    const staged = target + '.removed-' + randomUUID();
    let moved = false;
    try { await rename(target, staged); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await this.save({ active: [...activeSet], accounts: remaining.map(({ id, name, provider }) => ({ id, name, provider })) }); }
    catch (error) { if (moved) await rename(staged, target); throw error; }
    this.logins.delete(id);
    if (moved) await rm(staged, { recursive: id !== 'default', force: true });
    return this.list();
  }
  async activate(id: string) {
    this.find(id);
    const account = (await this.list()).accounts.find(item => item.id === id)!;
    if (!account.signedIn) throw new BridgeError('Сначала выполните вход в аккаунт.', 409);
    // Re-activating promotes the account back to the primary position.
    await this.save({ ...this.state, active: [...this.state.active.filter(item => item !== id), id] });
    return this.list();
  }
  async deactivate(id: string) {
    this.find(id);
    await this.save({ ...this.state, active: this.state.active.filter(item => item !== id) });
    return this.list();
  }
  async login(id: string) {
    const account = this.find(id);
    if (account.provider === 'glm') throw new BridgeError('Для аккаунта GLM сохраните API-ключ вместо входа.', 409);
    const existing = this.logins.get(id);
    if (existing?.status.state === 'waiting') return existing.status;
    const home = this.home(id);
    if (account.provider === 'antigravity') {
      await rm(path.join(home, '.antigravity-connected.json'), { force: true });
      await rm(path.join(home, '.gemini'), { recursive: true, force: true });
    }
    if (account.provider === 'gemini') {
      await mkdir(path.join(home, '.gemini'), { recursive: true, mode: 0o700 });
      await rm(path.join(home, '.gemini', 'oauth_creds.json'), { force: true });
      await writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } }, tools: { core: [] },
      }), { mode: 0o600 });
    }
    const google = account.provider !== 'codex';
    const child = spawn(google ? '/usr/bin/script' : '/usr/local/bin/codex',
      google ? ['-q', '-f', '-c', account.provider === 'antigravity' ? 'stty cols 200 rows 60; exec /usr/local/bin/agy' : '/usr/local/bin/gemini --skip-trust', '/dev/null'] : ['login', '--device-auth'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home, ...(google ? { HOME: home, GEMINI_CLI_HOME: home, NO_BROWSER: 'true', TERM: 'xterm-256color', SSH_CONNECTION: '127.0.0.1 22 127.0.0.1 22' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const state: NonNullable<ExecutionAccount['login']> = { state: 'waiting' };
    const lifetime = setTimeout(() => {
      state.state = 'error'; state.error = 'Срок ожидания входа истёк. Запросите новую ссылку.';
      this.stopLogin(child);
    }, google ? 6 * 60000 : 16 * 60000).unref();
    child.once('close', () => clearTimeout(lifetime));
    this.logins.set(id, { child, status: state });
    return await new Promise<typeof state>(resolve => {
      let output = '', returned = false, selectedGoogle = false;
      const finish = () => { if (!returned) { returned = true; clearTimeout(timer); resolve(state); } };
      const timer = setTimeout(() => { this.stopLogin(child); state.state = 'error'; state.error = 'Не удалось начать вход. Повторите попытку.'; finish(); }, 30000);
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '').slice(-64000);
        if (account.provider === 'antigravity' && !selectedGoogle && output.includes('Select login method:')) {
          selectedGoogle = true; child.stdin?.write('\r');
        }
        const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
        if (code && output.includes('https://auth.openai.com/codex/device')) {
          state.url = 'https://auth.openai.com/codex/device'; state.code = code; finish();
        }
        const googleUrl = output.match(/https:\/\/accounts\.google\.com\/[^\s\x1b\x07]+/)?.[0];
        if (google && googleUrl && !state.url && (account.provider === 'antigravity' || output.includes('Enter the authorization code:'))) {
          state.url = googleUrl; state.needsCode = true; finish();
        }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.once('error', () => { state.state = 'error'; state.error = 'Не удалось запустить вход исполнителя.'; finish(); });
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
    login.child.stdin?.write(code.trim() + (this.find(id).provider === 'antigravity' ? '\r' : '\n'));
    login.status.needsCode = false;
    if (this.find(id).provider === 'antigravity') void this.completeAntigravityLogin(id, login);
    return { ok: true };
  }
  async setKey(id: string, key: string) {
    const account = this.find(id);
    if (account.provider !== 'glm') throw new BridgeError('Ключ применяется только к аккаунту GLM.', 409);
    if (/[\r\n]/.test(key)) throw new BridgeError('Некорректный ключ GLM.');
    await writeGlmConfig(this.home(id), key);
    return this.list();
  }
  private async completeAntigravityLogin(id: string, login: { child: ChildProcess; status: NonNullable<ExecutionAccount['login']> }) {
    for (let attempt = 0; attempt < 15 && login.status.state === 'waiting'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        await this.runner(id).listModels!('');
        if (login.status.state !== 'waiting') return;
        await writeFile(path.join(this.home(id), '.antigravity-connected.json'), JSON.stringify({ session: randomUUID() }), { mode: 0o600 });
        login.status.state = 'complete';
        this.stopLogin(login.child);
        return;
      } catch { /* OAuth can take a few seconds to persist the native credentials. */ }
    }
    if (login.status.state === 'waiting') {
      login.status.state = 'error'; login.status.error = 'Antigravity не подтвердил вход. Запросите новую ссылку и проверьте код Google.';
      this.stopLogin(login.child);
    }
  }
  close() { for (const login of this.logins.values()) this.stopLogin(login.child); }
}
