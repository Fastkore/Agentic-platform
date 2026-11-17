import { useEffect, useState } from 'react';
import { Bot, Database, Plus, Settings2 } from 'lucide-react';
import type { ProjectAgentConnection, ProjectAgentPolicy, ProjectAgentSettings, ProjectSummary } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';

export function ProjectSpecialistsDialog({ project, request, close, openSpecialist, openSources }: {
  project: ProjectSummary;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
  openSpecialist: (id?: string) => void;
  /** Opens project sources filtered to this specialist (same grants as the project matrix). */
  openSources?: (profileId: string) => void;
}) {
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/agent-settings';
  const [settings, setSettings] = useState<ProjectAgentSettings>();
  const [adding, setAdding] = useState(false);
  const [candidateId, setCandidateId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

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
      setCandidateId('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  const connections = settings?.policy.connections ?? [];
  const connectedIds = new Set(connections.map(connection => connection.profileId));
  const connected = settings?.profiles.filter(profile => connectedIds.has(profile.id)) ?? [];
  const available = settings?.profiles.filter(profile => !connectedIds.has(profile.id)) ?? [];
  const candidate = available.find(profile => profile.id === candidateId);

  return <WorkspaceDialog title="Специалисты проекта" className="project-agents-dialog" close={() => { if (!pending) close(); }}>
    <div className="project-agents-intro">
      <strong>{project.name}</strong>
      {settings?.isolated && <button type="button" className="secondary" disabled={pending} aria-expanded={adding}
        onClick={() => setAdding(!adding)}><Plus size={16} aria-hidden="true" />Добавить специалиста</button>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!settings && !error && <p role="status">Загрузка…</p>}
    {settings && <div className="project-agent-scroll">
      {adding && (available.length > 0
        ? <form className="settings-project-actions project-specialist-add" onSubmit={event => {
          event.preventDefault();
          if (candidate) void save([...connections, { profileId: candidate.id, toolIds: candidate.toolIds, fileIds: null }]);
        }}>
          <select aria-label="Специалист для подключения" value={candidateId} disabled={pending} onChange={event => setCandidateId(event.target.value)}>
            <option value="">Выберите специалиста</option>
            {available.map(profile => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
          </select>
          <button type="submit" className="secondary" disabled={!candidate || pending}>Подключить</button>
        </form>
        : <div className="settings-project-actions project-specialist-add">
          <span className="help">Все специалисты из каталога подключены.</span>
          <button type="button" className="secondary" onClick={() => openSpecialist()}>Открыть каталог</button>
        </div>)}
      {connected.length > 0 ? <ul className="agent-card-list">
        {connected.map(profile => <li className="agent-card" key={profile.id}>
          <div className="agent-card-heading">
            <Bot size={17} aria-hidden="true" />
            <div>
              <strong title={profile.unavailableReason}>{profile.name}</strong>
              {profile.description && <p>{profile.description}</p>}
            </div>
            <span className="project-specialist-actions">
              {openSources && <button type="button" className="workspace-icon" disabled={pending} onClick={() => openSources(profile.id)}
                title="Библиотека специалиста в проекте" aria-label={'Библиотека: ' + profile.name}><Database size={17} aria-hidden="true" /></button>}
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
  </WorkspaceDialog>;
}
