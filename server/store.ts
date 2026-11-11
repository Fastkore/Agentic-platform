import { readFile, writeFile } from 'node:fs/promises';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { State } from '../shared/types.js';

export class BridgeError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export function redact(text: string) { return text.replace(/\bfkap1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]+\b/gi, '[REDACTED]').replace(/\b(?:sk-|ccb_[ks]_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]').replace(/((?:access_token|refresh_token|api_key|authorization|password|login_challenge|ticket|pairing_code|pairingCode|connectionKey|erp_key_verifier|erpKeyVerifier|__Host-bridge_sso_start|__Host-bridge_session)["'\s:=]+)[^\s,"';}&]+/gi, '$1[REDACTED]'); }
type AccessState = Pick<State, 'security' | 'externalIdentities' | 'sso'>;
const empty = (): State => ({ schemaVersion: 1, settings: { cliPath: '', allowWrite: false, includePreviews: true, model: '' }, projects: [], runs: [], jobs: [] });
type Row = { id: string; parent: string; payload: string };
const tables = ['projects', 'chats', 'messages', 'attachments', 'runs', 'jobs'] as const;

/** Single-process durable repository. Related changes commit in one SQLite transaction. */
export class Store {
  state: State;
  warning?: string;
  readonly file: string;
  readonly legacyFile: string;
  private readonly db: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'state.sqlite'); this.legacyFile = path.join(root, 'state.json');
    let legacy: State | undefined;
    const existed = existsSync(this.file);
    if (!existed && existsSync(this.legacyFile)) {
      try { legacy = this.readLegacy(this.legacyFile); }
      catch {
        try { legacy = this.readLegacy(this.legacyFile + '.bak'); this.warning = 'История перенесена из резервной копии JSON.'; }
        catch { throw new BridgeError('История JSON повреждена. Исходные файлы сохранены; автоматический перенос остановлен.', 500); }
      }
      copyFileSync(this.legacyFile, this.legacyFile + '.pre-sqlite-' + Date.now());
    }
    this.db = new DatabaseSync(this.file);
    try {
      chmodSync(this.file, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 2) throw new Error('Unsupported database version');
      this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      this.db.exec('CREATE TABLE IF NOT EXISTS external_identities (installation_id TEXT NOT NULL, external_user_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(installation_id,external_user_id));');
      this.db.exec('CREATE TABLE IF NOT EXISTS launch_ticket_uses (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);');
      for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, parent TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))); CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent,position);`);
      this.db.exec('PRAGMA user_version=2;');
      const initialized = this.db.prepare("SELECT value FROM metadata WHERE key='settings'").get();
      if (!initialized && existed && existsSync(this.legacyFile)) {
        try { legacy = this.readLegacy(this.legacyFile); } catch { legacy = this.readLegacy(this.legacyFile + '.bak'); }
      }
      this.state = initialized ? this.load() : legacy ?? empty();
      this.state.settings.model ??= ''; this.state.jobs ??= [];
      for (const run of this.state.runs) if (run.status === 'running') {
        run.status = 'interrupted'; run.progress = 'Выполнение прервано остановкой сервера'; run.completedAt = new Date().toISOString();
        run.response = undefined;
      }
      for (const project of this.state.projects) for (const chat of project.chats)
        for (const message of chat.messages) if (message.status === 'running') message.status = 'interrupted';
      this.commit(JSON.parse(JSON.stringify(this.state)) as State);
    } catch {
      this.db.close();
      throw new BridgeError('Не удалось открыть базу SQLite. Файлы сохранены. Проверьте резервную копию и версию приложения.', 500);
    }
  }
  private readLegacy(file: string): State {
    const state = JSON.parse(readFileSync(file, 'utf8')) as State;
    if (state.schemaVersion !== 1 || !state.settings || !Array.isArray(state.projects) || !Array.isArray(state.runs)
      || state.projects.some(p => !p.id || !p.directory || !Array.isArray(p.chats) || !Array.isArray(p.attachments)
        || p.chats.some(c => !c.id || !Array.isArray(c.messages)))) throw new Error('Invalid state');
    return state;
  }
  private load(): State {
    const meta = new Map((this.db.prepare('SELECT key,value FROM metadata').all() as { key: string; value: string }[]).map(r => [r.key, JSON.parse(r.value)]));
    const rows = (table: typeof tables[number]) => this.db.prepare(`SELECT id,parent,payload FROM ${table} ORDER BY position`).all() as Row[];
    const projects = rows('projects').map(r => ({ ...JSON.parse(r.payload), chats: [], attachments: [] })) as State['projects'];
    const byProject = new Map(projects.map(p => [p.id, p]));
    const byChat = new Map<string, State['projects'][number]['chats'][number]>();
    for (const r of rows('chats')) { const chat = { ...JSON.parse(r.payload), messages: [] }; byProject.get(r.parent)!.chats.push(chat); byChat.set(r.id, chat); }
    for (const r of rows('messages')) byChat.get(r.parent)!.messages.push(JSON.parse(r.payload));
    for (const r of rows('attachments')) byProject.get(r.parent)!.attachments.push(JSON.parse(r.payload));
    const externalIdentities = (this.db.prepare('SELECT installation_id,external_user_id,user_id FROM external_identities ORDER BY installation_id,external_user_id').all() as { installation_id: string; external_user_id: string; user_id: string }[]).map(r => ({ installationId: r.installation_id, externalUserId: r.external_user_id, userId: r.user_id }));
    return { schemaVersion: 1, settings: meta.get('settings'), security: meta.get('security'), corporate: meta.get('corporate'), sso: meta.get('sso'), externalIdentities, projects, runs: rows('runs').map(r => JSON.parse(r.payload)), jobs: rows('jobs').map(r => JSON.parse(r.payload)) };
  }
  private commit(snapshot: State) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const putMeta = this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)');
      putMeta.run('settings', JSON.stringify(snapshot.settings));
      if (snapshot.security) putMeta.run('security', JSON.stringify(snapshot.security));
      if (snapshot.corporate) putMeta.run('corporate', JSON.stringify(snapshot.corporate));
      if (snapshot.sso) putMeta.run('sso', JSON.stringify(snapshot.sso));
      this.db.exec('DELETE FROM external_identities');
      const identity = this.db.prepare('INSERT INTO external_identities(installation_id,external_user_id,user_id) VALUES(?,?,?)');
      for (const value of snapshot.externalIdentities ?? []) identity.run(value.installationId, value.externalUserId, value.userId);
      for (const table of tables) this.db.exec(`DELETE FROM ${table}`);
      const statements = new Map(tables.map(table => [table, this.db.prepare(`INSERT INTO ${table}(id,parent,position,payload) VALUES(?,?,?,?)`)]));
      const put = (table: typeof tables[number], id: string, parent: string, position: number, value: unknown) => statements.get(table)!.run(id, parent, position, JSON.stringify(value));
      snapshot.projects.forEach((project, pi) => {
        const { chats, attachments, ...record } = project; put('projects', project.id, '', pi, record);
        chats.forEach((chat, ci) => { const { messages, ...c } = chat; put('chats', chat.id, project.id, ci, c); messages.forEach((m, mi) => put('messages', m.id, chat.id, mi, m)); });
        attachments.forEach((a, ai) => put('attachments', a.id, project.id, ai, a));
      });
      snapshot.runs.forEach((r, i) => put('runs', r.id, r.chatId ?? '', i, r));
      (snapshot.jobs ?? []).forEach((j, i) => put('jobs', j.runId, '', i, j));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(): Promise<void> {
    if (this.closed) return Promise.reject(new BridgeError('Хранилище закрыто.', 503));
    const snapshot = JSON.parse(JSON.stringify(this.state)) as State;
    // Access transactions queued ahead of this write may have published new credentials.
    const save = this.queue.then(() => this.commit({ ...snapshot, ...this.accessState() }));
    this.queue = save.catch(() => {}); return save;
  }
  private accessState(): AccessState {
    const { security, externalIdentities, sso } = this.state;
    return { security, externalIdentities, sso };
  }
  changeAccess<T>(change: (draft: AccessState) => T): Promise<T> {
    if (this.closed) return Promise.reject(new BridgeError('Хранилище закрыто.', 503));
    const save = this.queue.then(() => {
      const draft = structuredClone(this.accessState());
      const result = change(draft);
      this.commit({ ...this.state, ...draft });
      if (this.state.security && draft.security) Object.assign(this.state.security, draft.security);
      else this.state.security = draft.security;
      this.state.externalIdentities = draft.externalIdentities;
      this.state.sso = draft.sso;
      return result;
    });
    this.queue = save.then(() => {}, () => {});
    return save;
  }
  /** Claim before the network call: an uncertain exchange requires a fresh ERP ticket. */
  claimLaunchTicket(hash: string) {
    const now = Date.now();
    this.db.prepare('DELETE FROM launch_ticket_uses WHERE expires_at <= ?').run(now);
    const count = this.db.prepare('SELECT count(*) AS count FROM launch_ticket_uses').get() as { count: number };
    if (count.count >= 10000) throw new BridgeError('Слишком много обменов. Повторите позже.', 429);
    return this.db.prepare('INSERT OR IGNORE INTO launch_ticket_uses(hash,expires_at) VALUES(?,?)').run(hash, now + 5 * 60_000).changes === 1;
  }
  async close() { if (this.closed) return; await this.queue; this.closed = true; this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
  async log(category: string, message: string) {
    const file = path.join(this.root, 'diagnostics.log');
    try { const old = await readFile(file, 'utf8').catch(() => ''); await writeFile(file, (old + `${new Date().toISOString()} [${category}] ${redact(message)}\n`).slice(-64_000), { mode: 0o600 }); }
    catch { /* Diagnostics must not interrupt a conversation. */ }
  }
}
