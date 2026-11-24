import { useEffect, useState } from 'react';
import type { ProjectRole, ProjectRoleLabel, ProjectRolePolicy, ProjectRoleSettings } from '../shared/types';
import type { Request } from './library-upload';

const roleKey = ({ installationId, roleId }: ProjectRole) => installationId + '/' + roleId;

export function ProjectRolesPanel({ projectId, request, onSaved, pendingChanged }: {
  projectId: string;
  request: Request;
  onSaved: (roles: ProjectRoleLabel[]) => void;
  pendingChanged: (pending: boolean) => void;
}) {
  const url = '/api/projects/' + encodeURIComponent(projectId) + '/roles';
  const [settings, setSettings] = useState<ProjectRoleSettings>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void request<ProjectRoleSettings>(url, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setSelected(value.roles.map(roleKey));
    }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [request, url]);

  async function save() {
    if (!settings || pending) return;
    const roles = settings.available.filter(role => selected.includes(roleKey(role)));
    setPending(true);
    pendingChanged(true);
    setError('');
    setSaved(false);
    try {
      const policy = await request<ProjectRolePolicy>(url, {
        method: 'PUT', body: JSON.stringify({ revision: settings.revision,
          roles: roles.map(({ installationId, roleId }) => ({ installationId, roleId })) }),
      });
      setSettings({ ...settings, ...policy });
      setSelected(policy.roles.map(roleKey));
      onSaved(roles);
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
      pendingChanged(false);
    }
  }

  const changed = settings && (selected.length !== settings.roles.length || settings.roles.some(role => !selected.includes(roleKey(role))));
  return <>
    <p className="help">Проект увидят сотрудники с одной из выбранных ролей Fastkore. Без выбранных ролей проект виден администраторам платформы.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!settings && !error && <p role="status">Загрузка…</p>}
    {settings && <form onSubmit={event => { event.preventDefault(); if (changed) void save(); }}>
      {settings.available.length ? <ul className="settings-records project-role-options" aria-label="Роли с доступом к проекту">
        {settings.available.map(role => {
          const key = roleKey(role);
          return <li key={key}><label>
            <input type="checkbox" disabled={pending} checked={selected.includes(key)} onChange={event => {
              const checked = event.currentTarget.checked;
              setSaved(false);
              setSelected(current => checked ? [...current, key] : current.filter(item => item !== key));
            }} />
            <span>{role.name}<small>{role.installationName}</small></span>
          </label></li>;
        })}
      </ul> : <p className="help">Роли появятся после входа сотрудников из Fastkore.</p>}
      <div className="settings-dialog-actions">
        {saved && <span role="status">Роли проекта сохранены.</span>}
        <button type="submit" className="primary" disabled={!changed || pending}>Сохранить роли</button>
      </div>
    </form>}
  </>;
}
