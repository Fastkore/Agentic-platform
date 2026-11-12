import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Chat, Credential, Security, StoredFastkoreInstallation, User, UserRecord } from '../shared/types.js';
import { BridgeError, type AccessDraft } from './store.js';
import type { Workspace } from './workspace.js';
import type { ErpDelegation, TicketIdentity } from './fastkore.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const publicUser = ({ id, username, name, role, roleId, disabled }: User): User => ({ id, username, name, role, roleId, disabled });
export interface Principal { user: UserRecord; credential: Credential }

/** Application authorization. Independent of HTTP and Codex authentication. */
export class Access {
  readonly data: Security;
  private queue: Promise<unknown> = Promise.resolve();
  externalCredentialValid?: (credential: Credential) => boolean;
  onSessionsRemoved?: (sessions: Credential[]) => void;
  constructor(readonly workspace: Workspace) {
    const state = workspace.store.state;
    if (!state.security) state.security = { users: [{ id: randomUUID(), username: 'admin', name: 'Руководитель', role: 'admin', disabled: false, passwordHash: '', createdAt: new Date().toISOString() }], credentials: [], audit: [] };
    this.data = state.security;
    if (!Array.isArray(this.data.users) || !Array.isArray(this.data.credentials) || !Array.isArray(this.data.audit) || !this.data.users.some(u => u.role === 'admin' && !u.disabled)) throw new BridgeError('Повреждены настройки доступа. Восстановите резервную копию.', 500);
    this.migrate();
  }
  get setupRequired() { return !this.data.users.some(u => u.role === 'admin' && u.passwordHash); }
  migrate() {
    const admins = new Set(this.data.users.filter(user => user.role === 'admin' && !user.disabled).map(user => user.id));
    this.data.credentials = this.data.credentials.filter(credential => credential.kind === 'session' &&
      (credential.source === 'fastkore' || admins.has(credential.userId)));
    for (const user of this.data.users) {
      user.roleId ??= 'employee';
      if (user.role !== 'admin') user.passwordHash = '';
    }
    const admin = this.data.users.find(u => u.role === 'admin')!;
    for (const project of this.workspace.store.state.projects) {
      project.memberIds ??= [];
      for (const chat of project.chats) { chat.ownerId ??= admin.id; chat.visibility ??= 'private'; }
      for (const attachment of project.attachments) attachment.ownerId ??= admin.id;
    }
  }
  private async change<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      const before = [...this.data.credentials];
      const value = await work();
      await this.workspace.store.save();
      this.notifyRemoved(before);
      return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  private changeAccess<T>(work: (draft: AccessDraft) => T) {
    const result = this.queue.then(async () => {
      const before = [...this.data.credentials];
      const value = await this.workspace.store.changeAccess(work);
      this.notifyRemoved(before);
      return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  private notifyRemoved(before: Credential[]) {
    if (!this.onSessionsRemoved) return;
    const current = new Set(this.data.credentials.map(c => c.id));
    this.onSessionsRemoved(before.filter(c => c.source === 'fastkore' && !current.has(c.id)));
  }
  private audit(actorId: string, action: string, targetId: string, data = this.data) {
    data.audit.unshift({ id: randomUUID(), actorId, action, targetId, createdAt: new Date().toISOString() }); data.audit.splice(1000);
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
  private issueSession(user: UserRecord, name: string, external?: Pick<Credential, 'source' | 'installationId' | 'externalUserId' | 'externalDisplayName'>,
    data = this.data, seal?: (credential: Credential) => Credential['erpDelegation']) {
    const token = 'ccb_s_' + randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (external?.source === 'fastkore' ? 1800_000 : 12 * 3600_000)).toISOString();
    const record: Credential = { id: randomUUID(), userId: user.id, kind: 'session', hash: digest(token), name, createdAt: new Date().toISOString(), expiresAt, ...external };
    if (seal) record.erpDelegation = seal(record);
    data.credentials = data.credentials.filter(c => !c.expiresAt || Date.parse(c.expiresAt) > Date.now());
    const old = data.credentials.filter(c => c.userId === user.id);
    for (const c of old.slice(0, Math.max(0, old.length - 19))) data.credentials.splice(data.credentials.indexOf(c), 1);
    data.credentials.push(record); return { token, user: publicUser(user), expiresAt };
  }
  authenticate(token: string): Principal {
    const hash = digest(token), credential = this.data.credentials.find(c => c.hash === hash);
    return this.authenticateCredential(credential?.id ?? '');
  }
  authenticateCredential(id: string): Principal {
    const credential = this.data.credentials.find(c => c.id === id);
    const user = credential && this.data.users.find(u => u.id === credential.userId && !u.disabled);
    if (!credential || credential.kind !== 'session' || !user || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())
      || (credential.source === 'fastkore' ? !this.externalCredentialValid?.(credential) : user.role !== 'admin')) throw new BridgeError('Войдите под своей учётной записью.', 401);
    return { user, credential };
  }
  bootstrap() { return this.change(() => { if (!this.setupRequired) throw new BridgeError('Первичная настройка завершена. Войдите по логину и паролю.', 403); return this.issueSession(this.data.users.find(u => u.role === 'admin')!, 'Первичная настройка'); }); }
  setup(actor: UserRecord, username: string, name: string, password: string) {
    return this.change(async () => {
      if (!this.setupRequired || actor.role !== 'admin') throw new BridgeError('Первичная настройка уже завершена.', 403);
      const login = this.username(username), hash = await this.password(password); actor.username = login; actor.name = name.trim() || 'Руководитель'; actor.passwordHash = hash;
      this.data.credentials = []; this.audit(actor.id, 'setup', actor.id); return this.issueSession(actor, 'Браузер');
    });
  }
  async login(username: string, password: string) {
    const user = this.data.users.find(u => u.username === username.trim().toLowerCase() && u.role === 'admin' && !u.disabled);
    // Run the same expensive derivation for an unknown login as for a known one.
    const previousHash = user?.passwordHash;
    const ok = await this.matches(password, previousHash || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    return this.change(() => {
      const current = this.data.users.find(u => u.id === user?.id && !u.disabled);
      if (!current || current.role !== 'admin' || current.passwordHash !== previousHash || !ok || this.setupRequired) throw new BridgeError('Неверный логин или пароль.', 401);
      return this.issueSession(current, 'Браузер');
    });
  }
  logout(principal: Principal) { return this.change(() => { this.data.credentials = this.data.credentials.filter(c => c.id !== principal.credential.id); return { ok: true }; }); }
  fastkoreLogin(identity: TicketIdentity, previousToken = '', recheck: () => void = () => {},
    seal?: (credential: Credential, delegation: ErpDelegation) => Credential['erpDelegation']) {
    return this.changeAccess(draft => {
      recheck();
      if (this.setupRequired) throw new BridgeError('Сначала администратор должен настроить платформу.', 403);
      const data = draft.security!, identities = draft.externalIdentities ??= [];
      const link = identities.find(i => i.installationId === identity.installationId && i.externalUserId === identity.externalUserId);
      let user = link && data.users.find(u => u.id === link.userId);
      if (link && (!user || user.disabled)) throw new BridgeError('Учётная запись отключена администратором платформы.', 403);
      if (!user) {
        const id = randomUUID();
        user = { id, username: `sso-${id}`, name: identity.displayName, role: 'employee', roleId: 'sso_pending', disabled: false, passwordHash: '', createdAt: new Date().toISOString() };
        data.users.push(user); identities.push({ installationId: identity.installationId, externalUserId: identity.externalUserId, userId: id });
        this.audit(user.id, 'sso.user.create', user.id, data);
      } else user.name = identity.displayName;
      if (previousToken) data.credentials = data.credentials.filter(c => c.source !== 'fastkore' || c.hash !== digest(previousToken));
      this.audit(user.id, 'sso.login', identity.installationId, data);
      const { delegation } = identity;
      return this.issueSession(user, 'Fastkore', { source: 'fastkore', installationId: identity.installationId, externalUserId: identity.externalUserId, externalDisplayName: identity.displayName },
        data, delegation && seal ? credential => seal(credential, delegation) : undefined);
    });
  }
  async forgetErpDelegation(id: string) {
    await this.changeAccess(draft => {
      const credential = draft.security?.credentials.find(c => c.id === id);
      if (credential?.erpDelegation) {
        delete credential.erpDelegation;
        credential.erpDelegationRevoked = true;
      }
    });
  }
  linkExternal(authorize: () => User, installationId: string, externalUserId: string, userId: string) {
    return this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      if (!data.users.some(u => u.id === userId && !u.disabled)) throw new BridgeError('Пользователь не найден.', 404);
      const identities = draft.externalIdentities ??= [];
      const link = identities.find(i => i.installationId === installationId && i.externalUserId === externalUserId);
      data.credentials = data.credentials.filter(c => c.installationId !== installationId || c.externalUserId !== externalUserId);
      if (link) link.userId = userId; else identities.push({ installationId, externalUserId, userId });
      this.audit(actor.id, 'sso.identity.link', userId, data); return { ok: true };
    });
  }
  changeInstallation<T>(authorize: () => User, action: string, work: (items: StoredFastkoreInstallation[]) => { id: string; result: T; revoke?: boolean }) {
    return this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      const items = (draft.sso ??= {}).installations ??= [];
      const { id, result, revoke } = work(items);
      if (revoke) data.credentials = data.credentials.filter(c => c.source !== 'fastkore' || c.installationId !== id);
      this.audit(actor.id, action, id, data);
      return result;
    });
  }
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
    this.admin(actor);
    if (input.role !== 'admin') throw new BridgeError('Профили сотрудников создаются при входе из Fastkore.', 403);
    return this.change(async () => {
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
      if (input.password !== undefined && (input.role ?? user.role) !== 'admin') throw new BridgeError('Сотрудники входят через Fastkore.', 403);
      const hash = input.password === undefined ? undefined : await this.password(input.password);
      if (input.disabled !== undefined) user.disabled = input.disabled; if (hash) user.passwordHash = hash;
      if (input.name !== undefined) user.name = input.name.trim() || user.username;
      if (input.roleId !== undefined) user.roleId = input.roleId;
      if (input.role !== undefined) user.role = input.role;
      if (input.disabled || hash) this.data.credentials = this.data.credentials.filter(c => c.userId !== id);
      if (user.role !== 'admin') {
        user.passwordHash = '';
        this.data.credentials = this.data.credentials.filter(c => c.userId !== id || c.source === 'fastkore');
      }
      this.audit(actor.id, 'user.update', id); return publicUser(user);
    });
  }
  changePassword(principal: Principal, current: string, password: string) {
    return this.change(async () => {
      const { credential, user } = this.authenticateCredential(principal.credential.id);
      if (credential.source === 'fastkore' || !await this.matches(current, user.passwordHash)) throw new BridgeError('Смена пароля доступна при локальном входе.', 403);
      user.passwordHash = await this.password(password); this.data.credentials = this.data.credentials.filter(c => c.userId !== user.id);
      this.audit(user.id, 'password.change', user.id); return this.issueSession(user, 'Браузер');
    });
  }
  members(actor: User, projectId: string, memberIds: string[]) {
    this.admin(actor); return this.change(() => {
      const project = this.workspace.project(projectId);
      if (memberIds.some(id => !this.data.users.some(u => u.id === id && !u.disabled))) throw new BridgeError('Выберите действующих пользователей.');
      project.memberIds = [...new Set(memberIds)]; this.audit(actor.id, 'project.members', projectId); return { memberIds: project.memberIds };
    });
  }
  userProjects(actor: User, userId: string) {
    this.admin(actor);
    const employee = this.data.users.find(user => user.id === userId && user.role === 'employee');
    if (!employee) throw new BridgeError('Сотрудник не найден.', 404);
    return this.workspace.store.state.projects.map(project => ({ id: project.id, name: project.name, allowed: project.memberIds?.includes(userId) ?? false }));
  }
  setUserProjects(authorize: () => User, userId: string, projectIds: string[]) {
    return this.changeAccess(draft => {
      const actor = authorize();
      const available = this.userProjects(actor, userId);
      const known = new Set(available.map(project => project.id));
      const selected = new Set(projectIds);
      if (projectIds.some(id => !known.has(id))) throw new BridgeError('Проект не найден.', 404);
      const projectMembers = new Map<string, string[]>();
      for (const project of this.workspace.store.state.projects) {
        const members = project.memberIds ?? [];
        if (selected.has(project.id) && !members.includes(userId)) projectMembers.set(project.id, [...members, userId]);
        else if (!selected.has(project.id) && members.includes(userId)) projectMembers.set(project.id, members.filter(id => id !== userId));
      }
      draft.projectMembers = projectMembers;
      this.audit(actor.id, 'user.projects', userId, draft.security);
      return available.map(project => ({ ...project, allowed: selected.has(project.id) }));
    });
  }
  visibility(actor: User, projectId: string, chatId: string, visibility: 'private' | 'project') {
    this.admin(actor); return this.change(() => {
      const chat = this.workspace.chat(projectId, chatId); chat.visibility = visibility; this.audit(actor.id, `chat.${visibility}`, chatId); return this.viewChat(chat);
    });
  }
}
