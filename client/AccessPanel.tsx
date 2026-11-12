import { useEffect, useState } from 'react';
import { Folder, Users } from 'lucide-react';
import { SettingsAction } from './SettingsAction';
import { shortUserName, userInitials } from './user-name';
import type { TeamUser, User } from '../shared/types';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function AccountPanel({ request, renewed, fastkore }: { request: Request; renewed: (token: string) => void; fastkore: boolean }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(''), [password, setPassword] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);

  function closeDialog() {
    setOpen(false);
    setCurrent('');
    setPassword('');
    setError('');
  }

  async function changePassword() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ token: string }>('/api/auth/password', json('POST', { currentPassword: current, password }));
      renewed(result.token);
      closeDialog();
      setNotice('Пароль изменён. Остальные сеансы завершены.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (fastkore) return <p>Пароль и вход управляются в Fastkore ERP.</p>;

  return <>
    {!open && <button type="button" className="secondary" onClick={() => { setNotice(''); setOpen(true); }}>Сменить пароль</button>}
    {notice && <p role="status">{notice}</p>}
    {open && <SettingsAction title="Сменить пароль">
      <form onSubmit={e => { e.preventDefault(); void changePassword(); }}>
        <label htmlFor="current-password">Текущий пароль</label>
        <input id="current-password" data-settings-focus type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
        <label htmlFor="new-password">Новый пароль · минимум 12 символов</label>
        <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} required />
        <div className="settings-dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={closeDialog}>Отмена</button>
          <button className="primary" disabled={busy}>Сменить пароль</button>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </form>
    </SettingsAction>}
  </>;
}

type TeamAction = { type: 'members'; projectId: string; projectName: string } | { type: 'projects'; user: User };
type EmployeeProject = { id: string; name: string; allowed: boolean };

export function TeamPanel({ request, projectId, projectName, self }: { request: Request; projectId: string; projectName: string; self: User }) {
  const [users, setUsers] = useState<TeamUser[]>([]), [members, setMembers] = useState<string[]>([]);
  const [employeeProjects, setEmployeeProjects] = useState<EmployeeProject[]>([]);
  const [editor, setEditor] = useState<TeamAction | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const title = editor?.type === 'projects' ? 'Доступ к проектам' : 'Участники проекта';

  async function load() {
    setUsers(await request<TeamUser[]>('/api/users'));
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try { await work(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function openEditor(value: TeamAction) {
    setError('');
    setNotice('');
    setEditor(value);
  }

  function closeEditor() {
    setEditor(null);
    setError('');
  }

  async function updateUser(user: User, changes: { disabled: boolean } | { roleId: string }) {
    const updated = await request<User>(`/api/users/${user.id}`, json('PATCH', changes));
    setUsers(items => items.map(item => item.id === updated.id ? { ...item, ...updated } : item));
  }

  useEffect(() => { void load().catch(e => setError(e.message)); }, []);

  return <>
    {!editor && <section className="setting-section">
      <div className="settings-section-heading">
        <h3>Учётные записи</h3>
        {projectId && <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await request<{ memberIds: string[] }>(`/api/projects/${projectId}/members`);
          setMembers(result.memberIds);
          openEditor({ type: 'members', projectId, projectName });
        })}><Users size={17} aria-hidden="true" />Участники проекта</button>}
      </div>
      <table className="team-table">
        <thead><tr><th scope="col">Имя</th><th scope="col">Роли Fastkore</th><th scope="col">Доступ</th></tr></thead>
        <tbody>{users.map(user => <tr key={user.id}>
          <th scope="row"><div className="person-cell"><span className="person-avatar" aria-hidden="true">{userInitials(user.name)}</span><div><b title={user.name}>{shortUserName(user.name)}{user.id === self.id && ' (вы)'}</b><small>{user.role === 'admin' ? 'Руководитель' : user.username.startsWith('sso-') ? 'Сотрудник Fastkore' : user.username}</small></div></div></th>
          <td><div className="team-erp-roles">
            {[...new Set(user.erpRoles?.flatMap(snapshot => snapshot.roles?.map(role => role.name) ?? []) ?? [])].map(name => <span key={name}>{name}</span>)}
            {!user.erpRoles?.length && <small>Локальная учётная запись</small>}
            {!!user.erpRoles?.length && user.erpRoles.every(snapshot => !snapshot.roles?.length) && <small>
              {user.erpRoles.some(snapshot => snapshot.roles === undefined) ? 'Роли ещё не переданы' : 'Ролей нет'}
            </small>}
          </div></td>
          <td><div className="team-access-actions">
            <label className={"check-setting team-access" + (user.disabled ? " inactive" : " active")}>
              <input type="checkbox" checked={!user.disabled} disabled={busy || user.id === self.id}
                aria-label={'Активен · ' + user.name}
                onChange={e => {
                  const disabled = !e.target.checked;
                  void run(() => updateUser(user, { disabled }));
                }} />
              {user.disabled ? 'Неактивен' : 'Активен'}
            </label>
            {user.role === 'employee' && <div className="team-actions team-row-actions">
              <button type="button" className="secondary" disabled={busy}
                aria-label={'Проекты · ' + user.name} onClick={() => void run(async () => {
                  setEmployeeProjects(await request<EmployeeProject[]>(`/api/users/${user.id}/projects`));
                  openEditor({ type: 'projects', user });
                })}><Folder size={16} aria-hidden="true" />Проекты</button>
            </div>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </section>}
    {!editor && error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}

    {editor && <SettingsAction title={title}>
        {editor.type === 'projects' && <>
          <p title={editor.user.name}>{shortUserName(editor.user.name)}</p>
          {employeeProjects.length ? <div className="member-list">{employeeProjects.map(project => <label key={project.id}>
            <input type="checkbox" checked={project.allowed} disabled={busy} onChange={e => {
              const allowed = e.target.checked;
              setEmployeeProjects(items => items.map(item => item.id === project.id ? { ...item, allowed } : item));
            }} />
            <span>{project.name}</span>
          </label>)}</div> : <p>Проектов пока нет.</p>}
          <div className="settings-dialog-actions team-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeEditor}>Отмена</button>
            <button type="button" className="primary" disabled={busy || !employeeProjects.length} onClick={() => void run(async () => {
              const projectIds = employeeProjects.filter(project => project.allowed).map(project => project.id);
              await request(`/api/users/${editor.user.id}/projects`, json('PATCH', { projectIds }));
              closeEditor();
              setNotice('Доступ к проектам сохранён.');
            })}>Сохранить</button>
          </div>
        </>}
        {editor.type === 'members' && <>
          <p>{editor.projectName}</p>
          <div className="member-list">{users.filter(user => user.role === 'employee' && !user.disabled).map(user => <label key={user.id}>
            <input type="checkbox" checked={members.includes(user.id)} onChange={e => setMembers(items => e.target.checked ? [...items, user.id] : items.filter(id => id !== user.id))} />
            <span title={user.name}>{shortUserName(user.name)}<small>{user.username}</small></span>
          </label>)}</div>
          <div className="settings-dialog-actions team-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeEditor}>Отмена</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
              await request(`/api/projects/${editor.projectId}/members`, json('PATCH', { memberIds: members.filter(id => users.some(user => user.id === id && !user.disabled)) }));
              closeEditor();
              setNotice('Доступ к проекту сохранён.');
            })}>Сохранить</button>
          </div>
        </>}
        {error && <div className="inline-error" role="alert">{error}</div>}
    </SettingsAction>}
  </>;
}
