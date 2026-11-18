import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { Bot, Check, Database, Pencil, Plus, Settings2, X } from 'lucide-react';
import type { ProjectAgentConnection, ProjectAgentPolicy, ProjectAgentSettings, ProjectSummary } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';
import './specialists.css';

const ProjectLibraryPanel = lazy(() => import('./ProjectLibraryDialog').then(module => ({ default: module.ProjectLibraryPanel })));
const sections = [['specialists', 'Специалисты'], ['library', 'Библиотека'], ['access', 'Доступ к материалам']] as const;
type Section = typeof sections[number][0];

export function ProjectSettingsDialog({ project, request, close, openSpecialist, rename, isAdmin }: {
  project: ProjectSummary;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
  openSpecialist: (id: string) => void;
  rename: (name: string) => Promise<string>;
  isAdmin: boolean;
}) {
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/agent-settings';
  const [settings, setSettings] = useState<ProjectAgentSettings>();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [libraryPending, setLibraryPending] = useState(false);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>('specialists');
  const [libraryProfile, setLibraryProfile] = useState<string>();
  const [name, setName] = useState(project.name);
  const [renameDraft, setRenameDraft] = useState<string>();
  const tabs = useId();
  const busy = pending || libraryPending;

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
    </div>
    <div className="specialist-tabs project-settings-tabs" role="tablist" aria-label="Разделы настроек проекта" onKeyDown={event => {
      if (busy) return;
      const current = sections.findIndex(([id]) => id === section);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : event.key === 'ArrowRight'
        ? (current + 1) % sections.length : event.key === 'ArrowLeft' ? (current + sections.length - 1) % sections.length : -1;
      if (next < 0) return;
      event.preventDefault();
      setLibraryProfile(undefined);
      setSection(sections[next][0]);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {sections.map(([id, label]) => <button key={id} id={tabs + id} type="button" role="tab" aria-selected={id === section}
        aria-controls={tabs + '-panel'} tabIndex={id === section ? 0 : -1} disabled={busy}
        onClick={() => { setLibraryProfile(undefined); setSection(id); }}>{label}</button>)}
    </div>
    {error && !adding && <p className="inline-error" role="alert">{error}</p>}
    <div id={tabs + '-panel'} role="tabpanel" aria-labelledby={tabs + section} tabIndex={0} className="project-agent-scroll">
    {section === 'specialists' ? <>
    <div className="project-agents-intro">
      <strong>Подключённые специалисты</strong>
      {settings?.isolated && <button type="button" className="secondary" disabled={pending} aria-haspopup="dialog"
        onClick={() => { setSelected([]); setError(''); setAdding(true); }}><Plus size={16} aria-hidden="true" />Добавить специалиста</button>}
    </div>
    {!settings && !error && <p role="status">Загрузка…</p>}
    {settings && <div className="project-agent-scroll">
      {connected.length > 0 ? <ul className="agent-card-list">
        {connected.map(profile => <li className="agent-card" key={profile.id}>
          <div className="agent-card-heading">
            <Bot size={17} aria-hidden="true" />
            <div>
              <strong title={profile.unavailableReason}>{profile.name}</strong>
              {profile.description && <p>{profile.description}</p>}
            </div>
            <span className="project-specialist-actions">
              <button type="button" className="workspace-icon" disabled={pending} onClick={() => { setLibraryProfile(profile.id); setSection('access'); }}
                title="Библиотека специалиста в проекте" aria-label={'Библиотека: ' + profile.name}><Database size={17} aria-hidden="true" /></button>
              <button type="button" className="workspace-icon" disabled={pending} onClick={() => openSpecialist(profile.id)}
                title="Настройки специалиста" aria-label={'Настройки: ' + profile.name}>
                <Settings2 size={17} aria-hidden="true" />
              </button>
              <button type="button" className="secondary" disabled={pending || !settings.isolated}
                title="Отключить специалиста в проекте" aria-label={'Отключить: ' + profile.name}
                onClick={() => void save(connections.filter(connection => connection.profileId !== profile.id))}>
                Отключить
              </button>
            </span>
          </div>
        </li>)}
      </ul> : <p className="help">В проекте пока нет подключённых специалистов.</p>}
    </div>}
    </> : <Suspense fallback={<p role="status">Загрузка…</p>}>
      <ProjectLibraryPanel key={libraryProfile ?? ''} project={project} request={request} section={section === 'library' ? 'folders' : 'access'}
        isAdmin={isAdmin} initialProfileId={libraryProfile} pendingChanged={setLibraryPending} />
    </Suspense>}
    </div>
  </WorkspaceDialog>
  {adding && <WorkspaceDialog title="Добавить специалистов" className="project-agents-dialog project-specialist-picker"
    close={() => { if (!pending) { setAdding(false); setError(''); } }}>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {available.length > 0 ? <form onSubmit={event => {
      event.preventDefault();
      if (newConnections.length) void save([...connections, ...newConnections]).then(saved => { if (saved) setAdding(false); });
    }}>
      <ul className="settings-records project-specialist-options" aria-label="Доступные специалисты">
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
        <button type="submit" className="primary" disabled={pending || !newConnections.length}>Подключить</button>
      </div>
    </form> : <p className="help">Все доступные специалисты уже подключены.</p>}
  </WorkspaceDialog>}
  </>;
}
