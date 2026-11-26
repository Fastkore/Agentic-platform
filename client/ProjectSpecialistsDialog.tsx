import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { Bot, Check, Database, FileText, MessageSquare, Pencil, Plus, Settings2, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import type { ChatView, ProjectAgentConnection, ProjectAgentPolicy, ProjectAgentSettings, ProjectRoleLabel, ProjectSummary } from '../shared/types';
import type { ExternalProvider } from '../shared/library';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ProjectRolesPanel } from './ProjectRolesPanel';
import { ChatDefaultsEditor } from './ChatDefaultsEditor';
import { ProjectInstructions } from './ProjectInstructions';
import { ProjectChatsPanel } from './ProjectChatsPanel';
import { SettingsSpinner } from './SettingsSpinner';
import { SettingsTabStrip } from './SettingsTabs';

const ProjectLibraryPanel = lazy(() => import('./ProjectLibraryDialog').then(module => ({ default: module.ProjectLibraryPanel })));
const sections = [['instructions', 'Инструкция', FileText], ['specialists', 'Агенты', Bot], ['library', 'Библиотеки', Database], ['access', 'Доступ к материалам', ShieldCheck], ['roles', 'Роли', Users], ['chats', 'Чаты', MessageSquare]] as const;
type Section = typeof sections[number][0];

