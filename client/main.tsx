import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Archive, ArrowUp, BarChart3, Bot, Box, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Database, Download, EllipsisVertical, Eraser, FileText, Folder, History, Link2, LoaderCircle, LockKeyhole, LogOut, Menu, Moon, Network, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, SquarePen, Sun, Terminal, Trash2, Users, X } from 'lucide-react';
import { interfaceScales, type AgentSummary, type Attachment, type Chat, type ChatSummary, type CodexLimits, type FastkoreAuthentication, type FileStorageStatus, type InterfaceScale, type ModelCatalog, type ProjectSummary, type RelatedChatSummary, type Run, type Settings, type Status, type User } from '../shared/types';
import './style.css';
import './workspace.css';
import { ChatArchiveDialog } from './ChatArchiveDialog';
import { shortUserName } from './user-name';
import { chatTooltip, dateTooltip, shortDate } from './chat-date';
import { parseHostTheme, webViewHost, type Theme } from './fastkore';
import { Select, type SelectHandle } from './Select';
import { ExecutionAccountsPanel } from './ExecutionAccountsPanel';
import { executionConnected } from '../shared/execution-accounts';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { ComposerInput } from './ComposerInput';
import { ChatAccessPopover } from './ChatAccessPopover';
import { ChatModelControls, reasoningOptions } from './ChatModelControls';
import { runToolLabel } from './run-tool-label';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ProjectFilesDialog } from './ProjectFilesDialog';
import { ProjectSpecialistsDialog } from './ProjectSpecialistsDialog';
import { VoiceDictation } from './VoiceDictation';
import { DictationModelSettings } from './DictationModelSettings';
import { PersonalInstructionsPanel } from './PersonalInstructionsPanel';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../shared/agent-instructions';
import { concreteModel, isAutomaticModel } from '../shared/model-selection';
import { canReadChatAttachment, previewModelFormat, type PreviewModelFormat } from '../shared/chat-attachments';
import { fastkoreChatContextKey, fastkoreChatTitle, fastkoreContextProblem, isFastkoreContextMessage, isFastkoreTileList, parseFastkoreContext, type FastkoreContext } from '../shared/fastkore-context';

const AccountPanel = lazy(() => import('./AccessPanel').then(module => ({ default: module.AccountPanel })));
const TeamPanel = lazy(() => import('./AccessPanel').then(module => ({ default: module.TeamPanel })));
const AuditPanel = lazy(() => import('./AuditPanel').then(module => ({ default: module.AuditPanel })));
const ErpRolesPanel = lazy(() => import('./ErpRolesPanel').then(module => ({ default: module.ErpRolesPanel })));
const SpecialistsPanel = lazy(() => import('./SpecialistsPanel').then(module => ({ default: module.SpecialistsPanel })));
const UsagePanel = lazy(() => import('./UsagePanel').then(module => ({ default: module.UsagePanel })));
const FastkorePanel = lazy(() => import('./FastkorePanel').then(module => ({ default: module.FastkorePanel })));
const KnowledgePanel = lazy(() => import('./KnowledgePanel').then(module => ({ default: module.KnowledgePanel })));
const ChatModelPreview = lazy(() => import('./ChatModelPreview').then(module => ({ default: module.ChatModelPreview })));
const ProjectSourcesDialog = lazy(() => import('./ProjectSourcesDialog').then(module => ({ default: module.ProjectSourcesDialog })));
const SourcesPanel = lazy(() => import('./SourcesPanel').then(module => ({ default: module.SourcesPanel })));
const ChatSourceScope = lazy(() => import('./ChatSourceScope').then(module => ({ default: module.ChatSourceScope })));

