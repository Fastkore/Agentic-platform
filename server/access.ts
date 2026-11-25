import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AuditEvent, Chat, ChatSummary, ChatView, Credential, ErpDelegationLoss, ErpSessionEnd, InterfaceScale, Project, ProjectRolePolicy, Security, StoredFastkoreInstallation, TeamUser, User, UserRecord } from '../shared/types.js';
import { publishAudit } from './audit-journal.js';
import { BridgeError, type AccessDraft } from './store.js';
import type { Workspace } from './workspace.js';
import type { ErpDelegation, TicketIdentity } from './fastkore.js';
import { canAccessProject, erpRolesForUser, observeErpRoles, projectAllowsRoles } from './erp-roles.js';
import { fastkoreChatSessionMatches } from './fastkore-chat.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// UserSet.AdministratorRole in Fastkore. Role names can be renamed or reused.
const fastkoreAdministratorRoleId = '1c3262c9-1105-4340-a9b5-1e0fbeaefe2d';
export const publicUser = ({ id, username, name, role, roleId, disabled }: User): User => ({ id, username, name, role, roleId, disabled });
export interface Principal { user: UserRecord; credential: Credential }

/** Application authorization. Independent of HTTP and Codex authentication. */
export class Access {
  readonly data: Security;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly browserCodes = new Map<string, { sessionId: string; expiresAt: number }>();
  externalCredentialValid?: (credential: Credential) => boolean;
  onSessionsRemoved?: (sessions: Credential[], reason: ErpSessionEnd) => void;
  constructor(readonly workspace: Workspace) {
    const state = workspace.store.state;
    if (!state.security) state.security = { users: [{ id: randomUUID(), username: 'admin', name: 'Руководитель', role: 'admin', disabled: false, passwordHash: '', createdAt: new Date().toISOString() }], credentials: [], audit: [] };
    this.data = state.security;
    if (!Array.isArray(this.data.users) || !Array.isArray(this.data.credentials) || !Array.isArray(this.data.audit) || !this.data.users.some(u => u.role === 'admin' && !u.disabled)) throw new BridgeError('Повреждены настройки доступа. Восстановите резервную копию.', 500);
    if (!this.data.pendingFastkoreAdminId && !state.externalIdentities?.length) {
      const setup = this.data.audit.find(event => event.action === 'setup');
      if (setup && this.data.users.some(user => user.id === setup.targetId && user.role === 'admin' && !user.disabled && user.passwordHash)) {
        this.data.pendingFastkoreAdminId = setup.targetId;
      }
    }
    this.migrate();
  }
  get setupRequired() {
    const admins = this.data.users.filter(user => user.role === 'admin' && !user.disabled);
    return !admins.some(user => user.passwordHash) &&
      !this.workspace.store.state.externalIdentities?.some(link => admins.some(admin => admin.id === link.userId));
  }
  migrate() {
    const admins = new Set(this.data.users.filter(user => user.role === 'admin' && !user.disabled).map(user => user.id));
    this.data.credentials = this.data.credentials.filter(credential => credential.kind === 'session' &&
      (credential.source === 'fastkore' || admins.has(credential.userId)));
    for (const user of this.data.users) {
      user.roleId ??= 'employee';
      if (user.role !== 'admin') user.passwordHash = '';
    }
    const admin = this.data.users.find(u => u.role === 'admin' && !u.disabled)!;
    for (const project of this.workspace.store.state.projects) {
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
  private changeAccess<T>(work: (draft: AccessDraft) => T, sessionEnd: ErpSessionEnd = 'session_removed') {
    const result = this.queue.then(async () => {
      const before = [...this.data.credentials];
      const value = await this.workspace.store.changeAccess(work);
      this.notifyRemoved(before, sessionEnd);
      return value;
    });
    this.queue = result.catch(() => {}); return result;
  }
  private notifyRemoved(before: Credential[], reason: ErpSessionEnd = 'session_removed') {
    if (!this.onSessionsRemoved) return;
    const current = new Set(this.data.credentials.map(c => c.id));
    this.onSessionsRemoved(before.filter(c => c.source === 'fastkore' && !current.has(c.id)), reason);
  }
  private audit(actorId: string, action: string, targetId: string, data = this.data, details?: AuditEvent['details']) {
    const event = { id: randomUUID(), actorId, action, targetId, createdAt: new Date().toISOString(), details };
    data.audit.unshift(event); data.audit.splice(1000);
    return event;
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
  private issueSession(user: UserRecord, name: string, external?: Pick<Credential, 'source' | 'installationId' | 'externalUserId' | 'externalDisplayName' | 'externalRoles' | 'browserParentId'>,
    data = this.data, seal?: (credential: Credential) => Credential['erpDelegation'], maxExpiresAt = Infinity) {
    const token = 'ccb_s_' + randomBytes(32).toString('hex');
    const expiresAt = new Date(Math.min(maxExpiresAt, Date.now() + (external?.source === 'fastkore' ? 1800_000 : 12 * 3600_000))).toISOString();
    const record: Credential = { id: randomUUID(), userId: user.id, kind: 'session', hash: digest(token), name, createdAt: new Date().toISOString(), expiresAt, ...external };
    if (seal) record.erpDelegation = seal(record);
    data.credentials = data.credentials.filter(c => !c.expiresAt || Date.parse(c.expiresAt) > Date.now());
    const old = data.credentials.filter(c => c.userId === user.id);
    for (const c of old.filter(c => c.id !== external?.browserParentId).slice(0, Math.max(0, old.length - 19))) data.credentials.splice(data.credentials.indexOf(c), 1);
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
    if (credential.browserParentId) {
      const parent = this.data.credentials.find(c => c.id === credential.browserParentId);
      if (!parent || user.role !== 'admin' || !this.canOpenBrowserSettings({ user, credential: parent }) ||
        parent.installationId !== credential.installationId || parent.externalUserId !== credential.externalUserId) {
        throw new BridgeError('Вход в настройки завершён. Откройте их заново из Fastkore.', 401);
      }
    }
    return { user, credential };
  }
  canOpenBrowserSettings({ user, credential }: Principal) {
    return user.role === 'admin' && !user.disabled && credential.userId === user.id && credential.kind === 'session' &&
      credential.source === 'fastkore' && !credential.browserParentId && Date.parse(credential.expiresAt ?? '') > Date.now() &&
      !!this.externalCredentialValid?.(credential);
  }
  issueBrowserCode(principal: Principal) {
    if (!this.canOpenBrowserSettings(principal)) throw new BridgeError('Откройте настройки из сеанса администратора Fastkore.', 403);
    const now = Date.now(), sessionId = principal.credential.id;
    for (const [key, entry] of this.browserCodes) {
      if (entry.expiresAt <= now || entry.sessionId === sessionId) this.browserCodes.delete(key);
    }
    if (this.browserCodes.size >= 2048) throw new BridgeError('Слишком много запросов на вход. Попробуйте позже.', 429);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + 60_000, Date.parse(principal.credential.expiresAt!));
    this.browserCodes.set(digest(code), { sessionId, expiresAt });
    return { code, expiresAt };
  }
  redeemBrowserCode(code: string, previousToken: string) {
    const key = digest(code), grant = this.browserCodes.get(key);
    this.browserCodes.delete(key);
    const invalid = () => new BridgeError('Ссылка истекла или уже использована. Откройте настройки из Fastkore заново.', 401);
    if (!grant || grant.expiresAt <= Date.now()) throw invalid();
    return this.changeAccess(draft => {
      if (grant.expiresAt <= Date.now()) throw invalid();
      const parent = this.authenticateCredential(grant.sessionId);
      if (!this.canOpenBrowserSettings(parent)) throw invalid();
      const data = draft.security!;
      const credential = parent.credential;
      const previous = previousToken && data.credentials.find(c => c.hash === digest(previousToken));
      if (previous && Date.parse(previous.expiresAt ?? '') > Date.now() && previous.userId !== parent.user.id) {
        throw new BridgeError('В браузере уже открыт сеанс другого сотрудника. Выйдите из него и снова откройте настройки из Fastkore.', 409);
      }
      if (previous && previous.browserParentId) data.credentials = data.credentials.filter(c => c.id !== previous.id);
      const { installationId, externalUserId, externalDisplayName, externalRoles } = credential;
      this.audit(parent.user.id, 'sso.browser.login', installationId!, data);
      return this.issueSession(parent.user, 'Настройки из Fastkore', { source: 'fastkore', installationId, externalUserId,
        externalDisplayName, externalRoles, browserParentId: credential.id }, data, undefined, Date.parse(credential.expiresAt!));
    });
  }
  changeInterfaceScale(current: () => Principal, interfaceScale: InterfaceScale) {
    return this.changeAccess(draft => {
      const { user } = current();
      draft.security!.users.find(item => item.id === user.id)!.interfaceScale = interfaceScale;
      return { interfaceScale };
    });
  }
  setChatPinned(pinned: boolean, authorize: () => { actor: User; chat: Chat }) {
    return this.changeAccess(draft => {
      const { actor, chat } = authorize();
      if (chat.archivedAt) throw new BridgeError('Восстановите чат из архива, чтобы закрепить его.', 409);
      const user = draft.security!.users.find(item => item.id === actor.id)!;
      const ids = new Set(user.pinnedChatIds);
      if (pinned) ids.add(chat.id);
      else ids.delete(chat.id);
      user.pinnedChatIds = ids.size ? [...ids] : undefined;
      return { pinned };
    });
  }
  markChatRead(replyId: string, authorize: () => { actor: UserRecord; chat: Chat }) {
    const { actor, chat } = authorize();
    if (chat.lastCompletedReplyId !== replyId || actor.readChatReplies?.[chat.id] === replyId) return { read: true };
    return this.changeAccess(draft => {
      const { actor, chat } = authorize();
      if (chat.lastCompletedReplyId === replyId) {
        const user = draft.security!.users.find(item => item.id === actor.id)!;
        (user.readChatReplies ??= {})[chat.id] = replyId;
      }
      return { read: true };
    });
  }
  bootstrap() {
    return this.changeAccess(draft => {
      if (!this.setupRequired) throw new BridgeError('Первичная настройка завершена. Войдите по логину и паролю.', 403);
      const data = draft.security!;
      return this.issueSession(data.users.find(u => u.role === 'admin' && !u.disabled)!, 'Первичная настройка', undefined, data);
    });
  }
  async setup(current: () => Principal, username: string, name: string, password: string) {
    if (!this.setupRequired || current().user.role !== 'admin') throw new BridgeError('Первичная настройка уже завершена.', 403);
    const login = this.username(username), hash = await this.password(password);
    return this.changeAccess(draft => {
      if (!this.setupRequired) throw new BridgeError('Первичная настройка уже завершена.', 403);
      const { user, credential } = current();
      this.admin(user);
      if (credential.source === 'fastkore') throw new BridgeError('Требуется локальный вход руководителя.', 403);
      const data = draft.security!, actor = data.users.find(item => item.id === user.id)!;
      actor.username = login;
      actor.name = name.trim() || 'Руководитель';
      actor.passwordHash = hash;
      data.pendingFastkoreAdminId = actor.id;
      data.credentials = [];
      this.audit(actor.id, 'setup', actor.id, data);
      return this.issueSession(actor, 'Браузер', undefined, data);
    });
  }
  async login(username: string, password: string) {
    const user = this.data.users.find(u => u.username === username.trim().toLowerCase() && u.role === 'admin' && !u.disabled);
    // Run the same expensive derivation for an unknown login as for a known one.
    const previousHash = user?.passwordHash;
    const ok = await this.matches(password, previousHash || `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    return this.changeAccess(draft => {
      const data = draft.security!;
      const current = data.users.find(u => u.id === user?.id && !u.disabled);
      if (!current || current.role !== 'admin' || current.passwordHash !== previousHash || !ok || this.setupRequired) throw new BridgeError('Неверный логин или пароль.', 401);
      this.audit(current.id, 'login', current.id, data);
      return this.issueSession(current, 'Браузер', undefined, data);
    });
  }
  logout(principal: Principal) {
    return this.changeAccess(draft => {
      const data = draft.security!;
      data.credentials = data.credentials.filter(c => c.id !== principal.credential.id);
      return { ok: true };
    }, 'logout');
  }
  fastkoreLogin(identity: TicketIdentity, previousToken = '', recheck: () => void = () => {},
    seal?: (credential: Credential, delegation: ErpDelegation) => Credential['erpDelegation']) {
    return this.changeAccess(draft => {
      recheck();
      if (this.setupRequired) throw new BridgeError('Сначала администратор должен настроить платформу.', 403);
      const data = draft.security!, identities = draft.externalIdentities ??= [];
      const linkIndex = identities.findIndex(i => i.installationId === identity.installationId && i.externalUserId === identity.externalUserId);
      const link = identities[linkIndex];
      let user = link && data.users.find(u => u.id === link.userId);
      if (user?.deletedAt) {
        // Earlier releases kept links to deleted accounts.
        identities.splice(linkIndex, 1);
        user = undefined;
      } else if (link && (!user || user.disabled)) throw new BridgeError('Учётная запись отключена администратором платформы.', 403);
      if (!link && data.pendingFastkoreAdminId && identity.roles?.some(role => role.id === fastkoreAdministratorRoleId)) {
        const installation = draft.sso?.installations?.find(item => item.id === identity.installationId);
        const bootstrapAdmin = data.users.find(u => u.id === data.pendingFastkoreAdminId && u.role === 'admin' && !u.disabled && u.passwordHash);
        if (installation?.enabled && installation.pairing?.required && installation.pairing.binding && bootstrapAdmin &&
          !identities.some(item => item.userId === bootstrapAdmin.id)) {
          user = bootstrapAdmin;
          identities.push({ installationId: identity.installationId, externalUserId: identity.externalUserId, userId: user.id });
          delete data.pendingFastkoreAdminId;
          this.audit(user.id, 'sso.identity.link', user.id, data);
        }
      }
      if (!user) {
        const id = randomUUID();
        user = { id, username: `sso-${id}`, name: identity.displayName, role: 'employee', roleId: 'sso_pending', disabled: false, passwordHash: '', createdAt: new Date().toISOString() };
        data.users.push(user); identities.push({ installationId: identity.installationId, externalUserId: identity.externalUserId, userId: id });
        this.audit(user.id, 'sso.user.create', user.id, data);
      } else user.name = identity.displayName;
      observeErpRoles(draft, identity.installationId, identity.externalUserId, identity.roles, new Date().toISOString());
      if (previousToken) data.credentials = data.credentials.filter(c => c.source !== 'fastkore' || c.hash !== digest(previousToken));
      this.audit(user.id, 'sso.login', identity.installationId, data);
      const { delegation } = identity;
      return this.issueSession(user, 'Fastkore', { source: 'fastkore', installationId: identity.installationId, externalUserId: identity.externalUserId,
        externalDisplayName: identity.displayName, externalRoles: identity.roles },
        data, delegation && seal ? credential => seal(credential, delegation) : undefined);
    }, 'login_rotation');
  }
  async forgetErpDelegation(id: string, reason: ErpDelegationLoss) {
    const event = await this.changeAccess(draft => {
      const credential = draft.security?.credentials.find(c => c.id === id);
      if (credential?.erpDelegation) {
        delete credential.erpDelegation;
        credential.erpDelegationRevoked = true;
        credential.erpDelegationLoss = reason;
        return this.audit(credential.userId, 'erp.delegation.invalidated', id, draft.security, {
          sessionId: id, installationId: credential.installationId, delegationReason: reason,
          status: reason === 'mcp_token_denied' || reason === 'cli_ticket_denied' ? 403 : undefined,
        });
      }
    });
    publishAudit(event);
  }
  linkExternal(authorize: () => User, installationId: string, externalUserId: string, userId: string) {
    return this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      if (!data.users.some(u => u.id === userId && !u.disabled)) throw new BridgeError('Пользователь не найден.', 404);
      const identities = draft.externalIdentities ??= [];
      const link = identities.find(i => i.installationId === installationId && i.externalUserId === externalUserId);
      data.credentials = data.credentials.filter(c => c.installationId !== installationId || c.externalUserId !== externalUserId);
      if (link) link.userId = userId; else identities.push({ installationId, externalUserId, userId });
      if (userId === data.pendingFastkoreAdminId) delete data.pendingFastkoreAdminId;
      this.audit(actor.id, 'sso.identity.link', userId, data); return { ok: true };
    }, 'identity_link');
  }
  changeInstallation<T>(authorize: () => User, action: string, work: (items: StoredFastkoreInstallation[]) => { id: string; result: T; revoke?: boolean }) {
    return this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      const items = (draft.sso ??= {}).installations ??= [];
      const { id, result, revoke } = work(items);
      if (revoke) data.credentials = data.credentials.filter(c => c.source !== 'fastkore' || c.installationId !== id);
      this.audit(actor.id, action, id, data);
      return result;
    }, 'installation_change');
  }
  admin(user: User) { if (user.role !== 'admin') throw new BridgeError('Доступно только руководителю.', 403); }
  project(user: User, id: string, credential?: Credential) {
    const project = this.workspace.project(id);
    if (!canAccessProject(user, project, credential)) throw new BridgeError('Проект не найден.', 404);
    return project;
  }
  canChat(user: User, chat: Chat) {
    return user.role === 'admin' || chat.ownerId === user.id && !!chat.fastkoreBinding
      || !chat.archivedAt && (chat.ownerId === user.id || chat.visibility === 'project');
  }
  canAccessChat(user: User, project: Project, chat: Chat, credential?: Credential) {
    if (project.deletedAt) return !user.disabled && (user.role === 'admin' || chat.ownerId === user.id);
    return canAccessProject(user, project, credential) && this.canChat(user, chat);
  }
  chat(user: User, projectId: string, chatId: string, credential?: Credential) {
    const project = this.workspace.project(projectId), chat = this.workspace.chat(projectId, chatId);
    if (!this.canAccessChat(user, project, chat, credential) || !fastkoreChatSessionMatches(chat, credential)) throw new BridgeError('Диалог не найден.', 404); return chat;
  }
  editChat(user: User, projectId: string, chatId: string, credential?: Credential) {
    const chat = this.chat(user, projectId, chatId, credential);
    if (chat.archivedAt) throw new BridgeError('Восстановите чат из архива, чтобы продолжить диалог.', 409);
    if (user.role !== 'admin' && chat.ownerId !== user.id) throw new BridgeError('Менять настройки этого чата может его владелец или администратор.', 403);
    return chat;
  }
  postChat(user: User, projectId: string, chatId: string, credential?: Credential) {
    const chat = this.chat(user, projectId, chatId, credential);
    if (chat.archivedAt) throw new BridgeError('Восстановите чат из архива, чтобы продолжить диалог.', 409);
    if (user.role !== 'admin' && chat.ownerId !== user.id && chat.visibility !== 'project') throw new BridgeError('Нет доступа к отправке сообщения в этот чат.', 403);
    return chat;
  }
  run(user: User, id: string, credential?: Credential) {
    const run = this.workspace.getRun(id); if (run.projectId && run.chatId) this.chat(user, run.projectId, run.chatId, credential); else this.admin(user); return run;
  }
  userNameLookup() {
    const authorNames = new Map<string | undefined, string>();
    return (id: string | undefined) => {
      const cached = authorNames.get(id);
      if (cached !== undefined) return cached;
      const name = this.data.users.find(user => user.id === id)?.name ?? 'Пользователь';
      authorNames.set(id, name);
      return name;
    };
  }
  viewChat(chat: Chat, session?: Credential): ChatView {
    const { specialistSessions, knowledgeRevision, fastkoreBinding, fastkoreHistory, titleCustomized, cliWorkspaceProjectId, sessionProvider, historyReplayPending, legacyHistory, ...view } = chat;
    const authorName = this.userNameLookup();
    const messages = chat.messages.map(({ historyScope, libraryHistory, requestScope, ...message }) => {
      if (message.role === 'assistant') return message;
      const authorId = message.authorId ?? chat.ownerId;
      return { ...message, authorId, authorName: authorName(authorId) };
    });
    let fastkoreNavigation: ChatView['fastkoreNavigation'];
    if (fastkoreBinding && session?.source === 'fastkore' && (session.userId === chat.ownerId || chat.visibility === 'project') &&
      session.installationId === fastkoreBinding.installationId && fastkoreChatSessionMatches(chat, session)) {
      const { installationId, entityUri, tileId, tileName } = fastkoreBinding;
      if (entityUri) fastkoreNavigation = { installationId, entityUri };
      else if (tileId) fastkoreNavigation = { installationId, tileId, tileName: tileName ?? fastkoreBinding.contextName };
    }
    const canSeeAllFiles = view.storedFiles?.length && this.data.users.some(user => user.id === session?.userId && user.role === 'admin');
    return { ...view, storedFiles: view.storedFiles?.filter(file => file.ownerId === session?.userId || canSeeAllFiles),
      linkedToFastkore: fastkoreBinding ? true : undefined, fastkoreNavigation, ownerName: authorName(chat.ownerId), messages };
  }
  chatSummary({ id, title, updatedAt, messages, ownerId, visibility, fastkoreBinding }: Chat,
    ownerName = this.data.users.find(user => user.id === ownerId)?.name ?? 'Пользователь'): ChatSummary {
    return { id, title, updatedAt, messageCount: messages.length, ownerId, ownerName, visibility, linkedToFastkore: fastkoreBinding ? true : undefined };
  }
  users(user: User, includeDeleted = false): TeamUser[] {
    this.admin(user);
    const state = this.workspace.store.state;
    return this.data.users.filter(item => includeDeleted || !item.deletedAt).map(item => {
      const erpRoles = erpRolesForUser(state, item.id);
      const projects = item.disabled ? [] : state.projects
        .filter(project => !project.deletedAt && (item.role === 'admin' || erpRoles.some(({ installationId, roles }) => projectAllowsRoles(project, installationId, roles))))
        .map(({ id, name }) => ({ id, name }));
      return { ...publicUser(item), erpRoles, projects };
    });
  }
  createUser(actor: User, input: { username: string; name: string; password: string; role: User['role']; roleId?: string }) {
    this.admin(actor);
    if (input.role !== 'admin') throw new BridgeError('Профили сотрудников создаются при входе из Fastkore.', 403);
    return this.change(async () => {
      const username = this.username(input.username); if (this.data.users.some(u => u.username === username && !u.deletedAt)) throw new BridgeError('Этот логин уже занят.', 409);
      const roleId = input.roleId ?? 'employee'; if (!this.workspace.corporate.data.roles.some(r => r.id === roleId && r.enabled)) throw new BridgeError('Роль недоступна.');
      const user: UserRecord = { id: randomUUID(), username, name: input.name.trim() || username, role: input.role, roleId, disabled: false, passwordHash: await this.password(input.password), createdAt: new Date().toISOString() };
      this.data.users.push(user); this.audit(actor.id, 'user.create', user.id); return publicUser(user);
    });
  }
  async updateUser(current: () => Principal, id: string, input: { disabled?: boolean; password?: string; name?: string; roleId?: string; role?: User['role'] }) {
    const authorize = () => {
      const { user, credential } = current();
      this.admin(user);
      const target = this.data.users.find(item => item.id === id && !item.deletedAt);
      if (!target) throw new BridgeError('Пользователь не найден.', 404);
      if (credential.source === 'fastkore' && (input.password !== undefined ||
        input.role !== undefined && input.role !== target.role || target.role === 'admin')) {
        throw new BridgeError('Требуется локальный вход руководителя.', 403);
      }
      return user;
    };
    authorize();
    const hash = input.password === undefined ? undefined : await this.password(input.password);
    return this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      const user = data.users.find(u => u.id === id)!;
      if (actor.id === id && input.disabled) throw new BridgeError('Нельзя отключить свою учётную запись.');
      if (input.disabled && user.role === 'admin' && this.data.users.filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new BridgeError('Должен остаться хотя бы один руководитель.');
      if (input.role && input.role !== 'admin' && user.role === 'admin' && this.data.users.filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new BridgeError('Должен остаться хотя бы один руководитель.');
      if (input.roleId !== undefined && !this.workspace.corporate.data.roles.some(r => r.id === input.roleId && r.enabled)) throw new BridgeError('Роль недоступна.');
      if (input.password !== undefined && (input.role ?? user.role) !== 'admin') throw new BridgeError('Сотрудники входят через Fastkore.', 403);
      if (input.disabled !== undefined) user.disabled = input.disabled; if (hash) user.passwordHash = hash;
      if (input.name !== undefined) user.name = input.name.trim() || user.username;
      if (input.roleId !== undefined) user.roleId = input.roleId;
      if (input.role !== undefined) user.role = input.role;
      if (input.disabled || hash) data.credentials = data.credentials.filter(c => c.userId !== id);
      if (user.role !== 'admin') {
        user.passwordHash = '';
        data.credentials = data.credentials.filter(c => c.userId !== id || c.source === 'fastkore');
      }
      this.audit(actor.id, 'user.update', id, data); return publicUser(user);
    }, 'account_change');
  }
  async deleteUser(authorize: () => User, id: string) {
    const event = await this.changeAccess(draft => {
      const actor = authorize(), data = draft.security!;
      this.admin(actor);
      const target = data.users.find(user => user.id === id);
      if (!target) throw new BridgeError('Пользователь не найден.', 404);
      if (target.id === actor.id) throw new BridgeError('Нельзя удалить свою учётную запись.', 403);
      if (target.deletedAt) return;
      if (target.role === 'admin') {
        const enabledInstallations = new Set(draft.sso?.installations?.filter(item => item.enabled).map(item => item.id));
        const linkedUsers = new Set(draft.externalIdentities?.filter(link => enabledInstallations.has(link.installationId)).map(link => link.userId));
        if (!data.users.some(user => user.id !== id && user.role === 'admin' && !user.disabled && (user.passwordHash || linkedUsers.has(user.id)))) {
          throw new BridgeError('Должен остаться активный администратор с возможностью входа.', 409);
        }
      }
      target.deletedAt = new Date().toISOString();
      target.disabled = true;
      target.passwordHash = '';
      data.credentials = data.credentials.filter(credential => credential.userId !== id);
      draft.externalIdentities = draft.externalIdentities?.filter(link => link.userId !== id);
      if (data.pendingFastkoreAdminId === id) delete data.pendingFastkoreAdminId;
      return this.audit(actor.id, 'user.delete', id, data);
    }, 'account_change');
    publishAudit(event);
    return { ok: true };
  }
  changePassword(principal: Principal, current: string, password: string) {
    return this.change(async () => {
      const { credential, user } = this.authenticateCredential(principal.credential.id);
      if (credential.source === 'fastkore' || !await this.matches(current, user.passwordHash)) throw new BridgeError('Смена пароля доступна при локальном входе.', 403);
      user.passwordHash = await this.password(password); this.data.credentials = this.data.credentials.filter(c => c.userId !== user.id);
      this.audit(user.id, 'password.change', user.id); return this.issueSession(user, 'Браузер');
    });
  }
  setProjectRoles(authorize: () => User, projectId: string, input: ProjectRolePolicy) {
    return this.changeAccess(draft => {
      const actor = authorize();
      this.admin(actor);
      const project = this.workspace.activeProject(projectId);
      if (input.revision !== (project.rolePolicy?.revision ?? 0)) throw new BridgeError('Роли проекта изменились. Откройте актуальные настройки.', 409);
      const known = new Set(draft.sso?.roles?.map(role => role.installationId + '/' + role.id));
      if (input.roles.some(role => !known.has(role.installationId + '/' + role.roleId))) throw new BridgeError('Выберите существующие роли Fastkore.');
      const policy = { revision: input.revision + 1, roles: input.roles };
      draft.projectRolePolicies = new Map([[projectId, policy]]);
      this.audit(actor.id, 'project.roles', projectId, draft.security);
      return policy;
    });
  }
}
