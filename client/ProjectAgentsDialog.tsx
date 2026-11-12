import { useEffect, useState } from 'react';
import { Bot, Database, Files, Paperclip } from 'lucide-react';
import { agentTools } from '../shared/agent-tools';
import type { ProjectAgentConnection, ProjectAgentPolicy, ProjectAgentSettings, ProjectSummary } from '../shared/types';
import { WorkspaceDialog } from './WorkspaceDialog';

export function ProjectAgentsDialog({ project, request, close }: {
  project: ProjectSummary;
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  close: () => void;
}) {
  const route = '/api/projects/' + encodeURIComponent(project.id) + '/agent-settings';
  const [settings, setSettings] = useState<ProjectAgentSettings>();
  const [connections, setConnections] = useState<ProjectAgentConnection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    request<ProjectAgentSettings>(route, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setConnections(value.policy.connections);
    }).catch(error => {
      if (!controller.signal.aborted) setError((error as Error).message);
    });
    return () => controller.abort();
  }, [request, route]);

  function update(connection: ProjectAgentConnection) {
    setConnections(current => current.map(item => item.profileId === connection.profileId ? connection : item));
  }

  async function save() {
    if (!settings || saving) return;
    setSaving(true);
    setError('');
    try {
      await request<ProjectAgentPolicy>(route, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: settings.policy.revision, connections }),
      });
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return <WorkspaceDialog title="Агенты проекта" className="project-agents-dialog" close={close}>
    <div className="project-agents-intro">
      <strong>{project.name}</strong>
      <p>Подключите нужных агентов и выберите, к каким данным они получат доступ. Участник проекта сможет запустить агента, если он доступен его рабочей роли.</p>
      {settings?.policy.revision === 0 && <p>Сейчас проект использует общие настройки. После сохранения будут действовать подключения из этого списка.</p>}
      {settings && !settings.isolated && <p>Для применения этих настроек нужен отдельный исполнитель Codex. В локальном режиме запуск агентов этого проекта будет приостановлен.</p>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!settings && !error && <p role="status">Загрузка…</p>}
    {settings && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="project-agent-scroll">
        <fieldset className="project-agent-controls" disabled={saving}>
          <legend>{connections.length} из {settings.profiles.length} подключено</legend>
          <ul className="agent-card-list" aria-label="Подключения агентов">
            {settings.profiles.map(profile => {
              const connection = connections.find(item => item.profileId === profile.id);
              return <li className="agent-card" key={profile.id}>
                <div className="agent-card-heading">
                  <Bot size={20} aria-hidden="true" />
                  <div>
                    <strong>{profile.name}</strong>
                    {profile.description && <p>{profile.description}</p>}
                    {profile.unavailableReason && <p>{profile.unavailableReason}</p>}
                  </div>
                  <label className="agent-connect">
                    <input type="checkbox" checked={!!connection} aria-label={'Подключить агента ' + profile.name} onChange={event => {
                      const checked = event.target.checked;
                      setConnections(items => checked
                        ? [...items, { profileId: profile.id, toolIds: [], fileIds: null }]
                        : items.filter(item => item.profileId !== profile.id));
                    }} />
                    {connection ? 'Подключён' : 'Подключить'}
                  </label>
                </div>
                {connection && <div className="agent-data">
                  {!profile.toolIds.length && <p className="help">Агент работает с текстом сообщения. В его профиле инструменты выключены.</p>}
                  {agentTools.filter(tool => profile.toolIds.includes(tool.id)).map(tool => {
                    const Icon = tool.id === 'project-files' ? Files : tool.id === 'chat-files' ? Paperclip : Database;
                    const checked = connection.toolIds.includes(tool.id);
                    return <div className="agent-data-source" key={tool.id}>
                      <label className="agent-tool-choice">
                        <input type="checkbox" checked={checked} onChange={event => update({
                          ...connection, toolIds: event.target.checked
                            ? [...connection.toolIds, tool.id] : connection.toolIds.filter(id => id !== tool.id),
                        })} />
                        <Icon size={17} aria-hidden="true" />
                        <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
                      </label>
                      {checked && tool.id === 'project-files' && <fieldset className="agent-file-selection">
                        <legend>Доступ к библиотеке</legend>
                        <label><input type="radio" name={'files-' + profile.id} checked={connection.fileIds === null}
                          onChange={() => update({ ...connection, fileIds: null })} />Все файлы, включая новые</label>
                        <label><input type="radio" name={'files-' + profile.id} checked={connection.fileIds !== null}
                          onChange={() => update({ ...connection, fileIds: [] })} />Только выбранные</label>
                        {connection.fileIds !== null && (settings.files.length
                          ? <ul className="agent-file-options" aria-label={'Файлы для агента ' + profile.name}>
                            {settings.files.map(file => <li key={file.id}><label>
                              <input type="checkbox" checked={connection.fileIds?.includes(file.id) ?? false}
                                onChange={event => update({ ...connection, fileIds: event.target.checked
                                  ? [...connection.fileIds!, file.id] : connection.fileIds!.filter(id => id !== file.id),
                                })} />
                              <span>{file.name}</span>
                            </label></li>)}
                          </ul>
                          : <p className="help">В библиотеке проекта пока нет файлов.</p>)}
                      </fieldset>}
                    </div>;
                  })}
                </div>}
              </li>;
            })}
          </ul>
        </fieldset>
      </div>
      <div className="button-pair project-agent-actions">
        <button className="primary" disabled={saving || (settings.policy.revision > 0 && connections === settings.policy.connections)}>{saving ? 'Сохранение…' : 'Сохранить подключения'}</button>
        <button type="button" className="secondary" disabled={saving} onClick={close}>Отмена</button>
      </div>
    </form>}
  </WorkspaceDialog>;
}