let accessKey = sessionStorage.getItem('bridge-key') ?? '';
const agentsUrl = (projectId: string) => projectId ? '/api/projects/' + encodeURIComponent(projectId) + '/agents' : '/api/agents';
const settingsSections = {
  team: { label: 'Команда', icon: Users },
  projects: { label: 'Проекты', icon: Folder },
  personal: { label: 'Мои инструкции', icon: FileText },
  employeeInstructions: { label: 'Инструкции сотрудников', icon: FileText },
  roles: { label: 'Роли', icon: ShieldCheck },
  profiles: { label: 'Специалисты', icon: Bot },
  sources: { label: 'Библиотека', icon: Database },
  agent: { label: 'Общие инструкции', icon: FileText },
  knowledgeFastkore: { label: 'База знаний о Fastkore', icon: FileText },
  knowledgeCompany: { label: 'База знаний о компании', icon: Folder },
  audit: { label: 'Журнал доступа', icon: ClipboardList },
  usage: { label: 'Использование', icon: BarChart3 },
  fastkore: { label: 'Вход из Fastkore', icon: Link2 },
  server: { label: 'Сервер и AI', icon: Network },
  account: { label: 'Учётная запись', icon: LockKeyhole },
};
type SettingsSection = keyof typeof settingsSections;
let browserSession = false, csrfToken = '', sessionUserId = '', authEpoch = 0;
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly transient = false) { super(message); }
}
const transientStatus = (status: number) => [408, 502, 503, 504].includes(status);
async function readApiJson(response: Response) {
  let value;
  try { value = await response.json(); }
  catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    if (response.ok) throw new ApiError('Сервер вернул неполный ответ.', 502, true);
  }
  if (!response.ok) {
    const temporary = transientStatus(response.status);
    const message = typeof value?.error === 'string' && value.error.trim() ? value.error : temporary ? 'Сервер временно недоступен.' : 'Не удалось выполнить запрос.';
    throw new ApiError(message, response.status, temporary);
  }
  return value;
}
async function fetchApi(url: string, init: RequestInit) {
  try { return await fetch(url, init); }
  catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Не удалось связаться с сервером.', 0, true);
  }
}
async function api<T>(url: string, init: RequestInit = {}, responseType: 'json' | 'blob' = 'json'): Promise<T> {
  const epoch = authEpoch;
  const headers = new Headers(init.headers);
  if (browserSession && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('X-CSRF-Token', csrfToken);
  if (!browserSession && accessKey) headers.set('Authorization', `Bearer ${accessKey}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const response = await fetchApi(url, { ...init, headers });
    const blob = response.ok && responseType === 'blob';
    const result = await (blob ? response.blob() : readApiJson(response));
    if (epoch !== authEpoch) throw new DOMException('Сеанс изменился.', 'AbortError');
    if (!blob && browserSession && sessionUserId && result?.user?.id && result.user.id !== sessionUserId) {
      throw new ApiError('Пользователь Fastkore изменился. Откройте помощника заново.', 401);
    }
    return result as T;
  } catch (error) {
    if (epoch !== authEpoch) throw new DOMException('Сеанс изменился.', 'AbortError');
    throw error;
  }
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
const focusControls = 'a, button, input, textarea, select, label, summary, dialog, [contenteditable], [tabindex], [role="button"], [role="option"]';

function App() {
  const [embedded] = useState(() => new URLSearchParams(location.search).get('embedded') === 'fastkore');
  const [interfaceScale, setInterfaceScale] = useState<InterfaceScale>(100);
  const [scalePendingEpoch, setScalePendingEpoch] = useState<number>();
  const savingScale = scalePendingEpoch === authEpoch;
  const [browserTheme, setBrowserTheme] = useState<Theme>(() => localStorage.getItem('bridge-theme') === 'light' ? 'light' : 'dark');
  const [initialErpTheme] = useState<Theme>(() => new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
  const [erpTheme, setErpTheme] = useState<{ theme: Theme } | null>(null);
  const [loggedIn, setLoggedIn] = useState(false), [passwordInput, setPasswordInput] = useState(''), [loginInput, setLoginInput] = useState('');
  const [checkingSession, setCheckingSession] = useState(true), [authSource, setAuthSource] = useState<'local' | 'fastkore'>('local');
  const [erpAuth, setErpAuth] = useState<FastkoreAuthentication | null>(null);
  const currentErpContext = useRef<{ snapshot?: FastkoreContext; problem?: string; key?: string; active?: boolean }>({});
  const contextNavigation = useRef(0);
  const [contextVersion, setContextVersion] = useState(0);
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
  const [projectId, setProjectId] = useState(localStorage.getItem('bridge-project') ?? ''), [chatId, setChatId] = useState(embedded ? '' : localStorage.getItem('bridge-chat') ?? '');
  const projectPicker = useRef<SelectHandle>(null);
  const [projectRequested, setProjectRequested] = useState(false);
  useEffect(() => { setProjectRequested(false); }, [projectId, chatId, contextVersion]);
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [specialists, setSpecialists] = useState<Record<string, string | undefined>>({});
  const [panel, setPanel] = useState<'settings' | 'project' | 'project-files' | 'project-agents' | 'project-sources' | 'rename-project' | 'search' | 'archive' | 'related' | 'rename-chat' | 'reset-chat' | null>(null);
  const [renameDraft, setRenameDraft] = useState<{ projectId: string; chatId: string; title: string; destinationId?: string }>();
  const [modelPreview, setModelPreview] = useState<{ name: string; url: string; format: PreviewModelFormat }>();
  const projectFromComposer = useRef(false);
  const [projectActionTarget, setProjectActionTarget] = useState<ProjectSummary | null>(null);
  const [sourceProfileId, setSourceProfileId] = useState<string>();
  const [renameProjectName, setRenameProjectName] = useState('');
  const projectActionFromSettings = useRef(false);
  const [initialSpecialistId, setInitialSpecialistId] = useState<string>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('team');
  const [instructionsDraft, setInstructionsDraft] = useState<string>();
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const [personalDirty, setPersonalDirty] = useState(false);
  const savedInstructions = status?.settings.agentInstructions ?? DEFAULT_AGENT_INSTRUCTIONS;
  const agentInstructions = instructionsDraft ?? savedInstructions;
  const openedFastkoreSettings = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false), [searchQuery, setSearchQuery] = useState(''), [searchLoading, setSearchLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('bridge-sidebar-collapsed') === '1');
  const sidebarCollapseButton = useRef<HTMLButtonElement>(null), sidebarExpandButton = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [copied, setCopied] = useState(''), [folderPath, setFolderPath] = useState(''), [projectName, setProjectName] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [agentCatalog, setAgentCatalog] = useState<{ projectId: string; list: AgentSummary[] }>();
  const [preferredAgent, setPreferredAgent] = useState('universal');
  const agents = agentCatalog?.projectId === projectId ? agentCatalog.list : [];
  const availableAgents = agents.filter(agent => agent.available);
  const newAgent = availableAgents.find(agent => agent.id === preferredAgent)?.id ?? '';
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null), [modelsLoading, setModelsLoading] = useState(false), [modelError, setModelError] = useState('');
  const modelLoads = useRef(0);
  const [cliPath, setCliPath] = useState(''), [diagnostics, setDiagnostics] = useState(''), [subscription, setSubscription] = useState<Run | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null);
  const focusedComposer = useRef<HTMLTextAreaElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null), stick = useRef(true), loadingSettings = useRef(false);
  const sending = useRef(false);
  const sendAttempt = useRef<{ chatId: string; content: string; requestId: string } | null>(null);
  const relatedDraftKey = currentErpContext.current.active && erpChatKey ? 'erp:' + erpChatKey : '';
  const draftSlot = chatId || relatedDraftKey;
  const selectedProject = projects.find(p => p.id === projectId), draft = drafts[draftSlot] ?? '', attachments = files[chatId] ?? [];
  const specialistKey = draftSlot || 'new:' + projectId;
  const specialistId = specialists[specialistKey];
  const activeRuns = status?.activeRuns ?? (status?.activeRun ? [status.activeRun] : []);
  const busy = status?.busy ?? activeRuns.length > 0;
  const queuedRuns = status?.queuedRuns ?? [];
  const chatActiveRuns = activeRuns.filter(run => run.status === 'running' && run.projectId === projectId && run.chatId === chatId);
  const chatQueuedRuns = queuedRuns.filter(run => run.status === 'queued' && run.projectId === projectId && run.chatId === chatId);
  const chatBusy = chatActiveRuns.length > 0 || chatQueuedRuns.length > 0;
  const steerTarget = chatActiveRuns.find(run => run.canSteer && run.ownerId === user?.id);
  const isAdmin = user?.role === 'admin';
  const inFastkore = embedded || (authSource === 'fastkore' && !!webViewHost());
  const matchesErpChat = !!erpChatKey && relatedChats?.key === erpChatKey && relatedChats.list.some(item => item.id === chatId && item.contextMatches !== false);
  const relatedLoading = !!erpChatKey && relatedChats?.key !== erpChatKey;
  const tileList = !!currentErpContext.current.snapshot && isFastkoreTileList(currentErpContext.current.snapshot);
  const sharedContextHistory = tileList || typeof currentErpContext.current.snapshot?.chat_key === 'string';
  const canReset = matchesErpChat && chat?.ownerId === user?.id && !chat?.archivedAt && (chat?.messages.length ?? 0) > 0;
  const canEditChatDetails = !!chat && !chat.archivedAt && (isAdmin || chat.ownerId === user?.id);
  const canEdit = canEditChatDetails && (!chat.linkedToFastkore || matchesErpChat || !inFastkore && !erpChatKey);
  const codexUnavailable = status?.isolatedCodex && !executionConnected(status.cli);
  const codexNotice = status?.executionDisabled ? 'Выполнение Codex отключено на сервере.' : codexUnavailable
    ? /активный аккаунт|Модель недоступна/.test(status.cli?.status ?? '') ? status.cli!.status
      : status.cli?.authentication === 'signed-out' ? 'Требуется вход в аккаунт на исполнителе.' : 'Исполнитель модели недоступен.'
    : '';
  const canCreateProject = status?.canCreateProject ?? (isAdmin && authSource === 'local');
  const currentAgent = chat ? agents.find(agent => agent.id === (chat.agentProfileId ?? 'universal')) : undefined;
  const messageAgent = chatId ? currentAgent : availableAgents.find(agent => agent.id === newAgent);
  const otherSpecialists = availableAgents.filter(agent => agent.id !== 'universal' && agent.id !== messageAgent?.id);
  const chatConsultants = otherSpecialists.filter(agent => chat?.consultantIds?.includes(agent.id));
  const availableConsultants = otherSpecialists.filter(agent => !chatConsultants.includes(agent));
  const unavailableConsultant = agents.find(agent => agent.id !== 'universal' && agent.id !== messageAgent?.id && !agent.available && agent.unavailableReason);
  const canAttach = canEdit && messageAgent?.available === true && messageAgent.toolIds.includes('chat-files');
  const canReadFastkore = !!projectId && messageAgent?.toolIds.includes('fastkore') === true;
  const canStartChat = !chatId && !!newAgent && !!selectedProject;
  const canPromptForProject = !!status && !chatId && !projectId && !(relatedLoading && currentErpContext.current.active);
  const canSend = !!status && !(relatedLoading && currentErpContext.current.active) && !status.executionDisabled && !codexUnavailable && (!canReadFastkore || !contextProblem || !!currentErpContext.current.snapshot) && (!attachments.length || canAttach)
    && !!messageAgent?.available && (!specialistId || otherSpecialists.some(agent => agent.id === specialistId)) && (chatId ? canEdit : canStartChat);
  const canManageSettings = isAdmin && !inFastkore;
  const canManageProjects = canManageSettings && authSource === 'local';
  const visibleSettingsSections = (Object.keys(settingsSections) as SettingsSection[]).filter(section =>
    section === 'projects' || section === 'employeeInstructions' ? canManageProjects : canManageSettings || section === 'personal');
  const instructionSettings = settingsSection === 'personal' || settingsSection === 'employeeInstructions';
  const relatedPanelOpen = panel === 'related';
  useEffect(() => {
    if (!loggedIn || !isAdmin || authSource !== 'local' || inFastkore || setupRequired || openedFastkoreSettings.current) return;
    if (new URLSearchParams(location.search).get('settings') !== 'fastkore') return;
    openedFastkoreSettings.current = true;
    setSettingsSection('fastkore');
    setPanel('settings');
  }, [loggedIn, isAdmin, authSource, inFastkore, setupRequired]);
  const theme = inFastkore ? erpTheme?.theme ?? initialErpTheme : browserTheme;
  const modelName = (id?: string) => id ? (catalog?.models.find(m => m.id === id)?.name ?? id) : 'Модель';
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
  function clearLogin() { authEpoch++; browserSession = false; csrfToken = ''; sessionUserId = ''; sendAttempt.current = null; setErpAuth(null); currentErpContext.current = {}; autoOpenRelated.current = undefined; setErpChatKey(undefined); setRelatedChats(undefined); setContextProblem(undefined); readySession.current = null; setAgentCatalog(undefined); setPreferredAgent('universal'); setCatalog(null); setModelError(''); accessKey = ''; sessionStorage.removeItem('bridge-key'); localStorage.removeItem('bridge-project'); localStorage.removeItem('bridge-chat'); setLoggedIn(false); setUser(null); setStatus(null); setProjects([]); setChatLists({}); setOpenProjects({}); setShowAll({}); setSidebarOpen(false); setChat(null); setModelPreview(undefined); setDrafts({}); setFiles({}); setSpecialists({}); setSubscription(null); setPanel(null); setProjectId(''); setChatId(''); setDiagnostics(''); setPasswordInput(''); }
  function logout() { void action(async () => { await post('/api/auth/logout'); clearLogin(); }); }
  useEffect(() => {
    let alive = true;
    const endpoint = embedded ? '/api/auth/me' : '/api/auth/browser-session';
    void fetchApi(endpoint, { credentials: 'same-origin' }).then(readApiJson).then(value => {
      if (!alive) return;
      if (value?.authentication?.source === 'fastkore') {
        clearLogin();
        setInterfaceScale(value.interfaceScale ?? 100);
        browserSession = true; csrfToken = value.authentication.csrfToken; sessionUserId = value.user.id;
        setErpAuth(value.authentication); setAuthSource('fastkore'); setUser(value.user); setSetupRequired(false); setLoggedIn(true);
      } else if (!embedded) setLoggedIn(!!accessKey);
    }).catch(error => {
      if (!alive) return;
      if (embedded && error instanceof ApiError && error.status === 401) {
        fail(new ApiError('Сеанс Fastkore завершён. Откройте помощника из ERP заново.', 401));
      } else fail(error);
    }).finally(() => { if (alive) setCheckingSession(false); });
    return () => { alive = false; };
  }, []);
  async function login(local = false) {
    await action(async () => {
      const result = local ? await api<{ token: string; user: User }>('/api/local-login', { method: 'POST', headers: { 'X-Bridge-Local': '1' } }) : await post<{ token: string; user: User }>('/api/auth/login', { username: loginInput, password: passwordInput });
      saveToken(result.token); setAuthSource('local');
      const me = await api<{ user: User; setupRequired: boolean; interfaceScale: InterfaceScale }>('/api/auth/me');
      setInterfaceScale(me.interfaceScale ?? 100); setUser(me.user); setSetupRequired(me.setupRequired); setLoggedIn(true); setPasswordInput('');
    });
  }
  useEffect(() => {
    if (!loggedIn || authSource === 'fastkore' || user) return;
    let alive = true;
    api<{ user: User; setupRequired: boolean; interfaceScale: InterfaceScale }>('/api/auth/me').then(me => {
      if (alive) { setInterfaceScale(me.interfaceScale ?? 100); setUser(me.user); setSetupRequired(me.setupRequired); }
    }).catch(e => { if (alive) fail(e); });
    return () => { alive = false; };
  }, [loggedIn, authSource, user?.id]);
  useEffect(() => {
    const host = inFastkore ? webViewHost() : undefined;
    if (!host) return;
    const receive = (event: { data: unknown }) => {
      const nextTheme = parseHostTheme(event.data);
      if (nextTheme) setErpTheme({ theme: nextTheme });
      if (erpAuth && isFastkoreContextMessage(event.data)) {
        const snapshot = parseFastkoreContext(event.data) ?? undefined;
        const problem = snapshot ? fastkoreContextProblem(snapshot) : 'Fastkore передал некорректный или неподдерживаемый снимок.';
        const key = snapshot && fastkoreChatContextKey(snapshot);
        const previous = currentErpContext.current;
        const unbound = !key && (snapshot?.chat_key === null || snapshot?.view === 'card' || !snapshot);
        const changed = unbound || key !== previous.key || (!key && snapshot?.view !== previous.snapshot?.view);
        currentErpContext.current = { snapshot, problem, key, active: changed ? Boolean(key || unbound) : previous.active };
        if (changed) {
          contextNavigation.current++;
          setContextVersion(contextNavigation.current);
          autoOpenRelated.current = key;
          setErpChatKey(key);
          setRelatedChats(undefined);
          navigateTo(key ? '' : selected.current.projectId);
          if (!key) {
            setDrafts(old => ({ ...old, '': '' }));
            setSpecialists(old => ({ ...old, ['new:' + selected.current.projectId]: undefined }));
          }
          setPanel(panel => panel === 'reset-chat' || (!key && panel === 'related') ? null : panel);
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
      setModelPreview(undefined);
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
    const navigation = contextNavigation.current;
    const epoch = authEpoch;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const stillCurrent = () => !controller.signal.aborted && authEpoch === epoch && currentErpContext.current.key === erpChatKey && contextNavigation.current === navigation;
    async function refreshRelated() {
      if (!stillCurrent()) return;
      try {
        const list = await postRelated();
        if (!stillCurrent()) return;
        if (autoOpenRelated.current !== erpChatKey) { setRelatedChats({ key: erpChatKey!, list }); return; }
        const matching = list.find(item => item.contextMatches !== false && !item.legacyContext)
          ?? (context?.view === 'list' && !context.tile_id ? list.find(item => item.legacyContext) : undefined);
        if (matching) {
          setRelatedChats({ key: erpChatKey!, list });
          navigateToRelated(matching);
          return;
        }
        autoOpenRelated.current = undefined;
        setRelatedChats({ key: erpChatKey!, list });
      } catch (error) {
        if (!stillCurrent()) return;
        if (error instanceof ApiError && error.transient) {
          retry = setTimeout(() => void refreshRelated(), 1200);
          return;
        }
        autoOpenRelated.current = undefined;
        setRelatedChats({ key: erpChatKey!, list: [] });
        fail(error);
      }
    }
    const postRelated = () => api<RelatedChatSummary[]>('/api/fastkore/chats/related', {
      method: 'POST', body: JSON.stringify({ context }), signal: controller.signal,
    });
    void refreshRelated();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [erpChatKey, relatedPanelOpen, contextVersion]);
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
    if (!loggedIn || !user || setupRequired) { setReconnecting(false); return; }
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    let consecutiveFailures = 0;
    async function refresh() {
      try {
        const projectAtStart = selected.current.projectId;
        const [state, list] = await Promise.all([api<Status>('/api/status'), api<ProjectSummary[]>('/api/projects')]);
        if (disposed) return;
        setStatus(state); setUser(state.user);
        const activeProjectExists = list.some(p => p.id === selected.current.projectId);
        if (activeProjectExists || projectAtStart === selected.current.projectId) setProjects(list);
        if (!activeProjectExists && projectAtStart === selected.current.projectId) {
          const awaitingContextProject = currentErpContext.current.active && !!currentErpContext.current.key;
          if (awaitingContextProject ? projectAtStart : projectAtStart || list.length) {
            navigateTo(awaitingContextProject ? '' : list[0]?.id ?? '');
          }
        }
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
        if (!disposed) { consecutiveFailures = 0; setReconnecting(false); }
      } catch (e) {
        if (!disposed) {
          if (e instanceof ApiError && e.transient) {
            if (++consecutiveFailures >= 3) setReconnecting(true);
          } else fail(e);
        }
      }
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
    }).catch(e => { if (!disposed && !(e instanceof ApiError && e.transient)) fail(e); });
    return () => { disposed = true; };
  }, [projectId, loggedIn, !!selectedProject]);
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || !projectId || !chatId || !selectedProject) return;
    let disposed = false;
    const stillSelected = () => !disposed && selected.current.projectId === projectId && selected.current.chatId === chatId;
    api<Chat>(`/api/projects/${projectId}/chats/${chatId}`).then(detail => { if (stillSelected()) setChat(detail); }).catch(error => {
      if (stillSelected() && !(error instanceof ApiError && error.transient)) fail(error);
    });
    return () => { disposed = true; };
  }, [chatId, projectId, loggedIn, !!selectedProject]);
  useEffect(() => { if (stick.current) end.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat?.messages.length, chat?.messages.at(-1)?.text, chatId]);
  useEffect(() => {
    if (!subscription || subscription.status !== 'running') return;
    const timer = setInterval(() => { api<Run>(`/api/runs/${subscription.id}`).then(setSubscription).catch(fail); }, 1200);
    return () => clearInterval(timer);
  }, [subscription?.id, subscription?.status]);
  async function loadModels(refresh = false, signal?: AbortSignal) {
    const load = ++modelLoads.current;
    setModelsLoading(true); setModelError('');
    try {
      const models = await (refresh ? post<ModelCatalog>('/api/models/refresh') : api<ModelCatalog>('/api/models', { signal }));
      if (!signal?.aborted && modelLoads.current === load) setCatalog(models);
    } catch (error) {
      if (signal?.aborted || modelLoads.current !== load || (error as Error).name === 'AbortError') return;
      setModelError((error as Error).message);
      return error instanceof ApiError && error.transient;
    } finally { if (modelLoads.current === load) setModelsLoading(false); }
  }
  useEffect(() => {
    if (!loggedIn || !user || setupRequired || !status || codexUnavailable) {
      modelLoads.current++;
      setModelsLoading(false);
      if (codexUnavailable) setCatalog(null);
      return;
    }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function refresh(attempt = 0) {
      const retryable = await loadModels(false, controller.signal);
      if (retryable && !controller.signal.aborted && attempt < 2) retry = setTimeout(() => void refresh(attempt + 1), 1200);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [loggedIn, !!user, setupRequired, !!status, codexUnavailable, status?.cli?.catalogRevision]);
  async function changeModel(model: string) {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}`, { method: 'PATCH', body: JSON.stringify({ model }) });
      if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated);
    });
  }
  async function changeReasoning(reasoningEffort: Settings['reasoningEffort']) {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}`, { method: 'PATCH', body: JSON.stringify({ reasoningEffort }) });
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
    const agent = choices.find(item => item.id === preferredAgent);
    if (!agent) throw new Error('В этом проекте вам пока не доступен ни один агент.');
    const result = context ? await post<{ projectId: string; chat: Chat }>('/api/fastkore/chats', { projectId: project, context, fresh, agentProfileId: agent.id })
      : { projectId: project, chat: await post<Chat>(`/api/projects/${project}/chats`, { agentProfileId: agent.id }) };
    const { id, title, updatedAt, ownerId, ownerName, visibility, messages, linkedToFastkore } = result.chat;
    const summary: ChatSummary = { id, title, updatedAt, ownerId, ownerName, visibility, linkedToFastkore, messageCount: messages.length };
    const p = result.projectId;
    setChatLists(old => ({ ...old, [p]: [summary, ...(old[p] ?? []).filter(item => item.id !== id)] }));
    const key = context && fastkoreChatContextKey(context);
    if (key && currentErpContext.current.key === key) {
      const entry = { ...summary, projectId: p, projectName: projects.find(item => item.id === p)?.name ?? '' };
      setRelatedChats(old => ({ key, list: [entry, ...(old?.key === key ? old.list.filter(item => item.id !== id) : [])] }));
    }
    return result;
  }
  async function newChat(project = projectId, linked = !!relatedDraftKey) {
    const navigation = contextNavigation.current;
    const context = linked ? currentErpContext.current.snapshot : undefined;
    const key = context && currentErpContext.current.key;
    if (!project || pending || relatedLoading && linked || (project === projectId && !newAgent)) return;
    await action(async () => {
      const { chat: created, projectId: p } = await createChat(project, context, true);
      if (contextNavigation.current !== navigation || key && currentErpContext.current.key !== key) return;
      if (!selected.current.chatId) {
        setDrafts(old => old[draftSlot] ? { ...old, [created.id]: old[draftSlot], [draftSlot]: '' } : old);
        if (project === projectId) setSpecialists(old => ({ ...old, [created.id]: old[specialistKey], [specialistKey]: undefined }));
      }
      currentErpContext.current.active = !!key;
      navigateTo(p, created.id);
      setChat(created);
      setPanel(current => current === 'related' ? null : current);
      input.current?.focus();
    });
  }
  async function selectComposerProject(project: string) {
    if (chat && project !== projectId) {
      await moveChatToProject(projectId, chat.id, project);
      return;
    }
    const { active, key, snapshot } = currentErpContext.current;
    const context = active && key ? snapshot : undefined;
    if (!context && !projectRequested) {
      if (active) navigateTo(project);
      else navigateWorkspace(project);
      return;
    }
    const navigation = contextNavigation.current, epoch = authEpoch, previous = selected.current;
    const { chat: created, projectId: destination } = await createChat(project, context);
    if (authEpoch !== epoch || contextNavigation.current !== navigation || selected.current.projectId !== previous.projectId ||
      selected.current.chatId !== previous.chatId ||
      (context && (!currentErpContext.current.active || currentErpContext.current.key !== key))) return;
    setDrafts(old => ({ ...old, [created.id]: old[draftSlot] || old[created.id] || '', [draftSlot]: '' }));
    setSpecialists(old => ({ ...old, [created.id]: old[specialistKey] ?? old[created.id], [specialistKey]: undefined }));
    navigateTo(destination, created.id);
    setChat(created);
  }
  async function changeVisibility(visibility: 'private' | 'project') {
    const p = projectId, c = chatId;
    await action(async () => {
      const updated = await api<Chat>(`/api/projects/${p}/chats/${c}/visibility`, { method: 'PATCH', body: JSON.stringify({ visibility }) });
      if (selected.current.projectId === p && selected.current.chatId === c) setChat(updated);
      await loadChats(p);
    });
  }
  function changeSidebarCollapsed(collapsed: boolean) {
    setSidebarCollapsed(collapsed);
    localStorage.setItem('bridge-sidebar-collapsed', collapsed ? '1' : '0');
    requestAnimationFrame(() => (collapsed ? sidebarExpandButton : sidebarCollapseButton).current?.focus());
  }
  async function moveChatToProject(source: string, conversation: string, destination: string, title?: string) {
    if (files[conversation]?.length) throw new Error('Перед переносом отправьте или уберите файлы из черновика.');
    const moved = await api<Chat>(`/api/projects/${source}/chats/${conversation}/move`, {
      method: 'PATCH', body: JSON.stringify({ projectId: destination, title }),
    });
    const { id, title: newTitle, updatedAt, messages, ownerId, ownerName, visibility, linkedToFastkore } = moved;
    const summary = { id, title: newTitle, updatedAt, messageCount: messages.length, ownerId, ownerName, visibility, linkedToFastkore };
    const projectName = projects.find(project => project.id === destination)?.name ?? '';
    setChatLists(old => ({
      ...old,
      [source]: (old[source] ?? []).filter(item => item.id !== conversation),
      [destination]: [{ ...summary, pinned: old[source]?.find(item => item.id === conversation)?.pinned },
        ...(old[destination] ?? []).filter(item => item.id !== conversation)],
    }));
    setRelatedChats(old => old && { ...old, list: old.list.map(item => item.id === conversation
      ? { ...item, title: newTitle, projectId: destination, projectName: projectName || item.projectName } : item) });
    if (selected.current.projectId === source && selected.current.chatId === conversation) {
      navigateTo(destination, conversation);
      setChat(moved);
    }
    void Promise.all([loadChats(source), loadChats(destination)]).catch(fail);
  }
  async function renameChat() {
    if (!renameDraft || pending) return;
    const { projectId: p, chatId: c, title, destinationId = p } = renameDraft;
    if (!title.trim()) return;
    await action(async () => {
      if (destinationId !== p) {
        await moveChatToProject(p, c, destinationId, title.trim());
        setPanel(current => current === 'rename-chat' ? null : current);
        setRenameDraft(undefined);
        return;
      }
      const updated = await api<{ title: string }>(`/api/projects/${p}/chats/${c}/title`, {
        method: 'PATCH', body: JSON.stringify({ title: title.trim() }),
      });
      setChat(old => old?.id === c ? { ...old, title: updated.title } : old);
      setChatLists(old => ({ ...old, [p]: (old[p] ?? []).map(item => item.id === c ? { ...item, title: updated.title } : item) }));
      setRelatedChats(old => old && { ...old, list: old.list.map(item => item.id === c ? { ...item, title: updated.title } : item) });
      setPanel(current => current === 'rename-chat' ? null : current);
      setRenameDraft(undefined);
    });
  }
  async function changeChatConsultants(consultantIds: string[]) {
    const p = projectId, c = chatId;
    await action(async () => {
      const saved = await api<{ consultantIds: string[] }>(`/api/projects/${p}/chats/${c}/specialists`, {
        method: 'PATCH', body: JSON.stringify({ consultantIds }),
      });
      if (selected.current.projectId === p && selected.current.chatId === c) {
        setChat(old => old?.id === c ? { ...old, consultantIds: saved.consultantIds } : old);
      }
    });
  }
  async function toggleChatPin(project: string, summary: ChatSummary) {
    if (pending) return;
    const conversation = summary.id;
    await action(async () => {
      const { pinned } = await api<{ pinned: boolean }>(`/api/projects/${project}/chats/${conversation}/pin`, {
        method: 'PATCH', body: JSON.stringify({ pinned: !summary.pinned }),
      });
      setChatLists(old => ({ ...old, [project]: (old[project] ?? []).map(item => item.id === conversation ? { ...item, pinned } : item) }));
    });
  }
  async function archiveChat(p = projectId, c = chatId) {
    await action(async () => {
      await api(`/api/projects/${p}/chats/${c}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
      setChatLists(old => ({ ...old, [p]: (old[p] ?? []).filter(item => item.id !== c) }));
      setRelatedChats(old => old && { ...old, list: old.list.filter(item => item.id !== c) });
      if (selected.current.projectId === p && selected.current.chatId === c) navigateTo(p);
      await loadChats(p);
    });
  }
  async function deleteEmptyChat(p = projectId, c = chatId) {
    await action(async () => {
      await api(`/api/projects/${p}/chats/${c}`, { method: 'DELETE' });
      setChatLists(old => ({ ...old, [p]: (old[p] ?? []).filter(item => item.id !== c) }));
      setRelatedChats(old => old && { ...old, list: old.list.filter(item => item.id !== c) });
      if (selected.current.projectId === p && selected.current.chatId === c) navigateTo(p);
      await loadChats(p);
    });
  }
  async function resetChat() {
    const { key, snapshot } = currentErpContext.current;
    if (!canReset || chatBusy || pending || !key || !snapshot) return;
    const p = projectId, c = chatId, epoch = authEpoch, navigation = contextNavigation.current;
    await action(async () => {
      const replacement = await post<Chat>(`/api/projects/${p}/chats/${c}/reset`, { context: snapshot });
      if (epoch !== authEpoch) return;
      const { id, title, updatedAt, ownerId, ownerName, visibility, linkedToFastkore } = replacement;
      const summary = { id, title, updatedAt, ownerId, ownerName, visibility, linkedToFastkore, messageCount: replacement.messages.length };
      setChatLists(old => ({ ...old, [p]: [summary, ...(old[p] ?? []).filter(item => item.id !== c && item.id !== id)] }));
      const entry = { ...summary, projectId: p, projectName: selectedProject?.name ?? 'Личные чаты' };
      setRelatedChats(old => old?.key === key ? { key, list: [entry, ...old.list.filter(item => item.id !== c && item.id !== id)] } : old);
      setDrafts(old => ({ ...old, [c]: '' }));
      setSpecialists(old => ({ ...old, [c]: undefined }));
      setFiles(old => ({ ...old, [c]: [] }));
      if (sendAttempt.current?.chatId === c) sendAttempt.current = null;
      if (contextNavigation.current === navigation && currentErpContext.current.key === key && selected.current.projectId === p && (selected.current.chatId === c || !selected.current.chatId)) {
        navigateToRelated(entry);
        setChat(replacement);
      }
      setPanel(panel => panel === 'reset-chat' ? null : panel);
    });
  }
  async function send(override?: string) {
    const navigation = contextNavigation.current;
    const text = (override ?? draft).trim();
    if (!text || pending || sending.current) return;
    if (canPromptForProject) {
      setProjectRequested(true);
      projectPicker.current?.open();
      return;
    }
    const link = relatedDraftKey ? currentErpContext.current : undefined;
    const { snapshot, problem } = currentErpContext.current.active || matchesErpChat || (!chat?.linkedToFastkore &&
      (canReadFastkore || otherSpecialists.some(agent => agent.toolIds.includes('fastkore')))) ? currentErpContext.current : {};
    if (!canSend || (canReadFastkore && problem && !snapshot)) return;
    const attachmentIds = attachments.map(a => a.id);
    sending.current = true;
    try {
      await action(async () => {
        const targetProject = projectId;
        let project = targetProject, conversation = chatId;
        if (!conversation) {
          const { chat: created, projectId: p } = await createChat(project, link?.snapshot);
          project = p;
          conversation = created.id;
          const pSelected = selected.current.projectId;
          const shouldOpen = contextNavigation.current === navigation && (pSelected === projectId || pSelected === targetProject) && !selected.current.chatId
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
        setStatus(old => old ? { ...old, ...(run.status === 'queued' ? { queuedRuns: [...(old.queuedRuns ?? []).filter(r => r.id !== run.id), { ...run, queuedText: text.slice(0, 240), queuedFiles: attachmentIds.length }] } : run.status === 'running' ? { activeRuns: [...(old.activeRuns ?? []).filter(r => r.id !== run.id), run], activeRun: run } : {}) } : old);
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
  async function changeInterfaceScale(scale: InterfaceScale) {
    if (savingScale || scale === interfaceScale) return;
    const epoch = authEpoch;
    setScalePendingEpoch(epoch);
    setInterfaceScale(scale);
    try {
      await api('/api/me/preferences', { method: 'PATCH', body: JSON.stringify({ interfaceScale: scale }) });
    } catch (cause) {
      if (epoch === authEpoch) { setInterfaceScale(interfaceScale); fail(cause); }
    } finally {
      if (epoch === authEpoch) setScalePendingEpoch(undefined);
    }
  }
  function showSettings() {
    setInitialSpecialistId(undefined);
    if (accountMenu.current) accountMenu.current.open = false;
    setSidebarOpen(false);
    setSettingsSection(canManageSettings ? 'team' : 'personal');
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
    if ((knowledgeDirty || personalDirty) && !window.confirm('Перейти в другой раздел и удалить несохранённые изменения?')) return;
    setInitialSpecialistId(undefined);
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
  const canUseChatTools = !!status && !status.executionDisabled && !codexUnavailable && messageAgent?.available && (chatId ? canEdit : canStartChat);
  const writeMode = !!(canUseChatTools && status.settings.allowWrite && messageAgent.allowWrite &&
    (!status.isolatedCodex || status.workerFilesAvailable && messageAgent.toolIds.includes('chat-files')));
  function renderChatAccess() {
    if (!status) return <p role="status" className="help">Загрузка…</p>;
    const permissions = [
      { name: 'Запись файлов', enabled: writeMode, description: status.isolatedCodex
        ? 'Файлы сохраняются в папке задания.'
        : 'Файлы сохраняются в папке проекта.' },
      { name: 'Fastkore CLI', enabled: canUseChatTools && canReadFastkore && status.toolPermissions?.cli },
      { name: 'Fastkore MCP', enabled: canUseChatTools && canReadFastkore && status.toolPermissions?.mcp },
      { name: 'Веб-поиск', enabled: canUseChatTools && status.toolPermissions?.webSearch,
        description: 'Поиск в интернете.' },
      { name: 'Чтение страниц', enabled: canUseChatTools && status.toolPermissions?.webRead,
        description: 'Чтение публичных веб-страниц по ссылке.' },
    ];
    return <div className="chat-access-settings">
      <ul className="settings-records">{permissions.map(({ name, enabled, description }) => <li key={name}>
        <div><strong>{name}</strong>{description && <small>{description}</small>}</div>
        <span className="chat-permission-state" data-enabled={!!enabled}>
          {enabled ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
          {enabled ? 'Разрешено' : 'Недоступно'}
        </span>
      </li>)}</ul>
    </div>;
  }
  const catalogOptions = catalog?.models.filter(model => !isAutomaticModel(model.id)).map(model => ({ value: model.id, label: model.name })) ?? [];
  const chatModel = concreteModel(catalog, chat?.model || messageAgent?.model || status?.settings.model);
  const chatReasoning = chat?.reasoningEffort ?? status?.settings.reasoningEffort ?? 'high';
  const chatReasoningOptions = chatModel.startsWith('glm') ? reasoningOptions.filter(option => option.value !== 'medium') : reasoningOptions;
  const chatModels = [
    ...(chatModel && !catalogOptions.some(model => model.value === chatModel) ? [{ value: chatModel, label: modelName(chatModel) }] : []),
    ...catalogOptions,
  ];
  const serverModel = concreteModel(catalog, status?.settings.model);
  const serverModels = [
    ...(serverModel && !catalogOptions.some(model => model.value === serverModel) ? [{ value: serverModel, label: modelName(serverModel) }] : []),
    ...catalogOptions,
  ];
  function openProjectPanel(project: ProjectSummary, next: 'project-files' | 'project-agents' | 'project-sources' | 'rename-project', trigger: HTMLButtonElement) {
    trigger.closest('details')?.removeAttribute('open');
    setError('');
    projectActionFromSettings.current = panel === 'settings';
    setProjectActionTarget(project);
    if (next === 'rename-project') setRenameProjectName(project.name);
    setPanel(next);
  }
  function renderProjectActions(project: ProjectSummary) {
    return <>
      <button type="button" className="workspace-row" onClick={event => openProjectPanel(project, 'project-files', event.currentTarget)}><FileText size={15} />Файлы проекта</button>
      <button type="button" className="workspace-row" onClick={event => openProjectPanel(project, 'project-agents', event.currentTarget)}><Bot size={15} />Специалисты проекта</button>
      <button type="button" className="workspace-row" onClick={event => openProjectPanel(project, 'project-sources', event.currentTarget)}><Database size={15} />Библиотека</button>
    </>;
  }
  const closeProjectPanel = () => setPanel(projectActionFromSettings.current ? 'settings' : null);
  const closePanel = () => {
    if ((knowledgeDirty || personalDirty) && !window.confirm('Закрыть настройки и удалить несохранённые изменения?')) return;
    projectFromComposer.current = false;
    setPanel(null);
  };
  const renderHistory = (conversation: Chat, project: string) => <>
      {conversation.messages.filter(message => message.status !== 'running' || message.text.trim() || message.attachments.length)
        .map(message => <article key={message.id} className={'conversation-message is-' + message.role}>
        {message.role === 'assistant' ? message.text && <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          img: ({ alt }) => <span>[Изображение: {alt}]</span>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}>{message.text}</ReactMarkdown></div> :
          <div className="question-bubble">
            {message.authorId && message.authorId !== user.id && <small title={dateTooltip(message.createdAt, message.authorName ?? conversation.ownerName)}>{shortUserName(message.authorName ?? conversation.ownerName)}</small>}
            {message.specialistName && <small title="Рекомендованный специалист">@{message.specialistName}</small>}
            {message.text}
          </div>}
        {message.attachments.length > 0 && <div className="conversation-files">{message.attachments.map(file => {
          if (!canReadChatAttachment(file, message, conversation.ownerId, user)) {
            return <span key={file.id}><FileText size={16} />{file.name}</span>;
          }
          const url = `/api/projects/${encodeURIComponent(project)}/chats/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(message.id)}/files/${encodeURIComponent(file.id)}`;
          const format = previewModelFormat(file.name);
          const download = () => void action(() => downloadChatFile(url, file.name));
          if (format) return <React.Fragment key={file.id}>
            <button type="button" title="Просмотреть 3D-модель" aria-label={'Просмотреть модель ' + file.name}
              onClick={() => setModelPreview({ name: file.name, url, format })}><Box size={16} />{file.name}</button>
            <button type="button" aria-label={'Скачать ' + file.name} title={'Скачать ' + file.name}
              onClick={download}><Download size={16} /></button>
          </React.Fragment>;
          return <button type="button" key={file.id} title={'Скачать ' + file.name} onClick={download}><FileText size={16} />{file.name}</button>;
        })}</div>}
        {['error', 'cancelled', 'interrupted'].includes(message.status) && <div className="message-note">{message.status === 'error' ? 'Ошибка задания' : message.status === 'cancelled' ? 'Задание остановлено' : message.role === 'user' ? 'Доставка уточнения не подтверждена' : 'Задание прервано'}</div>}
        {message.consultedSpecialists?.length ? <div className="message-specialists">Специалисты · {message.consultedSpecialists.join(', ')}</div> : null}
        <div className="message-actions">
          {message.text && <button className="workspace-icon" aria-label="Копировать сообщение" title="Копировать сообщение" onClick={() => void copyItem(message.text, message.id)}>{copied === message.id ? <Check size={14} /> : <Copy size={14} />}</button>}
          <time dateTime={message.createdAt} title={[
            dateTooltip(message.createdAt, message.role === 'user' ? message.authorName ?? (message.authorId === user.id ? user.name : conversation.ownerName) : 'Codex'),
            message.usage && 'Вход: ' + message.usage.inputTokens.toLocaleString('ru-RU') + ' · Выход: ' + message.usage.outputTokens.toLocaleString('ru-RU'),
          ].filter(Boolean).join('\n')}>{shortDate(message.createdAt)}</time>
        </div>
      </article>)}
  </>;
  const createProjectOption = '+project';
  const showChatConsultants = !!chat && (canEdit || chatConsultants.length > 0);
  function rememberComposerFocus(event: React.MouseEvent) {
    const field = input.current;
    focusedComposer.current = event.button === 0 && field === document.activeElement &&
      event.target instanceof Element && !event.target.closest(focusControls) ? field : null;
  }
  function restoreComposerFocus(event: React.MouseEvent) {
    const field = focusedComposer.current;
    focusedComposer.current = null;
    if (!field || field !== input.current || field.disabled || event.detail === 0 || event.defaultPrevented ||
        !(event.target instanceof Element) || event.target.closest(focusControls) || window.getSelection()?.isCollapsed === false) return;
    const active = document.activeElement;
    if (active !== field && active?.contains(event.target) && !active.closest(focusControls)) field.focus({ preventScroll: true });
  }
  const composer = <div className="bridge-composer">
    {chat && !canEdit && (relatedLoading
      ? <p className="composer-status" role="status">Проверяем связь чата с открытым окном Fastkore…</p>
      : chat.linkedToFastkore && chat.ownerId === user.id && !chat.archivedAt
        ? <LinkedFastkoreNotice key={chat.id} />
        : <p className="composer-status" role="alert">Чат доступен для чтения</p>)}
    {codexNotice && draftEditable && <p className="composer-status" role="status">{codexNotice} Можно подготовить черновик.</p>}
    {canReadFastkore && contextProblem && <p className="composer-status" role="alert">{contextProblem}</p>}
    {!!attachments.length && !canAttach && <p className="composer-status" role="status">Удалите вложения из черновика. Агенту сейчас не разрешено их читать.</p>}
    {canReadFastkore && inFastkore && status?.fastkoreToolsStatus === 'reauth' && <p className="composer-status" role="status">Для доступа к ERP откройте помощника из Fastkore заново.</p>}
    {canPromptForProject && projectRequested ? <p className="composer-status" role="alert">
      {projects.length || canCreateProject ? 'Выберите проект, чтобы отправить сообщение.' : 'Нет доступных проектов. Попросите администратора дать доступ к проекту.'}
    </p> : !projectId && status && !canCreateProject && !projects.length && <p className="composer-status">Для отправки администратор должен дать вам доступ к проекту.</p>}
    {agentCatalog?.projectId === projectId && chat && canEdit && !currentAgent?.available && <p className="composer-status">{currentAgent?.unavailableReason ?? 'Агент этого чата вам сейчас недоступен.'}</p>}
    {agentCatalog?.projectId === projectId && !chatId && status && (projectId || canCreateProject) && !availableAgents.length && <p className="composer-status">Для нового чата нужен доступ к агенту проекта.</p>}
    {chatQueuedRuns.map(run => <div className="bridge-progress queued-message" key={run.id}>
      <span>{run.steeringTo ? 'Отправляется…' : 'В очереди'}</span>
      {run.queuedText && <span className="queued-message-text" title={run.queuedText}>{run.queuedText}</span>}
      {canEdit && steerTarget && run.ownerId === user.id && !run.queuedFiles && run.model === steerTarget.model &&
        <button type="button" className="workspace-icon" aria-label="Отправить сейчас" title="Отправить сейчас" disabled={pending || !!run.steeringTo} onClick={() => void action(async () => {
          const result = await post<{ result: 'accepted' | 'rejected' | 'unknown' }>('/api/runs/' + run.id + '/send-now', { targetRunId: steerTarget.id });
          if (result.result === 'rejected') throw new Error('Текущий ход не принял уточнение. Сообщение осталось в очереди.');
          setStatus(old => old && { ...old, queuedRuns: old.queuedRuns.filter(item => item.id !== run.id) });
        })}><ArrowUp size={16} aria-hidden="true" /></button>}
      {canEdit && <button type="button" className="workspace-icon" aria-label="Отменить отправку" title="Отменить отправку" disabled={pending || !!run.steeringTo} onClick={() => void action(async () => {
        const cancelled = await post<Run>('/api/runs/' + run.id + '/cancel');
        if (cancelled.status === 'cancelled') setStatus(old => old && { ...old, queuedRuns: old.queuedRuns.filter(item => item.id !== run.id) });
      })}><X size={16} aria-hidden="true" /></button>}
    </div>)}
    {chatActiveRuns.map(run => <div className="bridge-progress" key={run.id}>
      <span role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{run.tool
        ? <span title={run.tool}>{runToolLabel(run.tool, run.toolContext)}</span>
        : <span className="sr-only">Ответ готовится</span>}</span>
      {(isAdmin || (run.chatId === chatId && canEdit)) && <button onClick={() => void action(async () => { await post('/api/runs/' + run.id + '/cancel'); })}><Square size={12} />Остановить</button>}
    </div>)}
    {(!hasMessages || showChatConsultants) && <div className="composer-project">
      {!hasMessages && <div className="composer-project-picker">
        <Folder size={17} aria-hidden="true" />
        <Select ref={projectPicker} label="Проект" placeholder="Выберите проект" value={projectId}
          disabled={pending || (relatedLoading && !!relatedDraftKey) || (!!chatId && !canEditChatDetails)}
          onChange={project => {
            if (project === createProjectOption) {
              projectFromComposer.current = true;
              setPanel('project');
            } else void action(() => selectComposerProject(project));
          }}
          options={[
            ...projects.map(project => ({ value: project.id, label: project.name })),
            ...(canCreateProject ? [{ value: createProjectOption, label: '+ Создать проект' }] : []),
          ]} />
      </div>}
      {showChatConsultants && <div key={'consultants:' + chat.id} className="chat-consultants">
        {chatConsultants.map(agent => <span key={agent.id} className="chat-consultant">
          <Bot size={14} aria-hidden="true" />
          {agent.name}
          {canEdit && <button type="button" className="workspace-icon" disabled={pending}
            aria-label={'Отключить специалиста ' + agent.name} title="Отключить специалиста"
            onClick={() => void changeChatConsultants(chatConsultants.filter(item => item.id !== agent.id).map(item => item.id))}>
            <X size={13} />
          </button>}
        </span>)}
        {canEdit && (availableConsultants.length > 0
          ? <Select className="chat-consultants-select" label="Подключить специалиста" placeholder="Подключить специалиста"
            value="" disabled={pending} onChange={id => void changeChatConsultants([...chatConsultants.map(item => item.id), id])}
            options={availableConsultants.map(agent => ({ value: agent.id, label: agent.name }))} />
          : agentCatalog?.projectId === projectId && <span className="chat-consultant-notice">
            {otherSpecialists.length ? 'Все доступные специалисты подключены' : unavailableConsultant
              ? `${unavailableConsultant.name}: ${unavailableConsultant.unavailableReason}` : 'Нет доступных дополнительных специалистов'}
          </span>)}
      </div>}
    </div>}
    <div className="bridge-editor">
      {attachments.length > 0 && <div className="attachment-chips">{attachments.map(attachment => <span key={attachment.id}>
        <FileText size={14} />{attachment.name}<button aria-label={'Убрать ' + attachment.name} onClick={() => setFiles(old => ({ ...old, [chatId]: (old[chatId] ?? []).filter(item => item.id !== attachment.id) }))}><X size={13} /></button>
      </span>)}</div>}
      <ComposerInput key={specialistKey} input={input} draft={draft}
        placeholder={hasMessages ? 'Продолжить разговор…' : 'Напишите сообщение…'}
        editable={draftEditable} pickerEnabled={draftEditable && !pending && (chatId ? canEdit : !!selectedProject)}
        agents={otherSpecialists} specialistId={specialistId}
        onDraft={text => setDrafts(old => ({ ...old, [draftSlot]: text }))}
        onSpecialist={id => setSpecialists(old => ({ ...old, [specialistKey]: id }))}
        onSend={() => void send()} controls={pickerButton => <div className="bridge-editor-controls">
        <input type="file" multiple ref={fileInput} onChange={e => void upload(e.target.files)} />
        <button className="workspace-icon" title={canAttach ? 'Прикрепить файл' : 'Агенту не разрешено читать вложения'} aria-label="Прикрепить файл" onClick={() => fileInput.current?.click()} disabled={!canAttach || pending}><Plus size={19} /></button>
        {pickerButton}
        <ChatAccessPopover writable={writeMode}>{renderChatAccess()}</ChatAccessPopover>
        <div className="composer-actions">
          <ModelPicker key={status?.cli?.accountId} request={api} unavailableReason={codexNotice} revision={status?.codexLimitsRevision}
            model={chatModel} options={chatModels} effort={chatModel.startsWith('glm') && chatReasoning === 'medium' ? 'high' : chatReasoning}
            levels={chatReasoningOptions} disabled={!canEdit || chatBusy || pending || modelsLoading}
            onModel={model => void changeModel(model)} onEffort={value => void changeReasoning(value)} />
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
          <button className="bridge-send" aria-label={chatBusy ? 'Добавить в очередь' : 'Отправить вопрос'}
            title={canPromptForProject ? 'Выбрать проект · Enter' : codexNotice || (chatBusy ? 'В очередь · Enter' : 'Отправить · Enter')}
            onClick={() => void send()} disabled={(!canSend && !canPromptForProject) || !draft.trim() || pending}><ArrowUp size={18} /></button>
        </div>
      </div>} />
    </div>
    {!chatId && canCreate && <button className="empty-new-chat" onClick={() => void newChat()}><SquarePen size={15} />Создать чат</button>}
  </div>;

  return <div className="workspace-shell" data-theme={theme} data-fastkore={inFastkore ? '' : undefined}
    style={{ '--interface-scale': interfaceScale / 100 } as React.CSSProperties}
    onMouseDownCapture={rememberComposerFocus} onClick={restoreComposerFocus}>
    {sidebarOpen && <button className="workspace-scrim" aria-label="Закрыть навигацию" onClick={() => setSidebarOpen(false)} />}
    <aside id="workspace-sidebar" className={'workspace-sidebar' + (sidebarOpen ? ' is-open' : '') + (sidebarCollapsed ? ' is-collapsed' : '')} aria-label="Боковая панель">
      <div className="workspace-brand"><span className="workspace-mark"><Terminal size={16} /></span><b>Agentic Platform</b>
        <button ref={sidebarCollapseButton} type="button" className="workspace-icon workspace-sidebar-toggle workspace-sidebar-collapse"
          aria-label="Свернуть боковую панель" title="Свернуть боковую панель" aria-controls="workspace-sidebar" aria-expanded="true"
          onClick={() => changeSidebarCollapsed(true)}><PanelLeftClose size={18} /></button>
        <button type="button" className="workspace-icon workspace-mobile-close" aria-label="Закрыть боковую панель" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
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
          const pinned = list.filter(item => item.pinned);
          const recent = list.filter(item => !item.pinned);
          const visible = [...pinned, ...(showAll[project.id] ? recent : recent.slice(0, 5))];
          const canManageProject = canManageProjects;
          const newChatDisabled = pending || (project.id === projectId && !newAgent);
          return <div key={project.id} className="project-group">
            <div className="project-line">
              <button className="workspace-row project-row" onClick={() => toggleProject(project.id)} aria-expanded={open} aria-controls={'chats-' + project.id} title={project.name}>
                <Folder size={14} /><span>{project.name}</span>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {!canManageProject && <button className="workspace-icon project-new-chat" title="Новый чат в проекте" aria-label={'Новый чат в проекте ' + project.name} disabled={newChatDisabled} onClick={() => void newChat(project.id, false)}><SquarePen size={17} /></button>}
              {canManageProject && <details className="project-actions" onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
              }} onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.currentTarget.open = false;
                  e.currentTarget.querySelector('summary')?.focus();
                }
              }}>
                <summary className="workspace-icon" aria-label={'Действия проекта ' + project.name} title="Действия проекта"><EllipsisVertical size={16} /></summary>
                <div className="project-actions-menu">
                  <button type="button" className="workspace-row" disabled={newChatDisabled} onClick={event => {
                    event.currentTarget.closest('details')?.removeAttribute('open');
                    void newChat(project.id, false);
                  }}><SquarePen size={15} />Новый чат</button>
                  {renderProjectActions(project)}
                  <button type="button" className="workspace-row" onClick={event => openProjectPanel(project, 'rename-project', event.currentTarget)}><Pencil size={15} />Переименовать проект</button>
                </div>
              </details>}
            </div>
            {open && <div className="project-chat-list" id={'chats-' + project.id}>
              {visible.map((item, index) => <React.Fragment key={item.id}>
                {pinned.length > 0 && index === pinned.length && <hr className="project-chat-divider" />}
                <div className="chat-row-container">
                  <button type="button" className="workspace-row chat-row" aria-current={item.id === chatId ? 'page' : undefined}
                    onClick={() => navigateWorkspace(project.id, item.id)} title={chatTooltip(item)}>
                    {item.pinned && <Pin size={13} className="chat-row-pin" aria-label="Закреплённый чат" />}
                    <span>{item.title}</span>
                    <span className="chat-row-time">{activeRuns.some(run => run.status === 'running' && run.projectId === project.id && run.chatId === item.id) ? <LoaderCircle size={13} className="spin" /> : <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>}</span>
                  </button>
                  <div className="chat-row-actions">
                    <button type="button" className="workspace-icon" title={item.pinned ? 'Открепить чат' : 'Закрепить чат'}
                      aria-label={(item.pinned ? 'Открепить чат «' : 'Закрепить чат «') + item.title + '»'} aria-pressed={!!item.pinned}
                      disabled={pending} onClick={() => void toggleChatPin(project.id, item)}><Pin size={14} /></button>
                    {(isAdmin || item.ownerId === user.id && item.messageCount === 0) && <button type="button" className="workspace-icon" title={item.messageCount === 0 ? 'Удалить пустой чат' : 'Архивировать чат'} aria-label={(item.messageCount === 0 ? 'Удалить пустой чат «' : 'Архивировать чат «') + item.title + '»'}
                      disabled={pending || [...activeRuns, ...queuedRuns].some(run => run.projectId === project.id && run.chatId === item.id)}
                      onClick={() => void (item.messageCount === 0 ? deleteEmptyChat(project.id, item.id) : archiveChat(project.id, item.id))}>
                      {item.messageCount === 0 ? <Trash2 size={14} /> : <Archive size={14} />}</button>}
                  </div>
                </div>
              </React.Fragment>)}
              {recent.length > 5 && <button className="workspace-row show-chats" onClick={() => setShowAll(old => ({ ...old, [project.id]: !old[project.id] }))}>{showAll[project.id] ? 'Свернуть' : 'Показать ещё'}</button>}
            </div>}
          </div>;
        })}
      </nav>
      {(isAdmin || erpAuth) && <div className="archive-nav"><button type="button" className="workspace-row" onClick={() => { setSidebarOpen(false); setPanel('archive'); }}>
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
        </details> : <button type="button" className="workspace-row account-row" aria-label="Настройки" title="Настройки" onClick={showSettings}>
          <span className="account-initial">{user.name.trim()[0]?.toUpperCase()}</span><span>{shortUserName(user.name)}</span><Settings2 size={16} aria-hidden="true" />
        </button>}
      </div>
      <SidebarResizeHandle />
    </aside>
    <main className="workspace-main">
      <header className="workspace-top">
        {sidebarCollapsed && <button ref={sidebarExpandButton} type="button" className="workspace-icon workspace-sidebar-toggle"
          aria-controls="workspace-sidebar" aria-expanded="false" aria-label="Развернуть боковую панель" title="Развернуть боковую панель"
          onClick={() => changeSidebarCollapsed(false)}><PanelLeftOpen size={18} /></button>}
        <button type="button" className="workspace-icon workspace-mobile-toggle" onClick={() => setSidebarOpen(true)}
          aria-label="Открыть проекты" aria-controls="workspace-sidebar" aria-expanded={sidebarOpen}><Menu size={20} /></button>
        {chat && <>
          <div className="workspace-chat-title">
            <Folder size={17} aria-label={selectedProject?.name} />
            <h1 title={chatTooltip(chat)}>{chat.title}</h1>
            {canEditChatDetails && <button type="button" className="workspace-icon chat-rename-button"
              aria-label="Переименовать чат" title="Переименовать чат" disabled={pending} onClick={() => {
                setError('');
                setRenameDraft({ projectId, chatId: chat.id, title: chat.title });
                setPanel('rename-chat');
              }}><Pencil size={15} /></button>}
          </div>
          {projectId && <Suspense fallback={null}><ChatSourceScope request={api} projectId={projectId} chatId={chat.id} canSwitch={canEdit} revision={chat.messages.length} /></Suspense>}
          <div className="chat-access" title={dateTooltip(chat.updatedAt, chat.ownerName)}>
            {isAdmin && !chat.linkedToFastkore ? <Select label="Видимость чата" value={chat.visibility ?? 'private'} disabled={pending}
              onChange={visibility => void changeVisibility(visibility as 'private' | 'project')}
              options={[{ value: 'private', label: 'Личный' }, { value: 'project', label: 'Общий' }]} />
              : <span><LockKeyhole size={13} />{chat.visibility === 'project' ? 'Общий' : 'Личный'}</span>}
          </div>
          {isAdmin && !matchesErpChat && !chat.archivedAt && <button type="button" className="workspace-icon chat-archive-button" aria-label="Перенести чат в архив" title="Перенести чат в архив"
            disabled={pending || chatBusy} onClick={() => void archiveChat()}><Archive size={17} /></button>}
        </>}
        {erpChatKey && <div className="related-chat-actions">
          <button type="button" className="workspace-icon" title="Связанные чаты" aria-label="Связанные чаты" onClick={() => { setError(''); setPanel('related'); }}><History size={18} /></button>
          {canReset && <button type="button" className="workspace-icon" title="Очистить чат" aria-label="Очистить чат"
            disabled={pending || chatBusy} onClick={() => { setError(''); setPanel('reset-chat'); }}><Eraser size={17} /></button>}
          {!sharedContextHistory && <button type="button" className="workspace-icon" title="Создать новый чат по этому контексту" aria-label="Создать новый чат по этому контексту"
            disabled={pending || relatedLoading || !newAgent || (!projectId && !canCreateProject)} onClick={() => void newChat(projectId, true)}><SquarePen size={17} /></button>}
        </div>}
        <select className="workspace-scale" aria-label="Масштаб интерфейса" title="Масштаб интерфейса"
          value={interfaceScale} disabled={savingScale} onChange={event => void changeInterfaceScale(Number(event.currentTarget.value) as InterfaceScale)}>
          {interfaceScales.map(scale => <option key={scale} value={scale}>{scale}%</option>)}
        </select>
        {themeButton}
      </header>
      {!embedded && chat?.erpContext && <div className="workspace-context">{chat.erpContext.entityType} / {chat.erpContext.entityId}</div>}
      {error && !panel && <div className="workspace-error" role="alert"><span>{error}</span><button className="workspace-icon" onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={17} /></button></div>}
      {reconnecting && !error && !panel && <p className="workspace-connection-status" role="status">Восстанавливаем связь с сервером…</p>}
      {hasMessages && chat ? <>
        <div ref={scroll} className="conversation-scroll" onScroll={() => { const el = scroll.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          <div className="conversation-lane conversation-history">
            {renderHistory(chat, projectId)}
            <div ref={end} />
          </div>
        </div>
        <div className="conversation-lane conversation-footer">{composer}</div>
      </> : <div className="workspace-welcome">
        <h2>{relatedDraftKey && !chatId ? fastkoreChatTitle(currentErpContext.current.snapshot) ?? 'Новый чат'
          : selectedProject ? 'Новый чат' : 'Выберите проект'}</h2>
        {composer}
      </div>}
    </main>
    {modelPreview && <WorkspaceDialog title={modelPreview.name} className="chat-model-dialog" close={() => setModelPreview(undefined)}>
      <Suspense fallback={<p className="chat-model-status" role="status">Загружаем просмотр…</p>}>
        <ChatModelPreview key={modelPreview.url} url={modelPreview.url} format={modelPreview.format} request={api<Blob>} />
      </Suspense>
    </WorkspaceDialog>}
    {panel === 'rename-chat' && renameDraft && <WorkspaceDialog title="Редактировать чат" className="workspace-chat-rename" close={closePanel}>
      <form onSubmit={e => { e.preventDefault(); void renameChat(); }}>
        <label htmlFor="chat-title">Название чата</label>
        <input id="chat-title" data-dialog-focus required maxLength={120} value={renameDraft.title}
          onFocus={e => e.currentTarget.select()} onChange={e => setRenameDraft({ ...renameDraft, title: e.target.value })} />
        <label htmlFor="chat-project">Проект</label>
        <select id="chat-project" value={renameDraft.destinationId ?? renameDraft.projectId} disabled={pending}
          onChange={e => setRenameDraft({ ...renameDraft, destinationId: e.target.value })}>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="settings-dialog-actions">
          <button type="button" className="secondary" onClick={closePanel} disabled={pending}>Отмена</button>
          <button type="submit" className="primary" disabled={pending || !renameDraft.title.trim()}>Сохранить</button>
        </div>
      </form>
    </WorkspaceDialog>}
    {panel === 'reset-chat' && canReset && <WorkspaceDialog title="Очистить чат?" className="workspace-chat-rename" close={() => { if (!pending) closePanel(); }}>
      <p>Текущий чат сохранится в архиве. Здесь откроется пустой чат.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="settings-dialog-actions">
        <button type="button" className="secondary" data-dialog-focus disabled={pending} onClick={closePanel}>Отмена</button>
        <button type="button" className="primary" disabled={pending || chatBusy} onClick={() => void resetChat()}>Очистить чат</button>
      </div>
    </WorkspaceDialog>}
    {panel === 'archive' && (isAdmin || erpAuth) && <ChatArchiveDialog request={api} close={closePanel} renderChat={renderHistory} manage={isAdmin}
      onRestore={project => void loadChats(project).catch(fail)} />}
    {relatedPanelOpen && erpChatKey && <WorkspaceDialog title="Связанные чаты" className="related-chats-dialog" close={closePanel}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {relatedLoading ? <p className="help" role="status">Загрузка…</p> : <div className="archive-list">
        {relatedChats?.list.map(item => <button type="button" className="workspace-row archive-row" key={item.id} aria-current={item.id === chatId ? 'page' : undefined}
          onClick={() => { navigateToRelated(item); closePanel(); }} title={chatTooltip(item)}><span><strong>{item.title}</strong><small>{item.parent ? 'Исходный чат · ' : ''}{item.projectName}</small></span>
          <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time></button>)}
        {!relatedChats?.list.length && !error && <p className="help">По этой карточке или списку пока нет чатов.</p>}
      </div>}
      {projectId && (!sharedContextHistory || !relatedChats?.list.some(item => item.contextMatches !== false)) && <div className="archive-actions related-dialog-actions"><button type="button" className="secondary" disabled={pending || relatedLoading || !newAgent}
        onClick={() => void newChat(projectId, true)}><SquarePen size={16} />Создать новый чат</button></div>}
    </WorkspaceDialog>}
    {panel === 'search' && <WorkspaceDialog title="Поиск" className="workspace-search" close={closePanel}>
      <input type="search" aria-label="Поиск по проектам и чатам" placeholder="Поиск по проектам и чатам" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} autoFocus />
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="search-results">
        {searchable.map(({ project, matchingChats }) => <div key={project.id}>
          <button className="workspace-row search-project" onClick={() => { navigateWorkspace(project.id); closePanel(); }}><Folder size={16} />{project.name}</button>
          {matchingChats.map(item => <button key={item.id} className="workspace-row chat-row" title={chatTooltip(item)} onClick={() => { navigateWorkspace(project.id, item.id); closePanel(); }}><span>{item.title}</span><time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time></button>)}
        </div>)}
        {searchLoading && <p className="composer-status" role="status">Загрузка…</p>}
        {!searchLoading && !searchable.length && <p className="composer-status">Ничего не найдено</p>}
      </div>
    </WorkspaceDialog>}
    {panel === 'project' && canCreateProject && <WorkspaceDialog title="Новый проект" className="workspace-project-form" close={closePanel}>
      <form onSubmit={e => { e.preventDefault(); void action(async () => {
        const selectForChat = projectFromComposer.current || (!!relatedDraftKey && !chatId);
        const previous = selected.current, navigation = contextNavigation.current;
        const p = await post<ProjectSummary>('/api/projects', { ...(folderPath.trim() && canManageProjects ? { directory: folderPath.trim() } : {}), ...(projectName.trim() ? { name: projectName.trim() } : {}) });
        setProjects(await api('/api/projects'));
        closePanel(); setFolderPath(''); setProjectName('');
        if (selected.current.projectId !== previous.projectId || selected.current.chatId !== previous.chatId ||
          contextNavigation.current !== navigation) return;
        if (selectForChat) await selectComposerProject(p.id);
        else navigateTo(p.id);
      }); }}>
        <label htmlFor="project-name">Название проекта</label>
        <input id="project-name" value={projectName} onChange={e => setProjectName(e.target.value)} required={!canManageProjects || !folderPath.trim()} maxLength={100} autoFocus />
        {canManageProjects && <><label htmlFor="directory">Папка на сервере <span>необязательно</span></label><input id="directory" value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder={status?.executionDisabled ? '/projects/Финансы' : 'C:\\Проекты\\Финансы'} /></>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button className="primary w-full" disabled={pending}>{folderPath.trim() && canManageProjects ? 'Подключить папку' : 'Создать проект'}</button>
      </form>
    </WorkspaceDialog>}
    {panel === 'rename-project' && projectActionTarget && canManageProjects && <WorkspaceDialog title="Переименовать проект" className="workspace-chat-rename"
      close={() => { if (!pending) closeProjectPanel(); }}>
      <form onSubmit={event => { event.preventDefault(); void action(async () => {
        const { id } = projectActionTarget;
        const { name } = await api<{ name: string }>('/api/projects/' + encodeURIComponent(id), {
          method: 'PATCH', body: JSON.stringify({ name: renameProjectName.trim() }),
        });
        setProjects(items => items.map(project => project.id === id ? { ...project, name } : project));
        setRelatedChats(chats => chats && { ...chats, list: chats.list.map(chat => chat.projectId === id ? { ...chat, projectName: name } : chat) });
        closeProjectPanel();
      }); }}>
        <label htmlFor="rename-project-name">Название проекта</label>
        <input id="rename-project-name" data-dialog-focus value={renameProjectName} onChange={event => setRenameProjectName(event.target.value)}
          onFocus={event => event.currentTarget.select()} required maxLength={100} disabled={pending} />
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="settings-dialog-actions">
          <button type="button" className="secondary" onClick={closeProjectPanel} disabled={pending}>Отмена</button>
          <button type="submit" className="primary" disabled={pending || !renameProjectName.trim() || renameProjectName.trim() === projectActionTarget.name}>Сохранить</button>
        </div>
      </form>
    </WorkspaceDialog>}
    {panel === 'project-files' && projectActionTarget && canManageProjects &&
      <ProjectFilesDialog key={projectActionTarget.id} project={projectActionTarget} request={api} download={url => api<Blob>(url, {}, 'blob')} close={closeProjectPanel} />}
    {panel === 'project-sources' && projectActionTarget && canManageProjects && <Suspense fallback={null}>
      <ProjectSourcesDialog key={projectActionTarget.id + (sourceProfileId ?? '')} project={projectActionTarget} request={api} close={() => { setSourceProfileId(undefined); closeProjectPanel(); }} isAdmin={isAdmin} initialProfileId={sourceProfileId} /></Suspense>}
    {panel === 'project-agents' && projectActionTarget && canManageProjects &&
      <ProjectSpecialistsDialog key={projectActionTarget.id} project={projectActionTarget} request={api} close={closeProjectPanel}
        openSources={profileId => { setSourceProfileId(profileId); setPanel('project-sources'); }}
        openSpecialist={id => {
          setInitialSpecialistId(id);
          setSettingsSection('profiles');
          setPanel('settings');
        }} />}
    {panel === 'settings' && visibleSettingsSections.includes(settingsSection) && <WorkspaceDialog title="Настройки"
      className={'workspace-settings' + (instructionSettings ? ' personal-instructions-dialog' : '')} close={closePanel}
      back={instructionSettings && visibleSettingsSections.length > 1 ? () => chooseSettingsSection('team') : undefined}>
      {instructionSettings ? <PersonalInstructionsPanel key={user.id + settingsSection} request={api} project={selectedProject}
        erp={authSource === 'fastkore'} context={currentErpContext.current.snapshot}
        administration={settingsSection === 'employeeInstructions'} dirtyChanged={setPersonalDirty} /> : <div className="settings-layout">
        <nav aria-label="Разделы настроек" className="settings-nav">
          {visibleSettingsSections.map(section => {
            const { label, icon: Icon } = settingsSections[section];
            return <button key={section} type="button" className="workspace-row" aria-current={settingsSection === section ? 'page' : undefined}
              onClick={() => chooseSettingsSection(section)}><Icon size={16} aria-hidden="true" />{label}</button>;
          })}
        </nav>
        <select className="settings-section-picker" aria-label="Раздел настроек" value={settingsSection}
          onChange={event => chooseSettingsSection(event.target.value as SettingsSection)}>
          {visibleSettingsSections.map(id => <option key={id} value={id}>{settingsSections[id].label}</option>)}
        </select>
        <section key={settingsSection} className={'panel-body settings-content' + (settingsSection === 'server' ? ' settings-server' : '')}
          aria-labelledby="settings-section-title">
          <div className={'settings-pane' + (settingsSection === 'agent' ? ' settings-pane-instructions' : '')}>
          {settingsSection !== 'profiles' && <h2 id="settings-section-title">{settingsSections[settingsSection].label}</h2>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <Suspense fallback={<p role="status">Загрузка…</p>}>
          {settingsSection === 'account' && <AccountPanel request={api} renewed={saveToken} fastkore={authSource === 'fastkore'} />}
          {settingsSection === 'team' && <TeamPanel request={api} projectId={projectId} projectName={selectedProject?.name ?? ''} self={user} />}
          {settingsSection === 'projects' && <ul className="agent-card-list">
            {projects.map(project => <li className="agent-card" key={project.id}>
              <div className="settings-project-title">
                <Folder size={16} aria-hidden="true" /><strong>{project.name}</strong>
                <button type="button" className="workspace-icon" aria-label={'Переименовать проект ' + project.name} title="Переименовать проект"
                  onClick={event => openProjectPanel(project, 'rename-project', event.currentTarget)}><Pencil size={15} aria-hidden="true" /></button>
              </div>
              <div className="settings-project-actions">{renderProjectActions(project)}</div>
            </li>)}
            {!projects.length && <li className="help">Проектов пока нет.</li>}
          </ul>}
          {settingsSection === 'roles' && <ErpRolesPanel request={api} />}
          {settingsSection === 'sources' && <SourcesPanel request={api} />}
          {settingsSection === 'profiles' && <SpecialistsPanel request={api} globalInstructions={savedInstructions} initialProfileId={initialSpecialistId} />}
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
            {status?.isolatedCodex && authSource === 'local' && !inFastkore && <ExecutionAccountsPanel request={api} busy={busy || pending}
              changed={async () => { await post('/api/cli/check'); setStatus(await api('/api/status')); await loadModels(true); }} />}
            {canManageProjects && !projects.length && <section className="setting-section"><h3>История настольной версии</h3><button className="secondary w-full" disabled={pending || busy} onClick={() => void action(async () => {
              await post('/api/migrations/desktop'); setProjects(await api('/api/projects')); setStatus(await api('/api/status')); closePanel();
            })}>Перенести проекты и историю</button></section>}
            <section className="setting-section"><h3>Адрес сервера</h3>
              {status?.addresses.map(url => <button key={url} className="copy-row" onClick={() => void copyItem(url, url)}><code>{url}</code>{copied === url ? <Check size={14} /> : <Copy size={14} />}</button>)}
            </section>
            {status && !status.isolatedCodex && <section className="setting-section"><h3>Исполнитель модели</h3>
              <p className="settings-status">{status?.cli?.authentication === 'google' ? 'Подключён Gemini CLI через Google' : status?.cli?.authentication === 'chatgpt' ? 'Подключён через ChatGPT' : status?.cli?.authentication === 'glm' ? 'Подключён GLM (Z.ai) по ключу Coding Plan' : status?.cli?.authentication === 'api-key' ? 'API-ключ · выполнение отключено' : 'Исполнитель не подключён'}</p>
              <label htmlFor="cli-path">Путь к Codex CLI</label>
              <input id="cli-path" value={cliPath} onChange={e => setCliPath(e.target.value)} placeholder="Автоопределение" disabled={busy} />
              <div className="settings-actions">
                <button className="secondary" disabled={pending || busy} onClick={() => void saveSettings({ cliPath: cliPath.trim() })}>Сохранить</button>
                <button className="secondary" disabled={pending || busy} onClick={() => void action(async () => { await post('/api/cli/check'); setStatus(await api('/api/status')); })}>Проверить</button>
                <button className="secondary" disabled={pending || busy || !!codexNotice} onClick={() => void action(async () => { setSubscription(await post<Run>('/api/subscription/check')); })}>Проверить подписку</button>
              </div>
              {subscription && <p role="status">{subscription.error ?? subscription.response ?? subscription.progress}</p>}
            </section>}
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
              <div className="settings-model-row">
                <label htmlFor="server-reasoning">Рассуждение по умолчанию</label>
                <Select id="server-reasoning" className="settings-select" value={status?.settings.reasoningEffort ?? 'high'} options={reasoningOptions}
                  disabled={busy || pending} onChange={value => void saveSettings({ reasoningEffort: value as Settings['reasoningEffort'] })} />
              </div>
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
      </div>}
    </WorkspaceDialog>}
  </div>;
}

const remainingPercent = (used: number) => Math.min(100, Math.max(0, 100 - used));
const limitPercentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function LinkedFastkoreNotice() {
  const [showHint, setShowHint] = useState(false);
  return <p className="composer-status" role="status">
    Чат связан с другим окном Fastkore.{' '}
    <button type="button" className="composer-status-link" aria-label="Открыть в Fastkore"
      onClick={() => setShowHint(true)}>Открыть</button>
    {showHint && ' · Переход пока недоступен. Откройте связанный список или карточку вручную.'}
  </p>;
}

function ModelPicker({ request, unavailableReason, revision, model, options, effort, levels, disabled, onModel, onEffort }: {
  request: typeof api; unavailableReason: string; revision?: number; model: string;
  options: { value: string; label: string }[]; effort: NonNullable<Settings['reasoningEffort']>; levels: typeof reasoningOptions;
  disabled: boolean; onModel: (model: string) => void; onEffort: (effort: NonNullable<Settings['reasoningEffort']>) => void;
}) {
  const [byModel, setByModel] = useState<Record<string, CodexLimits | null>>({});
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current || unavailableReason || document.hidden) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const result = await request<{ models: Record<string, CodexLimits | null> }>('/api/models/limits?model=' + encodeURIComponent(model), { signal: controller.signal });
      if (!controller.signal.aborted) setByModel(result.models);
    } catch {
      if (!controller.signal.aborted) setByModel({});
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [request, unavailableReason, model]);
  useEffect(() => {
    if (unavailableReason) {
      setByModel({});
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

  return <>
    <LimitsButton limits={byModel[model] ?? null} loading={loading} refresh={refresh} unavailableReason={unavailableReason} model={model} />
    <ChatModelControls model={model} effort={effort} levels={levels} disabled={disabled} onModel={onModel} onEffort={onEffort}
      models={options.map(option => {
        const limits = byModel[option.value || model];
        const windows = limits?.buckets.flatMap(bucket => bucket.windows) ?? [];
        const remaining = windows.length ? Math.min(...windows.map(window => remainingPercent(window.usedPercent))) : null;
        return { ...option, detail: remaining === null ? '—' : limitPercentFormat.format(remaining) + '%',
          detailTitle: limits?.unavailableReason || (remaining === null ? 'Лимиты пока недоступны' : 'Остаток лимита модели') };
      })} />
  </>;
}

function LimitsButton({ limits, loading, refresh, unavailableReason, model }: {
  limits: CodexLimits | null; loading: boolean; refresh: () => Promise<void>; unavailableReason: string; model: string;
}) {

  const windows = unavailableReason ? [] : limits?.buckets.flatMap(bucket => bucket.windows) ?? [];
  const remaining = windows.length ? Math.min(...windows.map(window => remainingPercent(window.usedPercent))) : null;
  const remainingLabel = remaining === null ? '' : `Осталось ${limitPercentFormat.format(remaining)}%`;
  const provider = limits?.provider || (model.startsWith('antigravity') ? 'antigravity' : model.startsWith('glm') ? 'glm' : model.startsWith('gemini') ? 'gemini' : 'codex');
  const heading = provider === 'codex' ? 'Лимиты Codex' : provider === 'glm' ? 'Лимиты Z.ai' : 'Лимиты Google';
  const title = remainingLabel ? `${heading} · ${remainingLabel.toLowerCase()}` : heading;
  return <details className="limits-control"
    onToggle={e => { if (e.currentTarget.open) void refresh(); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}
    onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary className="workspace-icon" aria-label={heading} aria-description={remainingLabel || unavailableReason || limits?.unavailableReason || undefined} title={title}>
      <svg className="limit-ring" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle className="limit-ring-track" cx="10" cy="10" r="8" />
        {remaining !== null && remaining > 0 && <circle className="limit-ring-value" cx="10" cy="10" r="8" pathLength="100"
          strokeDasharray={`${remaining} 100`} transform="rotate(-90 10 10)" />}
      </svg>
    </summary>
    <div className="limits-popover">
      <header><h3>{heading}</h3><button className="workspace-icon" title="Обновить лимиты" aria-label="Обновить лимиты" disabled={loading || !!unavailableReason} onClick={() => void refresh()}><RefreshCw size={14} /></button></header>
      {loading && !limits && <p role="status">Загрузка…</p>}
      {unavailableReason && <p role="status">{unavailableReason}</p>}
      {!unavailableReason && limits?.unavailableReason && <p role="status">{limits.unavailableReason}</p>}
      {!unavailableReason && !loading && !limits && <p role="status">Лимиты выбранной модели пока недоступны.</p>}
      {!unavailableReason && limits?.buckets.map((bucket, index) => <section key={index}>
        {limits.buckets.length > 1 && <b>{bucket.name}</b>}
        {bucket.windows.map((window, row) => {
          const left = remainingPercent(window.usedPercent);
          const mins = window.windowDurationMins;
          const label = window.label ?? (mins ? (mins % 1440 === 0 ? mins / 1440 + ' дн.' : mins % 60 === 0 ? mins / 60 + ' ч' : mins + ' мин') : 'Лимит');
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
