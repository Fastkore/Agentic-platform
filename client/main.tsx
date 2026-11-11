import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, Copy, FileText, Folder, LoaderCircle, LockKeyhole, LogOut, Menu, Moon, Network, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, SquarePen, Sun, Terminal, Users, X } from 'lucide-react';
import type { AgentSummary, Attachment, Chat, ChatSummary, CodexLimits, ErpContext, ModelCatalog, ProjectSummary, Run, Settings, Status, User } from '../shared/types';
import './style.css';
import './workspace.css';
import { AccountPanel, TeamPanel } from './AccessPanel';
import { parseHostContext, parseHostTheme, webViewHost, type Theme } from './fastkore';
import { Select } from './Select';

let accessKey = sessionStorage.getItem('bridge-key') ?? '';
let browserSession = false, csrfToken = '', sessionUserId = '', authEpoch = 0;
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const epoch = authEpoch;
  const headers = new Headers(init.headers);
  if (browserSession && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('X-Bridge-CSRF', csrfToken);
  if (!browserSession && accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const result = await response.json();
  if (epoch !== authEpoch) throw new DOMException('Сеанс изменился.', 'AbortError');
  if (!response.ok) throw new ApiError(result.error ?? 'Не удалось выполнить запрос.', response.status);
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
  const [embedded] = useState(() => new URLSearchParams(location.search).get('embedded') === 'fastkore');
  const [browserTheme, setBrowserTheme] = useState<Theme>(() => localStorage.getItem('bridge-theme') === 'light' ? 'light' : 'dark');
  const [initialErpTheme] = useState<Theme>(() => new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
  const [erpTheme, setErpTheme] = useState<{ theme: Theme } | null>(null);
  const [loggedIn, setLoggedIn] = useState(false), [keyInput, setKeyInput] = useState(''), [loginInput, setLoginInput] = useState('');
  const [checkingSession, setCheckingSession] = useState(true), [authSource, setAuthSource] = useState<'local' | 'fastkore'>('local');
  const [erpContext, setErpContext] = useState<ErpContext | null>(null), [contextNotice, setContextNotice] = useState('');
  const [user, setUser] = useState<User | null>(null), [setupRequired, setSetupRequired] = useState(false), [setupName, setSetupName] = useState('Руководитель');
  const [status, setStatus] = useState<Status | null>(null), [projects, setProjects] = useState<ProjectSummary[]>([]), [chat, setChat] = useState<Chat | null>(null);
  const [chatLists, setChatLists] = useState<Record<string, ChatSummary[]>>({});
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [projectId, setProjectId] = useState(localStorage.getItem('bridge-project') ?? ''), [chatId, setChatId] = useState(localStorage.getItem('bridge-chat') ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [panel, setPanel] = useState<'settings' | 'project' | 'search' | null>(null);
  const [settingsSection, setSettingsSection] = useState<'account' | 'team' | 'server'>('account');
  const [sidebarOpen, setSidebarOpen] = useState(false), [searchQuery, setSearchQuery] = useState(''), [searchLoading, setSearchLoading] = useState(false);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [copied, setCopied] = useState(''), [folderPath, setFolderPath] = useState(''), [projectName, setProjectName] = useState('');
  const [agents, setAgents] = useState<AgentSummary[]>([]), [newAgent, setNewAgent] = useState('universal');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null), [modelsLoading, setModelsLoading] = useState(false), [modelError, setModelError] = useState('');
  const [cliPath, setCliPath] = useState(''), [diagnostics, setDiagnostics] = useState(''), [subscription, setSubscription] = useState<Run | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true), loadingSettings = useRef(false);
  const selectedProject = projects.find(p => p.id === projectId), draft = drafts[chatId] ?? '', attachments = files[chatId] ?? [];
  const active = status?.activeRun, busy = status?.busy ?? !!active;
  const isAdmin = user?.role === 'admin', canEdit = !status?.executionDisabled && (isAdmin || (!!chat && chat.ownerId === user?.id));
  const canCreateProject = isAdmin || status?.canCreateProject === true;
  const inFastkore = embedded || (authSource === 'fastkore' && !!webViewHost());
  const theme = inFastkore ? erpTheme?.theme ?? initialErpTheme : browserTheme;
  const modelName = (id?: string) => id ? (catalog?.models.find(m => m.id === id)?.name ?? id) : 'Автовыбор Codex';
  const selected = useRef({ projectId, chatId }); selected.current = { projectId, chatId };
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setBrowserTheme(next);
    localStorage.setItem('bridge-theme', next);
  }
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f2f4f7' : '#171717');
  }, [theme]);
  const fail = (e: unknown) => {
    const err = e as Error;
    if (err.name === 'AbortError') return;
    setError(err.message);
    if (e instanceof ApiError && e.status === 401) {
      if (inFastkore) webViewHost()?.postMessage({ type: 'fastkore.sso.required', version: 1, reason: 'session_expired' });
      clearLogin();
    }
  };
  async function action(work: () => Promise<void>) { setPending(true); setError(''); try { await work(); } catch (e) { fail(e); } finally { setPending(false); } }
  function saveToken(token: string) { accessKey = token; sessionStorage.setItem('bridge-key', token); }
  function clearLogin() { authEpoch++; browserSession = false; csrfToken = ''; sessionUserId = ''; setErpContext(null); setContextNotice(''); setAgents([]); setCatalog(null); setModelError(''); accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat'); setLoggedIn(false); setUser(null); setStatus(null); setProjects([]); setChatLists({}); setOpenProjects({}); setShowAll({}); setSidebarOpen(false); setChat(null); setDrafts({}); setFiles({}); setSubscription(null); setPanel(null); setProjectId(''); setChatId(''); setDiagnostics(''); setKeyInput(''); }
  function logout() { void action(async () => { await post('/api/auth/logout'); clearLogin(); }); }
  useEffect(() => {
    let alive = true;
    void fetch('/api/auth/browser-session', { credentials: 'same-origin' }).then(async response => {
      const value = await response.json();
      if (!alive) return;
      if (!response.ok) { clearLogin(); throw new Error('Сеанс Fastkore завершён. Откройте помощника из ERP заново.'); }
      if (value.authenticated) {
        authEpoch++;
        accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat');
        browserSession = true; csrfToken = value.csrfToken; sessionUserId = value.user.id;
        setProjectId(''); setChatId(''); setAuthSource('fastkore'); setUser(value.user); setSetupRequired(false); setLoggedIn(true);
      } else if (!embedded) setLoggedIn(!!accessKey);
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
    const host = inFastkore ? webViewHost() : undefined;
    if (!host) return;
    const receive = (event: { data: unknown }) => {
      const nextTheme = parseHostTheme(event.data);
      if (nextTheme) setErpTheme({ theme: nextTheme });
    };
    host.addEventListener('message', receive);
    return () => host.removeEventListener('message', receive);
  }, [inFastkore]);
  useEffect(() => {
    if (inFastkore && erpTheme) webViewHost()?.postMessage({ type: 'fastkore.ui.applied', version: 1, theme: erpTheme.theme });
  }, [inFastkore, erpTheme]);
  useEffect(() => {
    const host = authSource === 'fastkore' && loggedIn && user ? webViewHost() : undefined;
    if (!host) return;
    let alive = true, sequence = 0;
    const receive = (event: { data: unknown }) => {
      const message = parseHostContext(event.data);
      if (!message || embedded) return;
      const current = ++sequence;
      void post<{ context: ErpContext; suggestedAgent?: string; suggestionUnavailable: boolean }>('/api/fastkore/context/validate', { entityType: message.entityType, entityId: message.entityId, ...(message.suggestedAgent ? { suggestedAgent: message.suggestedAgent } : {}) }).then(result => {
        if (!alive || current !== sequence) return;
        setErpContext(result.context);
        if (result.suggestedAgent) setNewAgent(result.suggestedAgent);
        setContextNotice(result.suggestionUnavailable ? 'Предложенный специалист недоступен' : '');
      }).catch(e => { if (alive && current === sequence) { setErpContext(null); setContextNotice(e.message); } });
    };
    host.addEventListener('message', receive); host.postMessage({ type: 'fastkore.ready', version: 1 });
    return () => { alive = false; host.removeEventListener('message', receive); };
  }, [authSource, loggedIn, !!user, embedded]);
  useEffect(() => { const restored = (event: PageTransitionEvent) => { if (event.persisted && browserSession) location.reload(); }; window.addEventListener('pageshow', restored); return () => window.removeEventListener('pageshow', restored); }, []);
  function navigateTo(project: string, conversation = '') {
    if (selected.current.projectId !== project || selected.current.chatId !== conversation) {
      selected.current = { projectId: project, chatId: conversation };
      setProjectId(project);
      setChatId(conversation);
      setChat(null);
    }
    if (project) setOpenProjects(old => ({ ...old, [project]: true }));
    setSidebarOpen(false);
    stick.current = true;
  }
  async function loadChats(project: string) {
    const credential = accessKey;
    const list = await api<ChatSummary[]>(`/api/projects/${project}/chats`);
    if (credential === accessKey) setChatLists(old => ({ ...old, [project]: list }));
    return list;
  }
  function toggleProject(project: string) {
    const open = openProjects[project] ?? project === projectId;
    setOpenProjects(old => ({ ...old, [project]: !open }));
    if (!open) void loadChats(project).catch(fail);
  }
  function openSearch() {
    setSearchQuery('');
    setPanel('search');
    setSearchLoading(true);
    void Promise.all(projects.map(project => loadChats(project.id)))
      .catch(fail)
      .finally(() => setSearchLoading(false));
  }
  useEffect(() => {
    if (authSource === 'local' && !embedded && loggedIn) {
      localStorage.setItem('bridge-project', projectId);
      localStorage.setItem('bridge-chat', chatId);
    }
  }, [projectId, chatId, loggedIn, authSource, embedded]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const projectAtStart = selected.current.projectId;
        const [state, list, allowedAgents] = await Promise.all([api<Status>('/api/status'), api<ProjectSummary[]>('/api/projects'), api<AgentSummary[]>('/api/agents')]);
        if (disposed) return;
        setStatus(state); setUser(state.user); setAgents(allowedAgents); setNewAgent(old => allowedAgents.some(a => a.id === old && a.available) ? old : allowedAgents.find(a => a.available)?.id ?? '');
        const activeProjectExists = list.some(p => p.id === selected.current.projectId);
        if (activeProjectExists || projectAtStart === selected.current.projectId) setProjects(list);
        if (!activeProjectExists && projectAtStart === selected.current.projectId && (projectAtStart || list.length)) navigateTo(list[0]?.id ?? '');
        const p = selected.current.projectId;
        const previousChat = selected.current.chatId;
        if (p && list.some(project => project.id === p)) {
          const conversations = await api<ChatSummary[]>(`/api/projects/${p}/chats`); if (disposed || selected.current.projectId !== p) return;
          if (selected.current.chatId !== previousChat) return;
          setChatLists(old => ({ ...old, [p]: conversations }));
          if ((previousChat || conversations.length) && !conversations.some(c => c.id === previousChat)) navigateTo(p, conversations[0]?.id ?? '');
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
    const previousChat = selected.current.chatId;
    loadChats(projectId).then(list => {
      if (!disposed && selected.current.projectId === projectId && selected.current.chatId === previousChat &&
        (previousChat || list.length) && !list.some(c => c.id === previousChat)) {
        navigateTo(projectId, list[0]?.id ?? '');
      }
    }).catch(e => { if (!disposed) fail(e); });
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
  async function newChat(project = projectId, context?: ErpContext) {
    if (!project) { if (canCreateProject) setPanel('project'); return; }
    if (!newAgent || pending) return;
    await action(async () => {
      const created = await post<Chat>(`/api/projects/${project}/chats`, {
        agentProfileId: newAgent,
        ...(context ? { title: (context.entityType + ' ' + context.entityId).slice(0, 120), erpContext: { entityType: context.entityType, entityId: context.entityId } } : {}),
      });
      navigateTo(project, created.id);
      setChat(created);
      await loadChats(project);
      input.current?.focus();
    });
  }
  async function changeVisibility(visibility: 'private' | 'project') {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}/visibility`, { method: 'PATCH', body: JSON.stringify({ visibility }) });
      if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated);
      await loadChats(p);
    });
  }
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
  function showSettings() {
    if (accountMenu.current) accountMenu.current.open = false;
    setSidebarOpen(false);
    setSettingsSection('account');
    setPanel('settings');
  }
  async function showServerSettings() {
    setSettingsSection('server');
    setCliPath(status?.settings.cliPath || status?.cli?.path || '');
    if (!loadingSettings.current) { loadingSettings.current = true; try { const log = await api<{ text: string }>('/api/diagnostics'); setDiagnostics(log.text); } catch (e) { fail(e); } finally { loadingSettings.current = false; } }
  }
  async function saveSettings(next: Partial<Settings>) { await action(async () => { const settings = await api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(next) }); setStatus(old => old ? { ...old, settings } : old); }); }

  const themeButton = !inFastkore && <button className="workspace-icon theme-toggle" onClick={toggleTheme}
    aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
    title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>;
  if (checkingSession) return <div className="bridge-signin" data-theme={theme} role="status"><LoaderCircle className="spin" size={24} /></div>;
  if (!loggedIn && inFastkore) return <div className="bridge-signin" data-theme={theme}><main className="login-card">
    <h1>Вход через Fastkore</h1>
    <p role="status">Откройте помощника из ERP.</p>
  </main></div>;
  if (!loggedIn) return <div className="bridge-signin" data-theme={theme}>{themeButton}<main className="login-card">
    <h1>Agentic Platform</h1>
    <form onSubmit={e => { e.preventDefault(); void login(); }}>
      <label htmlFor="login-name">Логин</label><input id="login-name" autoComplete="username" value={loginInput} onChange={e => setLoginInput(e.target.value)} required />
      <label htmlFor="access-key">Пароль</label><input id="access-key" type="password" autoComplete="current-password" value={keyInput} onChange={e => setKeyInput(e.target.value)} required />
      <button className="primary w-full" disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : 'Войти'}</button>
    </form>
    {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && <button className="secondary w-full local-setup" onClick={() => void login(true)} disabled={pending}>Первичная настройка руководителя</button>}
    {error && <div role="alert" className="inline-error">{error}</div>}
  </main></div>;

  if (!user) return <div className="bridge-signin" data-theme={theme} role="status"><LoaderCircle className="spin" size={24} /></div>;
  if (setupRequired) return <div className="bridge-signin" data-theme={theme}>{themeButton}<main className="login-card">
    <h1>Настройка руководителя</h1>
    <form onSubmit={e => { e.preventDefault(); void action(async () => {
      const result = await post<{ token: string; user: User }>('/api/auth/setup', { username: loginInput || 'admin', name: setupName, password: keyInput });
      saveToken(result.token); setUser(result.user); setSetupRequired(false); setKeyInput('');
    }); }}>
      <label htmlFor="setup-login">Логин</label><input id="setup-login" autoComplete="username" minLength={3} maxLength={48} value={loginInput || 'admin'} onChange={e => setLoginInput(e.target.value)} required />
      <label htmlFor="setup-name">Имя</label><input id="setup-name" maxLength={100} value={setupName} onChange={e => setSetupName(e.target.value)} required />
      <label htmlFor="setup-password">Пароль от 12 символов</label><input id="setup-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} value={keyInput} onChange={e => setKeyInput(e.target.value)} required />
      <button className="primary w-full" disabled={pending}>Сохранить</button>
    </form>
    {error && <div className="inline-error" role="alert">{error}</div>}
  </main></div>;

  const hasMessages = !!chat?.messages.length;
  const query = searchQuery.trim().toLocaleLowerCase('ru-RU');
  const searchable = projects.flatMap(project => {
    const matchesProject = project.name.toLocaleLowerCase('ru-RU').includes(query);
    const matchingChats = (chatLists[project.id] ?? []).filter(item => matchesProject || item.title.toLocaleLowerCase('ru-RU').includes(query));
    return matchesProject || matchingChats.length ? [{ project, matchingChats }] : [];
  });
  const editable = !!chat && canEdit;
  const canCreate = !!selectedProject && !!newAgent && !pending;
  const currentAgent = agents.find(agent => agent.id === chat?.agentProfileId);
  const writeMode = !!status?.settings.allowWrite && !!currentAgent?.allowWrite;
  const catalogOptions = catalog?.models.map(model => ({ value: model.id, label: model.name })) ?? [];
  const chatModel = currentAgent?.model ? '' : chat?.model ?? '';
  const defaultChatModel = modelName(currentAgent?.model || status?.settings.model || catalog?.models.find(model => model.isDefault)?.id);
  const chatModels = [
    { value: '', label: defaultChatModel + (catalog && !currentAgent?.model ? ' · авто' : '') },
    ...(chatModel && !catalogOptions.some(model => model.value === chatModel) ? [{ value: chatModel, label: modelName(chatModel) }] : []),
    ...catalogOptions,
  ];
  const serverModel = status?.settings.model ?? '';
  const serverModels = [
    { value: '', label: 'Автовыбор Codex' },
    ...(serverModel && !catalogOptions.some(model => model.value === serverModel) ? [{ value: serverModel, label: modelName(serverModel) }] : []),
    ...catalogOptions,
  ];
  const closePanel = () => setPanel(null);
  const composer = <div className="bridge-composer">
    {status?.executionDisabled && <p className="composer-status" role="status">Выполнение задач отключено</p>}
    {chat && !canEdit && !status?.executionDisabled && <p className="composer-status">Чат доступен для чтения</p>}
    {(status?.queuedRuns ?? []).filter(run => run.chatId === chatId).map(run => <div className="bridge-progress" key={run.id}>
      <LoaderCircle size={14} className="spin" /><span>В очереди</span>
      <button onClick={() => void action(async () => { await post('/api/runs/' + run.id + '/cancel'); })}>Отменить</button>
    </div>)}
    {active && (active.chatId === chatId || isAdmin) && <div className="bridge-progress" role="status">
      <LoaderCircle size={14} className="spin" /><span>{active.progress}</span>
      {(isAdmin || (active.chatId === chatId && canEdit)) && <button onClick={() => void action(async () => { await post('/api/runs/' + active.id + '/cancel'); })}><Square size={12} />Остановить</button>}
    </div>}
    {!hasMessages && <div className="composer-project">
      <Folder size={17} />
      <Select label="Проект" placeholder="Выберите проект" value={projectId} onChange={navigateTo} disabled={pending}
        options={projects.map(project => ({ value: project.id, label: project.name }))} />
      {canCreateProject && <button type="button" className="workspace-icon" title="Новый проект" aria-label="Новый проект" onClick={() => setPanel('project')}><Plus size={17} /></button>}
    </div>}
    <div className="bridge-editor">
      {attachments.length > 0 && <div className="attachment-chips">{attachments.map(attachment => <span key={attachment.id}>
        <FileText size={14} />{attachment.name}<button aria-label={'Убрать ' + attachment.name} onClick={() => setFiles(old => ({ ...old, [chatId]: (old[chatId] ?? []).filter(item => item.id !== attachment.id) }))}><X size={13} /></button>
      </span>)}</div>}
      <textarea ref={input} rows={2} value={draft} onChange={e => setDrafts(old => ({ ...old, [chatId]: e.target.value }))}
        placeholder={chatId ? (hasMessages ? 'Продолжить разговор…' : 'Напишите сообщение…') : 'Выберите проект и создайте чат'}
        disabled={!editable} aria-label="Сообщение Codex"
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <div className="bridge-editor-controls">
        <input type="file" multiple ref={fileInput} onChange={e => void upload(e.target.files)} />
        <button className="workspace-icon" title="Прикрепить файл" aria-label="Прикрепить файл" onClick={() => fileInput.current?.click()} disabled={!editable || pending}><Plus size={19} /></button>
        <span className={'access-mode' + (writeMode ? ' write' : '')} title={currentAgent?.name}><ShieldCheck size={16} />{writeMode ? 'Запись разрешена' : 'Только чтение'}</span>
        <div className="composer-actions">
          <LimitsButton request={api} />
          <div className="editor-model">
            <Select label="Модель диалога" value={chatModel} options={chatModels}
              disabled={!!currentAgent?.model || !chat || !(isAdmin || chat.ownerId === user.id) || busy || pending || modelsLoading || (!catalog && !chat.model)}
              onChange={model => void changeModel(model)} title={modelError || undefined} />
          </div>
          <button className="bridge-send" aria-label="Отправить вопрос" title="Отправить · Ctrl+Enter" onClick={() => void send()} disabled={!editable || !draft.trim() || pending}><ArrowUp size={18} /></button>
        </div>
      </div>
    </div>
    {!chatId && canCreate && <button className="empty-new-chat" onClick={() => void newChat()}><SquarePen size={15} />Создать чат</button>}
  </div>;

  return <div className="workspace-shell" data-theme={theme}>
    {sidebarOpen && <button className="workspace-scrim" aria-label="Закрыть навигацию" onClick={() => setSidebarOpen(false)} />}
    <aside className={'workspace-sidebar' + (sidebarOpen ? ' is-open' : '')} aria-label="Боковая панель">
      <div className="workspace-brand"><span className="workspace-mark"><Terminal size={16} /></span><b>Agentic Platform</b></div>
      <div className="workspace-start">
        <button className="workspace-row new-conversation" onClick={() => void newChat()} disabled={pending || (projectId ? !newAgent : !canCreateProject)}><SquarePen size={17} />Новый чат</button>
        {isAdmin && agents.filter(agent => agent.available).length > 1 && <Select className="workspace-agent" label="Специалист нового чата"
          value={newAgent} onChange={setNewAgent} options={agents.filter(agent => agent.available).map(agent => ({ value: agent.id, label: agent.name }))} />}
      </div>
      <div className="projects-heading">
        <b>Проекты</b>
        <button className="workspace-icon" onClick={openSearch} aria-label="Найти проект или чат" title="Поиск"><Search size={16} /></button>
        {canCreateProject && <button className="workspace-icon" onClick={() => setPanel('project')} aria-label="Добавить проект" title="Добавить проект"><Plus size={18} /></button>}
      </div>
      <nav className="project-tree" aria-label="Проекты и чаты">
        {projects.map(project => {
          const open = openProjects[project.id] ?? project.id === projectId;
          const list = chatLists[project.id] ?? [];
          const visible = showAll[project.id] ? list : list.slice(0, 5);
          return <div key={project.id} className="project-group">
            <div className="project-line">
              <button className="workspace-row project-row" onClick={() => toggleProject(project.id)} aria-expanded={open} aria-controls={'chats-' + project.id} title={project.name}>
                <Folder size={17} /><span>{project.name}</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button className="workspace-icon project-new-chat" title="Новый чат в проекте" aria-label={'Новый чат в проекте ' + project.name} disabled={!newAgent || pending} onClick={() => void newChat(project.id)}><Plus size={16} /></button>
            </div>
            {open && <div className="project-chat-list" id={'chats-' + project.id}>
              {visible.map(item => <button key={item.id} className="workspace-row chat-row" aria-current={item.id === chatId ? 'page' : undefined}
                onClick={() => navigateTo(project.id, item.id)} title={item.title}>
                <span>{item.title}</span>
                {active?.chatId === item.id ? <LoaderCircle size={13} className="spin" /> : <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>}
              </button>)}
              {list.length > 5 && <button className="workspace-row show-chats" onClick={() => setShowAll(old => ({ ...old, [project.id]: !old[project.id] }))}>{showAll[project.id] ? 'Свернуть' : 'Показать ещё'}</button>}
            </div>}
          </div>;
        })}
      </nav>
      <div className="workspace-account">
        {isAdmin && !inFastkore ? <details ref={accountMenu} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
          onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary className="workspace-row account-row"><span className="account-initial">{user.name.trim()[0]?.toUpperCase()}</span><span>{user.name}</span><ChevronDown size={14} /></summary>
          <div className="account-actions">
            <button className="workspace-row" onClick={showSettings}><Settings2 size={17} />Настройки</button>
            <button className="workspace-row" onClick={logout}><LogOut size={17} />Выйти</button>
          </div>
        </details> : <div className="workspace-row account-row"><span className="account-initial">{user.name.trim()[0]?.toUpperCase()}</span><span>{user.name}</span></div>}
      </div>
    </aside>
    <main className="workspace-main">
      <header className="workspace-top">
        <button className="workspace-icon workspace-mobile-toggle" onClick={() => setSidebarOpen(true)} aria-label="Открыть проекты"><Menu size={20} /></button>
        {chat && <>
          {hasMessages && <><Folder size={17} aria-label={selectedProject?.name} /><h1 title={chat.title}>{chat.title}</h1></>}
          <div className="chat-access" title={chat.ownerName}>
            {isAdmin ? <Select label="Видимость чата" value={chat.visibility ?? 'private'} disabled={pending}
              onChange={visibility => void changeVisibility(visibility as 'private' | 'project')}
              options={[{ value: 'private', label: 'Личный' }, { value: 'project', label: 'Общий' }]} />
              : <span><LockKeyhole size={13} />{chat.visibility === 'project' ? 'Общий' : 'Личный'}</span>}
          </div>
        </>}
        {themeButton}
      </header>
      {!embedded && (chat?.erpContext || erpContext || contextNotice) && <div className="workspace-context">
        {chat?.erpContext && <span>{chat.erpContext.entityType} / {chat.erpContext.entityId}</span>}
        {erpContext && <button className="workspace-row" disabled={!canCreate} onClick={() => void newChat(projectId, erpContext)}>Новый чат · {erpContext.entityType} / {erpContext.entityId}</button>}
        {contextNotice && <span role="status">{contextNotice}</span>}
      </div>}
      {error && !panel && <div className="workspace-error" role="alert"><span>{error}</span><button className="workspace-icon" onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={17} /></button></div>}
      {hasMessages && chat ? <>
        <div ref={scroll} className="conversation-scroll" onScroll={() => { const el = scroll.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          <div className="conversation-lane conversation-history">
            {chat.messages.map(message => <article key={message.id} className={'conversation-message is-' + message.role}>
              {message.role === 'assistant' ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                img: ({ alt }) => <span>[Изображение: {alt}]</span>,
                a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
              }}>{message.text || (message.status === 'running' ? 'Работаю над вопросом…' : 'Ответ не получен.')}</ReactMarkdown></div> :
                <div className="question-bubble">
                  {message.authorId && message.authorId !== user.id && <small>{message.authorName ?? chat.ownerName}</small>}
                  {message.text}
                </div>}
              {message.attachments.length > 0 && <div className="conversation-files">{message.attachments.map(file => <span key={file.id}><FileText size={16} />{file.name}</span>)}</div>}
              {['error', 'cancelled', 'interrupted'].includes(message.status) && <div className="message-note">{message.status === 'error' ? 'Ошибка задания' : message.status === 'cancelled' ? 'Задание остановлено' : 'Задание прервано'}</div>}
              <div className="message-actions">
                <button className="workspace-icon" aria-label="Копировать сообщение" title="Копировать сообщение" onClick={() => void copyItem(message.text, message.id)}>{copied === message.id ? <Check size={14} /> : <Copy size={14} />}</button>
                <time dateTime={message.createdAt} title={message.usage ? 'Вход: ' + message.usage.inputTokens.toLocaleString('ru-RU') + ' · Выход: ' + message.usage.outputTokens.toLocaleString('ru-RU') : undefined}>{shortDate(message.createdAt)}</time>
              </div>
            </article>)}
            <div ref={end} />
          </div>
        </div>
        <div className="conversation-lane conversation-footer">{composer}</div>
      </> : <div className="workspace-welcome">
        <h2>{selectedProject ? 'Новый чат' : 'Выберите проект'}</h2>
        {composer}
      </div>}
    </main>
    {panel === 'search' && <WorkspaceDialog title="Поиск" className="workspace-search" close={closePanel}>
      <input type="search" aria-label="Поиск по проектам и чатам" placeholder="Поиск по проектам и чатам" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} autoFocus />
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="search-results">
        {searchable.map(({ project, matchingChats }) => <div key={project.id}>
          <button className="workspace-row search-project" onClick={() => { navigateTo(project.id); closePanel(); }}><Folder size={16} />{project.name}</button>
          {matchingChats.map(item => <button key={item.id} className="workspace-row chat-row" onClick={() => { navigateTo(project.id, item.id); closePanel(); }}><span>{item.title}</span><time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time></button>)}
        </div>)}
        {searchLoading && <p className="composer-status" role="status">Загрузка…</p>}
        {!searchLoading && !searchable.length && <p className="composer-status">Ничего не найдено</p>}
      </div>
    </WorkspaceDialog>}
    {panel === 'project' && <WorkspaceDialog title="Новый проект" className="workspace-project-form" close={closePanel}>
      <form onSubmit={e => { e.preventDefault(); void action(async () => {
        const p = await post<ProjectSummary>('/api/projects', { ...(folderPath.trim() && isAdmin ? { directory: folderPath.trim() } : {}), ...(projectName.trim() ? { name: projectName.trim() } : {}) });
        setProjects(await api('/api/projects')); navigateTo(p.id); closePanel(); setFolderPath(''); setProjectName('');
      }); }}>
        <label htmlFor="project-name">Название проекта</label>
        <input id="project-name" value={projectName} onChange={e => setProjectName(e.target.value)} required={!isAdmin || !folderPath.trim()} maxLength={100} autoFocus />
        {isAdmin && <><label htmlFor="directory">Папка на сервере <span>необязательно</span></label><input id="directory" value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder={status?.executionDisabled ? '/projects/Финансы' : 'C:\\Проекты\\Финансы'} /></>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button className="primary w-full" disabled={pending}>{folderPath.trim() && isAdmin ? 'Подключить папку' : 'Создать проект'}</button>
      </form>
    </WorkspaceDialog>}
    {panel === 'settings' && isAdmin && <WorkspaceDialog title="Настройки" className="workspace-settings" close={closePanel}>
      <div className="settings-layout">
        <nav aria-label="Разделы настроек" className="settings-nav">
          <button className="workspace-row" aria-pressed={settingsSection === 'account'} onClick={() => setSettingsSection('account')}><LockKeyhole size={16} />Учётная запись</button>
          <button className="workspace-row" aria-pressed={settingsSection === 'team'} onClick={() => setSettingsSection('team')}><Users size={16} />Команда</button>
          <button className="workspace-row" aria-pressed={settingsSection === 'server'} onClick={() => void showServerSettings()}><Network size={16} />Сервер</button>
        </nav>
        <div className="panel-body settings-content">
          {error && <div className="inline-error" role="alert">{error}</div>}
          {settingsSection === 'account' && <>
            <AccountPanel request={api} copy={copy} renewed={saveToken} />
            <section className="setting-section"><h3>API</h3>
              <button className="copy-row" onClick={() => void copyItem(location.origin, 'base')}><code>{location.origin}</code>{copied === 'base' ? <Check size={14} /> : <Copy size={14} />}</button>
              <pre className="api-code">Authorization: Bearer &lt;ключ доступа&gt;</pre>
              {selectedProject && <><label>ID проекта</label><button className="copy-row" onClick={() => void copyItem(projectId, 'pid')}><code>{projectId}</code>{copied === 'pid' ? <Check size={14} /> : <Copy size={14} />}</button></>}
              {chatId && <><label>ID чата</label><button className="copy-row" onClick={() => void copyItem(chatId, 'cid')}><code>{chatId}</code>{copied === 'cid' ? <Check size={14} /> : <Copy size={14} />}</button></>}
            </section>
          </>}
          {settingsSection === 'team' && <TeamPanel request={api} projectId={projectId} projectName={selectedProject?.name ?? ''} self={user} />}
          {settingsSection === 'server' && <>
            {!projects.length && <section className="setting-section"><h3>История настольной версии</h3><button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => {
              await post('/api/migrations/desktop'); setProjects(await api('/api/projects')); setStatus(await api('/api/status')); closePanel();
            })}>Перенести проекты и историю</button></section>}
            <section className="setting-section"><h3>Адрес сервера</h3>
              {status?.addresses.map(url => <button key={url} className="copy-row" onClick={() => void copyItem(url, url)}><code>{url}</code>{copied === url ? <Check size={14} /> : <Copy size={14} />}</button>)}
            </section>
            <section className="setting-section"><h3>Codex CLI</h3>
              <p className="settings-status">{status?.cli?.authentication === 'chatgpt' ? 'Подключён через ChatGPT' : status?.cli?.authentication === 'api-key' ? 'API-ключ · выполнение отключено' : 'Codex не подключён'}</p>
              <label htmlFor="cli-path">Путь к Codex CLI</label><input id="cli-path" value={cliPath} onChange={e => setCliPath(e.target.value)} placeholder="Автоопределение" disabled={busy} />
              <div className="button-pair">
                <button className="secondary" disabled={pending || busy} onClick={() => void saveSettings({ cliPath: cliPath.trim() })}>Сохранить</button>
                <button className="secondary" disabled={pending || busy} onClick={() => void action(async () => { await post('/api/cli/check'); setStatus(await api('/api/status')); })}>Проверить</button>
              </div>
              <button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => { setSubscription(await post<Run>('/api/subscription/check')); })}>Проверить подписку</button>
              {subscription && <p role="status">{subscription.error ?? subscription.response ?? subscription.progress}</p>}
            </section>
            <section className="setting-section"><h3>Модель по умолчанию</h3>
              <Select className="settings-select" label="Модель сервера" value={serverModel} options={serverModels}
                disabled={busy || pending || modelsLoading} onChange={model => void saveSettings({ model })} />
              <button className="secondary w-full" disabled={modelsLoading} onClick={() => void loadModels(true)}>{modelsLoading ? 'Загрузка…' : 'Обновить список моделей'}</button>
              {modelError && <p role="status">{modelError}</p>}
            </section>
            <section className="setting-section"><h3>Работа с файлами</h3>
              <Toggle checked={status?.settings.allowWrite ?? false} disabled={busy || pending} title="Разрешить запись в проект" onChange={allowWrite => void saveSettings({ allowWrite })} />
              <Toggle checked={status?.settings.includePreviews ?? true} disabled={busy || pending} title="Добавлять выдержки из документов" onChange={includePreviews => void saveSettings({ includePreviews })} />
            </section>
            {(diagnostics || status?.storageWarning) && <section className="setting-section"><h3>Диагностика</h3>{diagnostics && <pre className="diagnostics">{diagnostics}</pre>}{status?.storageWarning && <p role="status">{status.storageWarning}</p>}</section>}
          </>}
        </div>
      </div>
    </WorkspaceDialog>}
  </div>;
}

function shortDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function LimitsButton({ request }: { request: typeof api }) {
  const [limits, setLimits] = useState<CodexLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  async function refresh() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try { setLimits((await request<{ limits: CodexLimits | null }>('/api/codex/limits')).limits); }
    catch { setLimits(null); }
    finally { busy.current = false; setLoading(false); }
  }
  return <details className="limits-control" data-available={!!limits}
    onToggle={e => { if (e.currentTarget.open) void refresh(); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
    onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary className="workspace-icon" aria-label="Лимиты Codex" title="Лимиты Codex">
      <Circle className="limit-ring" aria-hidden="true" size={17} strokeWidth={3} />
    </summary>
    <div className="limits-popover">
      <header><h3>Лимиты Codex</h3><button className="workspace-icon" title="Обновить лимиты" aria-label="Обновить лимиты" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} /></button></header>
      {loading && <p role="status">Загрузка…</p>}
      {!loading && !limits && <p role="status">Данные недоступны</p>}
      {limits?.buckets.map((bucket, index) => <section key={index}>
        {limits.buckets.length > 1 && <b>{bucket.name}</b>}
        {bucket.windows.map((window, row) => {
          const left = Math.max(0, Math.round(100 - window.usedPercent));
          const mins = window.windowDurationMins;
          const label = mins ? (mins % 1440 === 0 ? mins / 1440 + ' дн.' : mins % 60 === 0 ? mins / 60 + ' ч' : mins + ' мин') : 'Лимит';
          return <div key={row}><div className="limit-window"><span>{label}</span><span>Осталось {left}%</span></div>
            <progress value={left} max={100} aria-label={'Остаток за ' + label} />
            {!!window.resetsAt && <small>Обновится {new Date(window.resetsAt * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</small>}
          </div>;
        })}
      </section>)}
      {limits?.resetsAvailable != null && <p>Доступно сбросов: {limits.resetsAvailable}</p>}
    </div>
  </details>;
}

function WorkspaceDialog({ title, className, close, children }: { title: string; className: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = React.useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={'workspace-dialog ' + className} aria-labelledby={heading} onCancel={e => { e.preventDefault(); close(); }}
    onClick={e => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close();
    }}>
    <header><h2 id={heading}>{title}</h2><button className="workspace-icon" onClick={close} aria-label="Закрыть"><X size={19} /></button></header>
    {children}
  </dialog>;
}

function Toggle({ checked, disabled, title, onChange }: { checked: boolean; disabled: boolean; title: string; onChange: (value: boolean) => void }) { return <label className="toggle-row"><span><b>{title}</b></span><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="toggle" /></label>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