export function ProjectSettingsDialog({ project, request, close, openSpecialist, rename, saveInstructions, remove, isAdmin, rolesChanged, renderChat, chatError, openAccounts }: {
  project: ProjectSummary;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
  openSpecialist: (id: string) => void;
  rename: (name: string) => Promise<string>;
  saveInstructions: (previous: string, instructions: string) => Promise<string>;
  remove: () => Promise<void>;
  isAdmin: boolean;
  rolesChanged: (roles: ProjectRoleLabel[]) => void;
  renderChat: (chat: ChatView, projectId: string) => ReactNode;
  chatError: string;
  openAccounts?: (provider: ExternalProvider) => void;
}) {
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/agent-settings';
  const [settings, setSettings] = useState<ProjectAgentSettings>();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [libraryPending, setLibraryPending] = useState(false);
  const [rolesPending, setRolesPending] = useState(false);
  const [rolesOpened, setRolesOpened] = useState(false);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>(sections[0][0]);
  const [libraryProfile, setLibraryProfile] = useState<string>();
  const [name, setName] = useState(project.name);
  const [renameDraft, setRenameDraft] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const tabs = useId();
  const busy = pending || libraryPending || rolesPending;

  function openSection(next: Section) {
    setLibraryProfile(undefined);
    setSection(next);
    if (next === 'roles') setRolesOpened(true);
  }

  useEffect(() => {
    const controller = new AbortController();
    void request<ProjectAgentSettings>(route, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [request, route]);

  async function save(connections: ProjectAgentConnection[]) {
    if (!settings || pending) return;
    setPending(true);
    setError('');
    try {
      const policy = await request<ProjectAgentPolicy>(route, {
        method: 'PUT',
        body: JSON.stringify({ revision: settings.policy.revision, connections }),
      });
      setSettings({ ...settings, policy });
      return true;
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function saveName() {
    if (busy || !renameDraft?.trim()) return;
    setPending(true); setError('');
    try { setName(await rename(renameDraft)); setRenameDraft(undefined); } catch (cause) {
      setError((cause as Error).message);
    } finally { setPending(false); }
  }
  async function deleteProject() {
    if (busy) return;
    setPending(true); setDeleteError('');
    try { await remove(); }
    catch (cause) { setDeleteError((cause as Error).message); }
    finally { setPending(false); }
  }

  const connections = settings?.policy.connections ?? [];
  const connectedIds = new Set(connections.map(connection => connection.profileId));
  const connected = settings?.profiles.filter(profile => connectedIds.has(profile.id)) ?? [];
  const available = settings?.profiles.filter(profile => !connectedIds.has(profile.id)) ?? [];
  const newConnections = available.filter(profile => selected.includes(profile.id))
    .map(profile => ({ profileId: profile.id, toolIds: profile.toolIds, fileIds: null }));

  return <>
  <WorkspaceDialog title="Настройки проекта" className="project-agents-dialog project-settings-dialog" close={() => { if (!busy) close(); }}>
    <div className="project-agents-intro">
      {renameDraft === undefined ? <div className="settings-project-title"><strong>{name}</strong>
        <button type="button" className="workspace-icon" aria-label="Переименовать проект" disabled={busy} onClick={() => setRenameDraft(name)}><Pencil size={15} /></button>
      </div> : <form className="settings-project-rename" onSubmit={event => { event.preventDefault(); void saveName(); }}>
        <input autoFocus aria-label="Название проекта" maxLength={100} value={renameDraft} disabled={busy} onChange={event => setRenameDraft(event.target.value)} />
        <button type="submit" className="workspace-icon" aria-label="Сохранить название" disabled={busy || !renameDraft.trim() || renameDraft.trim() === name}><Check size={16} /></button>
        <button type="button" className="workspace-icon" aria-label="Отменить переименование" disabled={busy} onClick={() => setRenameDraft(undefined)}><X size={16} /></button>
      </form>}
      {isAdmin && <button type="button" className="secondary project-delete" disabled={busy} aria-haspopup="dialog"
        onClick={() => { setDeleteError(''); setConfirmDelete(true); }}><Trash2 size={16} aria-hidden="true" />Удалить проект</button>}
    </div>
    <SettingsTabStrip sections={sections} value={section} select={openSection} id={tabs} label="Разделы настроек проекта"
      panelId={() => tabs + '-panel'} className="project-settings-tabs" disabled={busy} />
    {error && !adding && <p className="inline-error" role="alert">{error}</p>}
    {section === 'chats' && chatError && <p className="inline-error" role="alert">{chatError}</p>}
    <div id={tabs + '-panel'} role="tabpanel" aria-labelledby={tabs + section} tabIndex={0}
      className={section === 'chats' ? 'project-chats-panel' : section === 'instructions' ? 'project-instructions-panel' : 'project-agent-scroll'}>
    {section === 'instructions' ? <ProjectInstructions project={project} save={saveInstructions} /> : section === 'specialists' ? <>
    <div className="project-agents-intro">
      <strong>Подключённые агенты</strong>
      {settings?.isolated && <button type="button" className="secondary" disabled={pending} aria-haspopup="dialog"
        onClick={() => { setSelected([]); setError(''); setAdding(true); }}><Plus size={16} aria-hidden="true" />Добавить агента</button>}
    </div>
    {settings?.chatDefaults && <ChatDefaultsEditor value={settings.chatDefaults}
      save={async value => {
        const updated = await request<typeof value>('/api/projects/' + encodeURIComponent(project.id) + '/chat-defaults',
          { method: 'PUT', body: JSON.stringify(value) });
        setSettings(current => current && { ...current, chatDefaults: updated });
        return updated;
      }} />}
    {!settings && !error && <SettingsSpinner label="Загрузка агентов…" />}
    {settings && <div className="project-agent-scroll">
      {connected.length > 0 ? <ul className="settings-records project-agent-rows">
        {connected.map(profile => <li key={profile.id}>
          <div className="agent-card-heading">
            <Bot size={17} aria-hidden="true" />
            <div>
              <strong title={profile.unavailableReason}>{profile.name}</strong>
              {profile.description && <p>{profile.description}</p>}
            </div>
            <span className="project-specialist-actions">
              <button type="button" className="workspace-icon" disabled={pending} onClick={() => { setLibraryProfile(profile.id); setSection('access'); }}
                title="Библиотека агента в проекте" aria-label={'Библиотека: ' + profile.name}><Database size={17} aria-hidden="true" /></button>
              <button type="button" className="workspace-icon" disabled={pending} onClick={() => openSpecialist(profile.id)}
                title="Настройки агента" aria-label={'Настройки: ' + profile.name}>
                <Settings2 size={17} aria-hidden="true" />
              </button>
              <button type="button" className="secondary" disabled={pending || !settings.isolated}
                title="Отключить агента в проекте" aria-label={'Отключить: ' + profile.name}
                onClick={() => void save(connections.filter(connection => connection.profileId !== profile.id))}>
                <X size={15} aria-hidden="true" />Отключить
              </button>
            </span>
          </div>
        </li>)}
      </ul> : <p className="help">В проекте пока нет подключённых агентов.</p>}
    </div>}
    </> : section === 'chats' ? <ProjectChatsPanel projectId={project.id} request={request} renderChat={renderChat} />
      : section !== 'roles' ? <Suspense fallback={<SettingsSpinner label="Загрузка…" />}>
      <ProjectLibraryPanel key={libraryProfile ?? ''} project={project} request={request} section={section === 'library' ? 'folders' : 'access'}
        isAdmin={isAdmin} initialProfileId={libraryProfile} pendingChanged={setLibraryPending} openAccounts={openAccounts} />
    </Suspense> : null}
    {rolesOpened && <div hidden={section !== 'roles'}>
      <ProjectRolesPanel projectId={project.id} request={request} onSaved={rolesChanged} pendingChanged={setRolesPending} />
    </div>}
    </div>
  </WorkspaceDialog>
  {confirmDelete && <WorkspaceDialog title="Удалить проект?" className="workspace-chat-rename"
    close={() => { if (!pending) setConfirmDelete(false); }}>
    <p>Проект «{name}» будет удалён. Чаты и вложения сохранятся в разделе «Без проекта». Общие чаты станут личными.</p>
    {deleteError && <p className="inline-error" role="alert">{deleteError}</p>}
    <div className="settings-dialog-actions">
      <button type="button" className="secondary" data-dialog-focus disabled={pending} onClick={() => setConfirmDelete(false)}><X size={16} aria-hidden="true" />Отмена</button>
      <button type="button" className="secondary project-delete" disabled={pending} onClick={() => void deleteProject()}><Trash2 size={16} aria-hidden="true" />Удалить проект</button>
    </div>
  </WorkspaceDialog>}
  {adding && <WorkspaceDialog title="Добавить агентов" className="project-agents-dialog project-specialist-picker"
    close={() => { if (!pending) { setAdding(false); setError(''); } }}>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {available.length > 0 ? <form onSubmit={event => {
      event.preventDefault();
      if (newConnections.length) void save([...connections, ...newConnections]).then(saved => { if (saved) setAdding(false); });
    }}>
      <ul className="settings-records project-specialist-options" aria-label="Доступные агенты">
        {available.map((profile, index) => <li key={profile.id}>
          <label>
            <input type="checkbox" data-dialog-focus={index === 0 ? '' : undefined} disabled={pending} checked={selected.includes(profile.id)}
              onChange={event => {
                const checked = event.currentTarget.checked;
                setSelected(current => checked ? [...current, profile.id] : current.filter(id => id !== profile.id));
              }} />
            <span><strong>{profile.name}</strong>{profile.description && <small>{profile.description}</small>}</span>
          </label>
        </li>)}
      </ul>
      <div className="settings-dialog-actions">
        <button type="submit" className="primary" disabled={pending || !newConnections.length}><Check size={16} aria-hidden="true" />Подключить</button>
      </div>
    </form> : <p className="help">Все доступные агенты уже подключены.</p>}
  </WorkspaceDialog>}
  </>;
}
