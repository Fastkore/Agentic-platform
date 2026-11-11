import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Code2, Copy, FileText, Folder, FolderPlus, Globe2, LoaderCircle, LogOut, Menu, MessageSquare, Network, Paperclip, Plus, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import type { AgentSummary, Attachment, Chat, ChatSummary, ErpContext, ModelCatalog, ProjectSummary, Run, Settings, Status, User } from '../shared/types';
import './style.css';
import { AccountPanel, TeamPanel } from './AccessPanel';
import { parseHostContext, webViewHost } from './fastkore';

let accessKey = sessionStorage.getItem('bridge-key') ?? '';
let browserSession = false, csrfToken = '', sessionUserId = '';
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (browserSession && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('X-Bridge-CSRF', csrfToken);
  if (!browserSession && accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const result = await response.json(); if (!response.ok) throw new ApiError(result.error ?? 'Не удалось выполнить запрос.', response.status);
  if (browserSession && sessionUserId && result.user?.id && result.user.id !== sessionUserId) throw new ApiError('Пользователь Fastkore изменился. Откройте помощника заново.', 401);
  return result;
}
const post = <T,>(url: string, body: unknown = {}) => api<T>(url, { method: 'POST', body: JSON.stringify(body) });
async function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  // Clipboard API is unavailable on plain LAN HTTP. Keep copying usable there too.
  const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
  const ok = document.execCommand('copy'); area.remove(); if (!ok) throw new Error('Выделите и скопируйте текст вручную.');
}
const requestId = () => globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function App() {
  const [loggedIn, setLoggedIn] = useState(false), [keyInput, setKeyInput] = useState(''), [loginInput, setLoginInput] = useState('');
  const [checkingSession, setCheckingSession] = useState(true), [authSource, setAuthSource] = useState<'local' | 'fastkore'>('local');
  const [erpContext, setErpContext] = useState<ErpContext | null>(null), [contextNotice, setContextNotice] = useState('');
  const [user, setUser] = useState<User | null>(null), [setupRequired, setSetupRequired] = useState(false), [setupName, setSetupName] = useState('Руководитель');
  const [status, setStatus] = useState<Status | null>(null), [projects, setProjects] = useState<ProjectSummary[]>([]), [chats, setChats] = useState<ChatSummary[]>([]), [chat, setChat] = useState<Chat | null>(null);
  const [projectId, setProjectId] = useState(localStorage.getItem('bridge-project') ?? ''), [chatId, setChatId] = useState(localStorage.getItem('bridge-chat') ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [panel, setPanel] = useState<'settings' | 'api' | 'project' | 'team' | null>(null), [sidebarOpen, setSidebarOpen] = useState(false), [projectOpen, setProjectOpen] = useState(false);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [copied, setCopied] = useState(''), [folderPath, setFolderPath] = useState(''), [projectName, setProjectName] = useState('');
  const [agents, setAgents] = useState<AgentSummary[]>([]), [newAgent, setNewAgent] = useState('universal');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null), [modelsLoading, setModelsLoading] = useState(false), [modelError, setModelError] = useState('');
  const [cliPath, setCliPath] = useState(''), [diagnostics, setDiagnostics] = useState(''), [subscription, setSubscription] = useState<Run | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true), loadingSettings = useRef(false);
  const selectedProject = projects.find(p => p.id === projectId), draft = drafts[chatId] ?? '', attachments = files[chatId] ?? [];
  const active = status?.activeRun, busy = status?.busy ?? !!active;
  const isAdmin = user?.role === 'admin', canEdit = !status?.executionDisabled && (isAdmin || (!!chat && chat.ownerId === user?.id));
  const modelName = (id?: string) => id ? (catalog?.models.find(m => m.id === id)?.name ?? id) : 'Автовыбор Codex';
  const selected = useRef({ projectId, chatId }); selected.current = { projectId, chatId };
  const fail = (e: unknown) => { const err = e as Error; setError(err.message); if (e instanceof ApiError && e.status === 401) clearLogin(); };
  async function action(work: () => Promise<void>) { setPending(true); setError(''); try { await work(); } catch (e) { fail(e); } finally { setPending(false); } }
  function saveToken(token: string) { accessKey = token; sessionStorage.setItem('bridge-key', token); }
  function clearLogin() { browserSession = false; csrfToken = ''; sessionUserId = ''; setErpContext(null); setContextNotice(''); setAgents([]); setCatalog(null); setModelError(''); accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat'); setLoggedIn(false); setUser(null); setStatus(null); setProjects([]); setChats([]); setChat(null); setDrafts({}); setFiles({}); setSubscription(null); setPanel(null); setProjectId(''); setChatId(''); setDiagnostics(''); setKeyInput(''); }
  function logout() { void action(async () => { await post('/api/auth/logout'); clearLogin(); }); }
  useEffect(() => {
    let alive = true;
    void fetch('/api/auth/browser-session', { credentials: 'same-origin' }).then(async response => {
      const value = await response.json();
      if (!alive) return;
      if (!response.ok) { clearLogin(); throw new Error('Сеанс Fastkore завершён. Откройте помощника из ERP заново.'); }
      if (value.authenticated) {
        accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat');
        browserSession = true; csrfToken = value.csrfToken; sessionUserId = value.user.id;
        setProjectId(''); setChatId(''); setAuthSource('fastkore'); setUser(value.user); setSetupRequired(false); setLoggedIn(true);
      } else setLoggedIn(!!accessKey);
    }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setCheckingSession(false); });
    return () => { alive = false; };
  }, []);
  async function login(local = false) {
    await action(async () => {
      const result = local ? await api<{ token: string; user: User }>('/api/local-login', { method: 'POST', headers: { 'X-Bridge-Local': '1' } }) : await post<{ token: string; user: User }>('/api/auth/login', { username: loginInput, password: keyInput });
      saveToken(result.token); setAuthSource('local'); const me = await api<{ user: User; setupRequired: boolean }>('/api/auth/me'); setUser(me.user); setSetupRequired(me.setupRequired); setLoggedIn(true); setKeyInput('');
    });
  }
  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    api<{ user: User; setupRequired: boolean }>('/api/auth/me').then(me => { if (alive) { setUser(me.user); setSetupRequired(me.setupRequired); } }).catch(e => { if (alive) fail(e); });
    return () => { alive = false; };
  }, [loggedIn]);
  useEffect(() => {
    const host = authSource === 'fastkore' && loggedIn && user ? webViewHost() : undefined;
    if (!host) return;
    let alive = true, sequence = 0;
    const receive = (event: { data: unknown }) => {
      const current = ++sequence;
      const message = parseHostContext(event.data); if (!message) { setErpContext(null); setContextNotice('Получен неподдерживаемый контекст Fastkore.'); return; }
      void post<{ context: ErpContext; suggestedAgent?: string; suggestionUnavailable: boolean }>('/api/fastkore/context/validate', { entityType: message.entityType, entityId: message.entityId, ...(message.suggestedAgent ? { suggestedAgent: message.suggestedAgent } : {}) }).then(result => {
        if (!alive || current !== sequence) return;
        setErpContext(result.context);
        if (result.suggestedAgent) setNewAgent(result.suggestedAgent);
        setContextNotice(result.suggestionUnavailable ? 'Предложенный специалист недоступен. Выберите разрешённого специалиста.' : 'Объект получен из Fastkore. Для работы с ним создайте отдельный диалог.');
      }).catch(e => { if (alive && current === sequence) { setErpContext(null); setContextNotice(e.message); } });
    };
    host.addEventListener('message', receive); host.postMessage({ type: 'fastkore.ready', version: 1 });
    return () => { alive = false; host.removeEventListener('message', receive); };
  }, [authSource, loggedIn, !!user]);
  useEffect(() => { const restored = (event: PageTransitionEvent) => { if (event.persisted && browserSession) location.reload(); }; window.addEventListener('pageshow', restored); return () => window.removeEventListener('pageshow', restored); }, []);
  function selectProject(id: string) { setProjectId(id); setChatId(''); setChat(null); setChats([]); setProjectOpen(false); }
  function selectChat(id: string) { setChatId(id); setChat(null); setSidebarOpen(false); stick.current = true; }
  useEffect(() => { localStorage.setItem('bridge-project', projectId); localStorage.setItem('bridge-chat', chatId); }, [projectId, chatId]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [state, list, allowedAgents] = await Promise.all([api<Status>('/api/status'), api<ProjectSummary[]>('/api/projects'), api<AgentSummary[]>('/api/agents')]);
        if (disposed) return; setStatus(state); setUser(state.user); setProjects(list); setAgents(allowedAgents); setNewAgent(old => allowedAgents.some(a => a.id === old && a.available) ? old : allowedAgents.find(a => a.available)?.id ?? '');
        if (!list.some(p => p.id === selected.current.projectId)) { setProjectId(list[0]?.id ?? ''); setChatId(''); setChat(null); setChats([]); }
        const p = selected.current.projectId;
        if (p && list.some(project => project.id === p)) {
          const conversations = await api<ChatSummary[]>(`/api/projects/${p}/chats`); if (disposed || selected.current.projectId !== p) return;
          setChats(conversations);
          if (!conversations.some(c => c.id === selected.current.chatId)) { setChat(null); setChatId(conversations[0]?.id ?? ''); }
          const c = selected.current.chatId;
          if (c && conversations.some(item => item.id === c)) {
            const detail = await api<Chat>(`/api/projects/${p}/chats/${c}`); if (!disposed && selected.current.projectId === p && selected.current.chatId === c) setChat(detail);
          }
        }
      } catch (e) { if (!disposed) fail(e); }
      finally { if (!disposed) timer = setTimeout(refresh, 1200); }
    }
    void refresh();
    if (user.role === 'admin') void post('/api/cli/check').catch(() => {});
    return () => { disposed = true; clearTimeout(timer); };
  }, [loggedIn, !!user, setupRequired]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || !projectId || !selectedProject) return;
    let disposed = false;
    api<ChatSummary[]>(`/api/projects/${projectId}/chats`).then(list => { if (!disposed) { setChats(list); if (!list.some(c => c.id === chatId)) setChatId(list[0]?.id ?? ''); } }).catch(fail);
    return () => { disposed = true; };
  }, [projectId, loggedIn, !!selectedProject]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || !projectId || !chatId || !selectedProject) return;
    let disposed = false;
    api<Chat>(`/api/projects/${projectId}/chats/${chatId}`).then(detail => { if (!disposed) setChat(detail); }).catch(fail);
    return () => { disposed = true; };
  }, [chatId, projectId, loggedIn, !!selectedProject]);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat?.messages.length, chat?.messages.at(-1)?.text, chatId]);
  useEffect(() => {
    if (!subscription || subscription.status !== 'running') return;
    const timer = setInterval(() => { api<Run>(`/api/runs/${subscription.id}`).then(setSubscription).catch(fail); }, 1200);
    return () => clearInterval(timer);
  }, [subscription?.id, subscription?.status]);
  async function loadModels(refresh = false) {
    setModelsLoading(true); setModelError('');
    try { setCatalog(await (refresh ? post<ModelCatalog>('/api/models/refresh') : api<ModelCatalog>('/api/models'))); }
    catch (e) { setModelError((e as Error).message); }
    finally { setModelsLoading(false); }
  }
  useEffect(() => { if (loggedIn && user && !setupRequired) void loadModels(); }, [loggedIn, !!user, setupRequired]);
  async function changeModel(model: string) {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}`, { method: 'PATCH', body: JSON.stringify({ model }) });
      if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated);
    });
  }
  useEffect(() => { if (!loggedIn || !user || setupRequired || panel) return; let alive = true; api<AgentSummary[]>('/api/agents').then(list => { if (alive) { setAgents(list); setNewAgent(old => list.some(a => a.id === old && a.available) ? old : list.find(a => a.available)?.id ?? ''); } }).catch(fail); return () => { alive = false; }; }, [loggedIn, !!user, setupRequired, user?.roleId, panel]);
  async function newChat(context?: ErpContext) { await action(async () => { const created = await post<Chat>(`/api/projects/${projectId}/chats`, { agentProfileId: newAgent, ...(context ? { title: `${context.entityType} ${context.entityId}`.slice(0, 120), erpContext: { entityType: context.entityType, entityId: context.entityId } } : {}) }); setChats(await api(`/api/projects/${projectId}/chats`)); selectChat(created.id); }); }
  async function send() {
    if (!draft.trim() || !projectId || !chatId || pending) return;
    const p = projectId, c = chatId;
    await action(async () => {
      const run = await post<Run>(`/api/projects/${p}/chats/${c}/messages`, { text: draft.trim(), attachmentIds: attachments.map(a => a.id), clientRequestId: requestId() });
      setDrafts(old => ({ ...old, [c]: '' })); setFiles(old => ({ ...old, [c]: [] }));
      setStatus(old => old ? { ...old, ...(run.status === 'queued' ? { queuedRuns: [...(old.queuedRuns ?? []), run] } : { activeRun: run }) } : old); stick.current = true;
    });
  }
  async function upload(list: FileList | null) {
    if (!list || !projectId || !chatId) return;
    const p = projectId, c = chatId;
    await action(async () => {
      if (attachments.length + list.length > 8) throw new Error('К вопросу можно прикрепить до 8 файлов.');
      for (const file of Array.from(list)) {
        if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер вложения — 20 МБ.');
        const form = new FormData(); form.append('file', file);
        const uploaded = await api<Attachment>(`/api/projects/${p}/attachments`, { method: 'POST', body: form });
        setFiles(old => ({ ...old, [c]: [...(old[c] ?? []), uploaded] }));
      }
    }); if (fileInput.current) fileInput.current.value = '';
  }
  async function copyItem(text: string, label: string) { try { await copy(text); setCopied(label); setTimeout(() => setCopied(''), 1800); } catch (e) { fail(e); } }
  async function showSettings() {
    setPanel('settings'); setCliPath(status?.settings.cliPath || status?.cli?.path || '');
    if (!loadingSettings.current) { loadingSettings.current = true; try { const log = await api<{ text: string }>('/api/diagnostics'); setDiagnostics(log.text); } catch (e) { fail(e); } finally { loadingSettings.current = false; } }
  }
  async function saveSettings(next: Partial<Settings>) { await action(async () => { const settings = await api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(next) }); setStatus(old => old ? { ...old, settings } : old); }); }

  if (checkingSession) return <div className="login-page"><main className="login-form"><p>Проверяем вход…</p></main></div>;
  if (!loggedIn) return <div className="login-page">
    <div className="login-art"><Brand /><div className="login-art-copy"><span className="eyebrow">ЛОКАЛЬНОЕ РАБОЧЕЕ ПРОСТРАНСТВО</span><h1>Ваши проекты.<br />Один разговор<br /><em>до результата.</em></h1><p>Codex работает с файлами на сервере.<br />Вы подключаетесь из любого браузера в сети.</p><div className="login-diagram"><Folder size={21} /><span /><Terminal size={21} /><span /><MessageSquare size={21} /></div></div><small>CODEX BRIDGE <span>WEB / 0.6</span></small></div>
    <main className="login-form"><div className="login-card"><div className="login-icon"><ShieldCheck size={26} /></div><span className="eyebrow">ДОСТУП К СЕРВЕРУ</span><h2>Продолжим работу</h2><p>Войдите под своей учётной записью.<br />Личные чаты доступны вам и руководителю.</p><form onSubmit={e => { e.preventDefault(); void login(); }}><label htmlFor="login-name">Логин</label><input id="login-name" autoComplete="username" value={loginInput} onChange={e => setLoginInput(e.target.value)} required /><label htmlFor="access-key">Пароль</label><input id="access-key" type="password" autoComplete="current-password" value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="Пароль вашей учётной записи" required /><button className="primary w-full" disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : <>Войти в рабочее пространство <ArrowUpRight size={17} /></>}</button></form>{['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && <><div className="login-divider"><span />или<span /></div><button className="secondary w-full" onClick={() => void login(true)} disabled={pending}><Terminal size={16} /> Первичная настройка руководителя</button><small>Доступна только на сервере, пока не задан пароль руководителя.</small></>}{error && <div role="alert" className="inline-error">{error}</div>}</div></main>
  </div>;

  if (loggedIn && !user) return <div className="login-page"><main className="login-form"><p>Проверяем учётную запись…</p></main></div>;
  if (setupRequired) return <div className="login-page"><main className="login-form"><div className="login-card"><Brand /><h2>Настройка руководителя</h2><p>Существующие проекты и чаты сохранены. Старые чаты будут доступны руководителям. Общий ключ больше не используется.</p><form onSubmit={e => { e.preventDefault(); void action(async () => { const result = await post<{ token: string; user: User }>('/api/auth/setup', { username: loginInput || 'admin', name: setupName, password: keyInput }); saveToken(result.token); setUser(result.user); setSetupRequired(false); setKeyInput(''); }); }}><label htmlFor="setup-login">Логин</label><input id="setup-login" autoComplete="username" minLength={3} maxLength={48} value={loginInput || 'admin'} onChange={e => setLoginInput(e.target.value)} required /><label htmlFor="setup-name">Имя</label><input id="setup-name" maxLength={100} value={setupName} onChange={e => setSetupName(e.target.value)} required /><label htmlFor="setup-password">Пароль · минимум 12 символов</label><input id="setup-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} value={keyInput} onChange={e => setKeyInput(e.target.value)} required /><button className="primary w-full" disabled={pending}>Сохранить и открыть проекты</button></form>{error && <div className="inline-error" role="alert">{error}</div>}</div></main></div>;

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Закрыть навигацию" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}><Brand /><div className="workspace-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <div className="project-select"><button className="project-trigger" onClick={() => setProjectOpen(!projectOpen)}><span className="folder-tile"><Folder size={18} /></span><span><b>{selectedProject?.name ?? 'Выберите проект'}</b><small>{projects.length} {projects.length === 1 ? 'проект' : 'проектов'} на сервере</small></span><ChevronDown size={15} /></button>
        {projectOpen && <div className="project-menu">{projects.map(p => <button key={p.id} onClick={() => selectProject(p.id)}><Folder size={15} /><span>{p.name}</span>{p.id === projectId && <Check size={15} />}</button>)}{isAdmin && <button onClick={() => { setPanel('project'); setProjectOpen(false); }}><FolderPlus size={15} /><span>Подключить папку</span></button>}</div>}
      </div>
      <div className="sidebar-agent"><label htmlFor="new-chat-agent">Специалист нового диалога</label><select id="new-chat-agent" value={newAgent} onChange={e => setNewAgent(e.target.value)}><option value="" disabled>Выберите специалиста</option>{agents.map(a => <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{!a.available ? ' · подготовка' : ''}</option>)}</select></div><button className="new-chat" onClick={() => void newChat()} disabled={!projectId || !newAgent || pending}><Plus size={18} /> Новый диалог <span>+</span></button>
      <div className="chat-heading"><span>ДИАЛОГИ</span><span>{chats.length.toString().padStart(2, '0')}</span></div>
      <nav className="chat-list" aria-label="Диалоги проекта">{chats.map(c => <button key={c.id} className={`chat-link ${chatId === c.id ? 'selected' : ''}`} onClick={() => selectChat(c.id)}><MessageSquare size={16} /><span>{c.title}<small className="chat-visibility">{c.visibility === 'project' ? 'Общий' : 'Личный'}{c.ownerId !== user?.id ? ` · ${c.ownerName}` : ''}</small></span>{active?.chatId === c.id && <LoaderCircle size={13} className="spin" />}</button>)}{chats.length === 0 && <p className="no-chats">Здесь появятся диалоги<br />выбранного проекта.</p>}</nav>
      <div className="sidebar-bottom">{isAdmin && <button onClick={() => setPanel('project')}><FolderPlus size={17} /> Подключить проект <Plus size={15} /></button>}<button onClick={() => setPanel('api')}><ShieldCheck size={17} /> {user?.name}<span className="role-caption">{isAdmin ? 'Руководитель' : 'Сотрудник'}</span></button><div className="server-card"><span className="live-dot" /><div><b>{status?.lan ? 'Сервер в локальной сети' : 'Локальный сервер'}</b><small>{status?.cli?.authentication === 'chatgpt' ? 'ChatGPT подключён' : 'Проверьте подключение Codex'}</small></div><Network size={16} /></div><div className="sidebar-foot"><span>WEB · 0.6.0</span><button onClick={logout} title="Выйти" aria-label="Выйти"><LogOut size={15} /></button></div></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)} aria-label="Открыть меню"><Menu size={20} /></button><span>Проекты</span><ChevronRight size={13} /><b>{selectedProject?.name ?? 'Рабочее пространство'}</b></div><div className="top-actions"><span className={`access-pill ${status?.settings.allowWrite ? 'write' : ''}`}><ShieldCheck size={13} />{status?.settings.allowWrite ? 'Запись разрешена' : 'Только чтение'}</span><button className="toolbar-button" aria-label="Доступ через API" onClick={() => setPanel('api')}><Code2 size={17} /><span>API</span></button>{isAdmin && <><button className="toolbar-button" aria-label="Сотрудники и доступ" onClick={() => setPanel('team')}><ShieldCheck size={17} /><span>Команда</span></button><button className="icon-button" onClick={() => void showSettings()} aria-label="Настройки"><Settings2 size={19} /></button></>}</div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={16} /></button></div>}
      {authSource !== 'fastkore' && chat?.erpContext && <div className="erp-context-bar"><b>Объект Fastkore этого диалога</b><p>{chat.erpContext.entityType} / {chat.erpContext.entityId}</p></div>}
      {authSource === 'fastkore' && <div className="erp-context-bar"><b>Fastkore · {user?.name}</b>{!user?.roleId && <p>Первый вход выполнен. Руководитель должен назначить вам роль и проекты.</p>}{chat?.erpContext && <p>Объект этого диалога: {chat.erpContext.entityType} / {chat.erpContext.entityId}</p>}{erpContext && <><p>Открыт в ERP: {erpContext.entityType} / {erpContext.entityId}</p><button className="secondary" disabled={!projectId || !newAgent || pending} onClick={() => void newChat(erpContext)}>Создать диалог по объекту</button></>}{contextNotice && <p role="status">{contextNotice}</p>}</div>}
      <div className="chat-topline"><div><span className="eyebrow">{selectedProject ? 'ДИАЛОГ С ПРОЕКТОМ' : 'НАЧАЛО РАБОТЫ'}</span><h2>{chat?.title ?? (selectedProject ? 'Новый диалог' : 'Ваше рабочее пространство')}</h2></div><span className="connection-pill"><span className="live-dot" /> {status?.cli?.authentication === 'chatgpt' ? 'Codex · ChatGPT' : 'Codex CLI'}</span></div>
      {chat && <div className="privacy-bar"><span><ShieldCheck size={14} /> {chat.visibility === 'project' ? 'Общий чат · виден участникам проекта' : 'Личный чат · доступен автору и руководителям'} · {chat.ownerName}</span>{isAdmin && <select aria-label="Видимость чата" value={chat.visibility ?? 'private'} disabled={pending} onChange={e => void action(async () => { const p = projectId, c = chatId; const updated = await api<Chat>(`/api/projects/${p}/chats/${c}/visibility`, { method: 'PATCH', body: JSON.stringify({ visibility: e.target.value }) }); if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated); setChats(await api(`/api/projects/${p}/chats`)); })}><option value="private">Личный</option><option value="project">Общий для проекта</option></select>}</div>}
      <div className="profile-caption">Специалист: {agents.find(a => a.id === (chat?.agentProfileId ?? newAgent))?.name ?? chat?.agentProfileId ?? 'не выбран'}</div><div className="model-bar"><div className="model-picker"><Terminal size={14} /><label htmlFor="chat-model">Модель диалога</label><select id="chat-model" aria-label="Модель диалога" value={chat?.model ?? ''} disabled={!chatId || !chat || !canEdit || busy || pending || modelsLoading} onChange={e => void changeModel(e.target.value)}><option value="">Как на сервере · {modelName(status?.settings.model)}</option>{chat?.model && !catalog?.models.some(m => m.id === chat.model) && <option value={chat.model}>{modelName(chat.model)}</option>}{catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><ChevronDown size={13} /></div><button className="model-refresh" aria-label="Обновить список моделей" title="Обновить список моделей" disabled={modelsLoading || pending} onClick={() => void loadModels(true)}>{modelsLoading ? <LoaderCircle size={13} className="spin" /> : <span>Обновить</span>}</button><span className="model-hint">История сохраняется при смене модели</span></div>{modelError && <div className="model-error" role="status">{modelError}</div>}
      <div ref={scroll} className="messages-scroll" onScroll={() => { const el = scroll.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        {(!chat || chat.messages.length === 0) ? <div className="empty-state"><div className="empty-mark"><Terminal size={31} strokeWidth={1.5} /><span /></div><span className="eyebrow">ФАЙЛЫ, КОНТЕКСТ И ИДЕИ — ВМЕСТЕ</span><h1>{selectedProject ? <>Что разберём<br />в этом проекте?</> : <>Начните с папки.<br />Продолжите вопросом.</>}</h1><p>{selectedProject ? 'Задайте вопрос о файлах, прикрепите документ или продолжите работу с Codex. История останется здесь.' : 'Подключите папку на сервере, чтобы обсуждать документы и работать с проектом из браузера.'}</p>{!projectId ? (isAdmin ? <button className="primary" onClick={() => setPanel('project')}><FolderPlus size={17} /> Подключить проект</button> : <p>Руководитель должен добавить вас в проект.</p>) : !chatId ? <button className="primary" onClick={() => void newChat()}><Plus size={17} /> Создать первый диалог</button> : <div className="suggestions">{[{ icon: FileText, title: 'Разобраться в документах', text: 'Перечисли доступные Excel-файлы и кратко опиши их содержимое' }, { icon: Folder, title: 'Изучить проект', text: 'Изучи файлы проекта и объясни, с чего начать' }].map(item => <button key={item.title} onClick={() => { setDrafts(old => ({ ...old, [chatId]: item.text })); input.current?.focus(); }}><item.icon size={19} /><b>{item.title}</b><span>{item.text}</span><ArrowUpRight size={16} /></button>)}</div>}</div> : <div className="messages-inner">{chat.messages.map(message => <article key={message.id} className={`message message-${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <Terminal size={17} /> : <MessageSquare size={17} />}</div><div className="message-content"><div className="message-meta"><b>{message.role === 'assistant' ? 'Codex' : message.authorId === user?.id ? 'Вы' : message.authorName ?? chat.ownerName ?? 'Пользователь'}</b>{message.role === 'assistant' && message.model && <span className="message-model">{modelName(message.model)}</span>}<span>{new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><button className="icon-button" title="Копировать сообщение" onClick={() => void copyItem(message.text, message.id)}>{copied === message.id ? <Check size={13} /> : <Copy size={13} />}</button></div><div className={message.role === 'assistant' ? 'markdown' : 'user-text'}>{message.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[Изображение: {alt}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{message.text || (message.status === 'running' ? 'Работаю над вопросом…' : 'Ответ не получен.')}</ReactMarkdown> : message.text}</div>{message.attachments.length > 0 && <div className="message-files">{message.attachments.map(a => <span key={a.id}><FileText size={13} />{a.name}</span>)}</div>}{['error', 'cancelled', 'interrupted'].includes(message.status) && <div className="message-note">{message.status === 'error' ? 'Задание завершилось с ошибкой' : message.status === 'cancelled' ? 'Остановлено пользователем' : 'Прервано остановкой сервера'}</div>}{message.usage && <div className="token-count">Токены: вход {message.usage.inputTokens.toLocaleString('ru-RU')} · выход {message.usage.outputTokens.toLocaleString('ru-RU')}</div>}</div></article>)}<div ref={end} /></div>}
      </div>
      <div className="composer-wrap">{status?.executionDisabled && <p className="shared-readonly">Выполнение заданий выключено до проверки среды. Настройки и история доступны.</p>}{(status?.queuedRuns ?? []).filter(r => r.chatId === chatId).map(r => <div className="run-progress" key={r.id}><LoaderCircle size={14} className="spin" /><span>Вопрос в очереди</span><button onClick={() => void action(async () => { await post(`/api/runs/${r.id}/cancel`); })}>Отменить</button></div>)}{busy && !active && <div className="run-progress"><LoaderCircle size={14} className="spin" /><span>Сервер занят. Новый вопрос можно отправить в очередь.</span></div>}{chat && !canEdit && !status?.executionDisabled && <p className="shared-readonly">Общий чат доступен для чтения. Для своего вопроса создайте новый диалог.</p>}{active && <div className="run-progress"><LoaderCircle size={14} className="spin" /><span>{active.progress}{active.chatId && active.chatId !== chatId ? ' · в другом диалоге' : ''}</span>{(isAdmin || (active.chatId === chatId && canEdit)) && <button onClick={() => void action(async () => { await post(`/api/runs/${active.id}/cancel`); })}><Square size={11} /> Остановить</button>}</div>}<div className="composer"><div className="attachment-chips">{attachments.map(a => <span key={a.id}><FileText size={14} />{a.name}<button aria-label={`Убрать ${a.name}`} onClick={() => setFiles(old => ({ ...old, [chatId]: attachments.filter(item => item.id !== a.id) }))}><X size={13} /></button></span>)}</div><textarea ref={input} rows={2} value={draft} onChange={e => setDrafts(old => ({ ...old, [chatId]: e.target.value }))} placeholder={chatId ? 'Задайте вопрос о проекте…' : 'Выберите проект и создайте диалог'} disabled={!chatId || !canEdit} aria-label="Сообщение Codex" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div><input type="file" multiple ref={fileInput} className="hidden" onChange={e => void upload(e.target.files)} /><button className="attach-button" onClick={() => fileInput.current?.click()} disabled={!chatId || !canEdit || pending}><Paperclip size={17} /><span>Прикрепить файл</span></button><span className="composer-divider" /><span className="workspace-label"><Folder size={13} />{selectedProject?.name ?? 'Папка не выбрана'}</span></div><button className="send-button" aria-label="Отправить вопрос" onClick={() => void send()} disabled={!chatId || !canEdit || !draft.trim() || pending}>{pending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}</button></div></div><div className="composer-foot"><span><ShieldCheck size={11} /> {status?.settings.includePreviews ? 'Выдержки документов передаются Codex' : 'Используется контекст сессии Codex'}</span><span>Ctrl + Enter <span className="foot-dash">— отправить</span></span></div></div>
    </main>
    {panel && <div className="panel-overlay" onClick={() => setPanel(null)}><section className={`side-panel ${panel === 'project' ? 'project-panel' : ''}`} role="dialog" aria-modal="true" aria-label={panel === 'settings' ? 'Настройки' : panel === 'api' ? 'Моя учётная запись и API' : panel === 'team' ? 'Сотрудники и доступ' : 'Подключить проект'} onClick={e => e.stopPropagation()}><header><div><span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2>{panel === 'settings' ? 'Настройки сервера' : panel === 'api' ? 'Моя учётная запись и API' : panel === 'team' ? 'Сотрудники и доступ' : 'Подключить проект'}</h2></div><button className="icon-button" aria-label="Закрыть панель" onClick={() => setPanel(null)}><X size={21} /></button></header><div className="panel-body">
      {error && <div className="inline-error" role="alert">{error}</div>}
      {panel === 'team' && isAdmin && user && <TeamPanel request={api} projectId={projectId} projectName={selectedProject?.name ?? ''} self={user} />}
      {panel === 'project' && isAdmin && <form onSubmit={e => { e.preventDefault(); void action(async () => { const p = await post<ProjectSummary>('/api/projects', { directory: folderPath.trim(), ...(projectName.trim() ? { name: projectName.trim() } : {}) }); setProjects(await api('/api/projects')); selectProject(p.id); setPanel(null); setFolderPath(''); setProjectName(''); }); }}><div className="panel-callout"><Folder size={22} /><p>Укажите папку <b>на серверном компьютере</b>. Если вы открыли страницу с другого устройства, файлы всё равно читает сервер.</p></div><label htmlFor="directory">Полный путь к папке</label><input id="directory" value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder="C:\Проекты\Финансы" required autoFocus /><label htmlFor="project-name">Название проекта <span>необязательно</span></label><input id="project-name" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Например, финансовые отчёты" /><p className="help">Существующие файлы и AGENTS.md сохранятся. Загруженные вложения будут размещаться в подпапке .bridge.</p><button className="primary w-full" disabled={pending}><FolderPlus size={17} /> Подключить папку</button></form>}
      {panel === 'settings' && isAdmin && <>{projects.length === 0 && <div className="setting-section"><h3><FolderPlus size={17} /> История настольной версии</h3><p>Можно перенести проекты и диалоги прежнего приложения с этого серверного компьютера. Импорт доступен, пока веб-пространство пустое.</p><button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => { await post('/api/migrations/desktop'); setProjects(await api('/api/projects')); setStatus(await api('/api/status')); setPanel(null); })}>Перенести проекты и историю</button></div>}<div className="setting-section"><h3><Network size={17} /> Сервер и локальная сеть</h3><p>Веб-интерфейс и API доступны по одному адресу.</p>{status?.addresses.map(url => <button key={url} className="copy-row" onClick={() => void copyItem(url, url)}><code>{url}</code>{copied === url ? <Check size={14} /> : <Copy size={14} />}</button>)}<p className="help">{status?.lan ? 'Для доступа с других компьютеров разрешите выбранный порт в брандмауэре Windows для частной сети.' : 'Для доступа из локальной сети запустите сервер через START-LAN.cmd.'}</p></div><div className="setting-section"><h3><Terminal size={17} /> Подключение Codex</h3><div className="auth-box"><span className={`live-dot ${status?.cli?.authentication !== 'chatgpt' ? 'amber' : ''}`} /><div><b>{status?.cli?.authentication === 'chatgpt' ? 'Вход через ChatGPT' : status?.cli?.authentication === 'api-key' ? 'API-ключ · запросы заблокированы' : 'Нужно проверить подключение'}</b><small>{status?.cli?.version ?? 'Codex CLI не проверен'}</small></div></div><label htmlFor="cli-path">Путь к codex.exe</label><input id="cli-path" value={cliPath} onChange={e => setCliPath(e.target.value)} placeholder="Автоопределение" disabled={busy} /><div className="button-pair"><button className="secondary" disabled={pending || busy} onClick={() => void saveSettings({ cliPath: cliPath.trim() })}>Сохранить</button><button className="secondary" disabled={pending || busy} onClick={() => void action(async () => { await post('/api/cli/check'); setStatus(await api('/api/status')); })}>Проверить</button></div><button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => { const run = await post<Run>('/api/subscription/check'); setSubscription(run); setStatus(old => old ? { ...old, activeRun: run } : old); })}>Проверить подписку</button>{subscription && <p className="help">{subscription.error ?? subscription.response ?? subscription.progress}</p>}<p className="help">Используется аккаунт серверного пользователя Windows. Тест отправляет короткий запрос и расходует его лимиты.</p></div><div className="setting-section"><h3><Terminal size={17} /> Модель по умолчанию</h3><p>Используется в диалогах с выбором «Как на сервере» и для проверки подписки.</p><label htmlFor="server-model">Модель сервера</label><select id="server-model" className="settings-select" aria-label="Модель сервера" value={status?.settings.model ?? ''} disabled={busy || pending || modelsLoading} onChange={e => void saveSettings({ model: e.target.value })}><option value="">Автовыбор Codex</option>{status?.settings.model && !catalog?.models.some(m => m.id === status.settings.model) && <option value={status.settings.model}>{modelName(status.settings.model)}</option>}{catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><button className="secondary w-full" disabled={modelsLoading} onClick={() => void loadModels(true)}>{modelsLoading ? 'Загрузка…' : 'Обновить список моделей'}</button>{modelError && <p className="help">{modelError}</p>}<p className="help">Каталог получен из Codex. Если модель недоступна аккаунту, запрос покажет ошибку — автоматической подмены не будет.</p></div><div className="setting-section"><h3><ShieldCheck size={17} /> Работа с файлами</h3><Toggle checked={status?.settings.allowWrite ?? false} disabled={busy || pending} title="Разрешить запись в проект" description="По умолчанию Codex только читает файлы." onChange={value => void saveSettings({ allowWrite: value })} /><Toggle checked={status?.settings.includePreviews ?? true} disabled={busy || pending} title="Выдержки документов" description="Добавлять в запрос содержимое Excel, CSV и PDF в ограниченном объёме." onChange={value => void saveSettings({ includePreviews: value })} /></div><div className="setting-section"><h3>Диагностика</h3><pre className="diagnostics">{diagnostics || 'Диагностических событий пока нет.'}</pre>{status?.storageWarning && <p className="help">{status.storageWarning}</p>}</div></>}
      {panel === 'api' && <><AccountPanel request={api} copy={copy} renewed={saveToken} fastkore={authSource === 'fastkore'} /><div className="panel-callout"><Code2 size={23} /><p>Используйте те же проекты и диалоги из любой системы. Ответы сохраняются и появляются в веб-чате.</p></div><label>Базовый адрес</label><button className="copy-row" onClick={() => void copyItem(location.origin, 'base')}><code>{location.origin}</code>{copied === 'base' ? <Check size={14} /> : <Copy size={14} />}</button><label>Авторизация</label><pre className="api-code">Authorization: Bearer &lt;ключ доступа&gt;</pre><h3 className="mt-7">Основные запросы</h3><div className="endpoints">{[['GET', '/api/models', 'Каталог моделей'], ['GET', '/api/projects', 'Список проектов'], ['GET', '/api/projects/{projectId}/chats', 'Диалоги проекта'], ['POST', '/api/projects/{projectId}/chats', 'Создать диалог'], ['GET', '/api/projects/{projectId}/chats/{chatId}', 'История диалога'], ['POST', '/api/projects/{projectId}/chats/{chatId}/messages', 'Отправить вопрос'], ['GET', '/api/runs/{runId}', 'Состояние и ответ'], ['POST', '/api/runs/{runId}/cancel', 'Остановить задание']].map(([method, url, desc]) => <div key={method + url}><span className={`method ${method === 'POST' ? 'post' : ''}`}>{method}</span><b>{desc}</b><code>{url}</code></div>)}</div><label>Тело запроса с вопросом</label><pre className="api-code">{'{\n  "text": "Изучи файлы проекта",\n  "clientRequestId": "question-001"\n}'}</pre><p className="help">Сервер вернёт 202 и ID задания. Проверяйте /api/runs/ID до статуса complete, error или cancelled. Готовый текст — в поле response. Задания выполняются по очереди. Статус queued означает ожидание; повтор clientRequestId с другим содержимым возвращает 409.</p>{selectedProject && <><label>ID выбранного проекта</label><button className="copy-row" onClick={() => void copyItem(projectId, 'pid')}><code>{projectId}</code>{copied === 'pid' ? <Check size={14} /> : <Copy size={14} />}</button></>}{chatId && <><label>ID выбранного диалога</label><button className="copy-row" onClick={() => void copyItem(chatId, 'cid')}><code>{chatId}</code>{copied === 'cid' ? <Check size={14} /> : <Copy size={14} />}</button></>}</>}
    </div></section></div>}
  </div>;
}
function Brand() { return <div className="brand"><div className="brand-mark"><Terminal size={21} strokeWidth={2} /></div><span>codex<span>bridge</span></span><small>WEB</small></div>; }
function Toggle({ checked, disabled, title, description, onChange }: { checked: boolean; disabled: boolean; title: string; description: string; onChange: (value: boolean) => void }) { return <label className="toggle-row"><span><b>{title}</b><small>{description}</small></span><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="toggle" /></label>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
