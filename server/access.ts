import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ApiKeyInfo, Chat, Credential, Security, User, UserRecord } from '../shared/types.js';
import { BridgeError } from './store.js';
import type { Workspace } from './workspace.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const publicUser = ({ id, username, name, role, roleId, disabled }: User): User => ({ id, username, name, role, roleId, disabled });
export interface Principal { user: UserRecord; credential: Credential }

/** Application authorization. Independent of HTTP and Codex authentication. */
export class Access {
  readonly data: Security;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly workspace: Workspace) {
    const state = workspace.store.state;
    if (!state.security) state.security = { users: [{ id: randomUUID(), username: 'admin', name: 'Руководитель', role: 'admin', disabled: false, passwordHash: '', createdAt: new Date().toISOString() }], credentials: [], audit: [] };
    this.data = state.security;
    if (!Array.isArray(this.data.users) || !Array.isArray(this.data.credentials) || !Array.isArray(this.data.audit) || !this.data.users.some(u => u.role === 'admin' && !u.disabled)) throw new BridgeError('Повреждены настройки доступа. Восстановите резервную копию.', 500);
    this.migrate();
  }
  get setupRequired() { return !this.data.users.some(u => u.role === 'admin' && u.passwordHash); }
  migrate() {
    for (const user of this.data.users) user.roleId ??= 'employee';
    const admin = this.data.users.find(u => u.role === 'admin')!;
    for (const project of this.workspace.store.state.projects) {
      project.memberIds ??= [];
      for (const chat of project.chats) { chat.ownerId ??= admin.id; chat.visibility ??= 'private'; }
      for (const attachment of project.attachments) attachment.ownerId ??= admin.id;
    }
  }
  private async change<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => { const value = await work(); await this.workspace.store.save(); return value; });
    this.queue = result.catch(() => {}); return result;
  }
  private audit(actorId: string, action: string, targetId: string) {
    this.data.audit.unshift({ id: randomUUID(), actorId, action, targetId, createdAt: new Date().toISOString() }); this.data.audit.splice(1000);
  }
  private username(value: string) { const name = value.trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(name)) throw new BridgeError('Логин: 3–48 латинских букв, цифр, точек, дефисов или подчёркиваний.'); return name; }
  private async password(value: string) {
    if (value.length < 12 || value.length > 200) throw new BridgeError('Пароль должен содержать от 12 до 200 символов.');
    const salt = randomBytes(16).toString('hex'), hash = await derive(value, salt, 64) as Buffer;
    return `${salt}:${hash.toString('hex')}`;
  }
  private async matches(value: string, stored: string) {
    const [salt, hash] = stored.split(':'); if (!salt || !hash) return false;
    const candidate = await derive(value, salt, 64) as Buffer, expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  private issue(user: UserRecord, kind: Credential['kind'], name: string) {
    const token = `ccb_${kind === 'api' ? 'k' : 's'}_${randomBytes(32).toString('hex')}`;
    const record: Credential = { id: randomUUID(), userId: user.id, kind, hash: digest(token), name, createdAt: new Date().toISOString(), ...(kind === 'session' ? { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() } : {}) };
    this.data.credentials = this.data.credentials.filter(c => !c.expiresAt || Date.parse(c.expiresAt) > Date.now());
    if (kind === 'session') { const old = this.data.credentials.filter(c => c.userId === user.id && c.kind === kind); for (const c of old.slice(0, Math.max(0, old.length - 19))) this.data.credentials.splice(this.data.credentials.indexOf(c), 1); }
    this.data.credentials.push(record); return { token, user: publicUser(user), key: { id: record.id, name, createdAt: record.createdAt } };
  }
  authenticate(token: string): Principal {
    const hash = digest(token), credential = this.data.credentials.find(c => c.hash === hash);
    const user = credential && this.data.users.find(u => u.id === credential.userId && !u.disabled);
    if (!credential || !user || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) throw new BridgeError('Войдите под своей учётной записью.', 401);
    return { user, credential };
  }
  bootstrap() { return this.change(() => { if (!this.setupRequired) throw new BridgeError('Первичная настройка завершена. Войдите по логину и паролю.', 403); return this.issue(this.data.users.find(u => u.role === 'admin')!, 'session', 'Первичная настройка'); }); }
  setup(actor: UserRecord, username: string, name: string, password: string) {
    return this.change(async () => {
      if (!this.setupRequired || actor.role !== 'admin') throw new BridgeError('Первичная настройка уже завершена.', 403);
      const login = this.username(username), hash = await this.password(password); actor.username = login; actor.name = name.trim() || 'Руководитель'; actor.passwordHash = hash;
      this.data.credentials = []; this.audit(actor.id, 'setup', actor.id); return this.issue(actor, 'session', 'Браузер');
    });
  }
  async login(username: string, password: string) {
    const user = this.data.users.find(u => u.username === username.trim().toLowerCase() && !u.disabled);
    // Run the same expensive derivation for an unknown login as for a known one.
    const previousHash = user?.passwordHash;
    const ok = await this.matches(password, previousHash || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    return this.change(() => { if (!user || user.disabled || user.passwordHash !== previousHash || !ok || this.setupRequired) throw new BridgeError('Неверный логин или пароль.', 401); return this.issue(user, 'session', 'Браузер'); });
  }
  logout(principal: Principal) { return this.change(() => { this.data.credentials = this.data.credentials.filter(c => c.id !== principal.credential.id); return { ok: true }; }); }
  admin(user: User) { if (user.role !== 'admin') throw new BridgeError('Доступно только руководителю.', 403); }
  project(user: User, id: string) {
    const project = this.workspace.project(id);
    if (user.role !== 'admin' && !project.memberIds?.includes(user.id)) throw new BridgeError('Проект не найден.', 404); return project;
  }
  canChat(user: User, chat: Chat) { return user.role === 'admin' || chat.ownerId === user.id || chat.visibility === 'project'; }
  chat(user: User, projectId: string, chatId: string) {
    this.project(user, projectId); const chat = this.workspace.chat(projectId, chatId);
    if (!this.canChat(user, chat)) throw new BridgeError('Диалог не найден.', 404); return chat;
  }
  editChat(user: User, projectId: string, chatId: string) {
    const chat = this.chat(user, projectId, chatId);
    if (user.role !== 'admin' && chat.ownerId !== user.id) throw new BridgeError('Общий диалог доступен для чтения. Создайте свой диалог.', 403); return chat;
  }
  run(user: User, id: string) {
    const run = this.workspace.getRun(id); if (run.projectId && run.chatId) this.chat(user, run.projectId, run.chatId); else this.admin(user); return run;
  }
  viewChat(chat: Chat) { return { ...chat, ownerName: this.data.users.find(u => u.id === chat.ownerId)?.name ?? 'Пользователь', messages: chat.messages.map(m => m.role === 'user' ? { ...m, authorId: m.authorId ?? chat.ownerId, authorName: this.data.users.find(u => u.id === (m.authorId ?? chat.ownerId))?.name ?? 'Пользователь' } : m) }; }
  users(user: User) { this.admin(user); return this.data.users.map(publicUser); }
  createUser(actor: User, input: { username: string; name: string; password: string; role: User['role']; roleId?: string }) {
    this.admin(actor); return this.change(async () => {
      const username = this.username(input.username); if (this.data.users.some(u => u.username === username)) throw new BridgeError('Этот логин уже занят.', 409);
      const roleId = input.roleId ?? 'employee'; if (!this.workspace.corporate.data.roles.some(r => r.id === roleId && r.enabled)) throw new BridgeError('Роль недоступна.');
      const user: UserRecord = { id: randomUUID(), username, name: input.name.trim() || username, role: input.role, roleId, disabled: false, passwordHash: await this.password(input.password), createdAt: new Date().toISOString() };
      this.data.users.push(user); this.audit(actor.id, 'user.create', user.id); return publicUser(user);
    });
  }
  updateUser(actor: User, id: string, input: { disabled?: boolean; password?: string; name?: string; roleId?: string; role?: User['role'] }) {
    this.admin(actor); return this.change(async () => {
      const user = this.data.users.find(u => u.id === id); if (!user) throw new BridgeError('Пользователь не найден.', 404);
      if (actor.id === id && input.disabled) throw new BridgeError('Нельзя отключить свою учётную запись.');
      if (input.disabled && user.role === 'admin' && this.data.users.filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new BridgeError('Должен остаться хотя бы один руководитель.');
      if (input.role && input.role !== 'admin' && user.role === 'admin' && this.data.users.filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new BridgeError('Должен остаться хотя бы один руководитель.');
      if (input.roleId !== undefined && !this.workspace.corporate.data.roles.some(r => r.id === input.roleId && r.enabled)) throw new BridgeError('Роль недоступна.');
      const hash = input.password === undefined ? undefined : await this.password(input.password);
      if (input.disabled !== undefined) user.disabled = input.disabled; if (hash) user.passwordHash = hash;
      if (input.name !== undefined) user.name = input.name.trim() || user.username;
      if (input.roleId !== undefined) user.roleId = input.roleId;
      if (input.role !== undefined) user.role = input.role;
      if (input.disabled || hash) this.data.credentials = this.data.credentials.filter(c => c.userId !== id);
      this.audit(actor.id, 'user.update', id); return publicUser(user);
    });
  }
  changePassword(principal: Principal, current: string, password: string) {
    return this.change(async () => {
      if (principal.credential.kind !== 'session' || !await this.matches(current, principal.user.passwordHash)) throw new BridgeError('Неверный текущий пароль.', 403);
      principal.user.passwordHash = await this.password(password); this.data.credentials = this.data.credentials.filter(c => c.userId !== principal.user.id);
      this.audit(principal.user.id, 'password.change', principal.user.id); return this.issue(principal.user, 'session', 'Браузер');
    });
  }
  members(actor: User, projectId: string, memberIds: string[]) {
    this.admin(actor); return this.change(() => {
      const project = this.workspace.project(projectId);
      if (memberIds.some(id => !this.data.users.some(u => u.id === id && !u.disabled))) throw new BridgeError('Выберите действующих пользователей.');
      project.memberIds = [...new Set(memberIds)]; this.audit(actor.id, 'project.members', projectId); return { memberIds: project.memberIds };
    });
  }
  visibility(actor: User, projectId: string, chatId: string, visibility: 'private' | 'project') {
    this.admin(actor); return this.change(() => {
      const chat = this.workspace.chat(projectId, chatId); chat.visibility = visibility; this.audit(actor.id, `chat.${visibility}`, chatId); return this.viewChat(chat);
    });
  }
  keys(principal: Principal): ApiKeyInfo[] { return this.data.credentials.filter(c => c.userId === principal.user.id && c.kind === 'api').map(({ id, name, createdAt }) => ({ id, name, createdAt })); }
  createKey(principal: Principal, name: string) {
    return this.change(() => {
      if (principal.credential.kind !== 'session') throw new BridgeError('Для выпуска ключа войдите по логину и паролю.', 403);
      if (this.keys(principal).length >= 10) throw new BridgeError('Можно создать до 10 ключей. Отзовите ненужные.');
      this.audit(principal.user.id, 'key.create', principal.user.id); const issued = this.issue(principal.user, 'api', name.trim() || 'Интеграция'); return { ...issued.key, token: issued.token };
    });
  }
  revokeKey(principal: Principal, id: string) {
    return this.change(() => {
      const key = this.data.credentials.find(c => c.id === id && c.kind === 'api' && c.userId === principal.user.id); if (!key) throw new BridgeError('Ключ не найден.', 404);
      this.data.credentials = this.data.credentials.filter(c => c.id !== id); this.audit(principal.user.id, 'key.revoke', id); return { ok: true };
    });
  }
}
