import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Archive, ArrowUp, BarChart3, Bot, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Database, EllipsisVertical, FileText, Folder, History, Link2, LoaderCircle, LockKeyhole, LogOut, Menu, Moon, Network, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, SquarePen, Sun, Terminal, Users, X } from 'lucide-react';
import type { AgentSummary, Attachment, Chat, ChatSummary, CodexLimits, FastkoreAuthentication, FileStorageStatus, ModelCatalog, ProjectSummary, RelatedChatSummary, Run, Settings, Status, User } from '../shared/types';
import './style.css';
import './workspace.css';
import { ChatArchiveDialog } from './ChatArchiveDialog';
import { shortUserName } from './user-name';
import { parseHostTheme, webViewHost, type Theme } from './fastkore';
import { Select } from './Select';
import { ComposerInput } from './ComposerInput';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ProjectFilesDialog } from './ProjectFilesDialog';
import { ProjectAgentsDialog } from './ProjectAgentsDialog';
import { VoiceDictation } from './VoiceDictation';
import { DictationModelSettings } from './DictationModelSettings';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../shared/agent-instructions';
import { fastkoreChatContextKey, fastkoreContextProblem, isFastkoreContextMessage, isFastkoreContextReset, parseFastkoreContext, type FastkoreContext } from '../shared/fastkore-context';

const AccountPanel = lazy(() => import('./AccessPanel').then(module => ({ default: module.AccountPanel })));
const TeamPanel = lazy(() => import('./AccessPanel').then(module => ({ default: module.TeamPanel })));
const AuditPanel = lazy(() => import('./AuditPanel').then(module => ({ default: module.AuditPanel })));
const ErpRolesPanel = lazy(() => import('./ErpRolesPanel').then(module => ({ default: module.ErpRolesPanel })));
const CorporatePanel = lazy(() => import('./CorporatePanel').then(module => ({ default: module.CorporatePanel })));
const SpecialistsPanel = lazy(() => import('./SpecialistsPanel').then(module => ({ default: module.SpecialistsPanel })));
const UsagePanel = lazy(() => import('./UsagePanel').then(module => ({ default: module.UsagePanel })));
const FastkorePanel = lazy(() => import('./FastkorePanel').then(module => ({ default: module.FastkorePanel })));
const KnowledgePanel = lazy(() => import('./KnowledgePanel').then(module => ({ default: module.KnowledgePanel })));

