import { useEffect, useState } from 'react';
import { Folder, Trash2 } from 'lucide-react';
import { ActiveStatusChip } from './ActiveStatusChip';
import { SettingsAction } from './SettingsAction';
import { SettingsSpinner } from './SettingsSpinner';
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

export function TeamPanel({ request, self, manageAdministrators }: { request: Request; self: User; manageAdministrators: boolean }) {
  const [users, setUsers] = useState<TeamUser[]>();
  const [removing, setRemoving] = useState<TeamUser>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);

  async function load() {
    setUsers(await request<TeamUser[]>('/api/users'));
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await work(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function updateUser(user: User, changes: { disabled: boolean }) {
    const updated = await request<User>(`/api/users/${user.id}`, json('PATCH', changes));
    setUsers(items => items?.map(item => item.id === updated.id ? { ...item, ...updated, projects: updated.disabled ? [] : item.projects } : item));
    if (!updated.disabled) await load();
  }

  useEffect(() => { void load().catch(e => setError(e.message)); }, []);

  return <>
    {removing ? <SettingsAction title="Удалить учётную запись">
      <p>Удалить учётную запись «{removing.name}» из команды? Сеансы завершатся. История чатов сохранится.</p>
      {!!removing.erpRoles?.length && <p>При следующем входе из Fastkore будет создана новая учётная запись.</p>}
      <div className="settings-dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => { setRemoving(undefined); setError(''); }}>Отмена</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => {
          await request(`/api/users/${removing.id}`, { method: 'DELETE' });
          setUsers(items => items?.filter(item => item.id !== removing.id));
          setRemoving(undefined);
        })}>Удалить</button>
      </div>
    </SettingsAction> : <section className="setting-section">
      <div className="settings-section-heading">
        <h3>Учётные записи</h3>
      </div>
      <p className="help">Проекты назначаются ролям Fastkore в «Настройки → Проекты → Настроить проект → Роли».</p>
      {!users && !error ? <SettingsSpinner label="Загрузка учётных записей…" /> : users && <table className="team-table">
        <thead><tr><th scope="col">Имя</th><th scope="col">Роли Fastkore</th><th scope="col">Доступ</th><th scope="col">Проекты</th></tr></thead>
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
            <ActiveStatusChip checked={!user.disabled} disabled={busy || user.id === self.id || (user.role === 'admin' && !manageAdministrators)}
              label={user.disabled ? 'Неактивен' : 'Активен'} accessibleLabel={'Активность · ' + user.name}
              onChange={checked => { void run(() => updateUser(user, { disabled: !checked })); }} />
            {user.id !== self.id && <button type="button" className="workspace-icon"
              aria-label={'Удалить учётную запись · ' + user.name} title="Удалить учётную запись" disabled={busy}
              onClick={() => { setError(''); setRemoving(user); }}><Trash2 size={16} aria-hidden="true" /></button>}
          </div></td>
          <td className="team-projects-cell">
            {user.projects.length ? <ul className="project-summary-chips" aria-label="Проекты">
              {user.projects.map(project => <li key={project.id}><Folder size={14} aria-hidden="true" /><span>{project.name}</span></li>)}
            </ul> : <span className="help">Нет доступных проектов</span>}
          </td>
        </tr>)}</tbody>
      </table>}
    </section>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </>;
}
