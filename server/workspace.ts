import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { Attachment, Chat, CliInfo, ErpContext, Job, ModelCatalog, Project, Run, Settings } from '../shared/types.js';
import { Store, BridgeError, redact } from './store.js';
import { type CodexRunner, discoverCli } from './codex.js';
import { buildContext } from './documents.js';
import { CorporateAccess } from './corporate.js';

export class Workspace {
  readonly corporate: CorporateAccess;
  cli: CliInfo | null = null;
  private active: { run: Run; cancel: AbortController; task?: Promise<void> } | null = null;
  private stopping = false;
  private started = false;
  private admissions: Promise<unknown> = Promise.resolve();
  private authorizer?: (job: Job, run: Run) => void;
  private catalog?: { path: string; value: ModelCatalog };
  private catalogPending?: { path: string; promise: Promise<ModelCatalog> };
  constructor(readonly store: Store, private readonly codex: CodexRunner) { this.corporate = new CorporateAccess(store); }
  get activeRun() { return this.active?.run ?? null; }
  get queuedRuns() { return this.store.state.runs.filter(r => r.status === 'queued'); }
  get busy() { return !!this.active || this.queuedRuns.length > 0; }
  start(authorizer?: (job: Job, run: Run) => void) { this.authorizer ??= authorizer; this.started = true; this.pump(); }
  private writable() { if (this.stopping) throw new BridgeError('Сервер останавливается.', 503); }
  private executionAllowed() { if (process.env.BRIDGE_EXECUTION === 'disabled') throw new BridgeError('Выполнение заданий выключено до проверки среды. Настройки и история доступны.', 503); }
  project(id: string): Project { const p = this.store.state.projects.find(p => p.id === id); if (!p) throw new BridgeError('Проект не найден.', 404); return p; }
  chat(projectId: string, chatId: string): Chat { const c = this.project(projectId).chats.find(c => c.id === chatId); if (!c) throw new BridgeError('Диалог не найден в этом проекте.', 404); return c; }
  listProjects() { return this.store.state.projects.map(p => ({ id: p.id, name: p.name, directory: p.directory, chatCount: p.chats.length })); }
  listChats(projectId: string) { return this.project(projectId).chats.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.length })); }
  async addProject(directory: string, name?: string) {
    this.writable();
    if (!path.isAbsolute(directory)) throw new BridgeError('Укажите абсолютный путь к папке на сервере.');
    const resolved = await realpath(directory).catch(() => { throw new BridgeError('Папка на сервере недоступна.'); });
    if (!(await stat(resolved)).isDirectory()) throw new BridgeError('Выберите папку проекта.');
    const existing = this.store.state.projects.find(p => p.directory.toLowerCase() === resolved.toLowerCase()); if (existing) return existing;
    const project: Project = { id: randomUUID(), name: name?.trim() || path.basename(resolved) || resolved, directory: resolved, chats: [], attachments: [] };
    this.store.state.projects.push(project); await this.store.save(); return project;
  }
  async addChat(projectId: string, title?: string, model = '', ownerId?: string, authorize?: () => void, agentProfileId = 'universal', erpContext?: ErpContext) {
    this.writable();
    await this.validateModel(model);
    authorize?.();
    this.corporate.profile(this.store.state.security?.users.find(u => u.id === ownerId), agentProfileId);
    const chat: Chat = { id: randomUUID(), title: title?.trim() || 'Новый диалог', updatedAt: new Date().toISOString(), messages: [], model, agentProfileId, ownerId, visibility: 'private', ...(erpContext ? { erpContext: { ...erpContext } } : {}) };
    this.project(projectId).chats.unshift(chat); await this.store.save(); return chat;
  }
  async changeChatModel(projectId: string, chatId: string, model: string, authorize?: () => void) {
    this.writable(); this.chat(projectId, chatId);
    const assertIdle = () => { if (this.store.state.runs.some(r => r.projectId === projectId && r.chatId === chatId && ['queued', 'running'].includes(r.status))) throw new BridgeError('Дождитесь завершения заданий в этом диалоге.', 409); };
    assertIdle(); await this.validateModel(model); this.writable(); assertIdle();
    authorize?.(); const chat = this.chat(projectId, chatId); chat.model = model; await this.store.save(); return chat;
  }
  async models(force = false): Promise<ModelCatalog> {
    const cliPath = this.store.state.settings.cliPath || await discoverCli();
    if (!cliPath) throw new BridgeError('Codex CLI не найден. Укажите путь к codex.exe в настройках.');
    if (!force && this.catalog?.path === cliPath && Date.now() - Date.parse(this.catalog.value.fetchedAt) < 300_000) return this.catalog.value;
    if (this.catalogPending?.path === cliPath) return this.catalogPending.promise;
    const promise = (async () => {
      const info = await this.codex.inspect(cliPath); this.cli = info;
      if (info.authentication !== 'chatgpt') throw new BridgeError('Для списка моделей выполните вход Codex через ChatGPT.');
      if (!this.codex.listModels) throw new BridgeError('Текущий Codex не поддерживает каталог моделей.', 502);
      const value = await this.codex.listModels(cliPath); this.catalog = { path: cliPath, value }; return value;
    })();
    this.catalogPending = { path: cliPath, promise };
    try { return await promise; } finally { if (this.catalogPending?.promise === promise) this.catalogPending = undefined; }
  }
  private async validateModel(model: string) {
    if (model === '') return;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) throw new BridgeError('Некорректный идентификатор модели.');
    if (!(await this.models()).models.some(m => m.id === model)) throw new BridgeError('Модель отсутствует в каталоге Codex. Обновите список и выберите модель.');
  }
  async importDesktop(source = path.join(process.env.LOCALAPPDATA ?? '', 'CodexChatBridge', 'state.json')) {
    this.writable();
    if (this.active || this.store.state.projects.length) throw new BridgeError('Импорт доступен в пустое рабочее пространство без активных заданий.', 409);
    let old: any;
    try { old = JSON.parse(await readFile(source, 'utf8')); } catch { throw new BridgeError('История настольной версии не найдена на сервере.'); }
    if (old.SchemaVersion !== 1 || !Array.isArray(old.Projects)) throw new BridgeError('Неподдерживаемая история настольной версии.');
    const projects: Project[] = old.Projects.map((p: any) => {
      if (typeof p.Id !== 'string' || typeof p.Directory !== 'string' || !Array.isArray(p.Chats)) throw new BridgeError('Некорректные данные проекта.');
      const attachments: Attachment[] = [];
      return { id: p.Id, name: String(p.Name ?? 'Проект'), directory: p.Directory, attachments,
        chats: p.Chats.map((c: any): Chat => {
          if (typeof c.Id !== 'string' || !Array.isArray(c.Messages)) throw new BridgeError('Некорректные данные диалога.');
          return { id: c.Id, title: String(c.Title ?? 'Диалог'), sessionId: typeof c.SessionId === 'string' ? c.SessionId : undefined,
            updatedAt: c.UpdatedAt ?? new Date().toISOString(), messages: c.Messages.map((m: any) => ({
              id: randomUUID(), role: m.Role === 'assistant' ? 'assistant' : 'user', text: String(m.Text ?? ''),
              status: m.Status === 'running' ? 'interrupted' : ['complete', 'error', 'cancelled', 'interrupted'].includes(m.Status) ? m.Status : 'complete', createdAt: m.CreatedAt ?? new Date().toISOString(),
              attachments: (Array.isArray(m.Attachments) ? m.Attachments : []).filter((f: unknown) => typeof f === 'string').map((f: string) => { const a = { id: randomUUID(), name: path.basename(f), path: f, size: 0 }; attachments.push(a); return a; }),
              usage: m.Usage ? { inputTokens: m.Usage.InputTokens ?? 0, cachedInputTokens: m.Usage.CachedInputTokens ?? 0, outputTokens: m.Usage.OutputTokens ?? 0 } : undefined
            })) };
        }) };
    });
    // Independent copy: the old desktop application's file is never modified.
    this.store.state.projects = projects;
    if (!this.store.state.settings.cliPath && typeof old.Settings?.CliPath === 'string') this.store.state.settings.cliPath = old.Settings.CliPath;
    await this.store.save(); return { projectCount: projects.length, chatCount: projects.reduce((sum, p) => sum + p.chats.length, 0) };
  }
  async settings(settings: Partial<Settings>) {
    this.writable(); if (this.busy) throw new BridgeError('Дождитесь завершения заданий.', 409);
    if (settings.model !== undefined) {
      if (settings.cliPath !== undefined && settings.cliPath !== this.store.state.settings.cliPath) throw new BridgeError('Сначала сохраните путь к Codex, затем выберите модель.');
      await this.validateModel(settings.model); this.writable();
      if (this.busy) throw new BridgeError('Дождитесь завершения заданий.', 409);
    }
    const pathChanged = settings.cliPath !== undefined && settings.cliPath !== this.store.state.settings.cliPath;
    this.store.state.settings = { ...this.store.state.settings, ...settings };
    if (pathChanged) { this.cli = null; this.catalog = undefined; }
    await this.store.save(); return this.store.state.settings;
  }
  async inspect(signal?: AbortSignal) {
    const cliPath = this.store.state.settings.cliPath || await discoverCli();
    if (!cliPath) throw new BridgeError('Codex CLI не найден. Укажите путь к codex.exe в настройках.');
    const info = await this.codex.inspect(cliPath, signal); this.cli = info; return info;
  }
  private async requireChatGPT(signal: AbortSignal) {
    const info = await this.inspect(signal);
    if (info.authentication !== 'chatgpt') throw new BridgeError(info.authentication === 'api-key' ? 'Обнаружен API-ключ. Запрос заблокирован: выполните вход Codex через ChatGPT.' : 'Нужен подтверждённый вход Codex через ChatGPT.');
    return info.path;
  }
  async send(projectId: string, chatId: string, text: string, attachmentIds: string[], clientRequestId?: string, model?: string, authorize?: () => void, author?: { id: string; name: string; credentialId?: string }) {
    this.executionAllowed();
    this.writable(); if (model !== undefined) await this.validateModel(model);
    const hash = createHash('sha256').update(JSON.stringify({ projectId, chatId, text, attachmentIds: [...attachmentIds].sort(), model: model ?? null })).digest('hex');
    return this.admit(async () => {
      this.writable(); authorize?.();
      const previous = clientRequestId && this.store.state.runs.find(r => r.clientRequestId === clientRequestId);
      if (previous) {
        if (previous.projectId !== projectId || previous.chatId !== chatId || (previous.requestHash && previous.requestHash !== hash)) throw new BridgeError('Этот clientRequestId уже использован с другим содержимым.', 409);
        return previous;
      }
      if (this.queuedRuns.length >= 100) throw new BridgeError('Очередь заполнена. Повторите позже.', 429);
      const project = this.project(projectId), chat = this.chat(projectId, chatId);
      const actor = this.store.state.security?.users.find(u => u.id === author?.id);
      const profile = this.corporate.profile(actor, chat.agentProfileId ?? 'universal');
      for (const id of attachmentIds) if (!project.attachments.some(a => a.id === id)) throw new BridgeError('Вложение не найдено в этом проекте.', 404);
      const oldModel = chat.model; if (model !== undefined) chat.model = model;
      const run: Run = { id: randomUUID(), projectId, chatId, ownerId: author?.id ?? chat.ownerId, agentProfileId: profile.id, profileRevision: profile.revision, status: 'queued', progress: 'Ожидает выполнения', createdAt: new Date().toISOString(), clientRequestId, requestHash: hash, model: profile.model || chat.model || this.store.state.settings.model || undefined };
      const job: Job = { runId: run.id, kind: 'chat', text, attachmentIds, authorId: author?.id, credentialId: author?.credentialId, scope: this.corporate.scope(actor, profile, projectId) };
      this.store.state.runs.push(run); this.store.state.jobs!.push(job);
      try { await this.store.save(); }
      catch (error) { this.store.state.runs.splice(this.store.state.runs.indexOf(run), 1); this.store.state.jobs!.splice(this.store.state.jobs!.indexOf(job), 1); chat.model = oldModel; throw error; }
      this.start(); return run;
    });
  }
  private admit<T>(action: () => Promise<T>): Promise<T> {
    const result = this.admissions.then(action); this.admissions = result.catch(() => {}); return result;
  }
  async subscription() {
    this.executionAllowed();
    return this.admit(async () => {
      this.writable(); if (this.busy) throw new BridgeError('Дождитесь завершения заданий.', 409);
      const block = this.corporate.unavailable(this.corporate.data.profiles.find(p => p.id === 'universal')!);
      if (block) throw new BridgeError(block, 409);
      const run: Run = { id: randomUUID(), status: 'queued', progress: 'Ожидает проверки подписки', createdAt: new Date().toISOString(), model: this.store.state.settings.model || undefined };
      this.store.state.runs.push(run); this.store.state.jobs!.push({ runId: run.id, kind: 'subscription', text: '', attachmentIds: [] });
      await this.store.save(); this.start(); return run;
    });
  }
  private pump() {
    if (!this.started || this.stopping || this.active || process.env.BRIDGE_EXECUTION === 'disabled') return;
    const run = this.queuedRuns[0]; if (!run) return;
    const active = { run, cancel: new AbortController(), task: undefined as Promise<void> | undefined };
    this.active = active;
    active.task = this.execute(active);
    void active.task.catch(() => {}); // execute persists failures; shutdown also awaits this promise.
  }
  private checkJob(job: Job, run: Run) {
    const profile = run.agentProfileId && this.corporate.profile(this.store.state.security?.users.find(u => u.id === job.authorId), run.agentProfileId);
    if (profile && profile.revision !== run.profileRevision) throw new BridgeError('Настройки профиля изменились. Создайте новое задание.', 409);
    if (profile && job.scope && job.scope !== this.corporate.scope(this.store.state.security?.users.find(u => u.id === job.authorId), profile, run.projectId!)) throw new BridgeError('Рабочая роль изменилась. Создайте новое задание.', 403);
    if (job.authorId && this.store.state.security) {
      const security = this.store.state.security;
      const actor = security.users.find(u => u.id === job.authorId && !u.disabled);
      if (!actor) throw new BridgeError('Доступ к заданию отозван.', 403);
      if (job.credentialId && !security.credentials.some(c => c.id === job.credentialId && c.userId === actor.id && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()))) throw new BridgeError('Сеанс или ключ задания отозван.', 403);
      if (run.projectId && run.chatId) {
        const project = this.project(run.projectId), chat = this.chat(run.projectId, run.chatId);
        if (actor.role !== 'admin' && (!project.memberIds?.includes(actor.id) || chat.ownerId !== actor.id)) throw new BridgeError('Доступ к заданию отозван.', 403);
        if (job.attachmentIds.some(id => !project.attachments.some(a => a.id === id && (actor.role === 'admin' || a.ownerId === actor.id)))) throw new BridgeError('Доступ к вложению отозван.', 403);
      }
    }
    this.authorizer?.(job, run);
  }
  private async execute(active: NonNullable<Workspace['active']>) {
    const { run, cancel } = active;
    const job = this.store.state.jobs!.find(j => j.runId === run.id);
    let revocation: ReturnType<typeof setInterval> | undefined;
    let revoked = false;
    try {
      if (!job) throw new BridgeError('Не найдено сохранённое содержимое задания.', 500);
      this.executionAllowed();
      this.checkJob(job, run);
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.progress = 'Проверяем подключение Codex…';
      await this.store.save();
      revocation = setInterval(() => { try { this.checkJob(job, run); } catch { revoked = true; cancel.abort(); } }, 200);
      const signal = cancel.signal;
      const cliPath = await this.requireChatGPT(signal); signal.throwIfAborted(); this.checkJob(job, run);
      if (job.kind === 'subscription') {
        // Never give this probe the directory containing credentials and the application database.
        const { mkdtemp } = await import('node:fs/promises'), { tmpdir } = await import('node:os');
        const directory = await mkdtemp(path.join(tmpdir(), 'bridge-probe-'));
        const result = await this.codex.run({ cliPath, workspace: directory, prompt: 'Ответь одним словом: OK. Не используй инструменты и не читай файлы.', allowWrite: false, ephemeral: true, model: run.model }, async () => {}, signal);
        run.response = 'ChatGPT: пробный запрос выполнен. Остаток лимита проверяйте в аккаунте ChatGPT.'; run.usage = result.usage;
      } else {
        await this.executeChat(job, run, cliPath, signal);
      }
      this.checkJob(job, run); signal.throwIfAborted(); run.status = 'complete'; run.progress = 'Задание завершено';
    } catch (error) {
      run.status = cancel.signal.aborted ? 'cancelled' : 'error';
      run.response = undefined;
      run.error = revoked ? 'Доступ к заданию отозван.' : cancel.signal.aborted ? undefined : redact((error as Error).message);
      run.progress = revoked ? 'Доступ отозван' : cancel.signal.aborted ? 'Задание остановлено' : 'Ошибка выполнения';
      if (run.projectId && run.chatId) for (const message of this.chat(run.projectId, run.chatId).messages)
        if (message.runId === run.id && message.role === 'assistant') { message.status = run.status; message.text = run.error ?? ''; }
    } finally {
      clearInterval(revocation); run.completedAt = new Date().toISOString();
      try { await this.store.save(); await this.store.log('run', `id=${run.id}; status=${run.status}`); }
      catch { run.status = 'error'; run.response = undefined; run.error = 'Не удалось сохранить результат на диске.'; this.stopping = true; }
      finally { if (this.active === active) this.active = null; this.pump(); }
    }
  }
  private async executeChat(job: Job, run: Run, cliPath: string, signal: AbortSignal) {
    const project = this.project(run.projectId!), chat = this.chat(project.id, run.chatId!);
    const actor = this.store.state.security?.users.find(u => u.id === job.authorId);
    const profile = this.corporate.profile(actor, run.agentProfileId ?? 'universal');
    const scope = this.corporate.scope(actor, profile, project.id);
    const instructions = this.corporate.instructions(actor, profile);
    if (chat.sessionScope !== scope && (chat.sessionScope || profile.id !== 'universal' || profile.revision !== 1 || instructions)) chat.sessionId = undefined;
    chat.sessionScope = scope;
    if (!(await stat(project.directory)).isDirectory()) throw new BridgeError('Папка проекта недоступна.');
    const attachments = job.attachmentIds.map(id => project.attachments.find(a => a.id === id)!);
    // Admission is durable before execution; messages appear only after Codex auth has been checked.
    chat.messages.push({ id: randomUUID(), role: 'user', text: job.text, status: 'complete', createdAt: run.createdAt, attachments, runId: run.id, authorId: job.authorId });
    const answer: Chat['messages'][number] = { id: randomUUID(), role: 'assistant', text: '', status: 'running', createdAt: new Date().toISOString(), attachments: [], runId: run.id, model: run.model };
    chat.messages.push(answer); chat.updatedAt = new Date().toISOString();
    if (chat.title === 'Новый диалог') chat.title = job.text.replace(/[\r\n]/g, ' ').slice(0, 48);
    await this.store.save();
    run.progress = 'Подготовка документов…';
    const settings = { ...this.store.state.settings };
    const context = settings.includePreviews ? await buildContext(project.directory, attachments, true, signal) : attachments.map(a => a.path).join('\n');
    const result = await this.codex.run({ cliPath, workspace: project.directory, prompt: (instructions ? '<workspace_instructions>\n' + instructions + '\n</workspace_instructions>\n\n' : '') + job.text + (context ? '\n\n<local_document_context>\n' + context + '\n</local_document_context>' : ''), sessionId: chat.sessionId, allowWrite: settings.allowWrite && profile.allowWrite, model: run.model, reasoningEffort: profile.reasoningEffort }, async event => {
      this.checkJob(job, run); signal.throwIfAborted();
      if (event.kind === 'session') {
        if (chat.sessionId && chat.sessionId !== event.text) throw new BridgeError('Неожиданная замена сессии Codex.');
        chat.sessionId = event.text;
      }
      if (event.kind === 'message') answer.text += (answer.text ? '\n\n' : '') + event.text;
      if (event.kind === 'usage') { answer.usage = event.usage; run.usage = event.usage; }
      if (event.kind === 'progress') run.progress = event.text ?? 'Выполняется…';
      if (event.kind !== 'progress') await this.store.save();
    }, signal);
    this.checkJob(job, run); signal.throwIfAborted();
    answer.text = result.response; answer.usage = result.usage; answer.status = 'complete';
    chat.sessionId = result.sessionId; run.response = result.response; run.usage = result.usage;
  }
  getRun(id: string) { const run = this.store.state.runs.find(r => r.id === id); if (!run) throw new BridgeError('Задание не найдено.', 404); return run; }
  async cancel(id: string) {
    const run = this.getRun(id);
    if (run.status === 'running' && this.active?.run.id === id) this.active.cancel.abort();
    else if (run.status === 'queued') { run.status = 'cancelled'; run.progress = 'Отменено в очереди'; run.completedAt = new Date().toISOString(); await this.store.save(); }
    return run;
  }
  private shutdownPromise?: Promise<void>;
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    return this.shutdownPromise = (async () => {
      await this.admissions; this.active?.cancel.abort(); await this.active?.task;
      await this.store.save(); await this.store.close();
    })();
  }
}