let accessKey = sessionStorage.getItem('bridge-key') ?? '';
const agentsUrl = (projectId: string) => projectId ? '/api/projects/' + encodeURIComponent(projectId) + '/agents' : '/api/agents';
const settingsSections = {
  account: { label: 'Учётная запись', icon: LockKeyhole },
  team: { label: 'Команда', icon: Users },
  roles: { label: 'Роли', icon: ShieldCheck },
  profiles: { label: 'Специалисты', icon: Bot },
  datasets: { label: 'Источники', icon: Database },
  agent: { label: 'Общие инструкции', icon: FileText },
  knowledgeFastkore: { label: 'База знаний о Fastkore', icon: FileText },
  knowledgeCompany: { label: 'База знаний о компании', icon: Folder },
  audit: { label: 'Журнал доступа', icon: ClipboardList },
  usage: { label: 'Использование', icon: BarChart3 },
  fastkore: { label: 'Вход из Fastkore', icon: Link2 },
  server: { label: 'Сервер', icon: Network },
};
type SettingsSection = keyof typeof settingsSections;
let browserSession = false, csrfToken = '', sessionUserId = '', authEpoch = 0;
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(url: string, init: RequestInit = {}, responseType: 'json' | 'blob' = 'json'): Promise<T> {
  const epoch = authEpoch;
  const headers = new Headers(init.headers);
  if (browserSession && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('X-CSRF-Token', csrfToken);
  if (!browserSession && accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  if (response.ok && responseType === 'blob') {
    const result = await response.blob();
    if (epoch !== authEpoch) throw new DOMException('Сеанс изменился.', 'AbortError');
    return result as T;
  }
  const result = await response.json();
  if (epoch !== authEpoch) throw new DOMException('Сеанс изменился.', 'AbortError');
  if (!response.ok) throw new ApiError(result.error ?? 'Не удалось выполнить запрос.', response.status);
  if (browserSession && sessionUserId && result.user?.id && result.user.id !== sessionUserId) throw new ApiError('Пользователь Fastkore изменился. Откройте помощника заново.', 401);
  return result;
}
const post = <T,>(url: string, body: unknown = {}) => api<T>(url, { method: 'POST', body: JSON.stringify(body) });
async function downloadChatFile(url: string, name: string) {
  const contents = await api<Blob>(url, {}, 'blob');
  const objectUrl = URL.createObjectURL(contents);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
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
  const [loggedIn, setLoggedIn] = useState(false), [passwordInput, setPasswordInput] = useState(''), [loginInput, setLoginInput] = useState('');
  const [checkingSession, setCheckingSession] = useState(true), [authSource, setAuthSource] = useState<'local' | 'fastkore'>('local');
  const [erpAuth, setErpAuth] = useState<FastkoreAuthentication | null>(null);
  const currentErpContext = useRef<{ snapshot?: FastkoreContext; problem?: string; key?: string; active?: boolean }>({});
  const autoOpenRelated = useRef<string | undefined>(undefined);
  const [erpChatKey, setErpChatKey] = useState<string>();
  const [relatedChats, setRelatedChats] = useState<{ key: string; list: RelatedChatSummary[] }>();
  const [contextProblem, setContextProblem] = useState<string>();
  const readySession = useRef<FastkoreAuthentication | null>(null);
  const [user, setUser] = useState<User | null>(null), [setupRequired, setSetupRequired] = useState(false), [setupName, setSetupName] = useState('Руководитель');
  const [status, setStatus] = useState<Status | null>(null), [projects, setProjects] = useState<ProjectSummary[]>([]), [chat, setChat] = useState<Chat | null>(null);
  const [chatLists, setChatLists] = useState<Record<string, ChatSummary[]>>({});
  const [projectsExpanded, setProjectsExpanded] = useState(() => localStorage.getItem('bridge-projects-collapsed') !== '1');
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [projectId, setProjectId] = useState(localStorage.getItem('bridge-project') ?? ''), [chatId, setChatId] = useState(localStorage.getItem('bridge-chat') ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [specialists, setSpecialists] = useState<Record<string, string | undefined>>({});
  const [panel, setPanel] = useState<'settings' | 'project' | 'project-files' | 'project-agents' | 'search' | 'archive' | 'related' | null>(null);
  const [projectActionTarget, setProjectActionTarget] = useState<ProjectSummary | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account');
  const [instructionsDraft, setInstructionsDraft] = useState<string>();
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const savedInstructions = status?.settings.agentInstructions ?? DEFAULT_AGENT_INSTRUCTIONS;
  const agentInstructions = instructionsDraft ?? savedInstructions;
  const openedFastkoreSettings = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false), [searchQuery, setSearchQuery] = useState(''), [searchLoading, setSearchLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('bridge-sidebar-collapsed') === '1');
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [copied, setCopied] = useState(''), [folderPath, setFolderPath] = useState(''), [projectName, setProjectName] = useState('');
  const [agentCatalog, setAgentCatalog] = useState<{ projectId: string; list: AgentSummary[] }>();
  const [preferredAgent, setPreferredAgent] = useState('universal');
  const agents = agentCatalog?.projectId === projectId ? agentCatalog.list : [];
  const availableAgents = agents.filter(agent => agent.available);
  const newAgent = (availableAgents.find(agent => agent.id === preferredAgent) ?? availableAgents[0])?.id ?? '';
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null), [modelsLoading, setModelsLoading] = useState(false), [modelError, setModelError] = useState('');
  const [cliPath, setCliPath] = useState(''), [diagnostics, setDiagnostics] = useState(''), [subscription, setSubscription] = useState<Run | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true), loadingSettings = useRef(false);
  const sending = useRef(false);
  const sendAttempt = useRef<{ chatId: string; content: string; requestId: string } | null>(null);
  const relatedDraftKey = currentErpContext.current.active && erpChatKey ? 'erp:' + erpChatKey : '';
  const draftSlot = chatId || relatedDraftKey;
  const selectedProject = projects.find(p => p.id === projectId), draft = drafts[draftSlot] ?? '', attachments = files[chatId] ?? [];
  const specialistKey = draftSlot || 'new:' + projectId;
  const specialistId = specialists[specialistKey];
  const active = status?.activeRun, busy = status?.busy ?? !!active;
  const isAdmin = user?.role === 'admin';
  const matchesErpChat = !!erpChatKey && relatedChats?.key === erpChatKey && relatedChats.list.some(item => item.id === chatId);
  const relatedLoading = !!erpChatKey && relatedChats?.key !== erpChatKey;
  const canEdit = !!chat && !chat.archivedAt && (!chat.linkedToFastkore || matchesErpChat) && (isAdmin || chat.ownerId === user?.id);
  const codexUnavailable = status?.isolatedCodex && status.cli?.authentication !== 'chatgpt';
  const codexNotice = status?.executionDisabled ? 'Выполнение Codex отключено на сервере.' : codexUnavailable
    ? status.cli?.authentication === 'signed-out' ? 'Требуется вход в ChatGPT на исполнителе.' : 'Исполнитель Codex недоступен.'
    : '';
  const canCreateProject = isAdmin || status?.canCreateProject === true;
  const canStartWithoutProject = !projectId && projects.length === 0 && canCreateProject;
  const currentAgent = chat ? agents.find(agent => agent.id === (chat.agentProfileId ?? 'universal')) : undefined;
  const messageAgent = chatId ? currentAgent : availableAgents.find(agent => agent.id === newAgent);
  const otherSpecialists = availableAgents.filter(agent => agent.id !== messageAgent?.id);
  const canAttach = canEdit && messageAgent?.available === true && messageAgent.toolIds.includes('chat-files');
  const canReadFastkore = !!projectId && messageAgent?.toolIds.includes('fastkore') === true;
  const canStartChat = !chatId && !!newAgent && (!!selectedProject || canStartWithoutProject);
  const canSend = !!status && !(relatedLoading && currentErpContext.current.active) && !status.executionDisabled && !codexUnavailable && (!canReadFastkore || !contextProblem || !!currentErpContext.current.snapshot) && (!attachments.length || canAttach)
    && !!messageAgent?.available && (!specialistId || otherSpecialists.some(agent => agent.id === specialistId)) && (chatId ? canEdit : canStartChat);
  const inFastkore = embedded || (authSource === 'fastkore' && !!webViewHost());
  const relatedPanelOpen = panel === 'related';
  useEffect(() => {
    if (!loggedIn || !isAdmin || authSource !== 'local' || inFastkore || setupRequired || openedFastkoreSettings.current) return;
    if (new URLSearchParams(location.search).get('settings') !== 'fastkore') return;
    openedFastkoreSettings.current = true;
    setSettingsSection('fastkore');
    setPanel('settings');
  }, [loggedIn, isAdmin, authSource, inFastkore, setupRequired]);
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
    if (inFastkore) document.documentElement.dataset.fastkoreTheme = theme;
  }, [theme, inFastkore]);
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
  function clearLogin() { authEpoch++; browserSession = false; csrfToken = ''; sessionUserId = ''; sendAttempt.current = null; setErpAuth(null); currentErpContext.current = {}; autoOpenRelated.current = undefined; setErpChatKey(undefined); setRelatedChats(undefined); setContextProblem(undefined); readySession.current = null; setAgentCatalog(undefined); setPreferredAgent('universal'); setCatalog(null); setModelError(''); accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat'); setLoggedIn(false); setUser(null); setStatus(null); setProjects([]); setChatLists({}); setOpenProjects({}); setShowAll({}); setSidebarOpen(false); setChat(null); setDrafts({}); setFiles({}); setSpecialists({}); setSubscription(null); setPanel(null); setProjectId(''); setChatId(''); setDiagnostics(''); setPasswordInput(''); }
  function logout() { void action(async () => { await post('/api/auth/logout'); clearLogin(); }); }
  useEffect(() => {
    let alive = true;
    const endpoint = embedded ? '/api/auth/me' : '/api/auth/browser-session';
    void fetch(endpoint, { credentials: 'same-origin' }).then(async response => {
      const value = await response.json();
      if (!alive) return;
      if (!response.ok) {
        if (embedded && response.status === 401) webViewHost()?.postMessage({ type: 'fastkore.sso.required', version: 1, reason: 'session_expired' });
        clearLogin(); throw new Error('Сеанс Fastkore завершён. Откройте помощника из ERP заново.');
      }
      if (value.authentication?.source === 'fastkore') {
        clearLogin();
        browserSession = true; csrfToken = value.authentication.csrfToken; sessionUserId = value.user.id;
        setErpAuth(value.authentication); setAuthSource('fastkore'); setUser(value.user); setSetupRequired(false); setLoggedIn(true);
      } else if (!embedded) setLoggedIn(!!accessKey);
    }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setCheckingSession(false); });
    return () => { alive = false; };
  }, []);
  async function login(local = false) {
    await action(async () => {
      const result = local ? await api<{ token: string; user: User }>('/api/local-login', { method: 'POST', headers: { 'X-Bridge-Local': '1' } }) : await post<{ token: string; user: User }>('/api/auth/login', { username: loginInput, password: passwordInput });
      saveToken(result.token); setAuthSource('local'); const me = await api<{ user: User; setupRequired: boolean }>('/api/auth/me'); setUser(me.user); setSetupRequired(me.setupRequired); setLoggedIn(true); setPasswordInput('');
    });
  }
  useEffect(() => {
    if (!loggedIn || authSource === 'fastkore') return;
    let alive = true;
    api<{ user: User; setupRequired: boolean }>('/api/auth/me').then(me => { if (alive) { setUser(me.user); setSetupRequired(me.setupRequired); } }).catch(e => { if (alive) fail(e); });
    return () => { alive = false; };
  }, [loggedIn, authSource]);
  useEffect(() => {
    const host = inFastkore ? webViewHost() : undefined;
    if (!host) return;
    const receive = (event: { data: unknown }) => {
      const nextTheme = parseHostTheme(event.data);
      if (nextTheme) setErpTheme({ theme: nextTheme });
      if (erpAuth && isFastkoreContextMessage(event.data) && event.data.version === 1) {
        const reset = isFastkoreContextReset(event.data);
        const snapshot = reset ? undefined : parseFastkoreContext(event.data) ?? undefined;
        const problem = reset ? undefined : snapshot ? fastkoreContextProblem(snapshot) : 'Fastkore передал некорректный снимок. Откройте помощника из нужной карточки или списка.';
        const key = snapshot && fastkoreChatContextKey(snapshot);
        const previous = currentErpContext.current;
        const changed = key !== previous.key;
        currentErpContext.current = { snapshot, problem, key, active: changed ? !!key : previous.active };
        if (changed) {
          autoOpenRelated.current = key;
          setErpChatKey(key);
          setRelatedChats(undefined);
          if (key || previous.active) navigateTo(selected.current.projectId);
          if (!key) setPanel(panel => panel === 'related' ? null : panel);
        }
        setContextProblem(problem);
      }
    };
    host.addEventListener('message', receive);
    return () => host.removeEventListener('message', receive);
  }, [inFastkore, erpAuth]);
  useEffect(() => {
    if (inFastkore && erpTheme) webViewHost()?.postMessage({ type: 'fastkore.ui.applied', version: 1, theme: erpTheme.theme });
  }, [inFastkore, erpTheme]);
  useEffect(() => {
    if (!erpAuth || !loggedIn || !user || readySession.current === erpAuth) return;
    readySession.current = erpAuth;
    webViewHost()?.postMessage({
      type: 'fastkore.ready', version: 1, installation_id: erpAuth.installationId,
      fastkore_user_id: erpAuth.externalUserId, theme,
    });
  }, [erpAuth, loggedIn, user?.id, theme]);
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
  function navigateWorkspace(project: string, conversation = '') {
    currentErpContext.current.active = false;
    autoOpenRelated.current = undefined;
    navigateTo(project, conversation);
  }
  function navigateToRelated(item: RelatedChatSummary) {
    currentErpContext.current.active = true;
    autoOpenRelated.current = undefined;
    navigateTo(item.projectId, item.id);
  }
  useEffect(() => {
    const context = currentErpContext.current.snapshot;
    if (!erpChatKey || !context) return;
    const controller = new AbortController();
    api<RelatedChatSummary[]>('/api/fastkore/chats/related', {
      method: 'POST', body: JSON.stringify({ context }), signal: controller.signal,
    }).then(list => {
      if (controller.signal.aborted || currentErpContext.current.key !== erpChatKey) return;
      setRelatedChats({ key: erpChatKey, list });
      if (autoOpenRelated.current === erpChatKey) {
        autoOpenRelated.current = undefined;
        if (list[0]) navigateToRelated(list[0]);
      }
    }).catch(error => {
      if (controller.signal.aborted) return;
      autoOpenRelated.current = undefined;
      setRelatedChats({ key: erpChatKey, list: [] });
      fail(error);
    });
    return () => controller.abort();
  }, [erpChatKey, relatedPanelOpen]);
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
        const [state, list] = await Promise.all([api<Status>('/api/status'), api<ProjectSummary[]>('/api/projects')]);
        if (disposed) return;
        setStatus(state); setUser(state.user);
        const activeProjectExists = list.some(p => p.id === selected.current.projectId);
        if (activeProjectExists || projectAtStart === selected.current.projectId) setProjects(list);
        if (!activeProjectExists && projectAtStart === selected.current.projectId && (projectAtStart || list.length)) navigateTo(list[0]?.id ?? '');
        const p = selected.current.projectId;
        if (!p || list.some(project => project.id === p)) {
          const allowedAgents = await api<AgentSummary[]>(agentsUrl(p));
          if (disposed || selected.current.projectId !== p) return;
          setAgentCatalog({ projectId: p, list: allowedAgents });
        }
        const previousChat = selected.current.chatId;
        if (p && list.some(project => project.id === p)) {
          const conversations = await api<ChatSummary[]>(`/api/projects/${p}/chats`); if (disposed || selected.current.projectId !== p) return;
          if (selected.current.chatId !== previousChat) return;
          setChatLists(old => ({ ...old, [p]: conversations }));
          const fallback = currentErpContext.current.active ? undefined : conversations.find(item => !item.linkedToFastkore);
          if ((previousChat || fallback) && !conversations.some(c => c.id === previousChat)) navigateTo(p, fallback?.id ?? '');
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
      const fallback = currentErpContext.current.active ? undefined : list.find(item => !item.linkedToFastkore);
      if (!disposed && selected.current.projectId === projectId && selected.current.chatId === previousChat &&
        (previousChat || fallback) && !list.some(c => c.id === previousChat)) {
        navigateTo(projectId, fallback?.id ?? '');
      }
    }).catch(e => { if (!disposed) fail(e); });
    return () => { disposed = true; };
  }, [projectId, loggedIn, !!selectedProject]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || !projectId || !chatId || !selectedProject) return;
    let disposed = false;
    api<Chat>(`/api/projects/${projectId}/chats/${chatId}`).then(detail => { if (!disposed) setChat(detail); }).catch(error => { if (!disposed) fail(error); });
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
  useEffect(() => {
    if (loggedIn && user && !setupRequired && status && !codexUnavailable) void loadModels();
    else if (codexUnavailable) setCatalog(null);
  }, [loggedIn, !!user, setupRequired, !!status, codexUnavailable]);
  async function changeModel(model: string) {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}`, { method: 'PATCH', body: JSON.stringify({ model }) });
      if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated);
    });
  }
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || panel || (projectId && !selectedProject)) return;
    let alive = true;
    api<AgentSummary[]>(agentsUrl(projectId)).then(list => {
      if (alive) setAgentCatalog({ projectId, list });
    }).catch(error => { if (alive) fail(error); });
    return () => { alive = false; };
  }, [loggedIn, !!user, setupRequired, user?.roleId, panel, projectId, !!selectedProject]);
  async function createChat(project: string, context?: FastkoreContext, fresh = false) {
    const choices = project === projectId ? availableAgents : (await api<AgentSummary[]>(agentsUrl(project))).filter(agent => agent.available);
    const agent = choices.find(item => item.id === newAgent) ?? choices[0];
    if (!agent) throw new Error('В этом проекте вам пока не доступен ни один агент.');
    const result = context ? await post<{ projectId: string; chat: Chat }>('/api/fastkore/chats', { projectId: project, context, fresh, agentProfileId: agent.id })
      : { projectId: project, chat: await post<Chat>(`/api/projects/${project}/chats`, { agentProfileId: agent.id }) };
    const { id, title, updatedAt, ownerId, ownerName, visibility, messages, linkedToFastkore } = result.chat;
    const summary: ChatSummary = { id, title, updatedAt, ownerId, ownerName, visibility, linkedToFastkore, messageCount: messages.length };
    const p = result.projectId;
    setChatLists(old => ({ ...old, [p]: [summary, ...(old[p] ?? []).filter(item => item.id !== id)] }));
    const key = context && fastkoreChatContextKey(context);
    if (key && currentErpContext.current.key === key) {
      const entry = { ...summary, projectId: p, projectName: projects.find(item => item.id === p)?.name ?? 'Личные чаты' };
      setRelatedChats(old => ({ key, list: [entry, ...(old?.key === key ? old.list.filter(item => item.id !== id) : [])] }));
    }
    return result;
  }
  async function createPersonalProject() {
    const created = await post<ProjectSummary>('/api/projects', { name: 'Личные чаты' });
    setProjects(old => old.some(p => p.id === created.id) ? old : [...old, created]);
    return created.id;
  }
  async function newChat(project = projectId, linked = !!relatedDraftKey) {
    const context = linked ? currentErpContext.current.snapshot : undefined;
    const key = context && currentErpContext.current.key;
    if (!project && !context) { if (canCreateProject) setPanel('project'); return; }
    if (pending || relatedLoading && linked || (project === projectId && !newAgent) || (!project && !canCreateProject)) return;
    await action(async () => {
      const { chat: created, projectId: p } = await createChat(project || await createPersonalProject(), context, true);
      if (key && currentErpContext.current.key !== key) return;
      if (!selected.current.chatId) {
        setDrafts(old => old[draftSlot] ? { ...old, [created.id]: old[draftSlot], [draftSlot]: '' } : old);
        if (project === projectId) setSpecialists(old => ({ ...old, [created.id]: old[specialistKey], [specialistKey]: undefined }));
      }
      currentErpContext.current.active = !!key;
      navigateTo(p, created.id);
      setChat(created);
      setPanel(panel => panel === 'related' ? null : panel);
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
  async function archiveChat() {
    const p = projectId, c = chatId;
    await action(async () => {
      await api(`/api/projects/${p}/chats/${c}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
      setChatLists(old => ({ ...old, [p]: (old[p] ?? []).filter(item => item.id !== c) }));
      setRelatedChats(old => old && { ...old, list: old.list.filter(item => item.id !== c) });
      if (selected.current.projectId === p && selected.current.chatId === c) navigateTo(p);
      await loadChats(p);
    });
  }
  async function send(override?: string) {
    const text = (override ?? draft).trim();
    const link = relatedDraftKey ? currentErpContext.current : undefined;
    const { snapshot, problem } = link || chat?.linkedToFastkore || canReadFastkore || otherSpecialists.some(agent => agent.toolIds.includes('fastkore')) ? currentErpContext.current : {};
    if (!canSend || (canReadFastkore && problem && !snapshot) || !text || pending || sending.current) return;
    const attachmentIds = attachments.map(a => a.id);
    sending.current = true;
    try {
      await action(async () => {
        const targetProject = projectId || await createPersonalProject();
        let project = targetProject, conversation = chatId;
        if (!conversation) {
          const { chat: created, projectId: p } = await createChat(project, link?.snapshot);
          project = p;
          conversation = created.id;
          const pSelected = selected.current.projectId;
          const shouldOpen = (pSelected === projectId || pSelected === targetProject) && !selected.current.chatId
            && (!link || currentErpContext.current.key === link.key && currentErpContext.current.active);
          setDrafts(old => ({
            ...old,
            [conversation]: shouldOpen ? old[draftSlot] ?? draft : draft,
            ...(shouldOpen ? { [draftSlot]: '' } : {}),
          }));
          setSpecialists(old => ({ ...old, [conversation]: specialistId, ...(shouldOpen ? { [specialistKey]: undefined } : {}) }));
          if (shouldOpen) {
            navigateTo(project, conversation);
            setChat(created);
          }
        }
        const message = { text, attachmentIds, fastkoreContext: snapshot, recommendedSpecialistId: specialistId };
        const content = JSON.stringify(message);
        const previous = sendAttempt.current;
        const id = previous?.chatId === conversation && previous.content === content ? previous.requestId : requestId();
        sendAttempt.current = { chatId: conversation, content, requestId: id };
        const run = await post<Run>(`/api/projects/${project}/chats/${conversation}/messages`, { ...message, clientRequestId: id });
        sendAttempt.current = null;
        setDrafts(old => old[conversation]?.trim() === text ? { ...old, [conversation]: '' } : old);
        setSpecialists(old => old[conversation] === specialistId ? { ...old, [conversation]: undefined } : old);
        setFiles(old => ({ ...old, [conversation]: (old[conversation] ?? []).filter(a => !attachmentIds.includes(a.id)) }));
        setStatus(old => old ? { ...old, ...(run.status === 'queued' ? { queuedRuns: [...(old.queuedRuns ?? []).filter(r => r.id !== run.id), run] } : run.status === 'running' ? { activeRun: run } : {}) } : old);
        stick.current = true;
      });
    } finally {
      sending.current = false;
    }
  }
  async function upload(list: FileList | null) {
    if (!list || !projectId || !chatId || !canAttach) return;
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
    setInstructionsDraft(undefined);
    setPanel('settings');
  }
  async function showServerSettings() {
    setSettingsSection('server');
    setCliPath(status?.settings.cliPath || status?.cli?.path || '');
    if (!loadingSettings.current) { loadingSettings.current = true; try { const log = await api<{ text: string }>('/api/diagnostics'); setDiagnostics(log.text); } catch (e) { fail(e); } finally { loadingSettings.current = false; } }
  }
  function chooseSettingsSection(section: SettingsSection) {
    if (section === settingsSection) return;
    if (knowledgeDirty && !window.confirm('Перейти в другой раздел и удалить несохранённые изменения?')) return;
    if (section === 'server') void showServerSettings();
    else setSettingsSection(section);
  }
  async function saveSettings(next: Partial<Settings>) { await action(async () => { const settings = await api<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(next) }); setStatus(old => old ? { ...old, settings, dictationEnabled: !!old.dictationAvailable && settings.dictationEnabled !== false } : old); }); }

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
      <label htmlFor="login-name">Логин администратора</label><input id="login-name" autoComplete="username" value={loginInput} onChange={e => setLoginInput(e.target.value)} required />
      <label htmlFor="login-password">Пароль</label><input id="login-password" type="password" autoComplete="current-password" value={passwordInput} onChange={e => setPasswordInput(e.target.value)} required />
      <button className="primary w-full" disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : 'Войти'}</button>
    </form>
    {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && <button className="secondary w-full local-setup" onClick={() => void login(true)} disabled={pending}>Первичная настройка руководителя</button>}
    {error && <div role="alert" className="inline-error">{error}</div>}
  </main></div>;

  if (!user) return <div className="bridge-signin" data-theme={theme} role="status"><LoaderCircle className="spin" size={24} /></div>;
  if (setupRequired) return <div className="bridge-signin" data-theme={theme}>{themeButton}<main className="login-card">
    <h1>Настройка руководителя</h1>
    <form onSubmit={e => { e.preventDefault(); void action(async () => {
      const result = await post<{ token: string; user: User }>('/api/auth/setup', { username: loginInput || 'admin', name: setupName, password: passwordInput });
      saveToken(result.token); setUser(result.user); setSetupRequired(false); setPasswordInput('');
    }); }}>
      <label htmlFor="setup-login">Логин</label><input id="setup-login" autoComplete="username" minLength={3} maxLength={48} value={loginInput || 'admin'} onChange={e => setLoginInput(e.target.value)} required />
      <label htmlFor="setup-name">Имя</label><input id="setup-name" maxLength={100} value={setupName} onChange={e => setSetupName(e.target.value)} required />
      <label htmlFor="setup-password">Пароль от 12 символов</label><input id="setup-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} value={passwordInput} onChange={e => setPasswordInput(e.target.value)} required />
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
  const draftEditable = !chatId || canEdit;
  const canCreate = !!selectedProject && !!newAgent && !pending;
  const canDictate = status?.dictationEnabled && messageAgent?.available && (chatId ? canEdit : canStartChat);
  const writeMode = (!status?.isolatedCodex || status.workerFilesAvailable) && !!status?.settings.allowWrite
    && !!messageAgent?.allowWrite && messageAgent.toolIds.includes('chat-files');
  const catalogOptions = catalog?.models.map(model => ({ value: model.id, label: model.name })) ?? [];
  const chatModel = messageAgent?.model ? '' : chat?.model ?? '';
  const defaultChatModel = modelName(messageAgent?.model || status?.settings.model || catalog?.models.find(model => model.isDefault)?.id);
  const chatModels = [
    { value: '', label: defaultChatModel + (catalog && !messageAgent?.model ? ' · авто' : '') },
    ...(chatModel && !catalogOptions.some(model => model.value === chatModel) ? [{ value: chatModel, label: modelName(chatModel) }] : []),
    ...catalogOptions,
  ];
  const serverModel = status?.settings.model ?? '';
  const serverModels = [
    { value: '', label: 'Автовыбор Codex' },
    ...(serverModel && !catalogOptions.some(model => model.value === serverModel) ? [{ value: serverModel, label: modelName(serverModel) }] : []),
    ...catalogOptions,
  ];
  const closePanel = () => {
    if (knowledgeDirty && !window.confirm('Закрыть настройки и удалить несохранённые изменения?')) return;
    setPanel(null);
  };
  const renderHistory = (conversation: Chat, project: string) => <>
      {conversation.messages.map(message => <article key={message.id} className={'conversation-message is-' + message.role}>
        {message.role === 'assistant' ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          img: ({ alt }) => <span>[Изображение: {alt}]</span>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}>{message.text || (message.status === 'running' ? 'Работаю над вопросом…' : 'Ответ не получен.')}</ReactMarkdown></div> :
          <div className="question-bubble">
            {message.authorId && message.authorId !== user.id && <small title={message.authorName ?? conversation.ownerName}>{shortUserName(message.authorName ?? conversation.ownerName)}</small>}
            {message.specialistName && <small title="Рекомендованный специалист">@{message.specialistName}</small>}
            {message.text}
          </div>}
        {message.attachments.length > 0 && <div className="conversation-files">{message.attachments.map(file =>
          message.role === 'assistant' && message.status === 'complete'
            ? <button type="button" key={file.id} title={'Скачать ' + file.name} onClick={() => void action(() => downloadChatFile(
              `/api/projects/${encodeURIComponent(project)}/chats/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(message.id)}/files/${encodeURIComponent(file.id)}`, file.name))}
              ><FileText size={16} />{file.name}</button>
            : <span key={file.id}><FileText size={16} />{file.name}</span>)}</div>}
        {['error', 'cancelled', 'interrupted'].includes(message.status) && <div className="message-note">{message.status === 'error' ? 'Ошибка задания' : message.status === 'cancelled' ? 'Задание остановлено' : 'Задание прервано'}</div>}
        {message.consultedSpecialists?.length ? <div className="message-specialists">Специалисты · {message.consultedSpecialists.join(', ')}</div> : null}
        <div className="message-actions">
          <button className="workspace-icon" aria-label="Копировать сообщение" title="Копировать сообщение" onClick={() => void copyItem(message.text, message.id)}>{copied === message.id ? <Check size={14} /> : <Copy size={14} />}</button>
          <time dateTime={message.createdAt} title={message.usage ? 'Вход: ' + message.usage.inputTokens.toLocaleString('ru-RU') + ' · Выход: ' + message.usage.outputTokens.toLocaleString('ru-RU') : undefined}>{shortDate(message.createdAt)}</time>
        </div>
      </article>)}
  </>;
  const composer = <div className="bridge-composer">
    {chat && !canEdit && <p className="composer-status">{chat.linkedToFastkore && chat.ownerId === user.id ? 'Чтобы продолжить чат, откройте связанную карточку или список в Fastkore.' : 'Чат доступен для чтения'}</p>}
    {codexNotice && draftEditable && <p className="composer-status" role="status">{codexNotice} Можно подготовить черновик.</p>}
    {canReadFastkore && contextProblem && <p className="composer-status" role="alert">{contextProblem}</p>}
    {!!attachments.length && !canAttach && <p className="composer-status" role="status">Удалите вложения из черновика. Агенту сейчас не разрешено их читать.</p>}
    {canReadFastkore && inFastkore && status?.fastkoreToolsStatus === 'reauth' && <p className="composer-status" role="status">Для доступа к ERP откройте помощника из Fastkore заново.</p>}
    {!projectId && status && !canCreateProject && !projects.length && <p className="composer-status">Для отправки администратор должен дать вам доступ к проекту.</p>}
    {canStartChat && canStartWithoutProject && <p className="composer-status">Первое сообщение создаст проект «Личные чаты».</p>}
    {agentCatalog?.projectId === projectId && chat && canEdit && !currentAgent?.available && <p className="composer-status">{currentAgent?.unavailableReason ?? 'Агент этого чата вам сейчас недоступен.'}</p>}
    {agentCatalog?.projectId === projectId && !chatId && status && (projectId || canCreateProject) && !availableAgents.length && <p className="composer-status">Для нового чата нужен доступ к агенту проекта.</p>}
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
      <Select label="Проект" placeholder="Выберите проект" value={projectId} onChange={project => currentErpContext.current.active ? navigateTo(project) : navigateWorkspace(project)} disabled={pending}
        options={projects.map(project => ({ value: project.id, label: project.name }))} />
      {canCreateProject && <button type="button" className="workspace-icon" title="Новый проект" aria-label="Новый проект" onClick={() => setPanel('project')}><Plus size={17} /></button>}
    </div>}
    <div className="bridge-editor">
      {attachments.length > 0 && <div className="attachment-chips">{attachments.map(attachment => <span key={attachment.id}>
        <FileText size={14} />{attachment.name}<button aria-label={'Убрать ' + attachment.name} onClick={() => setFiles(old => ({ ...old, [chatId]: (old[chatId] ?? []).filter(item => item.id !== attachment.id) }))}><X size={13} /></button>
      </span>)}</div>}
      <ComposerInput key={specialistKey} input={input} draft={draft}
        placeholder={hasMessages ? 'Продолжить разговор…' : 'Напишите сообщение…'}
        editable={draftEditable} pickerEnabled={draftEditable && !pending && (chatId ? canEdit : !!selectedProject || canStartWithoutProject)}
        agents={otherSpecialists} specialistId={specialistId}
        onDraft={text => setDrafts(old => ({ ...old, [draftSlot]: text }))}
        onSpecialist={id => setSpecialists(old => ({ ...old, [specialistKey]: id }))}
        onSend={() => void send()} controls={pickerButton => <div className="bridge-editor-controls">
        <input type="file" multiple ref={fileInput} onChange={e => void upload(e.target.files)} />
        <button className="workspace-icon" title={canAttach ? 'Прикрепить файл' : 'Агенту не разрешено читать вложения'} aria-label="Прикрепить файл" onClick={() => fileInput.current?.click()} disabled={!canAttach || pending}><Plus size={19} /></button>
        {pickerButton}
        <span className={'access-mode' + (writeMode ? ' write' : '')} title={messageAgent?.name}><ShieldCheck size={16} />{writeMode ? 'Запись разрешена' : 'Только чтение'}</span>
        <div className="composer-actions">
          <LimitsButton request={api} unavailableReason={codexNotice} revision={status?.codexLimitsRevision} />
          <div className="editor-model">
            <Select label="Модель диалога" value={chatModel} options={chatModels}
              disabled={!!messageAgent?.model || !chat || !(isAdmin || chat.ownerId === user.id) || busy || pending || modelsLoading || (!catalog && !chat.model)}
              onChange={model => void changeModel(model)} title={modelError || undefined} />
          </div>
          {canDictate && <VoiceDictation key={JSON.stringify([user.id, projectId, chatId, messageAgent?.id])} canSend={canSend && !pending}
            transcribe={async (wav, signal) => {
              const data = new FormData();
              data.append('file', wav, 'dictation.wav');
              const query = new URLSearchParams();
              if (projectId) query.set('projectId', projectId);
              if (chatId) query.set('chatId', chatId);
              else query.set('agentProfileId', newAgent);
              return (await api<{ text: string }>('/api/dictation?' + query, { method: 'POST', body: data, signal })).text;
            }} onText={(text, shouldSend) => {
              const previous = input.current?.value ?? draft;
              const content = previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text;
              setDrafts(old => ({ ...old, [draftSlot]: content }));
              if (shouldSend) void send(content);
              if (!shouldSend) requestAnimationFrame(() => input.current?.focus());
            }} onError={fail} />}
          <button className="bridge-send" aria-label="Отправить вопрос" title={codexNotice || 'Отправить · Enter'} onClick={() => void send()} disabled={!canSend || !draft.trim() || pending}><ArrowUp size={18} /></button>
        </div>
      </div>} />
    </div>
    {!chatId && canCreate && <button className="empty-new-chat" onClick={() => void newChat()}><SquarePen size={15} />Создать чат</button>}
  </div>;

  return <div className="workspace-shell" data-theme={theme}>
    {sidebarOpen && <button className="workspace-scrim" aria-label="Закрыть навигацию" onClick={() => setSidebarOpen(false)} />}
    <aside id="workspace-sidebar" className={'workspace-sidebar' + (sidebarOpen ? ' is-open' : '') + (sidebarCollapsed ? ' is-collapsed' : '')} aria-label="Боковая панель">
      <div className="workspace-brand"><span className="workspace-mark"><Terminal size={16} /></span><b>Agentic Platform</b>
        <button type="button" className="workspace-icon workspace-mobile-close" aria-label="Закрыть боковую панель" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
      </div>
      <div className="workspace-start">
        <button className="workspace-row new-conversation" onClick={() => void newChat()} disabled={pending || (projectId ? !newAgent : !canCreateProject)}><SquarePen size={17} />Новый чат</button>
        {availableAgents.length > 1 && <Select className="workspace-agent" label="Агент нового чата"
          value={newAgent} onChange={setPreferredAgent} options={availableAgents.map(agent => ({ value: agent.id, label: agent.name }))} />}
        {availableAgents.length === 1 && <p className="workspace-agent-current"><Bot size={15} aria-hidden="true" />{availableAgents[0].name}</p>}
      </div>
      <div className="projects-heading">
        <button type="button" className="workspace-row projects-toggle" aria-expanded={projectsExpanded} aria-controls="workspace-projects" onClick={() => {
          const expanded = !projectsExpanded;
          setProjectsExpanded(expanded);
          localStorage.setItem('bridge-projects-collapsed', expanded ? '0' : '1');
        }}>
          {projectsExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <span>Проекты</span>
        </button>
        <button className="workspace-icon" onClick={openSearch} aria-label="Найти проект или чат" title="Поиск"><Search size={16} /></button>
        {canCreateProject && <button className="workspace-icon" onClick={() => setPanel('project')} aria-label="Добавить проект" title="Добавить проект"><Plus size={18} /></button>}
      </div>
      <nav id="workspace-projects" className="project-tree" aria-label="Проекты и чаты" hidden={!projectsExpanded}>
        {projects.map(project => {
          const open = openProjects[project.id] ?? project.id === projectId;
          const list = chatLists[project.id] ?? [];
          const visible = showAll[project.id] ? list : list.slice(0, 5);
          return <div key={project.id} className="project-group">
            <div className="project-line">
              <button className="workspace-row project-row" onClick={() => toggleProject(project.id)} aria-expanded={open} aria-controls={'chats-' + project.id} title={project.name}>
                <Folder size={14} /><span>{project.name}</span>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <button className="workspace-icon project-new-chat" title="Новый чат в проекте" aria-label={'Новый чат в проекте ' + project.name} disabled={pending || (project.id === projectId && !newAgent)} onClick={() => void newChat(project.id, false)}><Plus size={16} /></button>
              {isAdmin && authSource === 'local' && !inFastkore && <details className="project-actions" onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
              }} onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.currentTarget.open = false;
                  e.currentTarget.querySelector('summary')?.focus();
                }
              }}>
                <summary className="workspace-icon" aria-label={'Действия проекта ' + project.name} title="Действия проекта"><EllipsisVertical size={16} /></summary>
                <div className="project-actions-menu">
                  <button className="workspace-row" onClick={e => {
                    const menu = e.currentTarget.closest('details');
                    if (menu) menu.open = false;
                    setProjectActionTarget(project);
                    setPanel('project-files');
                  }}><FileText size={15} />Файлы проекта</button>
                  <button className="workspace-row" onClick={e => {
                    const menu = e.currentTarget.closest('details');
                    if (menu) menu.open = false;
                    setProjectActionTarget(project);
                    setPanel('project-agents');
                  }}><Bot size={15} />Агенты проекта</button>
                </div>
              </details>}
            </div>
            {open && <div className="project-chat-list" id={'chats-' + project.id}>
              {visible.map(item => <button key={item.id} className="workspace-row chat-row" aria-current={item.id === chatId ? 'page' : undefined}
                onClick={() => navigateWorkspace(project.id, item.id)} title={item.title}>
                <span>{item.title}</span>
                {active?.chatId === item.id ? <LoaderCircle size={13} className="spin" /> : <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>}
              </button>)}
              {list.length > 5 && <button className="workspace-row show-chats" onClick={() => setShowAll(old => ({ ...old, [project.id]: !old[project.id] }))}>{showAll[project.id] ? 'Свернуть' : 'Показать ещё'}</button>}
            </div>}
          </div>;
        })}
      </nav>
      {isAdmin && <div className="archive-nav"><button type="button" className="workspace-row" onClick={() => { setSidebarOpen(false); setPanel('archive'); }}>
        <Archive size={17} aria-hidden="true" />Архив чатов
      </button></div>}
      <div className="workspace-account">
        {isAdmin && !inFastkore ? <details ref={accountMenu} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
          onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary className="workspace-row account-row" title={user.name}><span className="account-initial">{user.name.trim()[0]?.toUpperCase()}</span><span>{shortUserName(user.name)}</span><ChevronDown size={14} /></summary>
          <div className="account-actions">
            <button className="workspace-row" onClick={showSettings}><Settings2 size={17} />Настройки</button>
            <button className="workspace-row" onClick={logout}><LogOut size={17} />Выйти</button>
          </div>
        </details> : <div className="workspace-row account-row" title={user.name}><span className="account-initial">{user.name.trim()[0]?.toUpperCase()}</span><span>{shortUserName(user.name)}</span></div>}
      </div>
    </aside>
    <main className="workspace-main">
      <header className="workspace-top">
        <button type="button" className="workspace-icon workspace-sidebar-toggle" aria-controls="workspace-sidebar" aria-expanded={!sidebarCollapsed}
          aria-label={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
          title={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'} onClick={() => {
            const collapsed = !sidebarCollapsed;
            setSidebarCollapsed(collapsed);
            localStorage.setItem('bridge-sidebar-collapsed', collapsed ? '1' : '0');
          }}>{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
        <button type="button" className="workspace-icon workspace-mobile-toggle" onClick={() => setSidebarOpen(true)}
          aria-label="Открыть проекты" aria-controls="workspace-sidebar" aria-expanded={sidebarOpen}><Menu size={20} /></button>
        {chat && <>
          {hasMessages && <><Folder size={17} aria-label={selectedProject?.name} /><h1 title={chat.title}>{chat.title}</h1></>}
          <div className="chat-access" title={chat.ownerName}>
            {isAdmin && !chat.linkedToFastkore ? <Select label="Видимость чата" value={chat.visibility ?? 'private'} disabled={pending}
              onChange={visibility => void changeVisibility(visibility as 'private' | 'project')}
              options={[{ value: 'private', label: 'Личный' }, { value: 'project', label: 'Общий' }]} />
              : <span><LockKeyhole size={13} />{chat.visibility === 'project' ? 'Общий' : 'Личный'}</span>}
          </div>
          {isAdmin && !chat.archivedAt && <button type="button" className="workspace-icon chat-archive-button" aria-label="Перенести чат в архив" title="Перенести чат в архив"
            disabled={pending || active?.chatId === chat.id || status?.queuedRuns?.some(run => run.chatId === chat.id)} onClick={() => void archiveChat()}><Archive size={17} /></button>}
        </>}
        {erpChatKey && <div className="related-chat-actions">
          <button type="button" className="workspace-icon" title="Связанные чаты" aria-label="Связанные чаты" onClick={() => { setError(''); setPanel('related'); }}><History size={18} /></button>
          <button type="button" className="workspace-icon" title="Создать новый чат по этому контексту" aria-label="Создать новый чат по этому контексту"
            disabled={pending || relatedLoading || !newAgent || (!projectId && !canCreateProject)} onClick={() => void newChat(projectId, true)}><SquarePen size={17} /></button>
        </div>}
        {themeButton}
      </header>
      {!embedded && chat?.erpContext && <div className="workspace-context">{chat.erpContext.entityType} / {chat.erpContext.entityId}</div>}
      {error && !panel && <div className="workspace-error" role="alert"><span>{error}</span><button className="workspace-icon" onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={17} /></button></div>}
      {hasMessages && chat ? <>
        <div ref={scroll} className="conversation-scroll" onScroll={() => { const el = scroll.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          <div className="conversation-lane conversation-history">
            {renderHistory(chat, projectId)}
            <div ref={end} />
          </div>
        </div>
        <div className="conversation-lane conversation-footer">{composer}</div>
      </> : <div className="workspace-welcome">
        <h2>{selectedProject || canStartWithoutProject ? 'Новый чат' : 'Выберите проект'}</h2>
        {composer}
      </div>}
    </main>
    {panel === 'archive' && isAdmin && <ChatArchiveDialog request={api} close={closePanel} renderChat={renderHistory}
      onRestore={project => void loadChats(project).catch(fail)} />}
    {relatedPanelOpen && erpChatKey && <WorkspaceDialog title="Связанные чаты" className="related-chats-dialog" close={closePanel}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {relatedLoading ? <p className="help" role="status">Загрузка…</p> : <div className="archive-list">
        {relatedChats?.list.map(item => <button type="button" className="workspace-row archive-row" key={item.id} aria-current={item.id === chatId ? 'page' : undefined}
          onClick={() => { navigateToRelated(item); closePanel(); }}><span><strong>{item.title}</strong><small>{item.projectName}</small></span>
          <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time></button>)}
        {!relatedChats?.list.length && !error && <p className="help">По этой карточке или списку пока нет чатов.</p>}
      </div>}
      <div className="archive-actions related-dialog-actions"><button type="button" className="secondary" disabled={pending || relatedLoading || !newAgent || (!projectId && !canCreateProject)}
        onClick={() => void newChat(projectId, true)}><SquarePen size={16} />Создать новый чат</button></div>
    </WorkspaceDialog>}
    {panel === 'search' && <WorkspaceDialog title="Поиск" className="workspace-search" close={closePanel}>
      <input type="search" aria-label="Поиск по проектам и чатам" placeholder="Поиск по проектам и чатам" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} autoFocus />
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="search-results">
        {searchable.map(({ project, matchingChats }) => <div key={project.id}>
          <button className="workspace-row search-project" onClick={() => { navigateWorkspace(project.id); closePanel(); }}><Folder size={16} />{project.name}</button>
          {matchingChats.map(item => <button key={item.id} className="workspace-row chat-row" onClick={() => { navigateWorkspace(project.id, item.id); closePanel(); }}><span>{item.title}</span><time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time></button>)}
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
    {panel === 'project-files' && projectActionTarget && isAdmin && authSource === 'local' && !inFastkore &&
      <ProjectFilesDialog key={projectActionTarget.id} project={projectActionTarget} request={api} download={url => api<Blob>(url, {}, 'blob')} close={closePanel} />}
    {panel === 'project-agents' && projectActionTarget && isAdmin && authSource === 'local' && !inFastkore &&
      <ProjectAgentsDialog key={projectActionTarget.id} project={projectActionTarget} request={api} close={closePanel} />}
    {panel === 'settings' && isAdmin && <WorkspaceDialog title="Настройки" className="workspace-settings" close={closePanel}>
      <div className="settings-layout">
        <nav aria-label="Разделы настроек" className="settings-nav">
          {(Object.keys(settingsSections) as SettingsSection[]).map(section => {
            const { label, icon: Icon } = settingsSections[section];
            return <button key={section} type="button" className="workspace-row" aria-current={settingsSection === section ? 'page' : undefined}
              onClick={() => chooseSettingsSection(section)}><Icon size={16} aria-hidden="true" />{label}</button>;
          })}
        </nav>
        <select className="settings-section-picker" aria-label="Раздел настроек" value={settingsSection}
          onChange={event => chooseSettingsSection(event.target.value as SettingsSection)}>
          {Object.entries(settingsSections).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
        </select>
        <section key={settingsSection} className={'panel-body settings-content' + (settingsSection === 'server' ? ' settings-server' : '')}
          aria-labelledby="settings-section-title">
          <div className={'settings-pane' + (settingsSection === 'agent' ? ' settings-pane-instructions' : '')}>
          {settingsSection !== 'profiles' && <h2 id="settings-section-title">{settingsSections[settingsSection].label}</h2>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <Suspense fallback={<p role="status">Загрузка…</p>}>
          {settingsSection === 'account' && <AccountPanel request={api} renewed={saveToken} fastkore={authSource === 'fastkore'} />}
          {settingsSection === 'team' && <TeamPanel request={api} projectId={projectId} projectName={selectedProject?.name ?? ''} self={user} />}
          {settingsSection === 'roles' && <ErpRolesPanel request={api} />}
          {settingsSection === 'datasets' && <CorporatePanel request={api} section={settingsSection} />}
          {settingsSection === 'profiles' && <SpecialistsPanel request={api} globalInstructions={savedInstructions} />}
          {settingsSection === 'audit' && <AuditPanel request={api} />}
          {settingsSection === 'usage' && <UsagePanel request={api} />}
          {settingsSection === 'fastkore' && <FastkorePanel request={api} />}
          {(settingsSection === 'knowledgeFastkore' || settingsSection === 'knowledgeCompany') && <KnowledgePanel
            section={settingsSection === 'knowledgeFastkore' ? 'fastkore' : 'company'} request={api}
            download={url => api<Blob>(url, {}, 'blob')} dirtyChanged={setKnowledgeDirty} />}
          </Suspense>
          {settingsSection === 'agent' && <form className="settings-instructions" onSubmit={e => { e.preventDefault(); void saveSettings({ agentInstructions }); }}>
            <p className="help" id="agent-instructions-help">Действуют во всех чатах. Роли и агенты могут уточнять эти правила.</p>
            <textarea id="agent-instructions" aria-labelledby="settings-section-title" aria-describedby="agent-instructions-help" maxLength={8000} required
              value={agentInstructions} onChange={e => setInstructionsDraft(e.target.value)} />
            <div className="settings-instructions-actions">
              <button className="primary" disabled={pending || busy || !agentInstructions.trim() || agentInstructions.trim() === savedInstructions}>Сохранить</button>
            </div>
          </form>}
          {settingsSection === 'server' && <>
            {!projects.length && <section className="setting-section"><h3>История настольной версии</h3><button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => {
              await post('/api/migrations/desktop'); setProjects(await api('/api/projects')); setStatus(await api('/api/status')); closePanel();
            })}>Перенести проекты и историю</button></section>}
            <section className="setting-section"><h3>Адрес сервера</h3>
              {status?.addresses.map(url => <button key={url} className="copy-row" onClick={() => void copyItem(url, url)}><code>{url}</code>{copied === url ? <Check size={14} /> : <Copy size={14} />}</button>)}
            </section>
            <section className="setting-section"><h3>Codex CLI</h3>
              <p className="settings-status">{status?.cli?.authentication === 'chatgpt' ? 'Подключён через ChatGPT' : status?.cli?.authentication === 'api-key' ? 'API-ключ · выполнение отключено' : 'Codex не подключён'}</p>
              {status?.isolatedCodex ? <p className="help">Отдельный исполнитель</p>
                : <><label htmlFor="cli-path">Путь к Codex CLI</label><input id="cli-path" value={cliPath} onChange={e => setCliPath(e.target.value)} placeholder="Автоопределение" disabled={busy} /></>}
              <div className="settings-actions">
                {!status?.isolatedCodex && <button className="secondary" disabled={pending || busy} onClick={() => void saveSettings({ cliPath: cliPath.trim() })}>Сохранить</button>}
                <button className="secondary" disabled={pending || busy} onClick={() => void action(async () => { await post('/api/cli/check'); setStatus(await api('/api/status')); })}>Проверить</button>
                <button className="secondary" disabled={pending || busy || !!codexNotice} onClick={() => void action(async () => { setSubscription(await post<Run>('/api/subscription/check')); })}>Проверить подписку</button>
              </div>
              {subscription && <p role="status">{subscription.error ?? subscription.response ?? subscription.progress}</p>}
            </section>
            <section className="setting-section">
              <div className="settings-model-row">
                <label htmlFor="server-model">Модель по умолчанию</label>
                <Select id="server-model" className="settings-select" value={serverModel} options={serverModels}
                  disabled={busy || pending || modelsLoading} onChange={model => void saveSettings({ model })} />
                <button type="button" className="workspace-icon" aria-label="Обновить список моделей" title="Обновить список моделей"
                  disabled={modelsLoading} onClick={() => void loadModels(true)}>
                  {modelsLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                </button>
              </div>
              {modelError && <p role="status">{modelError}</p>}
            </section>
            {!status?.isolatedCodex && <section className="setting-section"><h3>Работа с файлами</h3>
              <Toggle checked={status?.settings.allowWrite ?? false} disabled={busy || pending} title="Разрешить запись в проект" onChange={allowWrite => void saveSettings({ allowWrite })} />
              <Toggle checked={status?.settings.includePreviews ?? true} disabled={busy || pending} title="Добавлять выдержки из документов" onChange={includePreviews => void saveSettings({ includePreviews })} />
            </section>}
            {status?.workerFilesAvailable && authSource === 'local' && !inFastkore && <section className="setting-section">
              <h3>Рабочая папка агента</h3>
              <Toggle checked={status.settings.allowWrite} disabled={busy || pending}
                title="Разрешить запись в рабочую папку" onChange={allowWrite => void saveSettings({ allowWrite })} />
              <p className="help">Запись также должна быть разрешена в профиле специалиста. Готовые файлы можно скачать из чата.</p>
            </section>}
            {status?.fileStorage && authSource === 'local' && !inFastkore && <section className="setting-section">
              <h3>Хранилище файлов</h3>
              <label htmlFor="file-storage">Куда сохранять новые файлы</label>
              <Select id="file-storage" value={status.fileStorage.provider} disabled={pending}
                options={[
                  { value: 'local', label: 'Локальный диск' },
                  { value: 's3', label: 'S3 / MinIO', disabled: !status.fileStorage.s3Configured },
                ]}
                onChange={provider => void action(async () => {
                  const fileStorage = await api<FileStorageStatus>('/api/settings/file-storage', { method: 'PATCH', body: JSON.stringify({ provider }) });
                  setStatus(current => current ? { ...current, fileStorage } : current);
                })} />
              <p className="help">{status.fileStorage.s3Configured
                ? 'Ранее загруженные файлы остаются в своём хранилище.'
                : 'S3 пока не настроен на сервере.'}</p>
            </section>}
            <section className="setting-section">
              <Toggle checked={!!status?.dictationEnabled} disabled={!status?.dictationAvailable || busy || pending} title="Использовать голос" onChange={dictationEnabled => void saveSettings({ dictationEnabled })} />
              {status?.dictationAvailable ? <DictationModelSettings request={api} /> : <p className="help">Сервис распознавания речи не настроен.</p>}
            </section>
            {(diagnostics || status?.storageWarning) && <section className="setting-section"><h3>Диагностика</h3>{diagnostics && <pre className="diagnostics settings-log" tabIndex={0} aria-label="Журнал диагностики">{diagnostics}</pre>}{status?.storageWarning && <p role="status">{status.storageWarning}</p>}</section>}
          </>}
          </div>
        </section>
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

const remainingPercent = (used: number) => Math.min(100, Math.max(0, 100 - used));
const limitPercentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function LimitsButton({ request, unavailableReason, revision }: { request: typeof api; unavailableReason: string; revision?: number }) {
  const [limits, setLimits] = useState<CodexLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current || unavailableReason || document.hidden) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const result = await request<{ limits: CodexLimits | null }>('/api/codex/limits', { signal: controller.signal });
      if (!controller.signal.aborted) setLimits(result.limits);
    } catch {
      if (!controller.signal.aborted) setLimits(null);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [request, unavailableReason]);
  useEffect(() => {
    if (unavailableReason) {
      setLimits(null);
      setLoading(false);
      return;
    }
    const update = () => void refresh();
    update();
    const timer = window.setInterval(update, 15_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [refresh, revision, unavailableReason]);

  const windows = unavailableReason ? [] : limits?.buckets.flatMap(bucket => bucket.windows) ?? [];
  const remaining = windows.length ? Math.min(...windows.map(window => remainingPercent(window.usedPercent))) : null;
  const remainingLabel = remaining === null ? '' : `Осталось ${limitPercentFormat.format(remaining)}%`;
  const title = remainingLabel ? `Лимиты Codex · ${remainingLabel.toLowerCase()}` : 'Лимиты Codex';
  return <details className="limits-control"
    onToggle={e => { if (e.currentTarget.open) void refresh(); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
    onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary className="workspace-icon" aria-label="Лимиты Codex" aria-description={remainingLabel || unavailableReason || undefined} title={title}>
      <svg className="limit-ring" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle className="limit-ring-track" cx="10" cy="10" r="8" />
        {remaining !== null && remaining > 0 && <circle className="limit-ring-value" cx="10" cy="10" r="8" pathLength="100"
          strokeDasharray={`${remaining} 100`} transform="rotate(-90 10 10)" />}
      </svg>
    </summary>
    <div className="limits-popover">
      <header><h3>Лимиты Codex</h3><button className="workspace-icon" title="Обновить лимиты" aria-label="Обновить лимиты" disabled={loading || !!unavailableReason} onClick={() => void refresh()}><RefreshCw size={14} /></button></header>
      {loading && !limits && <p role="status">Загрузка…</p>}
      {unavailableReason && <p role="status">{unavailableReason}</p>}
      {!unavailableReason && !loading && !limits && <p role="status">Сервер не получил лимиты от Codex.</p>}
      {!unavailableReason && limits?.buckets.map((bucket, index) => <section key={index}>
        {limits.buckets.length > 1 && <b>{bucket.name}</b>}
        {bucket.windows.map((window, row) => {
          const left = remainingPercent(window.usedPercent);
          const mins = window.windowDurationMins;
          const label = mins ? (mins % 1440 === 0 ? mins / 1440 + ' дн.' : mins % 60 === 0 ? mins / 60 + ' ч' : mins + ' мин') : 'Лимит';
          return <div key={row}><div className="limit-window"><span>{label}</span><span>Осталось {limitPercentFormat.format(left)}%</span></div>
            <progress value={left} max={100} aria-label={'Остаток за ' + label} />
            {!!window.resetsAt && <small>Обновится {new Date(window.resetsAt * 1000).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</small>}
          </div>;
        })}
      </section>)}
      {!unavailableReason && limits?.resetsAvailable != null && <p>Доступно сбросов: {limits.resetsAvailable}</p>}
    </div>
  </details>;
}

function Toggle({ checked, disabled, title, onChange }: { checked: boolean; disabled: boolean; title: string; onChange: (value: boolean) => void }) { return <label className="toggle-row"><span><b>{title}</b></span><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="toggle" /></label>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
