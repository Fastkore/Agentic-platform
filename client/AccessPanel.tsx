import { useEffect, useState } from 'react';
import { CorporatePanel } from './CorporatePanel';
import { Select } from './Select';
import { WorkspaceDialog } from './WorkspaceDialog';
import type { AuditEvent, User, WorkRole } from '../shared/types';

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
    <button type="button" className="secondary" onClick={() => { setNotice(''); setOpen(true); }}>Сменить пароль</button>
    {notice && <p role="status">{notice}</p>}
    {open && <WorkspaceDialog title="Сменить пароль" className="settings-action-dialog" close={() => { if (!busy) closeDialog(); }}>
      <form className="panel-body" onSubmit={e => { e.preventDefault(); void changePassword(); }}>
        <label htmlFor="current-password">Текущий пароль</label>
        <input id="current-password" data-dialog-focus type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
        <label htmlFor="new-password">Новый пароль · минимум 12 символов</label>
        <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} required />
        <div className="settings-dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={closeDialog}>Отмена</button>
          <button className="primary" disabled={busy}>Сменить пароль</button>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </form>
    </WorkspaceDialog>}
  </>;
}

type TeamDialog = { type: 'members' | 'roles' | 'audit' } | { type: 'disable'; user: User };

const auditLabels: Record<string, string> = {
  setup: 'Настройка руководителя',
  'user.create': 'Создан пользователь',
  'user.update': 'Изменён пользователь',
  'project.members': 'Изменены участники',
  'chat.private': 'Чат сделан личным',
  'chat.project': 'Чат открыт проекту',
  'key.create': 'Создан ключ API',
  'key.revoke': 'Отозван ключ API',
  'password.change': 'Изменён пароль',
};

export function TeamPanel({ request, projectId, projectName, self }: { request: Request; projectId: string; projectName: string; self: User }) {
  const [roles, setRoles] = useState<WorkRole[]>([]);
  const [users, setUsers] = useState<User[]>([]), [members, setMembers] = useState<string[]>([]), [audit, setAudit] = useState<AuditEvent[]>([]);
  const [dialog, setDialog] = useState<TeamDialog | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const title = dialog?.type === 'members' ? 'Участники проекта' : dialog?.type === 'roles' ? 'Роли, специалисты и библиотеки'
    : dialog?.type === 'audit' ? 'Журнал доступа' : 'Отключить доступ';

  async function load() {
    const [accounts, events, workRoles] = await Promise.all([
      request<User[]>('/api/users'), request<AuditEvent[]>('/api/audit'), request<WorkRole[]>('/api/admin/roles'),
    ]);
    setUsers(accounts);
    setAudit(events);
    setRoles(workRoles);
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

  function openDialog(value: TeamDialog) {
    setError('');
    setNotice('');
    setDialog(value);
  }

  function closeDialog() {
    setDialog(null);
    setError('');
  }

  async function updateUser(user: User, changes: { disabled: boolean } | { roleId: string }) {
    await request(`/api/users/${user.id}`, json('PATCH', changes));
    if (dialog?.type === 'disable') closeDialog();
    await load();
  }

  useEffect(() => { void load().catch(e => setError(e.message)); }, []);

  return <>
    <section className="setting-section">
      <div className="settings-section-heading">
        <h3>Учётные записи</h3>
        {projectId && <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await request<{ memberIds: string[] }>(`/api/projects/${projectId}/members`);
          setMembers(result.memberIds);
          openDialog({ type: 'members' });
        })}>Участники проекта</button>}
      </div>
      <table className="team-table">
        <thead><tr><th scope="col">Имя</th><th scope="col">Рабочая роль</th><th scope="col">Доступ</th></tr></thead>
        <tbody>{users.map(user => <tr key={user.id}>
          <th scope="row"><b>{user.name}{user.id === self.id && ' (вы)'}</b><small>{user.role === 'admin' ? 'Руководитель' : user.username}</small></th>
          <td><Select className="settings-select" label={`Рабочая роль · ${user.name}`} value={user.roleId ?? 'employee'} disabled={busy}
            onChange={roleId => void run(() => updateUser(user, { roleId }))}
            options={roles.map(role => ({ value: role.id, label: role.name + (role.enabled ? '' : ' · выключена'), disabled: !role.enabled }))} /></td>
          <td><span>{user.disabled ? 'Отключён' : 'Активен'}</span>{user.id !== self.id && <button type="button" className="secondary" disabled={busy} onClick={() => {
            if (user.disabled) void run(() => updateUser(user, { disabled: false }));
            else openDialog({ type: 'disable', user });
          }}>{user.disabled ? 'Включить' : 'Отключить'}</button>}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <div className="settings-actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => openDialog({ type: 'roles' })}>Роли, специалисты и библиотеки</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => openDialog({ type: 'audit' })}>Журнал доступа</button>
    </div>
    {!dialog && error && <div className="inline-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}

    {dialog && <WorkspaceDialog title={title} className={dialog.type === 'roles' ? 'settings-action-dialog wide' : 'settings-action-dialog'} close={() => { if (!busy) closeDialog(); }}>
      <div className="panel-body">
        {dialog.type === 'members' && <>
          <p>{projectName}</p>
          <div className="member-list">{users.filter(user => user.role === 'employee' && !user.disabled).map(user => <label key={user.id}>
            <input type="checkbox" checked={members.includes(user.id)} onChange={e => setMembers(items => e.target.checked ? [...items, user.id] : items.filter(id => id !== user.id))} />
            <span>{user.name}<small>{user.username}</small></span>
          </label>)}</div>
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" disabled={busy} onClick={closeDialog}>Отмена</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
              await request(`/api/projects/${projectId}/members`, json('PATCH', { memberIds: members.filter(id => users.some(user => user.id === id && !user.disabled)) }));
              closeDialog();
              setNotice('Доступ к проекту сохранён.');
            })}>Сохранить</button>
          </div>
        </>}
        {dialog.type === 'disable' && <>
          <p>{dialog.user.name} потеряет доступ к платформе. Активные сеансы будут закрыты.</p>
          <div className="settings-dialog-actions">
            <button type="button" className="secondary" data-dialog-focus disabled={busy} onClick={closeDialog}>Отмена</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => updateUser(dialog.user, { disabled: true }))}>Отключить доступ</button>
          </div>
        </>}
        {dialog.type === 'roles' && <CorporatePanel request={request} onSaved={() => void load().catch(e => setError(e.message))} />}
        {dialog.type === 'audit' && <div className="audit-list">{audit.slice(0, 30).map(event => <div key={event.id}>
          <b>{auditLabels[event.action] ?? event.action}</b>
          <small>{users.find(user => user.id === event.actorId)?.name ?? event.actorId} · {new Date(event.createdAt).toLocaleString('ru-RU')}</small>
        </div>)}</div>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
    </WorkspaceDialog>}
  </>;
}
